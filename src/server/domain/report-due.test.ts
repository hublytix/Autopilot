import { describe, expect, it } from 'vitest';
import { isReportDue, reportWeek, reportZone } from './report-due';

// D-17: due from Monday 08:00 local (current ISO week) until Tuesday 00:00 local; the period is
// [Mon 08:00 − 1 week, Mon 08:00) computed in the zone, returned as UTC instants.

const utc = (iso: string): Date => new Date(iso);

describe('reportWeek', () => {
  it('covers [Mon 08:00 − 1 week, Mon 08:00) in New York (the simulation week)', () => {
    expect(reportWeek(utc('2026-10-12T12:00:00Z'), 'America/New_York')).toEqual({
      timezone: 'America/New_York',
      weekStart: '2026-10-12',
      periodStart: utc('2026-10-05T12:00:00Z'),
      periodEnd: utc('2026-10-12T12:00:00Z'),
      dueUntil: utc('2026-10-13T04:00:00Z'),
    });
  });

  it('keeps 08:00 local at both ends across the autumn DST change (7 days + 1 hour)', () => {
    // EDT → EST on Sun 2026-11-01.
    const week = reportWeek(utc('2026-11-02T13:00:00Z'), 'America/New_York');
    expect(week.weekStart).toBe('2026-11-02');
    expect(week.periodStart).toEqual(utc('2026-10-26T12:00:00Z'));
    expect(week.periodEnd).toEqual(utc('2026-11-02T13:00:00Z'));
    expect(week.periodEnd.getTime() - week.periodStart.getTime()).toBe((7 * 24 + 1) * 3_600_000);
    expect(week.dueUntil).toEqual(utc('2026-11-03T05:00:00Z'));
  });

  it('keeps 08:00 local at both ends across the spring DST change (7 days − 1 hour)', () => {
    // EST → EDT on Sun 2027-03-14.
    const week = reportWeek(utc('2027-03-15T12:30:00Z'), 'America/New_York');
    expect(week.weekStart).toBe('2027-03-15');
    expect(week.periodStart).toEqual(utc('2027-03-08T13:00:00Z'));
    expect(week.periodEnd).toEqual(utc('2027-03-15T12:00:00Z'));
    expect(week.periodEnd.getTime() - week.periodStart.getTime()).toBe((7 * 24 - 1) * 3_600_000);
  });

  it('keeps 08:00 local at both ends in London across its autumn change (BST → GMT, 7 days + 1 hour)', () => {
    // BST → GMT on Sun 2026-10-25.
    const week = reportWeek(utc('2026-10-26T08:00:00Z'), 'Europe/London');
    expect(week).toEqual({
      timezone: 'Europe/London',
      weekStart: '2026-10-26',
      periodStart: utc('2026-10-19T07:00:00Z'),
      periodEnd: utc('2026-10-26T08:00:00Z'),
      dueUntil: utc('2026-10-27T00:00:00Z'),
    });
    expect(week.periodEnd.getTime() - week.periodStart.getTime()).toBe((7 * 24 + 1) * 3_600_000);
  });

  it('keeps 08:00 local at both ends in the southern hemisphere (Auckland: NZDT ends Sun 2027-04-04, starts Sun 2026-09-27)', () => {
    const autumn = reportWeek(utc('2027-04-04T20:00:00Z'), 'Pacific/Auckland');
    expect(autumn).toMatchObject({ weekStart: '2027-04-05', periodStart: utc('2027-03-28T19:00:00Z'), periodEnd: utc('2027-04-04T20:00:00Z') });
    expect(autumn.periodEnd.getTime() - autumn.periodStart.getTime()).toBe((7 * 24 + 1) * 3_600_000);
    const spring = reportWeek(utc('2026-09-27T19:00:00Z'), 'Pacific/Auckland');
    expect(spring).toMatchObject({ weekStart: '2026-09-28', periodStart: utc('2026-09-20T20:00:00Z'), periodEnd: utc('2026-09-27T19:00:00Z') });
    expect(spring.periodEnd.getTime() - spring.periodStart.getTime()).toBe((7 * 24 - 1) * 3_600_000);
  });

  it('uses the ISO week: Sunday belongs to the week that started the Monday before, also across a year end', () => {
    expect(reportWeek(utc('2026-10-12T03:30:00Z'), 'America/New_York').weekStart).toBe('2026-10-05');
    expect(reportWeek(utc('2027-01-01T12:00:00Z'), 'America/New_York').weekStart).toBe('2026-12-28');
  });

  it('computes Asia/Kolkata (+05:30) and Asia/Kathmandu (+05:45) periods in local time', () => {
    expect(reportWeek(utc('2026-10-12T03:00:00Z'), 'Asia/Kolkata')).toMatchObject({
      weekStart: '2026-10-12',
      periodStart: utc('2026-10-05T02:30:00Z'),
      periodEnd: utc('2026-10-12T02:30:00Z'),
      dueUntil: utc('2026-10-12T18:30:00Z'),
    });
    expect(reportWeek(utc('2026-10-12T03:00:00Z'), 'Asia/Kathmandu')).toMatchObject({
      weekStart: '2026-10-12',
      periodStart: utc('2026-10-05T02:15:00Z'),
      periodEnd: utc('2026-10-12T02:15:00Z'),
      dueUntil: utc('2026-10-12T18:15:00Z'),
    });
  });

  it('reads an unknown or unusable zone as UTC and says so', () => {
    for (const zone of [null, undefined, '', 'Not/AZone']) {
      expect(reportZone(zone)).toBe('UTC');
      expect(reportWeek(utc('2026-10-12T09:00:00Z'), zone)).toMatchObject({
        timezone: 'UTC',
        weekStart: '2026-10-12',
        periodStart: utc('2026-10-05T08:00:00Z'),
        periodEnd: utc('2026-10-12T08:00:00Z'),
      });
    }
    expect(reportZone('UTC+5')).toBe('UTC+5');
  });
});

