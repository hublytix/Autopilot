// Build-and-smoke gate (PLAN §15 step 4): starts the already-built app with `next start` and checks
// that the public placeholder routes answer 200. Run `APP_MODE=fake npm run build` first.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = process.cwd();
const HOST = '127.0.0.1';
const POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const PATHS = ['/api/health', '/', '/login'] as const;

interface CheckResult {
  path: string;
  ok: boolean;
  detail: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function startServer(port: number, output: string[]): ChildProcess {
  const nextBin = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [nextBin, 'start', '--hostname', HOST, '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so the whole tree can be stopped at the end.
    detached: true,
  });
  const keep = (chunk: Buffer): void => {
    output.push(chunk.toString('utf8'));
    if (output.length > 200) output.shift();
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  return child;
}

function signalServer(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function stopServer(child: ChildProcess): void {
  signalServer(child, 'SIGTERM');
  // Escalate if the server ignores SIGTERM; unref'd so a clean exit isn't delayed.
  setTimeout(() => signalServer(child, 'SIGKILL'), 5_000).unref();
}

async function get(url: string): Promise<Response> {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function waitUntilReady(baseUrl: string, child: ChildProcess): Promise<void> {
  const attempts = Math.ceil(READY_TIMEOUT_MS / POLL_INTERVAL_MS);
  for (let i = 0; i < attempts; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited early with code ${child.exitCode}`);
    }
    try {
      const res = await get(`${baseUrl}/api/health`);
      await res.body?.cancel();
      if (res.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`server not ready within ${READY_TIMEOUT_MS / 1000} s`);
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
  const output: string[] = [];
  const child = startServer(port, output);

  try {
    await waitUntilReady(baseUrl, child);
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
    stopServer(child);
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
