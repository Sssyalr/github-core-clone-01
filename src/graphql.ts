// graphql.ts — a small GraphQL executor for the exact documents gh and
// github-mcp-server send: repository/issue/pull-request queries, the
// __type introspection probes, node(id:), and the five mutations.
// No schema validation beyond unknown-field errors (HTTP 200 + errors array).
import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { ZERO_OID } from './store.ts';
import type { HttpResult } from './git.ts';
import { parseCommit } from './util.ts';

function json(status: number, value: unknown): HttpResult {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

// ---------------------------------------------------------------- ids
function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

function decodeGid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return gid('repo', repo.fullName);
}

function issueGid(repo: Repo, issue: Issue): string {
  return gid('issue', `${repo.fullName}#${issue.number}`);
}

function prGid(repo: Repo, pr: PullRequest): string {
  return gid('pr', `${repo.fullName}#${pr.number}`);
}

function commentGid(repo: Repo, issue: Issue, commentId: number): string {
  return gid('comment', `${repo.fullName}#${issue.number}/${commentId}`);
}

function findRepoByGid(store: Store, id: string): Repo | null {
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'repo') return null;
  const slash = decoded.key.indexOf('/');
  if (slash < 0) return null;
  return store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1)) ?? null;
}

function findIssueByGid(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'issue') return null;
  const hash = decoded.key.indexOf('#');
  if (hash < 0) return null;
  const ownerRepo = decoded.key.slice(0, hash);
  const number = parseInt(decoded.key.slice(hash + 1), 10);
  const slash = ownerRepo.indexOf('/');
  if (slash < 0 || !Number.isInteger(number)) return null;
  const repo = store.getRepo(ownerRepo.slice(0, slash), ownerRepo.slice(slash + 1));
  if (!repo) return null;
  const issue = repo.issues.find((i) => i.number === number);
  return issue ? { repo, issue } : null;
}

function findPrByGid(store: Store, id: string): { repo: Repo; pr: PullRequest } | null {
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'pr') return null;
  const hash = decoded.key.indexOf('#');
  if (hash < 0) return null;
  const ownerRepo = decoded.key.slice(0, hash);
  const number = parseInt(decoded.key.slice(hash + 1), 10);
  const slash = ownerRepo.indexOf('/');
  if (slash < 0 || !Number.isInteger(number)) return null;
  const repo = store.getRepo(ownerRepo.slice(0, slash), ownerRepo.slice(slash + 1));
  if (!repo) return null;
  const pr = repo.pulls.find((p) => p.number === number);
  return pr ? { repo, pr } : null;
}

// ---------------------------------------------------------------- tokenizer
type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '#') {
      if (ch === '#') {
        while (i < source.length && source[i] !== '\n') i += 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let num = '';
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) {
        num += source[j];
        j += 1;
      }
      const value = Number(num);
      tokens.push(Number.isInteger(value) && !num.includes('.') && !num.includes('e') && !num.includes('E')
        ? { kind: 'int', value }
        : { kind: 'float', value });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      let name = '';
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) {
        name += source[j];
        j += 1;
      }
      tokens.push({ kind: 'name', value: name });
      i = j;
      continue;
    }
    throw new Error(`graphql: unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser
type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selectionSet: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string;
  selectionSet: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; type: string; defaultValue?: Value }[];
  selectionSet: Selection[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('graphql: unexpected end of document');
    this.pos += 1;
    return t;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) {
      throw new Error(`graphql: expected ${value}, got ${JSON.stringify(t)}`);
    }
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`graphql: expected name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      this.next();
      type = t.value as 'query' | 'mutation';
      const n = this.peek();
      if (n?.kind === 'name') name = this.next().value as string;
    }
    const variables: Operation['variables'] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const varType = this.parseTypeName();
        let defaultValue: Value | undefined;
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, type: varType, defaultValue });
      }
      this.expectPunct(')');
    }
    const selectionSet = this.parseSelectionSet();
    return { type, name, variables, selectionSet };
  }

  private parseTypeName(): string {
    let name = '';
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === '[') {
      this.next();
      name = `[${this.parseTypeName()}]`;
    } else {
      name = this.expectName();
    }
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '!') {
      this.next();
      name += '!';
    }
    return name;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): Selection {
    const t = this.peek();
    if (t?.kind === 'spread') {
      this.next();
      this.expectName(); // 'on'
      const typeCondition = this.expectName();
      const selectionSet = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selectionSet };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, Value> = {};
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selectionSet: Selection[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'var', name: this.expectName() };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, Value> = {};
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`graphql: unexpected value token ${JSON.stringify(t)}`);
  }
}

