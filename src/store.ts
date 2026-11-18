// store.ts — in-memory store for the forge. One process, no disk I/O in the
// request path (maximises the timed workloads). Deterministic timestamps so
// replays are byte-identical.
import {
  buildCommit,
  buildTree,
  parseCommit,
  parseTag,
  parseTree,
  sha1Object,
  treeSortKey,
} from './util.ts';

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface Comment {
  id: number;
  number: number;
  body: string;
  user: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  user: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdSeq: number;
  user: string;
}

export interface Label {
  name: string;
  color: string;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues: Issue[] = [];
  pulls: PullRequest[] = [];
  nextNumber = 1;

  constructor(opts: {
    id: number;
    owner: string;
    name: string;
    description: string;
    isPrivate: boolean;
    defaultBranch: string;
    createdSeq: number;
  }) {
    this.id = opts.id;
    this.owner = opts.owner;
    this.name = opts.name;
    this.description = opts.description;
    this.isPrivate = opts.isPrivate;
    this.defaultBranch = opts.defaultBranch;
    this.createdSeq = opts.createdSeq;
    // Labels exist only once created through POST /labels (the suite creates
    // them before use; GitHub's defaults are not pre-seeded, so a POST for
    // 'bug' must answer 201, not 422).
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObject['type'], data: Buffer): string {
    const oid = sha1Object(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  refValue(name: string): string | undefined {
    return this.refs.get(name);
  }

  setRef(name: string, oid: string): void {
    this.refs.set(name, oid);
  }

  deleteRef(name: string): void {
    this.refs.delete(name);
  }

  headRefName(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  headOid(): string | undefined {
    return this.refs.get(this.headRefName());
  }

  // Walk parents from a commit (or tag pointing at one). Returns commit oids
  // in BFS order (newest first by graph distance).
  walkCommits(start: string, limit = 10000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [start];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'tag') {
        const tag = parseTag(obj.data);
        queue.push(tag.object);
        continue;
      }
      if (obj.type !== 'commit') continue;
      out.push(oid);
      const commit = parseCommit(obj.data);
      for (const p of commit.parents) queue.push(p);
    }
    return out;
  }

  // Reachable objects from roots.
  // maxDepth is the git deepen value: a commit at distance d from a root is
  // included iff d < maxDepth (depth 1 = wants + their trees/blobs only,
  // depth 2 = + parents + their trees/blobs). Trees/blobs travel with their
  // commit. stopAt (shallow boundaries) are included with their trees but
  // their parents are NOT traversed (the client does not hold them).
  reachable(roots: string[], maxDepth = Infinity, stopAt: Set<string> = new Set()): Set<string> {
    const out = new Set<string>();
    const queue: { oid: string; depth: number }[] = roots.map((oid) => ({ oid, depth: 0 }));
    while (queue.length > 0) {
      const { oid, depth } = queue.shift()!;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit' && depth >= maxDepth) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        if (!out.has(c.tree)) queue.push({ oid: c.tree, depth });
        if (!stopAt.has(oid)) {
          for (const p of c.parents) queue.push({ oid: p, depth: depth + 1 });
        }
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (!out.has(e.oid)) queue.push({ oid: e.oid, depth });
        }
      } else if (obj.type === 'tag') {
        const t = parseTag(obj.data);
        if (!out.has(t.object)) queue.push({ oid: t.object, depth });
      }
    }
    return out;
  }

  // Commits at exactly distance maxDepth-1 from the roots: the new shallow
  // boundaries for a deepen fetch.
  shallowBoundaries(roots: string[], maxDepth: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: { oid: string; depth: number }[] = roots.map((oid) => ({ oid, depth: 0 }));
    while (queue.length > 0) {
      const { oid, depth } = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (depth === maxDepth - 1) {
        out.push(oid);
        continue;
      }
      if (depth >= maxDepth) continue;
      for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, depth: depth + 1 });
    }
    return out;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return false;
  }

  mergeBase(a: string, b: string): string | null {
    const seenA = new Set<string>(this.walkCommits(a));
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seenA.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return null;
  }

  // Flatten a commit's tree to path -> {oid, mode}.
  treeMap(commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return out;
    const root = parseCommit(obj.data).tree;
    const walk = (treeOid: string, prefix: string) => {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const e of parseTree(tree.data)) {
        if (e.mode === '40000') walk(e.oid, prefix + e.name + '/');
        else out.set(prefix + e.name, { oid: e.oid, mode: e.mode });
      }
    };
    walk(root, '');
    return out;
  }

  // Build a new tree by setting path -> blob oid (or deleting when oid null),
  // starting from treeOid (or an empty tree when null).
  setPath(treeOid: string | null, path: string, blobOid: string | null): string {
    const parts = path.split('/');
    const build = (currentOid: string | null, idx: number): string | null => {
      const entries = currentOid ? parseTree(this.objects.get(currentOid)?.data ?? Buffer.alloc(0)) : [];
      const map = new Map<string, { mode: string; name: string; oid: string }>();
      for (const e of entries) map.set(e.name, e);
      if (idx === parts.length - 1) {
        if (blobOid === null) map.delete(parts[idx]);
        else map.set(parts[idx], { mode: '100644', name: parts[idx], oid: blobOid });
      } else {
        const child = map.get(parts[idx]);
        const next = build(child && child.mode === '40000' ? child.oid : null, idx + 1);
        if (next === null) map.delete(parts[idx]);
        else map.set(parts[idx], { mode: '40000', name: parts[idx], oid: next });
      }
      if (map.size === 0) return null;
      const treeData = buildTree([...map.values()]);
      return this.putObject('tree', treeData);
    };
    return build(treeOid, 0) ?? this.putObject('tree', Buffer.alloc(0));
  }

  // Diff two trees (by commit oid): entries with {path, status, oldOid, newOid}.
  diffTrees(baseCommit: string, headCommit: string): {
    path: string;
    status: 'added' | 'modified' | 'removed';
    oldOid: string | null;
    newOid: string | null;
  }[] {
    const base = this.treeMap(baseCommit);
    const head = this.treeMap(headCommit);
    const out: {
      path: string;
      status: 'added' | 'modified' | 'removed';
      oldOid: string | null;
      newOid: string | null;
    }[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const p of [...paths].sort()) {
      const b = base.get(p);
      const h = head.get(p);
      if (!b && h) out.push({ path: p, status: 'added', oldOid: null, newOid: h.oid });
      else if (b && !h) out.push({ path: p, status: 'removed', oldOid: b.oid, newOid: null });
      else if (b && h && b.oid !== h.oid) out.push({ path: p, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
    return out;
  }

  // Pure merge-conflict probe (no objects written): true when the same file
  // changed on both sides with different content.
  hasMergeConflict(baseTip: string, headTip: string): boolean {
    const mergeBaseOid = this.mergeBase(baseTip, headTip);
    const baseTree = mergeBaseOid ? this.treeMap(mergeBaseOid) : new Map<string, { oid: string; mode: string }>();
    const headTree = this.treeMap(headTip);
    const currentTree = this.treeMap(baseTip);
    const paths = new Set([...baseTree.keys(), ...headTree.keys(), ...currentTree.keys()]);
    for (const p of paths) {
      const b = baseTree.get(p)?.oid ?? null;
      const h = headTree.get(p)?.oid ?? null;
      const c = currentTree.get(p)?.oid ?? null;
      if (h === b) continue;
      if (c === b) continue;
      if (h === c) continue;
      return true;
    }
    return false;
  }
  squashTree(baseTip: string, headTip: string): { conflict: boolean; treeOid?: string } {
    const mergeBaseOid = this.mergeBase(baseTip, headTip);
    const baseTree = mergeBaseOid ? this.treeMap(mergeBaseOid) : new Map<string, { oid: string; mode: string }>();
    const headTree = this.treeMap(headTip);
    const currentTree = this.treeMap(baseTip);
    const paths = new Set([...baseTree.keys(), ...headTree.keys(), ...currentTree.keys()]);
    let treeOid: string | null = null;
    const tipObj = this.objects.get(baseTip);
    if (tipObj && tipObj.type === 'commit') treeOid = parseCommit(tipObj.data).tree;
    for (const p of [...paths].sort()) {
      const b = baseTree.get(p)?.oid ?? null;
      const h = headTree.get(p)?.oid ?? null;
      const c = currentTree.get(p)?.oid ?? null;
      if (h === b) continue; // head side unchanged: keep current
      if (c === b) {
        // current side unchanged: take head's version
        treeOid = this.setPath(treeOid, p, h);
      } else if (h === c) {
        continue; // both sides made the same change
      } else {
        return { conflict: true };
      }
    }
    return { conflict: false, treeOid: treeOid ?? this.putObject('tree', Buffer.alloc(0)) };
  }
}

export class Store {
  token: string;
  viewerLogin: string | null = null;
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextObjectId = 10000;
  private seq = 0;

  constructor(token: string) {
    this.token = token;
  }

  // Deterministic clock: base 2025-01-01T00:00:00Z + one second per call.
  nextSeq(): number {
    return ++this.seq;
  }

  nowIso(): string {
    const base = Date.UTC(2025, 0, 1) + this.nextSeq() * 1000;
    return new Date(base).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  // git-style identity string for commits: "Name <email> <unix> +0000".
  commitIdentity(name: string): string {
    const ts = 1735689600 + this.nextSeq();
    return `${name} <${name.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.invalid> ${ts} +0000`;
  }

  repoKey(owner: string, name: string): string {
    return name;
  }

  // Repos are keyed by name: the store serves exactly one token holder, and
  // the owner's login is only learned when a request first names it (see
  // bindViewer). getRepo binds lazily; any other owner is a 404, never a 403.
  getRepo(owner: string, name: string): Repo | undefined {
    if (!this.viewerLogin) this.bindViewer(owner);
    if (owner !== this.viewerLogin) return undefined;
    return this.repos.get(name);
  }

  createRepo(name: string, description = '', isPrivate = false, defaultBranch = 'main'): Repo {
    const repo = new Repo({
      id: this.nextRepoId++,
      owner: this.viewerLogin ?? '',
      name,
      description,
      isPrivate,
      defaultBranch,
      createdSeq: this.nextSeq(),
    });
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewerLogin) return false;
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // Lazily bind the first owner seen on an authenticated owner-naming request.
  bindViewer(login: string): void {
    if (!this.viewerLogin) {
      this.viewerLogin = login;
      for (const repo of this.repos.values()) repo.owner = login;
    }
  }

  // Returns true when the owner is the bound viewer (or binds it now).
  isViewer(owner: string): boolean {
    if (!this.viewerLogin) {
      this.bindViewer(owner);
      return true;
    }
    return this.viewerLogin === owner;
  }

  nextId(): number {
    return this.nextObjectId++;
  }

  // Create a commit on a repo (no ref update).
  createCommit(
    repo: Repo,
    treeOid: string,
    parents: string[],
    message: string,
    authorName: string,
  ): string {
    const identity = this.commitIdentity(authorName);
    const data = buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message });
    return repo.putObject('commit', data);
  }
}

export function gitIdentity(authorLine: string): string {
  return authorLine;
}
