import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allowedHoursPerWeek,
  isAllowed,
  isQuietHour,
  MAX_SHIFT_OFFSET_SECONDS,
  QuietHoursError,
  shiftOffsetSeconds,
  shiftToAllowed,
  validateQuietHours,
  type QuietHoursSettings,
} from './quiet-hours';

// PLAN §12: nothing here may read the wall clock, so the system time is set far from every instant the tests use.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const ACCOUNT = '5f0c6a3e-1d2b-4c8e-9a7f-0b1c2d3e4f50';
const OFFSET_MS = shiftOffsetSeconds(ACCOUNT) * 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** D-33 defaults: 19:00–08:00, skip weekends on. */
const DEFAULTS: QuietHoursSettings = { quietStartHour: 19, quietEndHour: 8, skipWeekends: true };
const WEEKENDS_ALLOWED: QuietHoursSettings = { ...DEFAULTS, skipWeekends: false };
const MIDDAY: QuietHoursSettings = { quietStartHour: 12, quietEndHour: 14, skipWeekends: false };
const NONE: QuietHoursSettings = { quietStartHour: 9, quietEndHour: 9, skipWeekends: false };

const NY = 'America/New_York';
const KOLKATA = 'Asia/Kolkata';
const KATHMANDU = 'Asia/Kathmandu';
const AUCKLAND = 'Pacific/Auckland';
const LONDON = 'Europe/London';

/** A local wall-clock time (an ISO string with an explicit offset picks one side of a DST overlap). */
function local(iso: string, zone: string): DateTime {
  return DateTime.fromISO(iso, { zone });
}

/** What a shifted result must be: the whole hour plus this account's offset. */
function wholeHourPlusOffset(iso: string, zone: string): Date {
  return new Date(local(iso, zone).toMillis() + OFFSET_MS);
}

function shift(iso: string, zone: string, settings: QuietHoursSettings): ReturnType<typeof shiftToAllowed> {
  return shiftToAllowed(local(iso, zone), settings, ACCOUNT);
}

describe('isQuietHour and isAllowed (D-33)', () => {
  it('treats a wrapping window (19–08) as quiet from 19:00 through 07:59', () => {
    const quiet = Array.from({ length: 24 }, (_, hour) => hour).filter((hour) => isQuietHour(hour, 19, 8));
    expect(quiet).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 19, 20, 21, 22, 23]);
    expect(isAllowed(local('2026-10-14T18:59:59', NY), DEFAULTS, NY)).toBe(true);
    expect(isAllowed(local('2026-10-14T19:00:00', NY), DEFAULTS, NY)).toBe(false);
    expect(isAllowed(local('2026-10-15T07:59:59', NY), DEFAULTS, NY)).toBe(false);
    expect(isAllowed(local('2026-10-15T08:00:00', NY), DEFAULTS, NY)).toBe(true);
  });

  it('treats a non-wrapping window (12–14) as quiet from 12:00 through 13:59 only', () => {
    const quiet = Array.from({ length: 24 }, (_, hour) => hour).filter((hour) => isQuietHour(hour, 12, 14));
    expect(quiet).toEqual([12, 13]);
    expect(isAllowed(local('2026-10-14T11:59:59', NY), MIDDAY, NY)).toBe(true);
    expect(isAllowed(local('2026-10-14T12:00:00', NY), MIDDAY, NY)).toBe(false);
    expect(isAllowed(local('2026-10-14T14:00:00', NY), MIDDAY, NY)).toBe(true);
    expect(isAllowed(local('2026-10-14T23:30:00', NY), MIDDAY, NY)).toBe(true);
  });

  it('has no quiet hours when start equals end', () => {
    for (let start = 0; start < 24; start += 1) {
      for (let hour = 0; hour < 24; hour += 1) expect(isQuietHour(hour, start, start)).toBe(false);
    }
  });

  it('refuses Saturday and Sunday only while skip weekends is on', () => {
    const saturday = local('2026-10-17T10:00:00', NY);
    const sunday = local('2026-10-18T10:00:00', NY);
    const friday = local('2026-10-16T10:00:00', NY);
    const monday = local('2026-10-19T10:00:00', NY);
    expect([saturday, sunday, friday, monday].map((dt) => isAllowed(dt, DEFAULTS, NY))).toEqual([false, false, true, true]);
    expect([saturday, sunday, friday, monday].map((dt) => isAllowed(dt, WEEKENDS_ALLOWED, NY))).toEqual([true, true, true, true]);
  });

  it('reads the hour and the weekday in the given zone, not in UTC', () => {
    // Friday 20:00 UTC is Saturday 09:00 in Auckland (NZDT, +13).
    const instant = new Date('2026-10-16T20:00:00.000Z');
    const noQuiet: QuietHoursSettings = { quietStartHour: 0, quietEndHour: 0, skipWeekends: true };
    expect(isAllowed(instant, noQuiet, 'UTC')).toBe(true);
    expect(isAllowed(instant, noQuiet, AUCKLAND)).toBe(false);
    // 02:30 UTC is 08:00 in Kolkata and 08:15 in Kathmandu: allowed there, quiet in UTC.
    const morning = new Date('2026-10-14T02:30:00.000Z');
    expect(isAllowed(morning, DEFAULTS, 'UTC')).toBe(false);
    expect(isAllowed(morning, DEFAULTS, KOLKATA)).toBe(true);
    expect(isAllowed(morning, DEFAULTS, KATHMANDU)).toBe(true);
  });

  it('throws a QuietHoursError for an unknown zone', () => {
    expect(() => isAllowed(new Date('2026-10-14T12:00:00.000Z'), DEFAULTS, 'Not/AZone')).toThrow(QuietHoursError);
  });
});

