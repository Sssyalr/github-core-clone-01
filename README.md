# GitHub Core Clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Sssyalr/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Sssyalr/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process — built for the
[make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).

## What it serves

One process, one in-memory store, four surfaces on the same base URL:

- **Git smart HTTP** — protocol v2 `git-upload-pack` (`ls-refs`, `fetch` with
  shallow/deepen, thin-pack, ofs-delta) and protocol v0 `git-receive-pack`
  (create/update/delete with fast-forward checks, `report-status`,
  `side-band-64k`). Packs are built and parsed in-process; no git binary.
- **REST v3** (`/api/v3`) — repositories, branches, commits, refs, contents
  (create/update/delete with sha checks and branch creation), labels, issues,
  comments, and pull requests with squash merge and conflict detection.
- **GraphQL** (`/api/graphql`) — the repository/issue/pull-request queries and
  mutations `gh` and `github-mcp-server` send, plus `__type` introspection,
  `node(id:)`, cursor pagination, and global ids.
- **MCP** (`/mcp`) — JSON-RPC 2.0 Streamable HTTP, era `2026-07-28`
  (`server/discover`, `initialize`, `tools/list`, `tools/call`) with six
  tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

Without `MAKEFUN_ENV_URL` it serves standalone on `$PORT` (default 18080).
With `MAKEFUN_ENV_URL` set it follows the sealed lifecycle: bind an ephemeral
port, register with the env, serve until the env reports done, then exit.

Node >= 22.18, no dependencies, no install step.

## Layout

- `main.ts` — entry point and env lifecycle.
- `src/app.ts` — HTTP server, routing, auth, request-id.
- `src/store.ts` — in-memory store: repos, objects, refs, issues, PRs,
  tree manipulation, three-way squash merge.
- `src/util.ts` — SHA-1 object ids, pkt-line codec, pack read/write.
- `src/git.ts` — smart HTTP handlers.
- `src/rest.ts` — REST v3 handlers.
- `src/graphql.ts` — GraphQL parser and executor.
- `src/mcp.ts` — MCP endpoint and tools.
