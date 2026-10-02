import 'server-only';
import { z } from 'zod';
import type { Db } from '@/server/db';
import type { Clock } from '@/server/ports/clock';
import { advanceMillis, type ClockAdvance } from './clock';

// Fake mode's clock (PLAN §4, D-29): a base clock (the wall clock, through SystemClock) plus an
// offset that the /dev "advance the clock" action moves. The offset lives in fake.state, so a dev
// restart comes back at the same simulated time. Tests and the simulation use FakeClock instead.

/** The fake.state row holding the offset. */
export const CLOCK_OFFSET_KEY = 'clock_offset_ms';

/** The offset as stored: whole milliseconds, within what a Date can hold. */
const storedOffsetSchema = z.object({ offsetMs: z.number().int().min(-8.64e15).max(8.64e15) });

export class DevClock implements Clock {
  readonly #base: Clock;
  readonly #db: Db;
  #offsetMs: number;

  private constructor(base: Clock, db: Db, offsetMs: number) {
    this.#base = base;
    this.#db = db;
    this.#offsetMs = offsetMs;
  }

  /** Reads the persisted offset (0 when there is none or it does not parse). */
  static async load(db: Db, base: Clock): Promise<DevClock> {
    const rows = await db.query<{ value: unknown }>('select value from fake.state where key = $1', [CLOCK_OFFSET_KEY]);
    const parsed = storedOffsetSchema.safeParse(rows[0]?.value);
    return new DevClock(base, db, parsed.success ? parsed.data.offsetMs : 0);
  }

  now(): Date {
    return new Date(this.#base.now().getTime() + this.#offsetMs);
  }

  /** How far this clock runs ahead of (or behind) the base clock. */
  get offsetMs(): number {
    return this.#offsetMs;
  }

  /** Moves forward by milliseconds or a fixed-length duration and persists the offset; returns the new now. */
  async advance(by: ClockAdvance): Promise<Date> {
    const ms = advanceMillis(by);
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('dev_clock_invalid_advance');
    await this.#store(this.#offsetMs + ms);
    return this.now();
  }

  /** Jumps to `date` (forwards or backwards) and persists the offset. */
  async set(date: Date): Promise<void> {
    const target = date.getTime();
    if (!Number.isFinite(target)) throw new RangeError('dev_clock_invalid_date');
    await this.#store(target - this.#base.now().getTime());
  }

  /** Back to the base clock. */
  async reset(): Promise<void> {
    await this.#store(0);
  }

  async #store(offsetMs: number): Promise<void> {
    const value = storedOffsetSchema.parse({ offsetMs: Math.trunc(offsetMs) });
    await this.#db.query(
      `insert into fake.state (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [CLOCK_OFFSET_KEY, value],
    );
    this.#offsetMs = value.offsetMs;
  }
}