describe('isReportDue', () => {
  const cases: readonly [string, string, string, boolean][] = [
    // America/New_York, EDT (UTC−4)
    ['America/New_York', '2026-10-12T11:59:59Z', 'Mon 07:59:59', false],
    ['America/New_York', '2026-10-12T12:00:00Z', 'Mon 08:00 (the hourly cron on the hour)', true],
    ['America/New_York', '2026-10-13T03:59:59Z', 'Mon 23:59:59', true],
    ['America/New_York', '2026-10-13T04:00:00Z', 'Tue 00:00', false],
    ['America/New_York', '2026-10-11T12:00:00Z', 'Sun 08:00', false],
    ['America/New_York', '2026-10-14T12:00:00Z', 'Wed 08:00', false],
    // America/New_York, the Monday after the autumn change (EST, UTC−5)
    ['America/New_York', '2026-11-02T12:00:00Z', 'Mon 07:00 EST', false],
    ['America/New_York', '2026-11-02T13:00:00Z', 'Mon 08:00 EST', true],
    ['America/New_York', '2026-11-03T04:00:00Z', 'Mon 23:00 EST', true],
    ['America/New_York', '2026-11-03T05:00:00Z', 'Tue 00:00 EST', false],
    // America/New_York, the Monday after the spring change (EDT, UTC−4)
    ['America/New_York', '2027-03-15T11:00:00Z', 'Mon 07:00 EDT', false],
    ['America/New_York', '2027-03-15T12:00:00Z', 'Mon 08:00 EDT', true],
    // Asia/Kolkata (+05:30): the hourly cron first sees it at 08:30
    ['Asia/Kolkata', '2026-10-12T02:00:00Z', 'Mon 07:30', false],
    ['Asia/Kolkata', '2026-10-12T03:00:00Z', 'Mon 08:30', true],
    ['Asia/Kolkata', '2026-10-12T18:00:00Z', 'Mon 23:30', true],
    ['Asia/Kolkata', '2026-10-12T19:00:00Z', 'Tue 00:30', false],
    // Asia/Kathmandu (+05:45): first at 08:45
    ['Asia/Kathmandu', '2026-10-12T02:00:00Z', 'Mon 07:45', false],
    ['Asia/Kathmandu', '2026-10-12T03:00:00Z', 'Mon 08:45', true],
    ['Asia/Kathmandu', '2026-10-12T18:00:00Z', 'Mon 23:45', true],
    ['Asia/Kathmandu', '2026-10-12T19:00:00Z', 'Tue 00:45', false],
  ];

  it.each(cases)('%s at %s (%s) → due %s', (zone, iso, _local, due) => {
    expect(isReportDue(utc(iso), zone).due).toBe(due);
  });

  // Thursday-to-Friday spans, each holding one Monday: an ordinary week, and the weeks of the London
  // (Oct 25), New York (Nov 1, Mar 14) and New Zealand/Chatham (Sep 27, Apr 4) clock changes.
  const SPANS: readonly [string, number, number, number][] = [
    ['ordinary week', 2026, 9, 9],
    ['NZ/Chatham spring change', 2026, 8, 24],
    ['London autumn change', 2026, 9, 22],
    ['New York autumn change', 2026, 9, 29],
    ['New York spring change', 2027, 2, 11],
    ['NZ/Chatham autumn change', 2027, 3, 1],
  ];
  const ZONES = ['America/New_York', 'Asia/Kolkata', 'Asia/Kathmandu', 'Pacific/Auckland', 'Europe/London', 'Pacific/Chatham'];

  it.each(SPANS)('gives every zone at least 15 hourly cron runs inside one week\'s window (%s)', (_label, year, month, day) => {
    for (const zone of ZONES) {
      const runs: Date[] = [];
      for (let hour = 0; hour < 24 * 8; hour += 1) runs.push(new Date(Date.UTC(year, month, day, hour)));
      const dueRuns = runs.filter((run) => isReportDue(run, zone).due);
      expect(dueRuns.length, zone).toBeGreaterThanOrEqual(15);
      expect(new Set(dueRuns.map((run) => isReportDue(run, zone).weekStart)).size, zone).toBe(1);
      for (const run of dueRuns) {
        const week = isReportDue(run, zone);
        // 08:00 local at both ends: 7 days, ± 1 hour in a week with a clock change.
        expect(Math.abs(week.periodEnd.getTime() - week.periodStart.getTime() - 7 * 24 * 3_600_000), zone).toBeLessThanOrEqual(3_600_000);
      }
    }
  });

  it('returns the week and period with the answer', () => {
    expect(isReportDue(utc('2026-10-12T15:00:00Z'), 'America/New_York')).toEqual({
      timezone: 'America/New_York',
      weekStart: '2026-10-12',
      periodStart: utc('2026-10-05T12:00:00Z'),
      periodEnd: utc('2026-10-12T12:00:00Z'),
      dueUntil: utc('2026-10-13T04:00:00Z'),
      due: true,
    });
  });
});
