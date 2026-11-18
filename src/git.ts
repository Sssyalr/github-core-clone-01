// git.ts — git smart HTTP: protocol v2 upload-pack (ls-refs, fetch) and
// protocol v0 receive-pack (push). No git binary; packs are built and parsed
// in-process (see util.ts).
import { parseCommit, parseTag, readPack, writePack } from './util.ts';
import type { Repo, Store } from './store.ts';
import { ZERO_OID } from './store.ts';
import { DELIM, FLUSH, decodePktLines, pktLine, sideband } from './util.ts';

const AGENT = 'github-core-clone/1.0';

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function json(status: number, value: unknown): HttpResult {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

interface RefEntry {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

function listRefs(repo: Repo): RefEntry[] {
  const out: RefEntry[] = [];
  const headOid = repo.headOid();
  const headRef = repo.headRefName();
  out.push({ oid: headOid ?? ZERO_OID, name: 'HEAD', symrefTarget: headRef, unborn: !headOid });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefEntry = { oid, name };
    const obj = repo.getObject(oid);
    if (obj && obj.type === 'tag') {
      let peeled = parseTag(obj.data).object;
      let t = repo.getObject(peeled);
      while (t && t.type === 'tag') {
        peeled = parseTag(t.data).object;
        t = repo.getObject(peeled);
      }
      entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function advertiseV2(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    FLUSH,
    pktLine('version 2\n'),
    pktLine('agent=' + AGENT + '\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ];
  return Buffer.concat(parts);
}

function advertiseV0(repo: Repo): Buffer {
  const caps = [
    'report-status',
    'report-status-v2',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    `agent=${AGENT}`,
    `symref=HEAD:${repo.headRefName()}`,
  ].join(' ');
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
  const refs = listRefs(repo);
  if (refs.length === 1 && refs[0].unborn) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleLsRefs(repo: Repo, lines: { type: string; data: Buffer }[]): HttpResult {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const line of lines) {
    if (line.type === 'delim') {
      afterDelim = true;
      continue;
    }
    if (line.type !== 'data' || !afterDelim) continue;
    const text = line.data.toString('utf8').replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  for (const ref of listRefs(repo)) {
    if (!keep(ref.name)) continue;
    if (ref.unborn) {
      if (unborn && ref.name === 'HEAD') {
        out.push(pktLine(`unborn HEAD symref-target:${ref.symrefTarget}\n`));
      }
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    out.push(pktLine(line + '\n'));
  }
  out.push(FLUSH);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(out),
  };
}

function handleFetchV2(repo: Repo, lines: { type: string; data: Buffer }[]): HttpResult {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReq: string[] = [];
  let depth: number | null = null;
  let afterDelim = false;
  for (const line of lines) {
    if (line.type === 'delim') {
      afterDelim = true;
      continue;
    }
    if (line.type !== 'data' || !afterDelim) continue;
    const text = line.data.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowReq.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7), 10);
  }
  if (depth !== null && (!Number.isFinite(depth) || depth < 1)) depth = null;

  const wanted = repo.reachable(wants, depth ?? Infinity);
  const held = repo.reachable(haves, Infinity, new Set(shallowReq));
  const toSend = new Set<string>();
  for (const oid of wanted) if (!held.has(oid)) toSend.add(oid);

  const objects: { type: string; data: Buffer; oid: string }[] = [];
  for (const oid of [...toSend].sort()) {
    const obj = repo.getObject(oid);
    if (obj) objects.push({ type: obj.type, data: obj.data, oid });
  }
  const pack = writePack(objects);

  const ackLines: string[] = [];
  if (haves.length === 0) {
    ackLines.push('NAK\n');
  } else {
    const common = haves.find((h) => wanted.has(h));
    if (common) {
      ackLines.push(`ACK ${common}\n`);
      ackLines.push('ready\n');
    } else {
      ackLines.push('NAK\n');
    }
  }

  const shallowLines: string[] = [];
  if (depth !== null) {
    for (const b of repo.shallowBoundaries(wants, depth)) shallowLines.push(`shallow ${b}\n`);
    for (const prev of shallowReq) {
      const obj = repo.getObject(prev);
      if (obj && obj.type === 'commit') {
        const parents = parseCommit(obj.data).parents;
        if (parents.some((p) => toSend.has(p))) shallowLines.push(`unshallow ${prev}\n`);
      }
    }
  }

  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  for (const l of ackLines) parts.push(pktLine(l));
  parts.push(FLUSH);
  if (shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const l of shallowLines) parts.push(pktLine(l));
    parts.push(FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(pack));
  parts.push(FLUSH);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(parts),
  };
}

function applyCommand(
  repo: Repo,
  cmd: { oldOid: string; newOid: string; ref: string },
): { ok: boolean; reason?: string } {
  const current = repo.refValue(cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    // delete
    if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) {
      return { ok: false, reason: 'old value does not match' };
    }
    if (!current) return { ok: false, reason: 'reference does not exist' };
    repo.deleteRef(cmd.ref);
    return { ok: true };
  }
  const obj = repo.getObject(cmd.newOid);
  if (!obj) return { ok: false, reason: 'object not found' };
  if (cmd.oldOid === ZERO_OID) {
    // create
    if (current) return { ok: false, reason: 'reference already exists' };
    repo.setRef(cmd.ref, cmd.newOid);
    return { ok: true };
  }
  // update
  if (current !== cmd.oldOid) return { ok: false, reason: 'old value does not match' };
  if (cmd.ref.startsWith('refs/heads/') && !repo.isAncestor(cmd.oldOid, cmd.newOid)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.setRef(cmd.ref, cmd.newOid);
  return { ok: true };
}

function handleReceivePack(repo: Repo, body: Buffer): HttpResult {
  // Parse command pkt-lines up to the first flush; the rest is the pack.
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let sidebandRequested = false;
  let off = 0;
  let firstLine = true;
  let sawFlush = false;
  while (off + 4 <= body.length) {
    const head = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return json(400, { message: 'Bad Request' });
    const len = parseInt(head, 16);
    if (len === 0) {
      off += 4;
      sawFlush = true;
      break;
    }
    if (len === 1 || len === 2 || len < 4 || off + len > body.length) {
      return json(400, { message: 'Bad Request' });
    }
    const payload = body.subarray(off + 4, off + len).toString('utf8');
    off += len;
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const cmdPart = nul >= 0 ? line.slice(0, nul) : line;
    const capsPart = nul >= 0 ? line.slice(nul + 1) : '';
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(cmdPart);
    if (!m) return json(400, { message: 'Bad Request' });
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    if (firstLine && capsPart) {
      sidebandRequested = capsPart.split(' ').includes('side-band-64k');
    }
    firstLine = false;
  }
  if (!sawFlush || commands.length === 0) return json(400, { message: 'Bad Request' });
  const packBytes = body.subarray(off);

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objs = readPack(packBytes);
      for (const o of objs) repo.putObject(o.type as 'commit' | 'tree' | 'blob' | 'tag', o.data);
    } catch (e) {
      unpackOk = false;
      unpackDetail = 'unpack error';
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  if (unpackOk) {
    for (const cmd of commands) {
      const result = applyCommand(repo, cmd);
      if (result.ok) reportLines.push(`ok ${cmd.ref}\n`);
      else reportLines.push(`ng ${cmd.ref} ${result.reason}\n`);
    }
  }
  const inner = Buffer.concat(reportLines.map((l) => pktLine(l)));
  const out = sidebandRequested ? Buffer.concat([sideband(inner), FLUSH]) : Buffer.concat([inner, FLUSH]);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
    body: out,
  };
}

export function handleGit(
  store: Store,
  owner: string,
  repoName: string,
  sub: string,
  method: string,
  query: URLSearchParams,
  body: Buffer,
): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return json(404, { message: 'Not Found' });
  if (sub === 'info/refs' && method === 'GET') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' },
        body: advertiseV2(),
      };
    }
    if (service === 'git-receive-pack') {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/x-git-receive-pack-advertisement' },
        body: advertiseV0(repo),
      };
    }
    return json(400, { message: 'Bad Request' });
  }
  if (sub === 'git-upload-pack' && method === 'POST') {
    let lines;
    try {
      lines = decodePktLines(body);
    } catch {
      return json(400, { message: 'Bad Request' });
    }
    const first = lines.find((l) => l.type === 'data');
    const command = first ? first.data.toString('utf8').replace(/\n$/, '') : '';
    if (command === 'command=ls-refs') return handleLsRefs(repo, lines);
    if (command === 'command=fetch') return handleFetchV2(repo, lines);
    return json(400, { message: 'Bad Request' });
  }
  if (sub === 'git-receive-pack' && method === 'POST') {
    return handleReceivePack(repo, body);
  }
  return json(404, { message: 'Not Found' });
}

export { DELIM };
