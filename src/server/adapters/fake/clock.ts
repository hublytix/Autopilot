import 'server-only';
import type { Clock } from '@/server/ports/clock';

/**
 * A fixed-length duration. Calendar units (months, years) are deliberately absent: the clock is an
 * instant, so a "day" here is exactly 24 h, whatever the DST rules of any zone.
 */
export interface DurationLike {
  weeks?: number | undefined;
  days?: number | undefined;
  hours?: number | undefined;
  minutes?: number | undefined;
  seconds?: number | undefined;
  milliseconds?: number | undefined;
}

/** Anything with `toMillis()`, such as a Luxon `Duration`. */
export interface MillisConvertible {
  toMillis(): number;
}

export type ClockAdvance = number | DurationLike | MillisConvertible;

/** Called after every `set` or `advance`, with fresh Date copies. */
export type ClockListener = (now: Date, previous: Date) => void;

const UNIT_MS = {
  weeks: 7 * 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  minutes: 60 * 1000,
  seconds: 1000,
  milliseconds: 1,
} as const satisfies Record<keyof DurationLike, number>;

/** The length of `by` in milliseconds. */
export function advanceMillis(by: ClockAdvance): number {
  if (typeof by === 'number') return by;
  if ('toMillis' in by && typeof by.toMillis === 'function') return by.toMillis();
  const duration = by as DurationLike;
  let total = 0;
  for (const unit of Object.keys(UNIT_MS) as (keyof DurationLike)[]) {
    const amount = duration[unit];
    if (amount !== undefined) total += amount * UNIT_MS[unit];
  }
  return total;
}

/** The largest magnitude a JavaScript Date can hold (ECMA-262 §21.4.1.1). */
const MAX_DATE_MS = 8.64e15;

function epochMs(date: Date): number {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('fake_clock_invalid_date');
  return ms;
}

/**
 * The settable, advanceable Clock for tests, the simulation and fake mode (PLAN §4, D-28). It never
 * reads the wall clock: time moves only through `set` and `advance`. `onChange` lets Luxon's
 * `Settings.now` and the fake scheduler follow it.
 */
export class FakeClock implements Clock {
  #ms: number;
  readonly #listeners = new Set<ClockListener>();

  constructor(start: Date) {
    this.#ms = epochMs(start);
  }

  now(): Date {
    return new Date(this.#ms);
  }

  /** The current instant as epoch milliseconds. */
  nowMs(): number {
    return this.#ms;
  }

  /** Jumps to `date`, forwards or backwards. */
  set(date: Date): void {
    this.#move(epochMs(date));
  }

  /** Moves forward by milliseconds or a fixed-length duration; returns the new now. Never moves backwards. */
  advance(by: ClockAdvance): Date {
    const ms = advanceMillis(by);
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('fake_clock_invalid_advance');
    this.#move(this.#ms + ms);
    return this.now();
  }

  /** Subscribes to clock moves; returns the unsubscribe function. */
  onChange(listener: ClockListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #move(nextMs: number): void {
    if (!Number.isFinite(nextMs) || Math.abs(nextMs) > MAX_DATE_MS) throw new RangeError('fake_clock_invalid_date');
    const previous = this.#ms;
    this.#ms = nextMs;
    // A snapshot, so a listener may unsubscribe itself (or another) while being notified.
    for (const listener of [...this.#listeners]) listener(new Date(nextMs), new Date(previous));
  }
}
