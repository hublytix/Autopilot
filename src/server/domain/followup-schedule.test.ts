import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLLOW_UP_DAYS, followUpDueAt, followUpTargets, resumeTargets } from './followup-schedule';
import { QuietHoursError, shiftOffsetSeconds, type QuietHoursSettings } from './quiet-hours';

// PLAN §12: nothing here may read the wall clock, so the system time is set far from every instant the tests use.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const ACCOUNT = '2d6b1f7a-3c4e-4f5a-8b9c-0d1e2f3a4b5c';
const OFFSET_MS = shiftOffsetSeconds(ACCOUNT) * 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = 'America/New_York';

/** D-33 defaults: 19:00–08:00, skip weekends on. */
const DEFAULTS: QuietHoursSettings = { quietStartHour: 19, quietEndHour: 8, skipWeekends: true };
/** The simulation's owner (D-39): 19:00–08:00, weekends allowed. */
const SIMULATION: QuietHoursSettings = { ...DEFAULTS, skipWeekends: false };

function at(iso: string, zone = NY): Date {
  return DateTime.fromISO(iso, { zone }).toJSDate();
}

function shiftedTo(iso: string, zone = NY): Date {
  return new Date(at(iso, zone).getTime() + OFFSET_MS);
}

describe('followUpTargets (brief §5.6, PLAN §8.5)', () => {
  it('schedules follow-up 1 on day 2 and follow-up 2 on day 5, unshifted when allowed (the simulation calendar)', () => {
    // D-39: Day 0 is Tuesday 2026-10-06 10:00; Day 2 is Thursday, Day 5 is Sunday (weekends allowed).
    const t0 = at('2026-10-06T10:00:12.345');
    expect(followUpTargets(t0, SIMULATION, NY, ACCOUNT)).toEqual([
      { n: 1, runAt: at('2026-10-08T10:00:12.345'), shifted: false },
      { n: 2, runAt: at('2026-10-11T10:00:12.345'), shifted: false },
    ]);
    expect(FOLLOW_UP_DAYS).toEqual({ 1: 2, 2: 5 });
  });

  it('moves a follow-up that falls on a weekend to Monday 08:00 plus the account offset when weekends are skipped', () => {
    const t0 = at('2026-10-06T10:00:00');
    expect(followUpTargets(t0, DEFAULTS, NY, ACCOUNT)).toEqual([
      { n: 1, runAt: at('2026-10-08T10:00:00'), shifted: false },
      { n: 2, runAt: shiftedTo('2026-10-12T08:00:00'), shifted: true },
    ]);
  });

  it('keeps the local time of day across the end of DST (day 2 is 49 hours later)', () => {
    const t0 = at('2026-10-30T10:00:00');
    const [fu1, fu2] = followUpTargets(t0, SIMULATION, NY, ACCOUNT);
    expect(fu1).toEqual({ n: 1, runAt: new Date('2026-11-01T15:00:00.000Z'), shifted: false });
    expect(fu1.runAt.getTime() - t0.getTime()).toBe(49 * HOUR);
    expect(fu2).toEqual({ n: 2, runAt: new Date('2026-11-04T15:00:00.000Z'), shifted: false });
  });

  it('keeps the local time of day across the start of DST (day 2 is 47 hours later)', () => {
    const t0 = at('2026-03-06T10:00:00');
    const [fu1] = followUpTargets(t0, SIMULATION, NY, ACCOUNT);
    expect(fu1).toEqual({ n: 1, runAt: new Date('2026-03-08T14:00:00.000Z'), shifted: false });
    expect(fu1.runAt.getTime() - t0.getTime()).toBe(47 * HOUR);
  });

  it('shifts follow-ups of a lead notified in the evening (the first email itself was immediate)', () => {
    const t0 = at('2026-10-05T20:15:00');
    expect(followUpTargets(t0, DEFAULTS, NY, ACCOUNT)).toEqual([
      { n: 1, runAt: shiftedTo('2026-10-08T08:00:00'), shifted: true },
      { n: 2, runAt: shiftedTo('2026-10-12T08:00:00'), shifted: true },
    ]);
    expect(followUpTargets(at('2026-10-05T18:30:00'), DEFAULTS, NY, ACCOUNT)[0]).toEqual({
      n: 1,
      runAt: at('2026-10-07T18:30:00'),
      shifted: false,
    });
  });

  it('reads the days and hours in the portal zone (Asia/Kolkata)', () => {
    // 14:00 UTC is 19:30 IST: quiet, so day 2 moves to 08:00 IST (02:30 UTC) the next morning.
    const t0 = new Date('2026-10-13T14:00:00.000Z');
    const [fu1] = followUpTargets(t0, DEFAULTS, 'Asia/Kolkata', ACCOUNT);
    expect(fu1).toEqual({ n: 1, runAt: new Date(Date.parse('2026-10-16T02:30:00.000Z') + OFFSET_MS), shifted: true });
    // The same instant is 10:00 in New York: allowed, unchanged.
    expect(followUpTargets(t0, DEFAULTS, NY, ACCOUNT)[0]).toEqual({ n: 1, runAt: new Date('2026-10-15T14:00:00.000Z'), shifted: false });
  });

  it('returns the Sunday-night follow-up 2 even though it lands more than 7 days after T0 (the jobs layer hops)', () => {
    const t0 = at('2026-10-11T22:30:00');
    const [fu1, fu2] = followUpTargets(t0, DEFAULTS, NY, ACCOUNT);
    expect(fu1).toEqual({ n: 1, runAt: shiftedTo('2026-10-14T08:00:00'), shifted: true });
    expect(fu2).toEqual({ n: 2, runAt: shiftedTo('2026-10-19T08:00:00'), shifted: true });
    expect(fu2.runAt.getTime() - t0.getTime()).toBeGreaterThan(7 * DAY);
  });

  it('is deterministic for an account', () => {
    const t0 = at('2026-10-09T21:00:00');
    expect(followUpTargets(t0, DEFAULTS, NY, ACCOUNT)).toEqual(followUpTargets(t0, DEFAULTS, NY, ACCOUNT));
  });

  it('throws a QuietHoursError for an unknown zone', () => {
    expect(() => followUpTargets(at('2026-10-06T10:00:00'), DEFAULTS, 'Not/AZone', ACCOUNT)).toThrow(QuietHoursError);
  });
});

