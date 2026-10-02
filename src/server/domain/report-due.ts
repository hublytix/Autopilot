import 'server-only';
import { DateTime } from 'luxon';

// The Monday report's due-check and period (D-17, PLAN §7.3, §9.8 step 2). Pure.
//
// - Due: the account's local time is at or after Monday 08:00 of the current ISO week and before
//   Tuesday 00:00 (so the hourly cron always gets one chance in the window, whatever the zone's
//   offset: Kolkata +05:30 and Kathmandu +05:45 are first due at the cron after 08:00 local).
// - Week: the Monday of that ISO week ('YYYY-MM-DD'), stored as `weekly_reports.week_start`.
// - Period: [Monday 08:00 local − 1 week, Monday 08:00 local), half-open. The week is subtracted in
//   the zone (Luxon calendar arithmetic), so both ends are 08:00 local even across a DST change: the
//   period is 7 days ± 1 hour in such a week.
// The zone is the account's IANA zone (or a Luxon fixed offset); an unknown or unusable one is read
// as UTC, and the zone actually used is returned so the row can store it.

/** The local hour the report is due from (brief §5.9). */
export const REPORT_LOCAL_HOUR = 8;

export interface ReportWeek {
  /** The zone the week and period were computed in. */
  readonly timezone: string;
  /** The Monday of the current ISO week in that zone, 'YYYY-MM-DD'. */
  readonly weekStart: string;
  /** Monday 08:00 local minus one week, as a UTC instant (inclusive). */
  readonly periodStart: Date;
  /** Monday 08:00 local, as a UTC instant (exclusive). */
  readonly periodEnd: Date;
  /** Tuesday 00:00 local after `weekStart`: the end of the due window. */
  readonly dueUntil: Date;
}

export interface ReportDue extends ReportWeek {
  /** `periodEnd ≤ now < dueUntil`. */
  readonly due: boolean;
}

/** `zone` when Luxon can use it, else UTC. */
export function reportZone(zone: string | null | undefined): string {
  if (zone === null || zone === undefined || zone.trim() === '') return 'UTC';
  return DateTime.fromMillis(0, { zone }).isValid ? zone : 'UTC';
}

/** The report week containing `now` (its Monday, period and due window), in `zone`. */
export function reportWeek(now: Date, zone: string | null | undefined): ReportWeek {
  const timezone = reportZone(zone);
  const local = DateTime.fromJSDate(now, { zone: timezone });
  const monday = local.startOf('week');
  const reportAt = monday.set({ hour: REPORT_LOCAL_HOUR, minute: 0, second: 0, millisecond: 0 });
  return {
    timezone,
    weekStart: monday.toFormat('yyyy-MM-dd'),
    periodStart: reportAt.minus({ weeks: 1 }).toJSDate(),
    periodEnd: reportAt.toJSDate(),
    dueUntil: monday.plus({ days: 1 }).startOf('day').toJSDate(),
  };
}

/** D-17's due-check for an account whose local zone is `zone`, at `now`. */
export function isReportDue(now: Date, zone: string | null | undefined): ReportDue {
  const week = reportWeek(now, zone);
  const at = now.getTime();
  return { ...week, due: at >= week.periodEnd.getTime() && at < week.dueUntil.getTime() };
}