// ---------------------------------------------------------------- values
function resolveValue(v: Value, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var':
      return variables[v.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = resolveValue(val, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema (introspection)
interface TypeDef {
  name: string;
  kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  fields: string[];
  enumValues: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: { name: 'Query', kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'], enumValues: [] },
  Mutation: { name: 'Mutation', kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'], enumValues: [] },
  Repository: {
    name: 'Repository',
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'],
    enumValues: [],
  },
  Issue: {
    name: 'Issue',
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'labels', 'comments'],
    enumValues: [],
  },
  PullRequest: {
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt'],
    enumValues: [],
  },
  User: { name: 'User', kind: 'OBJECT', fields: ['id', 'login', 'name'], enumValues: [] },
  SearchType: {
    name: 'SearchType',
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'],
  },
};

// ---------------------------------------------------------------- executor
interface RuntimeObject {
  __typename: string;
  [key: string]: unknown;
}

interface Ctx {
  store: Store;
  errors: { message: string }[];
  variables: Record<string, unknown>;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice(7), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pr: PullRequest): string {
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function mergeableOf(repo: Repo, pr: PullRequest): string {
  const headTip = repo.refValue(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refValue(`refs/heads/${pr.baseRef}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  return repo.hasMergeConflict(baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
}

function issueObject(store: Store, repo: Repo, issue: Issue): RuntimeObject {
  return {
    __typename: 'Issue',
    __issue: issue,
    __repo: repo,
    id: issueGid(repo, issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
    url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    createdAt: new Date(Date.UTC(2025, 0, 1) + issue.createdSeq * 1000).toISOString(),
  };
}

function prObject(store: Store, repo: Repo, pr: PullRequest): RuntimeObject {
  return {
    __typename: 'PullRequest',
    __pr: pr,
    __repo: repo,
    id: prGid(repo, pr),
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: prState(pr),
    merged: pr.merged,
    mergeable: mergeableOf(repo, pr),
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    url: `https://example.invalid/${repo.fullName}/pull/${pr.number}`,
    createdAt: new Date(Date.UTC(2025, 0, 1) + pr.createdSeq * 1000).toISOString(),
  };
}

function repoObject(store: Store, repo: Repo): RuntimeObject {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: repoGid(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function userObject(login: string): RuntimeObject {
  return { __typename: 'User', id: gid('user', login), login, name: login };
}

function typeObject(def: TypeDef): RuntimeObject {
  return {
    __typename: '__Type',
    __typeDef: def,
    name: def.name,
    kind: def.kind,
    description: null,
    fields: def.fields.map((name) => ({ __typename: '__Field', name, description: null })),
    enumValues: def.kind === 'ENUM' ? def.enumValues.map((name) => ({ __typename: '__EnumValue', name, description: null })) : null,
  };
}

function pageInfoObject(hasNextPage: boolean, endCursor: string | null): RuntimeObject {
  return {
    __typename: 'PageInfo',
    hasNextPage,
    hasPreviousPage: false,
    startCursor: null,
    endCursor,
  };
}

// Resolve one field on a runtime object. Returns {value, typeName} where
// typeName is the __typename for further selection, or null for scalars.
function resolveField(ctx: Ctx, obj: RuntimeObject, field: FieldSelection): { value: unknown; typeName: string | null } {
  const { store } = ctx;
  const typeName = obj.__typename;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) args[k] = resolveValue(v, ctx.variables);

  // ---- Query
  if (typeName === 'Query') {
    if (field.name === 'viewer') return { value: userObject(store.viewerLogin ?? ''), typeName: 'User' };
    if (field.name === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return { value: repo ? repoObject(store, repo) : null, typeName: 'Repository' };
    }
    if (field.name === 'node') {
      const id = String(args.id ?? '');
      const decoded = decodeGid(id);
      if (!decoded) return { value: null, typeName: null };
      if (decoded.kind === 'repo') {
        const repo = findRepoByGid(store, id);
        return { value: repo ? repoObject(store, repo) : null, typeName: 'Repository' };
      }
      if (decoded.kind === 'issue') {
        const found = findIssueByGid(store, id);
        return { value: found ? issueObject(store, found.repo, found.issue) : null, typeName: 'Issue' };
      }
      if (decoded.kind === 'pr') {
        const found = findPrByGid(store, id);
        return { value: found ? prObject(store, found.repo, found.pr) : null, typeName: 'PullRequest' };
      }
      return { value: null, typeName: null };
    }
    if (field.name === '__type') {
      const def = SCHEMA[String(args.name ?? '')];
      return { value: def ? typeObject(def) : null, typeName: '__Type' };
    }
    if (field.name === '__schema') {
      return { value: { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } }, typeName: '__Schema' };
    }
  }

  // ---- Mutation
  if (typeName === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGid(store, String(input.repositoryId ?? ''));
      if (!repo) return { value: null, typeName: null };
      const issue: Issue = {
        id: store.nextId(),
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: store.nextSeq(),
        user: store.viewerLogin ?? '',
      };
      repo.issues.push(issue);
      return { value: { __typename: 'CreateIssuePayload', issue: issueObject(store, repo, issue) }, typeName: 'CreateIssuePayload' };
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGid(store, String(input.issueId ?? ''));
      if (!found) return { value: null, typeName: null };
      found.issue.state = 'closed';
      return { value: { __typename: 'CloseIssuePayload', issue: issueObject(store, found.repo, found.issue) }, typeName: 'CloseIssuePayload' };
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGid(store, String(input.repositoryId ?? ''));
      if (!repo) return { value: null, typeName: null };
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headTip = repo.refValue(`refs/heads/${head}`);
      const baseTip = repo.refValue(`refs/heads/${base}`);
      if (!headTip || !baseTip) return { value: null, typeName: null };
      const pr: PullRequest = {
        id: store.nextId(),
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        createdSeq: store.nextSeq(),
        user: store.viewerLogin ?? '',
      };
      repo.pulls.push(pr);
      return { value: { __typename: 'CreatePullRequestPayload', pullRequest: prObject(store, repo, pr) }, typeName: 'CreatePullRequestPayload' };
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPrByGid(store, String(input.pullRequestId ?? ''));
      if (!found) return { value: null, typeName: null };
      const { repo, pr } = found;
      const headTip = repo.refValue(`refs/heads/${pr.headRef}`);
      const baseTip = repo.refValue(`refs/heads/${pr.baseRef}`);
      if (headTip && baseTip && pr.state === 'open') {
        const method = String(input.mergeMethod ?? 'SQUASH');
        if (method === 'SQUASH') {
          const result = repo.squashTree(baseTip, headTip);
          if (!result.conflict && result.treeOid) {
            const viewer = store.viewerLogin ?? '';
            const message = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`;
            const commitOid = store.createCommit(repo, result.treeOid, [baseTip, headTip], message, viewer);
            repo.setRef(`refs/heads/${pr.baseRef}`, commitOid);
            pr.state = 'closed';
            pr.merged = true;
            pr.mergedAt = new Date(Date.UTC(2025, 0, 1) + store.nextSeq() * 1000).toISOString();
            pr.mergeCommitSha = commitOid;
          }
        }
      }
      return { value: { __typename: 'MergePullRequestPayload', pullRequest: prObject(store, repo, pr) }, typeName: 'MergePullRequestPayload' };
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGid(store, String(input.subjectId ?? ''));
      if (!found) return { value: null, typeName: null };
      const { repo, issue } = found;
      const comment = {
        id: store.nextId(),
        number: issue.comments.length + 1,
        body: String(input.body ?? ''),
        user: store.viewerLogin ?? '',
        createdSeq: store.nextSeq(),
      };
      issue.comments.push(comment);
      const node: RuntimeObject = {
        __typename: 'IssueComment',
        id: commentGid(repo, issue, comment.id),
        body: comment.body,
      };
      return {
        value: { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(comment.id) } },
        typeName: 'AddCommentPayload',
      };
    }
  }

  // ---- Repository
  if (typeName === 'Repository') {
    const repo = obj.__repo as Repo;
    if (field.name === 'owner') return { value: userObject(repo.owner), typeName: 'User' };
    if (field.name === 'defaultBranchRef') {
      const tip = repo.headOid();
      if (!tip) return { value: null, typeName: 'Ref' };
      return { value: { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: tip } }, typeName: 'Ref' };
    }
    if (field.name === 'issue') {
      const number = Number(args.number);
      const issue = repo.issues.find((i) => i.number === number);
      return { value: issue ? issueObject(store, repo, issue) : null, typeName: 'Issue' };
    }
    if (field.name === 'issues') {
      const states = (args.states as string[] | undefined) ?? null;
      const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? null;
      let list = [...repo.issues];
      if (states) {
        const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : 'closed')));
        list = list.filter((i) => wanted.has(i.state));
      }
      const desc = orderBy?.direction === 'DESC';
      list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
      const first = typeof args.first === 'number' ? args.first : list.length;
      const afterNum = typeof args.after === 'string' ? cursorNumber(args.after) : null;
      if (afterNum !== null) {
        list = list.filter((i) => (desc ? i.number < afterNum : i.number > afterNum));
      }
      const page = list.slice(0, first);
      const hasNextPage = list.length > page.length;
      const endCursor = page.length ? cursorFor(page[page.length - 1].number) : null;
      return {
        value: {
          __typename: 'IssueConnection',
          nodes: page.map((i) => issueObject(store, repo, i)),
          totalCount: repo.issues.length,
          pageInfo: pageInfoObject(hasNextPage, endCursor),
        },
        typeName: 'IssueConnection',
      };
    }
    if (field.name === 'pullRequest') {
      const number = Number(args.number);
      const pr = repo.pulls.find((p) => p.number === number);
      return { value: pr ? prObject(store, repo, pr) : null, typeName: 'PullRequest' };
    }
    if (field.name === 'pullRequests') {
      const states = (args.states as string[] | undefined) ?? null;
      let list = [...repo.pulls];
      if (states) {
        const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s === 'MERGED' ? 'merged' : s)));
        list = list.filter((p) => wanted.has(p.state) || (wanted.has('merged') && p.merged));
      }
      const first = typeof args.first === 'number' ? args.first : list.length;
      const afterNum = typeof args.after === 'string' ? cursorNumber(args.after) : null;
      if (afterNum !== null) list = list.filter((p) => p.number > afterNum);
      const page = list.slice(0, first);
      const hasNextPage = list.length > page.length;
      const endCursor = page.length ? cursorFor(page[page.length - 1].number) : null;
      return {
        value: {
          __typename: 'PullRequestConnection',
          nodes: page.map((p) => prObject(store, repo, p)),
          totalCount: repo.pulls.length,
          pageInfo: pageInfoObject(hasNextPage, endCursor),
        },
        typeName: 'PullRequestConnection',
      };
    }
  }

  // ---- PullRequest
  if (typeName === 'PullRequest') {
    const repo = obj.__repo as Repo;
    const pr = obj.__pr as PullRequest;
    if (field.name === 'files') {
      const headTip = repo.refValue(`refs/heads/${pr.headRef}`);
      const baseTip = repo.refValue(`refs/heads/${pr.baseRef}`);
      let nodes: RuntimeObject[] = [];
      if (headTip && baseTip) {
        const mergeBaseOid = repo.mergeBase(headTip, baseTip) ?? baseTip;
        const diff = repo.diffTrees(mergeBaseOid, headTip);
        nodes = diff.map((d) => ({
          __typename: 'PullRequestChangedFile',
          path: d.path,
          additions: d.status === 'removed' ? 0 : 1,
          deletions: d.status === 'added' ? 0 : 1,
          changeType: d.status.toUpperCase(),
        }));
      }
      const first = typeof args.first === 'number' ? args.first : nodes.length;
      const page = nodes.slice(0, first);
      return {
        value: {
          __typename: 'PullRequestChangedFileConnection',
          nodes: page,
          totalCount: nodes.length,
          pageInfo: pageInfoObject(nodes.length > page.length, null),
        },
        typeName: 'PullRequestChangedFileConnection',
      };
    }
    if (field.name === 'headRef') {
      const tip = repo.refValue(`refs/heads/${pr.headRef}`);
      return { value: tip ? { __typename: 'Ref', name: pr.headRef, target: { __typename: 'Commit', oid: tip } } : null, typeName: 'Ref' };
    }
    if (field.name === 'baseRef') {
      const tip = repo.refValue(`refs/heads/${pr.baseRef}`);
      return { value: tip ? { __typename: 'Ref', name: pr.baseRef, target: { __typename: 'Commit', oid: tip } } : null, typeName: 'Ref' };
    }
  }

  // ---- connections / introspection types: plain property access
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes' || field.name === 'edges' || field.name === 'pageInfo' || field.name === 'totalCount') {
      const value = (obj as Record<string, unknown>)[field.name];
      if (field.name === 'edges') {
        const nodes = (obj.nodes as RuntimeObject[]) ?? [];
        return { value: nodes.map((n) => ({ __typename: 'Edge', node: n, cursor: cursorFor(0) })), typeName: 'Edge' };
      }
      return { value: value ?? null, typeName: field.name === 'pageInfo' ? 'PageInfo' : null };
    }
  }
  if (typeName === '__Type') {
    const def = obj.__typeDef as TypeDef;
    if (field.name === 'fields' || field.name === 'enumValues') {
      const value = (obj as Record<string, unknown>)[field.name];
      return { value: value ?? null, typeName: field.name === 'fields' ? '__Field' : '__EnumValue' };
    }
  }
  if (typeName === 'Ref') {
    if (field.name === 'target') {
      const target = (obj as Record<string, unknown>).target as RuntimeObject | undefined;
      return { value: target ?? null, typeName: 'Commit' };
    }
  }

  // ---- plain scalar/object property access (id, number, title, ...)
  if (field.name in obj && obj[field.name] !== undefined) {
    const value = obj[field.name];
    if (value && typeof value === 'object' && !Array.isArray(value) && '__typename' in (value as Record<string, unknown>)) {
      return { value, typeName: (value as RuntimeObject).__typename };
    }
    return { value, typeName: null };
  }

  // unknown field
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
  return { value: null, typeName: null };
}

function resolveSelections(ctx: Ctx, obj: RuntimeObject, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === obj.__typename) {
        Object.assign(out, resolveSelections(ctx, obj, sel.selectionSet));
      }
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    const { value, typeName } = resolveField(ctx, obj, sel);
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) => {
        if (item && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          return resolveSelections(ctx, item as RuntimeObject, sel.selectionSet);
        }
        return item;
      });
      continue;
    }
    if (typeName && typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      out[responseKey] = resolveSelections(ctx, value as RuntimeObject, sel.selectionSet);
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { store, errors: [], variables: { ...variables } };
  for (const varDef of op.variables) {
    if (!(varDef.name in ctx.variables) && varDef.defaultValue) {
      ctx.variables[varDef.name] = resolveValue(varDef.defaultValue, ctx.variables);
    }
  }
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const root: RuntimeObject = { __typename: rootType };
  const data = resolveSelections(ctx, root, op.selectionSet);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export function handleGraphql(store: Store, body: unknown): HttpResult {
  let operations: { query: string; variables?: Record<string, unknown>; operationName?: string }[];
  if (Array.isArray(body)) {
    operations = body as typeof operations;
  } else if (body && typeof body === 'object') {
    operations = [body as (typeof operations)[number]];
  } else {
    return json(400, { errors: [{ message: 'GraphQL request body must be an object or array' }] });
  }
  const results: Record<string, unknown>[] = [];
  for (const item of operations) {
    const query = typeof item.query === 'string' ? item.query : '';
    const variables = (item.variables ?? {}) as Record<string, unknown>;
    let parsed: Operation[];
    try {
      parsed = new Parser(tokenize(query)).parseDocument();
    } catch (e) {
      results.push({ errors: [{ message: e instanceof Error ? e.message : 'GraphQL parse error' }] });
      continue;
    }
    if (parsed.length === 0) {
      results.push({ errors: [{ message: 'Empty GraphQL document' }] });
      continue;
    }
    // execute the named operation, or the first one
    let op = parsed[0];
    if (item.operationName) {
      const named = parsed.find((p) => p.name === item.operationName);
      if (named) op = named;
    }
    results.push(executeOperation(store, op, variables));
  }
  return json(200, Array.isArray(body) ? results : results[0]);
}