describe('validateQuietHours (D-33)', () => {
  // The "no allowed hour in a week" rule cannot reject a whole-hour setting: a quiet window is at
  // most 23 hours long and weekdays are always allowed. This exhaustive case proves it.
  it('accepts every whole-hour setting, each leaving at least 5 allowed hours a week', () => {
    for (let start = 0; start < 24; start += 1) {
      for (let end = 0; end < 24; end += 1) {
        for (const skipWeekends of [true, false]) {
          const settings = { quietStartHour: start, quietEndHour: end, skipWeekends };
          expect(validateQuietHours(settings)).toEqual({ ok: true });
          expect(allowedHoursPerWeek(settings)).toBeGreaterThanOrEqual(5);
        }
      }
    }
  });

  it('counts the allowed hours of the defaults, of a midday window and of no quiet hours', () => {
    expect(allowedHoursPerWeek(DEFAULTS)).toBe(11 * 5);
    expect(allowedHoursPerWeek(WEEKENDS_ALLOWED)).toBe(11 * 7);
    expect(allowedHoursPerWeek(MIDDAY)).toBe(22 * 7);
    expect(allowedHoursPerWeek(NONE)).toBe(24 * 7);
  });

  it('rejects hours that are not whole hours from 0 to 23', () => {
    expect(validateQuietHours({ ...DEFAULTS, quietStartHour: 24 })).toEqual({ ok: false, code: 'invalid_start_hour' });
    expect(validateQuietHours({ ...DEFAULTS, quietStartHour: -1 })).toEqual({ ok: false, code: 'invalid_start_hour' });
    expect(validateQuietHours({ ...DEFAULTS, quietEndHour: 7.5 })).toEqual({ ok: false, code: 'invalid_end_hour' });
    expect(validateQuietHours({ ...DEFAULTS, quietEndHour: Number.NaN })).toEqual({ ok: false, code: 'invalid_end_hour' });
  });

});

