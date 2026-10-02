import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';

// The dev job ticker (PLAN §4 "a dev job ticker runs due fake jobs every 10 s"; fake mode only).
// Every 10 s of wall time it delivers the FakeScheduler's due jobs at `clock.now()` (the DevClock,
// so an advanced fake clock makes later jobs due), through the scheduler's dispatch callback, which
// the container wires to the jobs bridge (the same dispatcher /api/jobs/run uses). It also runs
// the poll cron's logic (processing states, polls, sweeper, retention guard) once per 5-minute slot
// of fake-clock time, like the `*/5` cron: once at the first tick, then whenever the fake clock has
// entered a new slot (advancing the clock by an hour polls once, not twelve times).
// Ticks never overlap: a tick that is still running when the next one is due is shared. A failing
// step is logged (codes only) and the ticker keeps going. Services never import adapters, so the
// scheduler and the poll cron are handed in.

export const DEV_TICK_INTERVAL_MS = 10_000;
export const DEV_POLL_EVERY_MS = 5 * 60 * 1000;

/** What the ticker needs from the FakeScheduler. */
export interface DevTickerScheduler {
  runDue(now: Date): Promise<number>;
}

/** The interval timer (real timers by default; tests inject their own). */
export interface DevTickerTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface DevTickerOptions {
  /** `deps.clock` is the fake clock the due check and the poll slots use. */
  deps: Deps;
  scheduler: DevTickerScheduler;
  /** The poll cron's logic, e.g. `(deps) => runPollCron(deps, { sweep, retentionGuard })`. */
  pollCron: (deps: Deps) => Promise<unknown>;
  intervalMs?: number | undefined;
  pollEveryMs?: number | undefined;
  timers?: DevTickerTimers | undefined;
}

export interface DevTickResult {
  /** Handler invocations the scheduler made. */
  readonly delivered: number;
  /** The poll cron ran in this tick. */
  readonly polled: boolean;
}

export interface DevTicker {
  /** Starts the interval (idempotent). */
  start(): void;
  /** One tick now; while a tick runs, returns that tick. */
  tick(): Promise<DevTickResult>;
  /** Clears the interval and waits for a running tick. */
  stop(): Promise<void>;
  readonly started: boolean;
}

const realTimers: DevTickerTimers = {
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    // Never keeps a process alive on its own (a build or a script that touched the container).
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createDevTicker(options: DevTickerOptions): DevTicker {
  const { deps, scheduler, pollCron } = options;
  const intervalMs = options.intervalMs ?? DEV_TICK_INTERVAL_MS;
  const pollEveryMs = options.pollEveryMs ?? DEV_POLL_EVERY_MS;
  const timers = options.timers ?? realTimers;
  let handle: unknown = null;
  let current: Promise<DevTickResult> | null = null;
  let lastPollSlot: number | null = null;

  async function runTick(): Promise<DevTickResult> {
    let delivered = 0;
    try {
      delivered = await scheduler.runDue(deps.clock.now());
    } catch (error) {
      log.warn('dev ticker could not run due jobs', { event: 'dev_ticker.run_due_failed', code: errorCode(error) });
    }
    let polled = false;
    const slot = Math.floor(deps.clock.now().getTime() / pollEveryMs);
    if (slot !== lastPollSlot) {
      lastPollSlot = slot;
      try {
        await pollCron(deps);
        polled = true;
      } catch (error) {
        log.warn('dev ticker poll failed', { event: 'dev_ticker.poll_failed', code: errorCode(error) });
      }
    }
    return { delivered, polled };
  }

  function tick(): Promise<DevTickResult> {
    if (current !== null) return current;
    const running = runTick().finally(() => {
      if (current === running) current = null;
    });
    current = running;
    return running;
  }

  return {
    start() {
      if (handle !== null) return;
      handle = timers.setInterval(() => void tick(), intervalMs);
    },
    tick,
    async stop() {
      if (handle !== null) timers.clearInterval(handle);
      handle = null;
      if (current !== null) await current.catch(() => undefined);
    },
    get started() {
      return handle !== null;
    },
  };
}
