import { Duration } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from './clock';

const START = new Date('2026-10-06T13:00:00.000Z');

describe('FakeClock', () => {
  beforeEach(() => {
    // Proves the clock never reads the wall clock: the system time is far away from START.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at the given instant, not the wall clock', () => {
    const clock = new FakeClock(START);
    expect(clock.now().toISOString()).toBe('2026-10-06T13:00:00.000Z');
    expect(clock.nowMs()).toBe(START.getTime());
  });

  it('does not move on its own', () => {
    const clock = new FakeClock(START);
    vi.advanceTimersByTime(60_000);
    expect(clock.now().toISOString()).toBe(START.toISOString());
  });

  it('returns a fresh Date on every call, so callers cannot move it by mutation', () => {
    const clock = new FakeClock(START);
    const a = clock.now();
    a.setTime(0);
    expect(clock.now().toISOString()).toBe(START.toISOString());
    expect(clock.now()).not.toBe(clock.now());
  });

  it('copies the start date, so mutating it later has no effect', () => {
    const start = new Date(START.getTime());
    const clock = new FakeClock(start);
    start.setTime(0);
    expect(clock.now().toISOString()).toBe(START.toISOString());
  });

  it('advances by milliseconds', () => {
    const clock = new FakeClock(START);
    expect(clock.advance(1500).toISOString()).toBe('2026-10-06T13:00:01.500Z');
  });

  it('advances by a duration-like object, with a day as exactly 24 h', () => {
    const clock = new FakeClock(START);
    clock.advance({ days: 1, hours: 2, minutes: 3, seconds: 4, milliseconds: 5 });
    expect(clock.now().toISOString()).toBe('2026-10-07T15:03:04.005Z');
    clock.advance({ weeks: 1 });
    expect(clock.now().toISOString()).toBe('2026-10-14T15:03:04.005Z');
  });

  it('advances across a DST change by exact elapsed time', () => {
    // America/New_York leaves DST on 2026-11-01; the instant moves by exactly 24 h regardless.
    const clock = new FakeClock(new Date('2026-10-31T16:00:00.000Z'));
    clock.advance({ days: 1 });
    expect(clock.now().toISOString()).toBe('2026-11-01T16:00:00.000Z');
  });

  it('advances by a Luxon Duration', () => {
    const clock = new FakeClock(START);
    clock.advance(Duration.fromObject({ minutes: 90 }));
    expect(clock.now().toISOString()).toBe('2026-10-06T14:30:00.000Z');
  });

  it('refuses to advance backwards or by a non-finite amount', () => {
    const clock = new FakeClock(START);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance({ minutes: -5 })).toThrow(RangeError);
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(clock.now().toISOString()).toBe(START.toISOString());
  });

  it('sets to any instant, including an earlier one', () => {
    const clock = new FakeClock(START);
    clock.set(new Date('2026-10-12T12:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-10-12T12:00:00.000Z');
    clock.set(new Date('2026-09-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('rejects invalid dates', () => {
    expect(() => new FakeClock(new Date(Number.NaN))).toThrow(RangeError);
    const clock = new FakeClock(START);
    expect(() => clock.set(new Date('not a date'))).toThrow(RangeError);
    expect(() => clock.advance(8.64e15)).toThrow(RangeError);
    expect(clock.now().toISOString()).toBe(START.toISOString());
  });

  it('notifies listeners after set and advance with the new and previous instants', () => {
    const clock = new FakeClock(START);
    const seen: [string, string][] = [];
    clock.onChange((now, previous) => seen.push([now.toISOString(), previous.toISOString()]));
    clock.advance({ minutes: 5 });
    clock.set(new Date('2026-10-07T00:00:00.000Z'));
    expect(seen).toEqual([
      ['2026-10-06T13:05:00.000Z', '2026-10-06T13:00:00.000Z'],
      ['2026-10-07T00:00:00.000Z', '2026-10-06T13:05:00.000Z'],
    ]);
  });

  it('lets a listener read the clock, which has already moved', () => {
    const clock = new FakeClock(START);
    let readInside = '';
    clock.onChange(() => {
      readInside = clock.now().toISOString();
    });
    clock.advance(1000);
    expect(readInside).toBe('2026-10-06T13:00:01.000Z');
  });

  it('stops notifying after unsubscribe, including from inside a listener', () => {
    const clock = new FakeClock(START);
    const calls: string[] = [];
    const unsubscribeA = clock.onChange(() => {
      calls.push('a');
      unsubscribeA();
    });
    clock.onChange(() => calls.push('b'));
    clock.advance(1);
    clock.advance(1);
    expect(calls).toEqual(['a', 'b', 'b']);
  });
});
