// main.ts — entry point. Lifecycle (from the kit's starter contract):
// bind an ephemeral port, POST {"port": N} to $MAKEFUN_ENV_URL/register
// (200 or 409 wins; 400/405 are contract errors; anything else retries with
// exponential backoff 250ms -> 2000ms), then poll GET $MAKEFUN_ENV_URL/done
// until {"done": true}, close and exit 0. Boot budget is 20s; the env GETs
// /healthz twice within 10s.
// Without MAKEFUN_ENV_URL (local dev), serve standalone on $PORT (default
// 18080) instead of exiting.
import { Store } from './src/store.ts';
import { createApp } from './src/app.ts';

const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');
const store = new Store(token);
const app = createApp(store);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function sealedRun(): Promise<void> {
  const server = app;
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) {
    console.error('forge: could not bind a port');
    process.exit(1);
  }
  // register with backoff until the env accepts (200) or reports a first
  // registration already won (409).
  let delay = 250;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200 || res.status === 409) break;
      if (res.status === 400 || res.status === 405) {
        console.error(`forge: register rejected with ${res.status}`);
        process.exit(1);
      }
    } catch {
      // env not reachable yet; retry
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
  // poll until the trial is done
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`);
      if (res.ok) {
        const data = (await res.json()) as { done?: boolean };
        if (data.done === true) break;
      }
    } catch {
      // ignore transient failures
    }
    await sleep(500);
  }
  server.close(() => process.exit(0));
  // safety: exit even if a connection lingers
  setTimeout(() => process.exit(0), 2000).unref();
}

if (!envUrl) {
  const port = parseInt(process.env.PORT ?? '18080', 10);
  app.listen(port, () => {
    console.log(`forge listening on http://127.0.0.1:${port} (dev mode, no env)`);
  });
} else {
  sealedRun().catch((err) => {
    console.error('forge: fatal', err);
    process.exit(1);
  });
}
