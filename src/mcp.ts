// mcp.ts — MCP Streamable HTTP: JSON-RPC 2.0 over POST /mcp, plain
// application/json answers. Modern era 2026-07-28 (server/discover) plus the
// legacy initialize fallback. No sessions, no handshake.
import type { Store } from './store.ts';
import type { HttpResult } from './git.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

function json(status: number, value: unknown): HttpResult {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): HttpResult {
  return json(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): HttpResult {
  return json(200, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(obj: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function missingArg(name: string): Record<string, unknown> {
  return toolError(`missing required argument: ${name}`);
}

export function handleMcp(store: Store, method: string, body: Buffer): HttpResult {
  if (method === 'DELETE') {
    return { status: 204, headers: { 'Content-Type': 'application/json' }, body: Buffer.alloc(0) };
  }
  if (method !== 'POST') {
    return json(405, { message: 'Method Not Allowed' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const req = parsed as Record<string, unknown>;
  const id = 'id' in req ? req.id : undefined;
  const reqMethod = typeof req.method === 'string' ? req.method : '';
  // Notifications (no id) get a 202 with no body.
  if (id === undefined) {
    return { status: 202, headers: { 'Content-Type': 'application/json' }, body: Buffer.alloc(0) };
  }
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

  if (reqMethod === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: ['2026-07-28', '2025-06-18', '2025-03-26'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (reqMethod === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo,
    });
  }
  if (reqMethod === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (reqMethod === 'tools/call') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return rpcResult(id, missingArg(required));
      }
    }
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const viewer = store.viewerLogin ?? '';

    if (name === 'create_repo') {
      const repoName = str(args.name);
      if (store.getRepo(viewer, repoName)) return rpcResult(id, toolError(`Repository already exists: ${repoName}`));
      const repo = store.createRepo(repoName, str(args.description), args.private === true);
      return rpcResult(id, toolResult({
        id: repo.id,
        name: repo.name,
        full_name: repo.fullName,
        owner: { login: repo.owner },
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
      }));
    }
    if (name === 'get_repo') {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (!repo) return rpcResult(id, toolError(`Repository not found: ${args.owner}/${args.repo}`));
      return rpcResult(id, toolResult({
        id: repo.id,
        name: repo.name,
        full_name: repo.fullName,
        owner: { login: repo.owner },
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
      }));
    }
    if (name === 'create_issue') {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (!repo) return rpcResult(id, toolError(`Repository not found: ${args.owner}/${args.repo}`));
      const issue = {
        id: store.nextId(),
        number: repo.nextNumber++,
        title: str(args.title),
        body: str(args.body),
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: store.nextSeq(),
        user: viewer,
      };
      repo.issues.push(issue);
      return rpcResult(id, toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
      }));
    }
    if (name === 'list_issues') {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (!repo) return rpcResult(id, toolError(`Repository not found: ${args.owner}/${args.repo}`));
      const state = str(args.state) || 'open';
      const list = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels }));
      return rpcResult(id, toolResult(list));
    }
    if (name === 'create_pull_request') {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (!repo) return rpcResult(id, toolError(`Repository not found: ${args.owner}/${args.repo}`));
      const head = str(args.head);
      const base = str(args.base);
      const headTip = repo.refValue(`refs/heads/${head}`);
      const baseTip = repo.refValue(`refs/heads/${base}`);
      if (!headTip || !baseTip) return rpcResult(id, toolError(`Branch not found: ${!headTip ? head : base}`));
      const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (dup) return rpcResult(id, toolError('A pull request already exists for these branches'));
      const pr = {
        id: store.nextId(),
        number: repo.nextNumber++,
        title: str(args.title),
        body: str(args.body),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        createdSeq: store.nextSeq(),
        user: viewer,
      };
      repo.pulls.push(pr);
      return rpcResult(id, toolResult({
        id: pr.id,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        head: { ref: head, sha: headTip },
        base: { ref: base, sha: baseTip },
      }));
    }
    if (name === 'merge_pull_request') {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (!repo) return rpcResult(id, toolError(`Repository not found: ${args.owner}/${args.repo}`));
      const number = Number(args.pull_number);
      const pr = repo.pulls.find((p) => p.number === number);
      if (!pr) return rpcResult(id, toolError(`Pull request not found: #${args.pull_number}`));
      if (pr.state !== 'open') return rpcResult(id, toolError('Pull request is not open'));
      const headTip = repo.refValue(`refs/heads/${pr.headRef}`);
      const baseTip = repo.refValue(`refs/heads/${pr.baseRef}`);
      if (!headTip || !baseTip) return rpcResult(id, toolError('Branch not found'));
      const result = repo.squashTree(baseTip, headTip);
      if (result.conflict || !result.treeOid) return rpcResult(id, toolError('Merge conflict'));
      const message = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`;
      const commitOid = store.createCommit(repo, result.treeOid, [baseTip, headTip], message, viewer);
      repo.setRef(`refs/heads/${pr.baseRef}`, commitOid);
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = new Date(Date.UTC(2025, 0, 1) + store.nextSeq() * 1000).toISOString();
      pr.mergeCommitSha = commitOid;
      return rpcResult(id, toolResult({ merged: true, number: pr.number, sha: commitOid, message: `Pull request #${pr.number} merged` }));
    }
    return rpcError(id, -32602, `Unknown tool: ${name}`);
  }
  return rpcError(id, -32601, `Method not found: ${reqMethod}`);
}
