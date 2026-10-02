import 'server-only';
import { DateTime } from 'luxon';
import {
  NOT_ENOUGH_DATA,
  NOT_ENOUGH_LOGGED_HISTORY,
  WEEKLY_REPORT_LABELS,
  type WeeklyReportComparison,
  type WeeklyReportProps,
  type WeeklyReportWaiting,
} from '@/emails/WeeklyReport';
import { baselineReasonIsLoggedHistory } from '@/server/domain/baseline';
import { reportZone } from '@/server/domain/report-due';
import type { WeeklyMetrics } from '@/server/domain/weekly-metrics';

// The stored metrics as the WeeklyReport email shows them (PLAN §9.8 step 5, D-37): every label is
// D-37's, a null is "Not enough data" (the baseline's own gap is "Not enough logged history"), times
// are in the zone the period was computed in. Built from the stored metrics alone, so the first send
// and a resumed one (the sweeper) render the same email.

export interface WeeklyReportPresentation {
  productName: string;
  /** `weekly_reports.timezone`. */
  timezone: string;
  /** `{APP_URL}/dashboard`. */
  dashboardUrl: string;
}

function local(iso: string, zone: string): DateTime {
  return DateTime.fromISO(iso, { zone: reportZone(zone) }).setLocale('en-GB');
}

/** "Mon 5 Oct". */
function day(iso: string, zone: string): string {
  return local(iso, zone).toFormat('ccc d LLL');
}

/** "Tue 6 Oct, 10:05". */
function dayTime(iso: string, zone: string): string {
  return local(iso, zone).toFormat('ccc d LLL, HH:mm');
}

/** "21 min", "3 h 30 min", "23 h 30 min", "2 d 3 h"; whole minutes. */
export function formatWait(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'under 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

function count(value: number | null): string | null {
  return value === null ? null : String(value);
}

function orNotEnough(value: string | null): string {
  return value ?? NOT_ENOUGH_DATA;
}

/** "Mon 5 Oct – Mon 12 Oct": the subject's and the heading's week. */
export function weekLabelOf(metrics: WeeklyMetrics, zone: string): string {
  return `${day(metrics.period.start, zone)} – ${day(metrics.period.end, zone)}`;
}

function waitingOf(metrics: WeeklyMetrics, zone: string): WeeklyReportWaiting {
  const waiting = metrics.cohort.waiting;
  if (waiting === null) return { kind: 'unconfirmable' };
  return {
    kind: 'list',
    value: String(waiting.count),
    leads: waiting.leads.map((lead) => ({ text: `Lead submitted ${dayTime(lead.submittedAt, zone)}`, recordUrl: lead.recordUrl })),
    more: waiting.more,
  };
}

function comparisonOf(metrics: WeeklyMetrics): WeeklyReportComparison {
  const comparison = metrics.comparison;
  // The onboarding baseline page's words (D-77): logging that can't be read → "Not enough logged
  // history"; no baseline, too many submissions or no leads → "Not enough data".
  if (comparison.baseline === 'none') return { kind: 'unavailable', text: NOT_ENOUGH_DATA };
  if (comparison.baseline !== 'ok') {
    return { kind: 'unavailable', text: baselineReasonIsLoggedHistory(comparison.baseline) ? NOT_ENOUGH_LOGGED_HISTORY : NOT_ENOUGH_DATA };
  }
  const wait = (seconds: number | null): string => orNotEnough(seconds === null ? null : formatWait(seconds));
  const percent = (value: number | null): string => orNotEnough(value === null ? null : `${value}%`);
  return {
    kind: 'rows',
    rows: [
      { label: WEEKLY_REPORT_LABELS.median, baseline: wait(comparison.baselineMedianSeconds), thisWeek: wait(comparison.medianSeconds) },
      {
        label: WEEKLY_REPORT_LABELS.percentWithoutReply,
        baseline: percent(comparison.baselinePercentWithoutReply),
        thisWeek: percent(comparison.percentWithoutReply),
      },
    ],
  };
}

export function weeklyReportProps(metrics: WeeklyMetrics, input: WeeklyReportPresentation): WeeklyReportProps {
  const zone = reportZone(input.timezone);
  const cohort = metrics.cohort;
  const median = cohort.medianTimeToFirstReply.seconds;
  return {
    productName: input.productName,
    weekLabel: weekLabelOf(metrics, zone),
    periodLine: `From ${dayTime(metrics.period.start, zone)} to ${dayTime(metrics.period.end, zone)} (${zone}).`,
    rows: [
      { label: WEEKLY_REPORT_LABELS.leadsIn, value: String(cohort.leadsIn) },
      { label: WEEKLY_REPORT_LABELS.filtered, value: String(cohort.filtered) },
      { label: WEEKLY_REPORT_LABELS.draftsEmailed, value: String(cohort.draftsEmailed) },
      { label: WEEKLY_REPORT_LABELS.sendsConfirmed, value: count(cohort.sendsConfirmed) },
      { label: WEEKLY_REPORT_LABELS.sendLinkOpened, value: String(cohort.sendLinkOpenedNotConfirmed) },
      { label: WEEKLY_REPORT_LABELS.median, value: median === null ? null : formatWait(median) },
    ],
    waiting: waitingOf(metrics, zone),
    // Without the email scope nothing can be checked at all, which the waiting line already says.
    unchecked: metrics.basis.emailScope ? cohort.unchecked : 0,
    activity: [
      { label: WEEKLY_REPORT_LABELS.replies, value: count(metrics.events.repliesFromLeads) },
      { label: WEEKLY_REPORT_LABELS.followUps, value: String(metrics.events.followUpsDrafted) },
    ],
    comparison: comparisonOf(metrics),
    dashboardUrl: input.dashboardUrl,
  };
}
