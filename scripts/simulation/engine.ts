// The simulation's time-travel engine (PLAN §13, D-39). `advanceTo(t)` moves the FakeClock forward
// to `t`, stopping at every instant something happens, in time order:
//   1. external events (a form submission, a webhook, an owner action) scheduled with `at()`;
//   2. jobs the FakeScheduler holds that are due (delivered to runJob through the scheduler bridge,
//      exactly as QStash would call /api/jobs/run, with its retries and the failure callback);
//   3. cron ticks (the poll every 5 minutes, the hourly due-check, the daily run at 03:17 UTC).
// At the same instant the order is events, then jobs, then ticks ("events precede ticks"): a
// webhook's own `portal_poll` job therefore runs before the cron poll of the same minute.
import type { FakeClock } from '@/server/adapters/fake/clock';
import type { FakeScheduler } from '@/server/adapters/fake/scheduler';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A periodic trigger (PLAN §8.1, UTC). */
export interface CronSeries {
  /** Timeline name, e.g. `cron.poll`. */
  readonly name: string;
  /** The first instant strictly after `afterMs` at which it fires. */
  next(afterMs: number): number;
  /** Runs one tick at the current simulated time. */
  run(): Promise<void>;
}

/** `*\/n * * * *` style: every `periodMs`, aligned to the epoch (UTC), offset by `offsetMs`. */
export function everyUtc(periodMs: number, offsetMs = 0): (afterMs: number) => number {
  return (afterMs) => Math.floor((afterMs - offsetMs) / periodMs) * periodMs + offsetMs + periodMs;
}

/** PLAN §8.1: `*\/5 * * * *`. */
export const EVERY_5_MINUTES = everyUtc(5 * MINUTE_MS);
/** PLAN §8.1: `0 * * * *`. */
export const HOURLY = everyUtc(HOUR_MS);
/** PLAN §8.1: `17 3 * * *` (UTC). */
export const DAILY_0317_UTC = everyUtc(DAY_MS, 3 * HOUR_MS + 17 * MINUTE_MS);

interface PendingEvent {
  atMs: number;
  seq: number;
  name: string;
  run: () => Promise<void>;
}

export interface TimeTravelOptions {
  clock: FakeClock;
  scheduler: FakeScheduler;
  crons: readonly CronSeries[];
  /** Called after every event, job batch and tick (the run notes new leads here). */
  afterStep?: (() => Promise<void>) | undefined;
}

type Next = { type: 'event'; atMs: number } | { type: 'jobs'; atMs: number } | { type: 'tick'; atMs: number; series: CronSeries[] };

/** Priority at the same instant: events, then jobs, then ticks. */
const PRIORITY: Readonly<Record<Next['type'], number>> = { event: 0, jobs: 1, tick: 2 };

/** Upper bound on steps in one advanceTo, so a job that re-publishes itself forever stops the run. */
const MAX_STEPS = 200_000;

export class TimeTravel {
  readonly #clock: FakeClock;
  readonly #scheduler: FakeScheduler;
  readonly #crons: readonly CronSeries[];
  readonly #afterStep: () => Promise<void>;
  readonly #events: PendingEvent[] = [];
  #seq = 0;
  /** Ticks strictly after this instant are still to run (a tick at the start instant counts). */
  #lastTickMs: number;

  constructor(options: TimeTravelOptions) {
    this.#clock = options.clock;
    this.#scheduler = options.scheduler;
    this.#crons = options.crons;
    this.#afterStep = options.afterStep ?? (async () => undefined);
    this.#lastTickMs = options.clock.nowMs() - 1;
  }

  /** Schedules an external event; events at the same instant run in the order they were added. */
  at(time: Date, name: string, run: () => Promise<void>): void {
    const atMs = time.getTime();
    if (!Number.isFinite(atMs) || atMs < this.#clock.nowMs()) throw new RangeError(`simulation: event ${name} is in the past`);
    const event: PendingEvent = { atMs, seq: ++this.#seq, name, run };
    const index = this.#events.findIndex((e) => e.atMs > atMs);
    if (index < 0) this.#events.push(event);
    else this.#events.splice(index, 0, event);
  }

  /** Events not yet run. */
  get pendingEvents(): readonly string[] {
    return this.#events.map((event) => event.name);
  }

  /** Runs everything due up to and including `target`, then leaves the clock at `target`. */
  async advanceTo(target: Date): Promise<void> {
    const targetMs = target.getTime();
    if (!Number.isFinite(targetMs) || targetMs < this.#clock.nowMs()) throw new RangeError('simulation: cannot travel backwards');
    for (let steps = 0; ; steps += 1) {
      if (steps > MAX_STEPS) throw new Error('simulation: too many steps in one advanceTo');
      const next = this.#next(targetMs);
      if (next === null) break;
      // A handler may have moved the clock on (a limiter sleep): late work runs now, never in the past.
      if (next.atMs > this.#clock.nowMs()) this.#clock.set(new Date(next.atMs));
      if (next.type === 'event') {
        const event = this.#events.shift();
        if (event !== undefined) await event.run();
      } else if (next.type === 'jobs') {
        await this.#scheduler.runDue(this.#clock.now());
      } else {
        this.#lastTickMs = next.atMs;
        for (const series of next.series) await series.run();
      }
      await this.#afterStep();
    }
    if (targetMs > this.#clock.nowMs()) this.#clock.set(target);
  }

  #next(targetMs: number): Next | null {
    const candidates: Next[] = [];
    const event = this.#events[0];
    if (event !== undefined) candidates.push({ type: 'event', atMs: event.atMs });
    const job = this.#scheduler.nextRunAt();
    if (job !== null) candidates.push({ type: 'jobs', atMs: job.getTime() });
    const tickMs = Math.min(...this.#crons.map((series) => series.next(this.#lastTickMs)));
    if (Number.isFinite(tickMs)) {
      candidates.push({ type: 'tick', atMs: tickMs, series: this.#crons.filter((series) => series.next(this.#lastTickMs) === tickMs) });
    }
    const due = candidates.filter((c) => c.atMs <= targetMs);
    due.sort((a, b) => a.atMs - b.atMs || PRIORITY[a.type] - PRIORITY[b.type]);
    return due[0] ?? null;
  }
}
