import 'server-only';
import type { FakeAdapters } from '@/server/adapters/fake';
import { getContainer } from '@/server/container';
import { getEnv, type Env } from '@/server/env';

// The /dev routes exist only in fake mode (PLAN §7.6, D-29): everywhere else they answer 404, as if
// they were not there. The layout guards the pages; every route handler checks again, because
// layouts do not wrap route handlers (and a layout check alone is not a guard for its pages).

/** What a /dev route works with: the environment and the fakes behind fake mode's Deps. */
export interface DevContext {
  readonly env: Env;
  readonly fakes: FakeAdapters;
}

/** True only in fake mode. An environment that does not parse counts as "not fake" (fail closed). */
export function devToolsEnabled(): boolean {
  try {
    return getEnv().APP_MODE === 'fake';
  } catch {
    return false;
  }
}

/** The dev context in fake mode; null otherwise (never builds the live container). */
export async function getDevContext(): Promise<DevContext | null> {
  if (!devToolsEnabled()) return null;
  const container = await getContainer();
  if (container.mode !== 'fake' || container.fakes === null) return null;
  return { env: container.deps.env, fakes: container.fakes };
}

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } as const;

/** The answer of every /dev route outside fake mode. */
export function devNotFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE } });
}

export function devPlainResponse(status: number, body: string, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE, ...headers } });
}
