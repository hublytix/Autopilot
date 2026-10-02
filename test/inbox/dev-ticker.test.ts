import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJobRegistry, insertJob, JobOutcomes, publishJobs } from '@/server/jobs';
import { createJobTestRig, seedAccount, type JobTestRig } from '@/server/jobs/testing';
import type { Deps } from '@/server/ports';
import {
  createDevTicker,
  currentDevTicker,
  DEV_TICK_INTERVAL_MS,
  devTickerEnabled,
  startDevTicker,
  startDevTickerIfEnabled,
  stopDevTicker,
  type DevTickerTimers,
} from '@/server/services/dev-ticker';
import { useTestDb as setUpTestDb } from '../db/harness';

// The dev job ticker (PLAN §4, fake mode only): every 10 s of wall time it delivers the
// FakeScheduler's due jobs at the fake clock's now (through the jobs bridge), and runs the poll
// cron once per 5-minute slot of fake-clock time. Wall time is a captured interval callback here.

const getDb = setUpTestDb();

let rig: JobTestRig;
let delivered: string[];
let polls: Date[];
let timers: DevTickerTimers & { callback: (() => void) | null; ms: number | null; cleared: number };

beforeEach(async () => {
  delivered = [];
  polls = [];
  const registry = createJobRegistry();
  registry.register('portal_poll', async (_deps, job) => {
    delivered.push(job.dedupeKey);
    return JobOutcomes.done();
  });
  rig = createJobTestRig(getDb(), registry);
  timers = {
    callback: null,
    ms: null,
    cleared: 0,
    setInterval(callback, ms) {
      timers.callback = callback;
      timers.ms = ms;
      return 1;
    },
    clearInterval() {
      timers.cleared += 1;
    },
  };
});

afterEach(async () => {
  await stopDevTicker();
});

async function scheduleJob(key: string, runAt: Date): Promise<void> {
  const accountId = await seedAccount(getDb(), { now: rig.clock.now() });
  const job = await getDb().tx((tx) =>
    insertJob(tx, { kind: 'portal_poll', accountId, dedupeKey: key, runAt, now: rig.clock.now() }),
  );
  await publishJobs(rig.deps, [job]);
}

function ticker() {
  return createDevTicker({
    deps: rig.deps,
    scheduler: rig.fakes.scheduler,
    pollCron: async (deps: Deps) => {
      polls.push(deps.clock.now());
    },
    timers,
  });
}

/** One interval firing, waited for. */
async function fire(t: ReturnType<typeof ticker>) {
  if (timers.callback === null) throw new Error('not started');
  timers.callback();
  return t.tick();
}

describe('dev job ticker', () => {
  it('runs the jobs that are due on the fake clock every 10 s of wall time', async () => {
    const start = rig.clock.now();
    await scheduleJob('poll:acct:a', new Date(start.getTime() + 30_000));
    const t = ticker();
    t.start();
    expect(timers.ms).toBe(DEV_TICK_INTERVAL_MS);
    expect(DEV_TICK_INTERVAL_MS).toBe(10_000);

    expect(await fire(t)).toEqual({ delivered: 0, polled: true });
    expect(delivered).toEqual([]);

    rig.clock.advance(30_000);
    expect(await fire(t)).toEqual({ delivered: 1, polled: false });
    expect(delivered).toEqual(['poll:acct:a']);
    expect(await getDb().one(`select status from scheduled_jobs where dedupe_key = 'poll:acct:a'`)).toEqual({ status: 'done' });

    await t.stop();
    expect(timers.cleared).toBe(1);
    expect(t.started).toBe(false);
  });

  it('runs the poll cron once per 5-minute slot of fake-clock time', async () => {
    rig.clock.set(new Date('2026-10-06T14:00:00.000Z'));
    const t = ticker();
    t.start();
    await fire(t);
    rig.clock.set(new Date('2026-10-06T14:04:59.000Z'));
    await fire(t);
    rig.clock.set(new Date('2026-10-06T14:05:00.000Z'));
    await fire(t);
    // A clock advanced by an hour polls once, not twelve times.
    rig.clock.set(new Date('2026-10-06T15:07:00.000Z'));
    await fire(t);
    await fire(t);
    expect(polls.map((d) => d.toISOString())).toEqual(['2026-10-06T14:00:00.000Z', '2026-10-06T14:05:00.000Z', '2026-10-06T15:07:00.000Z']);
  });

  it('never runs two ticks at once and keeps going after a failing step', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const t = createDevTicker({
      deps: rig.deps,
      scheduler: {
        runDue: async () => {
          calls += 1;
          if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
          if (calls === 2) throw new Error('boom');
          return 0;
        },
      },
      pollCron: async () => {
        throw new Error('poll failed');
      },
      timers,
    });
    const first = t.tick();
    const overlapping = t.tick();
    expect(overlapping).toBe(first);
    release();
    expect(await first).toEqual({ delivered: 0, polled: false });
    expect(await t.tick()).toEqual({ delivered: 0, polled: false });
    expect(calls).toBe(2);
  });

  it('keeps one ticker per process: starting another stops the previous one', async () => {
    const options = { deps: rig.deps, scheduler: rig.fakes.scheduler, pollCron: async () => undefined, timers };
    const first = startDevTicker(options);
    const second = startDevTicker(options);
    expect(currentDevTicker()).toBe(second);
    expect(first.started).toBe(false);
    expect(second.started).toBe(true);
    await stopDevTicker(first);
    expect(currentDevTicker()).toBe(second);
    await stopDevTicker();
    expect(currentDevTicker()).toBeNull();
    expect(second.started).toBe(false);
  });

  it('starts only in fake mode, never under a test runner, live mode or next build', () => {
    expect(devTickerEnabled({ APP_MODE: 'fake' }, {})).toBe(true);
    expect(devTickerEnabled({ APP_MODE: 'fake' }, { NODE_ENV: 'development' })).toBe(true);
    expect(devTickerEnabled({ APP_MODE: 'live' }, {})).toBe(false);
    expect(devTickerEnabled({ APP_MODE: 'fake' }, { NODE_ENV: 'test' })).toBe(false);
    expect(devTickerEnabled({ APP_MODE: 'fake' }, { VITEST: 'true' })).toBe(false);
    expect(devTickerEnabled({ APP_MODE: 'fake' }, { NEXT_PHASE: 'phase-production-build' })).toBe(false);
    const started = startDevTickerIfEnabled({
      env: rig.deps.env,
      deps: rig.deps,
      scheduler: rig.fakes.scheduler,
      sweep: async () => {
        throw new Error('not called');
      },
      retentionGuard: async () => ({}),
    });
    expect(started).toBeNull();
    expect(currentDevTicker()).toBeNull();
  });
});
