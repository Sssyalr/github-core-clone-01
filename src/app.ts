// app.ts — HTTP server: routing, auth, request-id, body reading. Every
// response carries a non-empty X-GitHub-Request-Id; every REST reply is JSON.
import { createServer, type Server } from 'node:http';
import { Store } from './store.ts';
import { handleGit, type HttpResult } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export function createApp(store: Store): Server {
  let requestCounter = 0;
  const server = createServer(async (req, res) => {
    const requestId = `req-${++requestCounter}`;
    const send = (result: HttpResult): void => {
      try {
        res.writeHead(result.status, { ...result.headers, 'X-GitHub-Request-Id': requestId });
        res.end(result.body);
      } catch {
        // client went away; nothing to do
      }
    };
    const sendJson = (status: number, value: unknown, extra: Record<string, string> = {}): void => {
      send({
        status,
        headers: { 'Content-Type': 'application/json', ...extra },
        body: Buffer.from(JSON.stringify(value), 'utf8'),
      });
    };
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const segments = url.pathname.split('/').filter(Boolean);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      const authHeader = req.headers.authorization ?? '';
      const authed = store.token !== '' && authHeader === `Bearer ${store.token}`;

      // health probe (no auth)
      if (url.pathname === '/healthz') {
        sendJson(200, { ok: true });
        return;
      }

      // git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(url.pathname);
      if (gitMatch) {
        if (!authed) {
          sendJson(401, { message: 'Bad credentials' });
          return;
        }
        send(handleGit(store, gitMatch[1], gitMatch[2], gitMatch[3], req.method ?? 'GET', url.searchParams, body));
        return;
      }

      // MCP: /mcp
      if (url.pathname === '/mcp') {
        if (!authed) {
          sendJson(401, { message: 'Bad credentials' });
          return;
        }
        send(handleMcp(store, req.method ?? 'POST', body));
        return;
      }

      // GraphQL: /api/graphql
      if (url.pathname === '/api/graphql') {
        if (!authed) {
          sendJson(401, { message: 'Bad credentials' });
          return;
        }
        let parsed: unknown = null;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(400, { message: 'Bad Request' });
            return;
          }
        }
        send(handleGraphql(store, parsed));
        return;
      }

      // REST v3: /api/v3/...
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const restSegments = segments.slice(2);
        const isRootOrMeta =
          restSegments.length === 0 || (restSegments.length === 1 && restSegments[0] === 'meta');
        if (!authed && !isRootOrMeta) {
          sendJson(401, { message: 'Bad credentials' });
          return;
        }
        let parsed: unknown = null;
        const method = req.method ?? 'GET';
        if (body.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(400, { message: 'Bad Request' });
            return;
          }
        }
        const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
        send(handleRest(store, method, restSegments, url.searchParams, parsed, baseUrl));
        return;
      }

      sendJson(404, { message: 'Not Found' });
    } catch {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      } catch {
        // ignore
      }
    }
  });
  return server;
}