describe('resumeTargets (D-42, PLAN §9.6)', () => {
  const t0 = at('2026-10-06T10:00:00');

  it('keeps the original targets when they are still more than an hour away', () => {
    const now = at('2026-10-07T10:00:00');
    expect(resumeTargets(t0, now, [], SIMULATION, NY, ACCOUNT)).toEqual(followUpTargets(t0, SIMULATION, NY, ACCOUNT));
  });

  it('reschedules only the follow-ups not yet sent', () => {
    const now = at('2026-10-09T10:00:00');
    expect(resumeTargets(t0, now, [1], SIMULATION, NY, ACCOUNT)).toEqual([{ n: 2, runAt: at('2026-10-11T10:00:00'), shifted: false }]);
    expect(resumeTargets(t0, now, [1, 2], SIMULATION, NY, ACCOUNT)).toEqual([]);
  });

  it('runs an overdue follow-up one hour from now', () => {
    const now = at('2026-10-08T14:20:00');
    expect(resumeTargets(t0, now, [], SIMULATION, NY, ACCOUNT)).toEqual([
      { n: 1, runAt: at('2026-10-08T15:20:00'), shifted: false },
      { n: 2, runAt: at('2026-10-11T10:00:00'), shifted: false },
    ]);
  });

  it('runs both at now + 1 h once day 5 has passed too, as D-42 says', () => {
    const now = at('2026-10-12T11:00:00');
    expect(resumeTargets(t0, now, [], SIMULATION, NY, ACCOUNT)).toEqual([
      { n: 1, runAt: at('2026-10-12T12:00:00'), shifted: false },
      { n: 2, runAt: at('2026-10-12T12:00:00'), shifted: false },
    ]);
  });

  it('takes T0 + n days when it is exactly now + 1 h, and now + 1 h one millisecond later', () => {
    const due = followUpDueAt(t0, 2, NY).toJSDate();
    expect(resumeTargets(t0, new Date(due.getTime() - HOUR), [1], SIMULATION, NY, ACCOUNT)).toEqual([{ n: 2, runAt: due, shifted: false }]);
    expect(resumeTargets(t0, new Date(due.getTime() - HOUR + 1), [1], SIMULATION, NY, ACCOUNT)).toEqual([
      { n: 2, runAt: new Date(due.getTime() + 1), shifted: false },
    ]);
  });

  it('shifts now + 1 h out of quiet hours and weekends', () => {
    // Day 5 has passed; Friday 18:30 + 1 h is 19:30 (quiet), then the weekend: Monday 08:00 plus the offset.
    const now = at('2026-10-16T18:30:00');
    expect(resumeTargets(t0, now, [1], DEFAULTS, NY, ACCOUNT)).toEqual([{ n: 2, runAt: shiftedTo('2026-10-19T08:00:00'), shifted: true }]);
  });
});