describe('shiftToAllowed (D-33, PLAN §8.5)', () => {
  it('returns an allowed target unchanged, without the offset', () => {
    const target = local('2026-10-14T10:07:33.250', NY);
    expect(shiftToAllowed(target, DEFAULTS, ACCOUNT)).toEqual({ at: target.toJSDate(), shifted: false });
  });

  describe('wrapping and non-wrapping windows', () => {
    it('moves a time inside a wrapping window (19–08) to 08:00 the next morning', () => {
      expect(shift('2026-10-14T21:30:00', NY, DEFAULTS)).toEqual({ at: wholeHourPlusOffset('2026-10-15T08:00:00', NY), shifted: true });
      expect(shift('2026-10-14T19:00:00', NY, DEFAULTS)).toEqual({ at: wholeHourPlusOffset('2026-10-15T08:00:00', NY), shifted: true });
    });

    it('moves a time after midnight inside a wrapping window to 08:00 the same day', () => {
      expect(shift('2026-10-15T00:00:00', NY, DEFAULTS)).toEqual({ at: wholeHourPlusOffset('2026-10-15T08:00:00', NY), shifted: true });
      expect(shift('2026-10-15T07:59:59', NY, DEFAULTS)).toEqual({ at: wholeHourPlusOffset('2026-10-15T08:00:00', NY), shifted: true });
    });

    it('moves a time inside a non-wrapping window (12–14) to 14:00 the same day', () => {
      expect(shift('2026-10-14T12:30:00', NY, MIDDAY)).toEqual({ at: wholeHourPlusOffset('2026-10-14T14:00:00', NY), shifted: true });
      expect(shift('2026-10-14T13:59:59', NY, MIDDAY)).toEqual({ at: wholeHourPlusOffset('2026-10-14T14:00:00', NY), shifted: true });
      expect(shift('2026-10-14T14:00:00', NY, MIDDAY).shifted).toBe(false);
      expect(shift('2026-10-14T19:30:00', NY, MIDDAY).shifted).toBe(false);
    });
  });

  describe('quiet start equal to quiet end', () => {
    it('never shifts any hour of the week while weekends are allowed', () => {
      const monday = local('2026-10-12T00:20:00', NY);
      for (let hour = 0; hour < 7 * 24; hour += 1) {
        expect(shiftToAllowed(monday.plus({ hours: hour }), NONE, ACCOUNT).shifted).toBe(false);
      }
    });

    it('still skips the weekend when skip weekends is on, to Monday 00:00', () => {
      const weekdaysOnly: QuietHoursSettings = { ...NONE, skipWeekends: true };
      expect(shift('2026-10-17T15:00:00', NY, weekdaysOnly)).toEqual({ at: wholeHourPlusOffset('2026-10-19T00:00:00', NY), shifted: true });
      expect(shift('2026-10-16T23:59:00', NY, weekdaysOnly).shifted).toBe(false);
    });
  });

  describe('skip weekends', () => {
    it('on: Friday evening, Saturday and Sunday night all move to Monday 08:00', () => {
      for (const iso of ['2026-10-16T20:00:00', '2026-10-17T10:00:00', '2026-10-18T23:00:00', '2026-10-19T03:00:00']) {
        expect(shift(iso, NY, DEFAULTS)).toEqual({ at: wholeHourPlusOffset('2026-10-19T08:00:00', NY), shifted: true });
      }
    });

    it('off: Friday evening moves to Saturday 08:00 and Saturday daytime is kept', () => {
      expect(shift('2026-10-16T20:00:00', NY, WEEKENDS_ALLOWED)).toEqual({ at: wholeHourPlusOffset('2026-10-17T08:00:00', NY), shifted: true });
      expect(shift('2026-10-17T10:00:00', NY, WEEKENDS_ALLOWED).shifted).toBe(false);
    });

    it('can search across the weekend to the only allowed hour of the day', () => {
      // Quiet 01:00–00:00 leaves only the 00:00 hour; Friday 00:30 waits until Monday 00:00.
      const midnightOnly: QuietHoursSettings = { quietStartHour: 1, quietEndHour: 0, skipWeekends: true };
      expect(shift('2026-10-16T00:30:00', NY, midnightOnly).shifted).toBe(false);
      expect(shift('2026-10-16T01:30:00', NY, midnightOnly)).toEqual({ at: wholeHourPlusOffset('2026-10-19T00:00:00', NY), shifted: true });
    });
  });

  describe('America/New_York', () => {
    it('DST ends (Sunday 2026-11-01): Saturday night moves to Sunday 08:00 EST, 13 hours later', () => {
      const result = shift('2026-10-31T20:00:00', NY, WEEKENDS_ALLOWED);
      expect(result).toEqual({ at: new Date(Date.parse('2026-11-01T13:00:00.000Z') + OFFSET_MS), shifted: true });
      expect(DateTime.fromJSDate(result.at, { zone: NY }).offset).toBe(-300);
      expect(result.at.getTime() - OFFSET_MS - local('2026-10-31T20:00:00', NY).toMillis()).toBe(13 * HOUR);
    });

    it('DST ends: the repeated 01:00 hour is quiet both times, so 01:30 EDT moves to 02:00 EST', () => {
      const oneOClockOnly: QuietHoursSettings = { quietStartHour: 1, quietEndHour: 2, skipWeekends: false };
      const result = shiftToAllowed(local('2026-11-01T01:30:00-04:00', NY), oneOClockOnly, ACCOUNT);
      expect(result).toEqual({ at: new Date(Date.parse('2026-11-01T07:00:00.000Z') + OFFSET_MS), shifted: true });
    });

    it('DST starts (Sunday 2026-03-08): Saturday night moves to Sunday 08:00 EDT, 11 hours later', () => {
      const result = shift('2026-03-07T20:00:00', NY, WEEKENDS_ALLOWED);
      expect(result).toEqual({ at: new Date(Date.parse('2026-03-08T12:00:00.000Z') + OFFSET_MS), shifted: true });
      expect(DateTime.fromJSDate(result.at, { zone: NY }).offset).toBe(-240);
    });

    it('DST starts: the missing 02:00 hour is skipped, so the next whole allowed hour is 03:00 EDT', () => {
      const earlyQuiet: QuietHoursSettings = { quietStartHour: 0, quietEndHour: 2, skipWeekends: false };
      const result = shift('2026-03-08T00:30:00', NY, earlyQuiet);
      expect(result).toEqual({ at: new Date(Date.parse('2026-03-08T07:00:00.000Z') + OFFSET_MS), shifted: true });
      const shown = DateTime.fromJSDate(new Date(result.at.getTime() - OFFSET_MS), { zone: NY });
      expect([shown.hour, shown.minute, shown.offset]).toEqual([3, 0, -240]);
    });
  });

  describe('half-hour and quarter-hour zones', () => {
    it('Asia/Kolkata (+05:30): 08:00 IST is 02:30 UTC', () => {
      expect(shift('2026-10-14T21:15:00', KOLKATA, DEFAULTS)).toEqual({
        at: new Date(Date.parse('2026-10-15T02:30:00.000Z') + OFFSET_MS),
        shifted: true,
      });
    });

    it('Asia/Kathmandu (+05:45): 08:00 NPT is 02:15 UTC, a whole local hour', () => {
      expect(shift('2026-10-14T21:20:00', KATHMANDU, DEFAULTS)).toEqual({
        at: new Date(Date.parse('2026-10-15T02:15:00.000Z') + OFFSET_MS),
        shifted: true,
      });
      expect(shift('2026-10-15T07:50:00', KATHMANDU, DEFAULTS)).toEqual({
        at: new Date(Date.parse('2026-10-15T02:15:00.000Z') + OFFSET_MS),
        shifted: true,
      });
    });
  });

  describe('Pacific/Auckland', () => {
    it('DST ends (Sunday 2026-04-05): Saturday night moves to Sunday 08:00 NZST (+12)', () => {
      expect(shift('2026-04-04T22:00:00', AUCKLAND, WEEKENDS_ALLOWED)).toEqual({
        at: new Date(Date.parse('2026-04-04T20:00:00.000Z') + OFFSET_MS),
        shifted: true,
      });
    });

    it('DST starts (Sunday 2026-09-27): Saturday night moves to Sunday 08:00 NZDT (+13)', () => {
      expect(shift('2026-09-26T22:00:00', AUCKLAND, WEEKENDS_ALLOWED)).toEqual({
        at: new Date(Date.parse('2026-09-26T19:00:00.000Z') + OFFSET_MS),
        shifted: true,
      });
    });

    it('skips the local weekend: Friday 20:00 UTC is Saturday there, so Monday 08:00 NZDT (Sunday in UTC)', () => {
      const target = DateTime.fromJSDate(new Date('2026-10-16T20:00:00.000Z'), { zone: AUCKLAND });
      expect(shiftToAllowed(target, DEFAULTS, ACCOUNT)).toEqual({
        at: new Date(Date.parse('2026-10-18T19:00:00.000Z') + OFFSET_MS),
        shifted: true,
      });
    });
  });

  describe('Europe/London', () => {
    it('BST ends (Sunday 2026-10-25): Friday night with weekends skipped moves to Monday 08:00 GMT', () => {
      expect(shift('2026-10-23T21:00:00', LONDON, DEFAULTS)).toEqual({
        at: new Date(Date.parse('2026-10-26T08:00:00.000Z') + OFFSET_MS),
        shifted: true,
      });
    });

    it('BST ends: Saturday night with weekends allowed moves to Sunday 08:00 GMT', () => {
      expect(shift('2026-10-24T21:00:00', LONDON, WEEKENDS_ALLOWED)).toEqual({
        at: new Date(Date.parse('2026-10-25T08:00:00.000Z') + OFFSET_MS),
        shifted: true,
      });
    });

    it('BST starts (Sunday 2026-03-29): Saturday night moves to Sunday 08:00 BST (07:00 UTC)', () => {
      expect(shift('2026-03-28T22:00:00', LONDON, WEEKENDS_ALLOWED)).toEqual({
        at: new Date(Date.parse('2026-03-29T07:00:00.000Z') + OFFSET_MS),
        shifted: true,
      });
    });
  });

  describe('the per-account offset', () => {
    it('is 0–10 minutes, the same for the same account, and spreads different accounts', () => {
      const ids = Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      const offsets = ids.map(shiftOffsetSeconds);
      for (const offset of offsets) {
        expect(Number.isInteger(offset)).toBe(true);
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThanOrEqual(MAX_SHIFT_OFFSET_SECONDS);
      }
      expect(new Set(offsets).size).toBeGreaterThan(30);
      expect(ids.map(shiftOffsetSeconds)).toEqual(offsets);
    });

    it('lands inside the allowed whole hour, after its start', () => {
      for (const id of ['a', 'account-2', ACCOUNT, '9b1d7c4e-0000-4000-8000-000000000001']) {
        const { at, shifted } = shiftToAllowed(local('2026-10-14T21:30:00', NY), DEFAULTS, id);
        const shown = DateTime.fromJSDate(at, { zone: NY });
        expect(shifted).toBe(true);
        expect(shown.toISODate()).toBe('2026-10-15');
        expect(shown.hour).toBe(8);
        expect(at.getTime() - local('2026-10-15T08:00:00', NY).toMillis()).toBe(shiftOffsetSeconds(id) * 1000);
      }
    });

    it('is never added to a target that was already allowed', () => {
      const target = local('2026-10-14T09:00:00', NY);
      expect(shiftToAllowed(target, DEFAULTS, 'any-account').at).toEqual(target.toJSDate());
    });
  });

  describe('the search limit', () => {
    it('returns a target beyond 7 days from T0 as it is (Sunday night + 5 days lands on Monday): the jobs layer hops', () => {
      // T0 Sunday 22:30; follow-up 2 is due Friday 22:30 (quiet), then the weekend is skipped.
      const t0 = local('2026-10-11T22:30:00', NY);
      const result = shiftToAllowed(t0.plus({ days: 5 }), DEFAULTS, ACCOUNT);
      expect(result).toEqual({ at: wholeHourPlusOffset('2026-10-19T08:00:00', NY), shifted: true });
      expect(result.at.getTime() - t0.toMillis()).toBeGreaterThan(7 * DAY);
    });

    it('throws a QuietHoursError when no hour within 8 days is allowed', () => {
      // An end hour of 24 is out of range (validateQuietHours rejects it) and makes every hour quiet.
      const everyHourQuiet: QuietHoursSettings = { quietStartHour: 0, quietEndHour: 24, skipWeekends: false };
      expect(validateQuietHours(everyHourQuiet).ok).toBe(false);
      let caught: unknown;
      try {
        shift('2026-10-14T10:00:00', NY, everyHourQuiet);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(QuietHoursError);
      expect((caught as QuietHoursError).code).toBe('quiet_hours_no_allowed_hour');
      expect((caught as QuietHoursError).kind).toBe('permanent');
    });

    it('throws a QuietHoursError for an invalid target', () => {
      expect(() => shiftToAllowed(DateTime.fromISO('2026-10-14T10:00:00', { zone: 'Not/AZone' }), DEFAULTS, ACCOUNT)).toThrow(
        QuietHoursError,
      );
    });
  });
});
