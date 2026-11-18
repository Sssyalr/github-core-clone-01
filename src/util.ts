// util.ts — pure helpers for the forge: SHA-1 object ids, pkt-line codec,
// git object builders/parsers, pack read/write (plain objects, no deltas),
// and reachability walks. Node built-ins only.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- SHA-1
export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

export function sha1Object(type: string, body: Buffer): string {
  const header = Buffer.from(`${type} ${body.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, body]));
}

export function encodeOid(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

// ---------------------------------------------------------------- pkt-lines
// encodePktLine: 4 hex digits (total length incl. the 4) + payload.
export function pktLine(payload: string | Buffer): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface PktLine {
  type: 'data' | 'flush' | 'delim';
  data: Buffer;
}

// decodePktLines parses a whole buffer of pkt-lines. Throws on malformed input.
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pkt-line: truncated length');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`pkt-line: bad length "${head}"`);
    const len = parseInt(head, 16);
    if (len === 0) {
      out.push({ type: 'flush', data: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      out.push({ type: 'delim', data: Buffer.alloc(0) });
      off += 4;
    } else if (len < 4 || off + len > buf.length) {
      throw new Error('pkt-line: bad length value');
    } else {
      out.push({ type: 'data', data: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return out;
}

// encodeSideband wraps a Buffer of pkt-lines into band-1 sideband packets.
export function sideband(data: Buffer, chunk = 60000): Buffer {
  const parts: Buffer[] = [];
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([1])));
    return Buffer.concat(parts);
  }
  for (let off = 0; off < data.length; off += chunk) {
    const slice = data.subarray(off, off + chunk);
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- git objects
export interface CommitParsed {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitParsed {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(opts: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let text = `tree ${opts.tree}\n`;
  for (const p of opts.parents) text += `parent ${p}\n`;
  text += `author ${opts.author}\ncommitter ${opts.committer}\n\n${opts.message}`;
  return Buffer.from(text, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

// git-style sort: entries compared by name, dirs as if ending in '/'.
export function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? e.name + '/' : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(encodeOid(e.oid));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) throw new Error('tree: missing space');
    const nul = data.indexOf(0x00, sp);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree: missing nul');
    out.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return out;
}

export interface TagParsed {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagParsed {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pack codec
const TYPE_CODES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_IDS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

// writePack: version 2, plain (non-delta) objects only.
export function writePack(objects: { type: string; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  const hash = createHash('sha1');
  hash.update(header);
  for (const obj of objects) {
    const typeId = TYPE_IDS[obj.type];
    if (!typeId) throw new Error(`pack: unknown type ${obj.type}`);
    const size = obj.data.length;
    // varint header: first byte holds 4 size bits, type in bits 4..6, cont bit 7.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeId << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      headerBytes.push(b);
    }
    const deflated = deflateSync(obj.data);
    const chunk = Buffer.concat([Buffer.from(headerBytes), deflated]);
    parts.push(chunk);
    hash.update(chunk);
  }
  const trailer = hash.digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}

// inflateAt: inflate a zlib stream starting at offset; returns data + next offset.
// Uses engine.bytesWritten (input bytes consumed) exactly like the kit's wire.ts.
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('pack: inflate consumed nothing');
  return { data: result.buffer, next: offset + written };
}

// readPack: parse a pack buffer into plain objects. Verifies the trailer.
// Deltas are rejected (the suite's client never sends them).
export function readPack(buf: Buffer): { type: string; data: Buffer; oid: string }[] {
  if (buf.length < 32) throw new Error('pack: too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack: bad signature');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack: bad version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects: { type: string; data: Buffer; oid: string }[] = [];
  let off = 12;
  const byOffset = new Map<number, { type: string; data: Buffer; oid: string }>();
  for (let i = 0; i < count; i++) {
    const entryStart = off;
    if (off >= buf.length) throw new Error('pack: truncated entry');
    let byte = buf[off++];
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (off >= buf.length) throw new Error('pack: truncated size');
      byte = buf[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      // OFS_DELTA
      let offsetByte = buf[off++];
      let baseOffset = offsetByte & 0x7f;
      while (offsetByte & 0x80) {
        offsetByte = buf[off++];
        baseOffset = ((baseOffset + 1) << 7) | (offsetByte & 0x7f);
      }
      const base = byOffset.get(entryStart - baseOffset);
      if (!base) throw new Error('pack: delta base not found');
      const { data: delta, next } = inflateAt(buf, off);
      off = next;
      const data = applyDelta(base.data, delta);
      const obj = { type: base.type, data, oid: sha1Object(base.type, data) };
      objects.push(obj);
      byOffset.set(entryStart, obj);
    } else if (typeId === 7) {
      // REF_DELTA
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const base = objects.find((o) => o.oid === baseOid) ?? [...byOffset.values()].find((o) => o.oid === baseOid);
      if (!base) throw new Error('pack: ref-delta base not found');
      const { data: delta, next } = inflateAt(buf, off);
      off = next;
      const data = applyDelta(base.data, delta);
      const obj = { type: base.type, data, oid: sha1Object(base.type, data) };
      objects.push(obj);
      byOffset.set(entryStart, obj);
    } else {
      const type = TYPE_CODES[typeId];
      if (!type) throw new Error(`pack: bad type ${typeId}`);
      const { data, next } = inflateAt(buf, off);
      off = next;
      if (data.length !== size) throw new Error('pack: size mismatch');
      const obj = { type, data, oid: sha1Object(type, data) };
      objects.push(obj);
      byOffset.set(entryStart, obj);
    }
  }
  const trailer = buf.subarray(buf.length - 20);
  const expected = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expected)) throw new Error('pack: trailer mismatch');
  return objects;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (true) {
      const b = delta[pos++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta: source size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset |= delta[pos++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= delta[pos++] << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('delta: opcode 0');
    }
  }
  if (total !== targetSize) throw new Error('delta: target size mismatch');
  return Buffer.concat(out);
}
