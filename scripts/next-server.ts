// `next start` for the smoke gate and the fake-mode end-to-end run: a free loopback port, the
// server in its own process group, readiness through /api/health, and a clean stop.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const ROOT = process.cwd();
export const HOST = '127.0.0.1';
const POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 5_000;

export function freePort(): Promise<number> {
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

export interface NextServer {
  readonly child: ChildProcess;
  /** The last chunks of stdout/stderr, for a failure report. */
  readonly output: string[];
}

/** `next start` on HOST:port with `env` (default: this process's environment). */
export function startServer(port: number, env: NodeJS.ProcessEnv = process.env): NextServer {
  const output: string[] = [];
  const nextBin = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [nextBin, 'start', '--hostname', HOST, '--port', String(port)], {
    cwd: ROOT,
    env: { ...env, PORT: String(port) },
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
  return { child, output };
}

function signalServer(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** SIGTERM, then SIGKILL after a grace period; resolves when the process has exited. */
export async function stopServer(server: NextServer): Promise<void> {
  const { child } = server;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  signalServer(child, 'SIGTERM');
  const escalate = setTimeout(() => signalServer(child, 'SIGKILL'), STOP_GRACE_MS);
  escalate.unref();
  await exited;
  clearTimeout(escalate);
}

export async function get(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init });
}

export async function waitUntilReady(baseUrl: string, server: NextServer): Promise<void> {
  const attempts = Math.ceil(READY_TIMEOUT_MS / POLL_INTERVAL_MS);
  for (let i = 0; i < attempts; i += 1) {
    if (server.child.exitCode !== null) {
      throw new Error(`next start exited early with code ${server.child.exitCode}`);
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
