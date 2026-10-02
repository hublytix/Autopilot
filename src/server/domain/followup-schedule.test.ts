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

  it('runs an overdue follow-up one hour from now, and the next one 3 days after it', () => {
    const now = at('2026-10-08T14:20:00');
    expect(resumeTargets(t0, now, [], SIMULATION, NY, ACCOUNT)).toEqual([
      { n: 1, runAt: at('2026-10-08T15:20:00'), shifted: false },
      // Day 5 (Sunday 10:00) would be under 3 days after follow-up 1, so Sunday 15:20 (D-72).
      { n: 2, runAt: at('2026-10-11T15:20:00'), shifted: false },
    ]);
  });

  it('keeps the 3-day gap for follow-up 2 once day 5 has passed too (D-42 alone would put both at now + 1 h; D-72)', () => {
    const now = at('2026-10-12T11:00:00');
    expect(resumeTargets(t0, now, [], SIMULATION, NY, ACCOUNT)).toEqual([
      { n: 1, runAt: at('2026-10-12T12:00:00'), shifted: false },
      { n: 2, runAt: at('2026-10-15T12:00:00'), shifted: false },
    ]);
  });

  it('counts the gap from follow-up 1 after quiet hours and the weekend moved it', () => {
    // Friday 18:30: now + 1 h is quiet, then the weekend: follow-up 1 on Monday 08:00 plus the offset.
    const [first, second] = resumeTargets(t0, at('2026-10-09T18:30:00'), [], DEFAULTS, NY, ACCOUNT);
    expect(first).toEqual({ n: 1, runAt: shiftedTo('2026-10-12T08:00:00'), shifted: true });
    // Thursday 08:00 + offset is allowed, so it is not shifted again and stays exactly 3 days later.
    expect(second).toEqual({ n: 2, runAt: shiftedTo('2026-10-15T08:00:00'), shifted: false });
  });

  it('shifts the spaced follow-up 2 out of a weekend', () => {
    // Wednesday 17:30 on day 8: follow-up 1 at 18:30; three days later is Saturday 18:30 → Monday 08:00.
    const [first, second] = resumeTargets(t0, at('2026-10-14T17:30:00'), [], DEFAULTS, NY, ACCOUNT);
    expect(first).toEqual({ n: 1, runAt: at('2026-10-14T18:30:00'), shifted: false });
    expect(second).toEqual({ n: 2, runAt: shiftedTo('2026-10-19T08:00:00'), shifted: true });
  });

  it('keeps the gap after a follow-up 1 that is still being sent (an earlier stream\'s email) or was just sent (D-73)', () => {
    // Resumed on day 8: follow-up 1's email of the old stream was first reserved an hour ago and the sweeper is still sending it.
    const now = at('2026-10-14T11:00:00');
    const reserved = at('2026-10-14T10:00:00');
    expect(resumeTargets(t0, now, [1], SIMULATION, NY, ACCOUNT, { 1: reserved })).toEqual([{ n: 2, runAt: at('2026-10-17T10:00:00'), shifted: false }]);
    // Without it, D-42's formula alone: an hour from now, an hour after follow-up 1.
    expect(resumeTargets(t0, now, [1], SIMULATION, NY, ACCOUNT)).toEqual([{ n: 2, runAt: at('2026-10-14T12:00:00'), shifted: false }]);
    // A follow-up 1 sent on day 2 is long past: day 5 or now + 1 h as before.
    expect(resumeTargets(t0, at('2026-10-09T10:00:00'), [1], SIMULATION, NY, ACCOUNT, { 1: at('2026-10-08T10:00:00') })).toEqual([
      { n: 2, runAt: at('2026-10-11T10:00:00'), shifted: false },
    ]);
    // The gap lands in quiet hours or a weekend: shifted out of them.
    const [late] = resumeTargets(t0, at('2026-10-14T21:00:00'), [1], DEFAULTS, NY, ACCOUNT, { 1: at('2026-10-14T20:30:00') });
    expect(late).toEqual({ n: 2, runAt: shiftedTo('2026-10-19T08:00:00'), shifted: true });
    for (let hour = 0; hour < 14 * 24; hour += 1) {
      const resumedAt = new Date(t0.getTime() + hour * HOUR);
      const fu1At = new Date(resumedAt.getTime() - 30 * 60 * 1000);
      const [second] = resumeTargets(t0, resumedAt, [1], DEFAULTS, NY, ACCOUNT, { 1: fu1At });
      if (second === undefined) throw new Error('one target expected');
      expect(DateTime.fromJSDate(second.runAt, { zone: NY }).diff(DateTime.fromJSDate(fu1At, { zone: NY }), 'days').days).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps both original days when resumed before follow-up 1 was due, and fu2 ≥ fu1 + 3 days every hour of a fortnight', () => {
    expect(resumeTargets(t0, at('2026-10-07T10:00:00'), [], DEFAULTS, NY, ACCOUNT)).toEqual(followUpTargets(t0, DEFAULTS, NY, ACCOUNT));
    for (let hour = 0; hour < 14 * 24; hour += 1) {
      const now = new Date(t0.getTime() + hour * HOUR);
      for (const settings of [DEFAULTS, SIMULATION]) {
        const [first, second] = resumeTargets(t0, now, [], settings, NY, ACCOUNT);
        if (first === undefined || second === undefined) throw new Error('two targets expected');
        expect(first.runAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + HOUR);
        expect(second.runAt.getTime() - first.runAt.getTime()).toBeGreaterThanOrEqual(3 * DAY - HOUR);
        expect(DateTime.fromJSDate(second.runAt, { zone: NY }).diff(DateTime.fromJSDate(first.runAt, { zone: NY }), 'days').days).toBeGreaterThanOrEqual(3);
      }
    }
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
