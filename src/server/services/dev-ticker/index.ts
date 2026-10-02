import 'server-only';
import type { Env } from '@/server/env';
import type { Deps } from '@/server/ports';
import { runPollCron, type PollCronOptions } from '@/server/services/intake/poll-cron';
import { createDevTicker, type DevTicker, type DevTickerOptions, type DevTickerScheduler } from './ticker';

// The dev job ticker's wiring hook (PLAN §4): the fake-mode container calls
// startDevTickerIfEnabled once it has built the Deps, and stops the ticker in close(). It starts
// only in fake mode, and never under a test runner or `next build`. One ticker per process: the
// running one lives on globalThis, so a hot reload that rebuilds the container (or re-evaluates this
// module) replaces it instead of adding a second interval.

export { createDevTicker, DEV_POLL_EVERY_MS, DEV_TICK_INTERVAL_MS } from './ticker';
export type { DevTicker, DevTickerOptions, DevTickerScheduler, DevTickerTimers, DevTickResult } from './ticker';

type TickerGlobal = typeof globalThis & { __autopilotDevTicker?: DevTicker | undefined };

const store = globalThis as TickerGlobal;

/** The process's running ticker, if any. */
export function currentDevTicker(): DevTicker | null {
  return store.__autopilotDevTicker ?? null;
}

/** Starts a ticker as the process's only one, stopping any previous ticker first. */
export function startDevTicker(options: DevTickerOptions): DevTicker {
  const previous = store.__autopilotDevTicker;
  if (previous !== undefined) void previous.stop();
  const ticker = createDevTicker(options);
  store.__autopilotDevTicker = ticker;
  ticker.start();
  return ticker;
}

/**
 * Stops `ticker` (default: the process's current one), e.g. from the container's close(). A newer
 * ticker that replaced it stays running.
 */
export async function stopDevTicker(ticker: DevTicker | null = currentDevTicker()): Promise<void> {
  if (ticker === null) return;
  if (store.__autopilotDevTicker === ticker) store.__autopilotDevTicker = undefined;
  await ticker.stop();
}

type ProcessEnv = Readonly<Record<string, string | undefined>>;

/** Fake mode only; never under Vitest (NODE_ENV=test or VITEST) or during `next build`. */
export function devTickerEnabled(env: Pick<Env, 'APP_MODE'>, processEnv: ProcessEnv = process.env): boolean {
  if (env.APP_MODE !== 'fake') return false;
  if (processEnv.NODE_ENV === 'test' || processEnv.VITEST !== undefined) return false;
  return processEnv.NEXT_PHASE !== 'phase-production-build';
}

export interface DevTickerHookInput {
  env: Pick<Env, 'APP_MODE'>;
  deps: Deps;
  /** The FakeScheduler (its dispatch callback is the jobs bridge). */
  scheduler: DevTickerScheduler;
  /** The job sweeper, as the poll cron route passes it (`(deps) => runSweeper(deps)`). */
  sweep: PollCronOptions['sweep'];
  /** The retention guard, as the poll cron route passes it (`runRetentionGuard`). */
  retentionGuard: PollCronOptions['retentionGuard'];
  /** Defaults to process.env. */
  processEnv?: ProcessEnv | undefined;
}

/** The container's hook: the ticker when it should run here, else null (nothing started). */
export function startDevTickerIfEnabled(input: DevTickerHookInput): DevTicker | null {
  if (!devTickerEnabled(input.env, input.processEnv)) return null;
  return startDevTicker({
    deps: input.deps,
    scheduler: input.scheduler,
    pollCron: (deps) => runPollCron(deps, { sweep: input.sweep, retentionGuard: input.retentionGuard }),
  });
}
