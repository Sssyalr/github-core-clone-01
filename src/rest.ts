// rest.ts — GitHub REST v3 surface: repos, branches, commits, refs, contents,
// labels, issues, comments, pull requests. All responses are JSON; every
// error body carries a string `message`.
import { parseCommit, parseTree } from './util.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { ZERO_OID } from './store.ts';
import type { HttpResult } from './git.ts';

const SHA40 = /^[0-9a-f]{40}$/i;

function json(status: number, value: unknown, extraHeaders: Record<string, string> = {}): HttpResult {
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

function err(status: number, message: string): HttpResult {
  return json(status, { message });
}

function isoFromSeq(seq: number): string {
  return new Date(Date.UTC(2025, 0, 1) + seq * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!m) return { name: line, email: '', date: isoFromSeq(0) };
  return {
    name: m[1],
    email: m[2],
    date: new Date(parseInt(m[3], 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

// ---------------------------------------------------------------- serializers
function userJson(login: string): Record<string, unknown> {
  return { login, id: 1000, node_id: b64url(`user:${login}`), type: 'User' };
}

function repoJson(store: Store, repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: b64url(`repo:${repo.fullName}`),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoFromSeq(repo.createdSeq),
    updated_at: isoFromSeq(repo.createdSeq),
    html_url: `${baseUrl}/${repo.fullName}`,
    url: `${baseUrl}/api/v3/repos/${repo.fullName}`,
    clone_url: `${baseUrl}/${repo.fullName}.git`,
    git_url: `${baseUrl}/${repo.fullName}.git`,
    ssh_url: `git@example.invalid:${repo.fullName}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

function issueJson(store: Store, repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: b64url(`issue:${repo.fullName}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: '000000' })),
    user: userJson(issue.user),
    created_at: isoFromSeq(issue.createdSeq),
    updated_at: isoFromSeq(issue.createdSeq),
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `${baseUrl}/${repo.fullName}/issues/${issue.number}`,
    comments: issue.comments.length,
    comments_url: `${baseUrl}/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
  };
}

function commentJson(store: Store, repo: Repo, issue: Issue, comment: Issue['comments'][number], baseUrl: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: b64url(`comment:${repo.fullName}#${issue.number}/${comment.number}`),
    body: comment.body,
    user: userJson(comment.user),
    created_at: isoFromSeq(comment.createdSeq),
    updated_at: isoFromSeq(comment.createdSeq),
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `${baseUrl}/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

function pullJson(store: Store, repo: Repo, pr: PullRequest, baseUrl: string): Record<string, unknown> {
  const headSha = repo.refValue(`refs/heads/${pr.headRef}`) ?? ZERO_OID;
  const baseSha = repo.refValue(`refs/heads/${pr.baseRef}`) ?? ZERO_OID;
  return {
    id: pr.id,
    node_id: b64url(`pr:${repo.fullName}#${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: headSha, label: `${repo.owner}:${pr.headRef}`, repo: repoJson(store, repo, baseUrl) },
    base: { ref: pr.baseRef, sha: baseSha, label: `${repo.owner}:${pr.baseRef}`, repo: repoJson(store, repo, baseUrl) },
    user: userJson(pr.user),
    created_at: isoFromSeq(pr.createdSeq),
    updated_at: isoFromSeq(pr.createdSeq),
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/pulls/${pr.number}`,
    html_url: `${baseUrl}/${repo.fullName}/pull/${pr.number}`,
  };
}

function commitJson(store: Store, repo: Repo, oid: string, baseUrl: string): Record<string, unknown> | null {
  const obj = repo.getObject(oid);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const author = parseIdentity(c.author);
  const committer = parseIdentity(c.committer);
  return {
    sha: oid,
    node_id: b64url(`commit:${repo.fullName}@${oid}`),
    commit: {
      message: c.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: c.tree },
    },
    author: userJson(author.name),
    committer: userJson(committer.name),
    parents: c.parents.map((p) => ({ sha: p })),
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/commits/${oid}`,
    html_url: `${baseUrl}/${repo.fullName}/commit/${oid}`,
  };
}

// ---------------------------------------------------------------- helpers
function resolveRefTip(repo: Repo, ref: string): string | undefined {
  // ref may be a branch name, a full ref, or a commit oid.
  if (SHA40.test(ref)) {
    const obj = repo.getObject(ref);
    return obj && obj.type === 'commit' ? ref : undefined;
  }
  const name = ref.startsWith('refs/heads/') ? ref : `refs/heads/${ref}`;
  return repo.refValue(name);
}

function parseBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// ---------------------------------------------------------------- handler
export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): HttpResult {
  const viewer = store.viewerLogin ?? '';
  const b = parseBody(body);

  // ---- /api/v3/ root and /api/v3/meta (anon allowed; app.ts routes here)
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { current_user_url: `${baseUrl}/api/v3/user` }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0' });
  }

  // ---- /api/v3/user
  if (segments.length >= 1 && segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') {
      if (!store.viewerLogin) return err(404, 'Not Found');
      return json(200, { ...userJson(store.viewerLogin), name: store.viewerLogin, email: `${store.viewerLogin}@example.invalid` });
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'POST') {
        const name = str(b.name).trim();
        if (!name) return err(422, 'name is required');
        if (store.getRepo(viewer, name)) return err(422, 'Repository already exists');
        const repo = store.createRepo(name, str(b.description), b.private === true, str(b.default_branch, 'main') || 'main');
        return json(201, repoJson(store, repo, baseUrl));
      }
      if (method === 'GET') {
        const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
        const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
        const all = store.listRepos();
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const headers: Record<string, string> = {};
        if (page * perPage < all.length) {
          const next = `${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
          headers.Link = `<${next}>; rel="next"`;
        }
        return json(200, slice.map((r) => repoJson(store, r, baseUrl)), headers);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // ---- /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1];
    const repoName = segments[2];
    const repo = store.getRepo(owner, repoName);
    if (!repo) return err(404, 'Not Found');
    const rest = segments.slice(3);

    // repo itself
    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(store, repo, baseUrl));
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.default_branch === 'string' && b.default_branch) repo.defaultBranch = b.default_branch;
        return json(200, repoJson(store, repo, baseUrl));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return { status: 204, headers: { 'Content-Type': 'application/json' }, body: Buffer.alloc(0) };
      }
      return err(404, 'Not Found');
    }

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((n) => n.startsWith('refs/heads/'))
          .map((n) => n.slice('refs/heads/'.length))
          .sort()
          .map((name) => ({
            name,
            commit: { sha: repo.refValue(`refs/heads/${name}`) },
            protected: false,
          }));
        return json(200, branches);
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refValue(`refs/heads/${decodeURIComponent(rest[1])}`);
        if (!sha) return err(404, 'Not Found');
        return json(200, { name: decodeURIComponent(rest[1]), commit: { sha }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      const start = shaParam ? resolveRefTip(repo, shaParam) : repo.headOid();
      if (!start) return json(200, []);
      const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
      const oids = repo.walkCommits(start, perPage);
      const out: Record<string, unknown>[] = [];
      for (const oid of oids) {
        const c = commitJson(store, repo, oid, baseUrl);
        if (c) out.push(c);
      }
      return json(200, out);
    }

    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const ref = str(b.ref);
        const sha = str(b.sha);
        if (!ref.startsWith('refs/') || !SHA40.test(sha)) return err(422, 'Invalid ref or sha');
        if (repo.refValue(ref)) return err(422, 'Reference already exists');
        const obj = repo.getObject(sha);
        if (!obj) return err(422, 'Object does not exist');
        repo.setRef(ref, sha);
        return json(201, { ref, object: { sha, type: obj.type, url: `${baseUrl}/api/v3/repos/${repo.fullName}/git/${obj.type}s/${sha}` } });
      }
      if (rest.length >= 3 && method === 'GET') {
        const refName = rest.slice(2).map(decodeURIComponent).join('/');
        const sha = repo.refValue(refName);
        if (!sha) return err(404, 'Not Found');
        const obj = repo.getObject(sha);
        return json(200, { ref: refName, object: { sha, type: obj?.type ?? 'commit', url: `${baseUrl}/api/v3/repos/${repo.fullName}/git/${obj?.type ?? 'commit'}s/${sha}` } });
      }
      return err(404, 'Not Found');
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') return getContents(store, repo, path, query, baseUrl);
      if (method === 'PUT') return putContents(store, repo, path, b, baseUrl);
      if (method === 'DELETE') return deleteContents(store, repo, path, b, baseUrl);
      return err(404, 'Not Found');
    }

    // labels
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'POST') {
        const name = str(b.name).trim();
        if (!name) return err(422, 'name is required');
        if (repo.labels.has(name)) return err(422, 'Label already exists');
        const label = { name, color: str(b.color, '000000') };
        repo.labels.set(name, label);
        return json(201, labelJson(label));
      }
      if (rest.length === 1 && method === 'GET') {
        return json(200, [...repo.labels.values()].map(labelJson));
      }
      return err(404, 'Not Found');
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1 && method === 'POST') return createIssue(store, repo, b, baseUrl);
      if (rest.length === 1 && method === 'GET') return listIssues(store, repo, query, baseUrl);
      const num = parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(num)) return err(404, 'Not Found');
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return json(200, issueJson(store, repo, issue, baseUrl));
        if (method === 'PATCH') {
          if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (Array.isArray(b.labels)) {
            const names = (b.labels as unknown[]).filter((x): x is string => typeof x === 'string');
            for (const name of names) if (!repo.labels.has(name)) return err(422, `Label does not exist: ${name}`);
            issue.labels = names;
          }
          return json(200, issueJson(store, repo, issue, baseUrl));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') {
          return json(200, issue.comments.map((c) => commentJson(store, repo, issue, c, baseUrl)));
        }
        if (method === 'POST') {
          const comment = {
            id: store.nextId(),
            number: issue.comments.length + 1,
            body: str(b.body),
            user: viewer,
            createdSeq: store.nextSeq(),
          };
          issue.comments.push(comment);
          return json(201, commentJson(store, repo, issue, comment, baseUrl));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1 && method === 'POST') return createPull(store, repo, b, baseUrl);
      if (rest.length === 1 && method === 'GET') return listPulls(store, repo, query, baseUrl);
      const num = parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(num)) return err(404, 'Not Found');
      const pr = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (!pr) return err(404, 'Not Found');
        if (method === 'GET') return json(200, pullJson(store, repo, pr, baseUrl));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pr) return err(404, 'Not Found');
        return json(200, pullFiles(store, repo, pr));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pr) return err(404, 'Not Found');
        return mergePull(store, repo, pr, b, baseUrl);
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- contents
function getContents(store: Store, repo: Repo, path: string, query: URLSearchParams, baseUrl: string): HttpResult {
  const refParam = query.get('ref');
  const tip = refParam ? resolveRefTip(repo, refParam) : repo.headOid();
  if (!tip) return err(404, 'Not Found');
  const tree = repo.treeMap(tip);
  if (path === '') {
    // root directory listing
    const entries = new Map<string, { type: string; name: string; path: string; sha: string }>();
    for (const [p, v] of tree) {
      const first = p.split('/')[0];
      if (!entries.has(first)) {
        entries.set(first, {
          type: p.includes('/') ? 'dir' : 'file',
          name: first,
          path: first,
          sha: p.includes('/') ? '' : v.oid,
        });
      }
    }
    // directory shas: resolve from the tip tree
    const tipObj = repo.getObject(tip);
    if (tipObj && tipObj.type === 'commit') {
      const rootTree = parseCommit(tipObj.data).tree;
      const rootEntries = parseTree(repo.getObject(rootTree)?.data ?? Buffer.alloc(0));
      for (const e of rootEntries) {
        const entry = entries.get(e.name);
        if (entry && e.mode === '40000') entry.sha = e.oid;
      }
    }
    return json(200, [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
  }
  const direct = tree.get(path);
  if (direct) {
    const obj = repo.getObject(direct.oid);
    if (!obj || obj.type !== 'blob') return err(404, 'Not Found');
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: obj.data.length,
      name: path.split('/').pop(),
      path,
      content: obj.data.toString('base64'),
      sha: direct.oid,
    });
  }
  // directory?
  const prefix = path + '/';
  const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
  for (const [p, v] of tree) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const first = rest.split('/')[0];
    if (!children.has(first)) {
      children.set(first, {
        type: rest.includes('/') ? 'dir' : 'file',
        name: first,
        path: path + '/' + first,
        sha: rest.includes('/') ? '' : v.oid,
      });
    }
  }
  if (children.size === 0) return err(404, 'Not Found');
  // resolve directory shas by walking the tree
  const tipObj = repo.getObject(tip);
  if (tipObj && tipObj.type === 'commit') {
    let treeOid: string | undefined = parseCommit(tipObj.data).tree;
    for (const part of path.split('/')) {
      const entries = parseTree(repo.getObject(treeOid ?? '')?.data ?? Buffer.alloc(0));
      const next = entries.find((e) => e.name === part && e.mode === '40000');
      if (!next) {
        treeOid = undefined;
        break;
      }
      treeOid = next.oid;
    }
    if (treeOid) {
      for (const e of parseTree(repo.getObject(treeOid)?.data ?? Buffer.alloc(0))) {
        const child = children.get(e.name);
        if (child) child.sha = e.oid;
      }
    }
  }
  return json(200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
}

function putContents(store: Store, repo: Repo, path: string, b: Record<string, unknown>, baseUrl: string): HttpResult {
  const contentB64 = str(b.content);
  if (!contentB64) return err(422, 'content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const branch = str(b.branch) || repo.defaultBranch;
  const shaParam = str(b.sha);
  const branchRef = `refs/heads/${branch}`;
  let tip = repo.refValue(branchRef);
  let isNewBranch = false;
  if (!tip) {
    // create the branch from the default tip (or unborn)
    tip = repo.headOid();
    isNewBranch = true;
  }
  const tree = tip ? repo.treeMap(tip) : new Map<string, { oid: string; mode: string }>();
  const existing = tree.get(path);
  if (shaParam) {
    if (!existing || existing.oid !== shaParam) return err(409, 'sha does not match the current file');
  } else if (existing) {
    return err(409, 'file already exists');
  }
  const blobOid = repo.putObject('blob', content);
  let treeOid: string | null = null;
  if (tip) {
    const tipObj = repo.getObject(tip);
    if (tipObj && tipObj.type === 'commit') treeOid = parseCommit(tipObj.data).tree;
  }
  const newTreeOid = repo.setPath(treeOid, path, blobOid);
  const viewer = store.viewerLogin ?? 'conformance';
  const commitOid = store.createCommit(
    repo,
    newTreeOid,
    tip ? [tip] : [],
    str(b.message) || `${existing ? 'Update' : 'Create'} ${path}`,
    viewer,
  );
  repo.setRef(branchRef, commitOid);
  const status = existing ? 200 : 201;
  return json(status, {
    content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
    commit: { sha: commitOid, message: str(b.message) || '' },
  });
}

function deleteContents(store: Store, repo: Repo, path: string, b: Record<string, unknown>, baseUrl: string): HttpResult {
  const branch = str(b.branch) || repo.defaultBranch;
  const branchRef = `refs/heads/${branch}`;
  const tip = repo.refValue(branchRef);
  if (!tip) return err(404, 'Not Found');
  const tree = repo.treeMap(tip);
  const existing = tree.get(path);
  if (!existing) return err(404, 'Not Found');
  const shaParam = str(b.sha);
  if (shaParam && existing.oid !== shaParam) return err(409, 'sha does not match the current file');
  const tipObj = repo.getObject(tip);
  const treeOid = tipObj && tipObj.type === 'commit' ? parseCommit(tipObj.data).tree : null;
  const newTreeOid = repo.setPath(treeOid, path, null);
  const viewer = store.viewerLogin ?? 'conformance';
  const commitOid = store.createCommit(repo, newTreeOid, [tip], str(b.message) || `Delete ${path}`, viewer);
  repo.setRef(branchRef, commitOid);
  return json(200, { commit: { sha: commitOid, message: str(b.message) || '' } });
}

// ---------------------------------------------------------------- issues
function createIssue(store: Store, repo: Repo, b: Record<string, unknown>, baseUrl: string): HttpResult {
  const labels = Array.isArray(b.labels)
    ? (b.labels as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  for (const name of labels) if (!repo.labels.has(name)) return err(422, `Label does not exist: ${name}`);
  const issue: Issue = {
    id: store.nextId(),
    number: repo.nextNumber++,
    title: str(b.title),
    body: str(b.body),
    state: 'open',
    labels,
    comments: [],
    createdSeq: store.nextSeq(),
    user: store.viewerLogin ?? 'conformance',
  };
  repo.issues.push(issue);
  return json(201, issueJson(store, repo, issue, baseUrl));
}

function listIssues(store: Store, repo: Repo, query: URLSearchParams, baseUrl: string): HttpResult {
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  let list = repo.issues.filter((i) => state === 'all' || i.state === state);
  list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  return json(200, list.map((i) => issueJson(store, repo, i, baseUrl)));
}

// ---------------------------------------------------------------- pulls
function createPull(store: Store, repo: Repo, b: Record<string, unknown>, baseUrl: string): HttpResult {
  const head = str(b.head);
  const base = str(b.base);
  if (!head || !base) return err(422, 'head and base are required');
  const headTip = repo.refValue(`refs/heads/${head}`);
  const baseTip = repo.refValue(`refs/heads/${base}`);
  if (!headTip || !baseTip) return err(404, 'Not Found');
  const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
  if (dup) return err(422, 'A pull request already exists for these branches');
  const pr: PullRequest = {
    id: store.nextId(),
    number: repo.nextNumber++,
    title: str(b.title),
    body: str(b.body),
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    createdSeq: store.nextSeq(),
    user: store.viewerLogin ?? 'conformance',
  };
  repo.pulls.push(pr);
  return json(201, pullJson(store, repo, pr, baseUrl));
}

function listPulls(store: Store, repo: Repo, query: URLSearchParams, baseUrl: string): HttpResult {
  const state = query.get('state') ?? 'open';
  const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
  return json(200, list.map((p) => pullJson(store, repo, p, baseUrl)));
}

function pullFiles(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown>[] {
  const headTip = repo.refValue(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refValue(`refs/heads/${pr.baseRef}`);
  if (!headTip || !baseTip) return [];
  const mergeBaseOid = repo.mergeBase(headTip, baseTip) ?? baseTip;
  const diff = repo.diffTrees(mergeBaseOid, headTip);
  return diff.map((d) => {
    const oldData = d.oldOid ? repo.getObject(d.oldOid)?.data : undefined;
    const newData = d.newOid ? repo.getObject(d.newOid)?.data : undefined;
    const countLines = (data: Buffer | undefined): number => {
      if (!data || data.length === 0) return 0;
      let n = 0;
      for (const byte of data) if (byte === 0x0a) n += 1;
      return n + (data[data.length - 1] === 0x0a ? 0 : 1);
    };
    const additions = d.status === 'removed' ? 0 : Math.max(1, countLines(newData));
    const deletions = d.status === 'added' ? 0 : countLines(oldData);
    return {
      sha: d.newOid ?? d.oldOid ?? ZERO_OID,
      filename: d.path,
      status: d.status === 'removed' ? 'removed' : d.status,
      additions,
      deletions,
      changes: additions + deletions,
      patch: '',
    };
  });
}

function mergePull(store: Store, repo: Repo, pr: PullRequest, b: Record<string, unknown>, baseUrl: string): HttpResult {
  if (pr.state !== 'open') return err(405, 'Pull request is not open');
  const headTip = repo.refValue(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refValue(`refs/heads/${pr.baseRef}`);
  if (!headTip || !baseTip) return err(404, 'Not Found');
  const method = str(b.merge_method, 'squash');
  if (method !== 'squash') return err(405, 'Only squash merges are supported');
  const result = repo.squashTree(baseTip, headTip);
  if (result.conflict) return err(405, 'Merge conflict');
  const viewer = store.viewerLogin ?? 'conformance';
  const message = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`;
  const commitOid = store.createCommit(repo, result.treeOid!, [baseTip, headTip], message, viewer);
  repo.setRef(`refs/heads/${pr.baseRef}`, commitOid);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = isoFromSeq(store.nextSeq());
  pr.mergeCommitSha = commitOid;
  return json(200, { sha: commitOid, merged: true, message: `Pull request #${pr.number} merged` });
}
