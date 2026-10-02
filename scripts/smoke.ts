// Build-and-smoke gate (PLAN §15 step 4): starts the already-built app with `next start` and checks
// that the public placeholder routes answer 200. Run `APP_MODE=fake npm run build` first.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { freePort, get, HOST, ROOT, startServer, stopServer, waitUntilReady } from './next-server';

const PATHS = ['/api/health', '/', '/login'] as const;

interface CheckResult {
  path: string;
  ok: boolean;
  detail: string;
}

async function check(baseUrl: string, path: string): Promise<CheckResult> {
  try {
    const res = await get(`${baseUrl}${path}`);
    if (res.status !== 200) {
      await res.body?.cancel();
      return { path, ok: false, detail: `status ${res.status}` };
    }
    if (path === '/api/health') {
      const body: unknown = await res.json();
      const ok = typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;
      const mode = typeof body === 'object' && body !== null ? (body as { mode?: unknown }).mode : undefined;
      return { path, ok, detail: ok ? `200 mode=${String(mode)}` : '200 but body.ok !== true' };
    }
    await res.body?.cancel();
    return { path, ok: true, detail: '200' };
  } catch (err) {
    return { path, ok: false, detail: err instanceof Error ? err.name : 'request failed' };
  }
}

async function main(): Promise<number> {
  if (!existsSync(join(ROOT, '.next', 'BUILD_ID'))) {
    console.error('smoke: no production build found. Run `APP_MODE=fake npm run build` first.');
    return 1;
  }
  if (process.env.APP_MODE !== 'fake') {
    console.warn(`smoke: APP_MODE is ${process.env.APP_MODE ?? 'unset'}; the gate expects APP_MODE=fake.`);
  }

  const port = await freePort();
  const baseUrl = `http://${HOST}:${port}`;
  const server = startServer(port);
  const { output } = server;

  try {
    await waitUntilReady(baseUrl, server);
    const results: CheckResult[] = [];
    for (const path of PATHS) {
      results.push(await check(baseUrl, path));
    }
    for (const r of results) {
      console.log(`smoke: ${r.ok ? 'PASS' : 'FAIL'} GET ${r.path} (${r.detail})`);
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.error(`smoke: ${failed.length} check(s) failed. Server output:\n${output.join('')}`);
      return 1;
    }
    console.log(`smoke: all ${results.length} checks passed on ${baseUrl}`);
    return 0;
  } catch (err) {
    console.error(`smoke: ${err instanceof Error ? err.message : 'failed'}. Server output:\n${output.join('')}`);
    return 1;
  } finally {
    await stopServer(server);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error('smoke: unexpected failure', err);
    process.exitCode = 1;
  },
);
