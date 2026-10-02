import 'server-only';
import { NotificationKeys } from '@/server/services/notifications/predicates';

// The Monday report's keys (PLAN §8.2, §8.4): the `weekly_report` job and its email share
// `report:{acct}:{week_start}` (the sweeper's re-enqueue joins weekly_reports through the job's key,
// D-54). `week_start` is the report week's Monday, 'YYYY-MM-DD'.

export interface ReportRef {
  readonly accountId: string;
  readonly weekStart: string;
}

const REPORT_KEY = /^report:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{4}-\d{2}-\d{2})$/;
const WEEK_START = /^\d{4}-\d{2}-\d{2}$/;

/** `scheduled_jobs.dedupe_key` of the report's job (without the ENV_NAMESPACE prefix). */
export function reportJobKey(ref: ReportRef): string {
  return `report:${ref.accountId}:${ref.weekStart}`;
}

/** `notifications_sent.dedupe_key` of the report's email. */
export function reportEmailKey(ref: ReportRef): string {
  return NotificationKeys.weeklyReport(ref.accountId, ref.weekStart);
}

/** The account and week of a `report:{acct}:{week_start}` key; null for any other key. */
export function parseReportKey(key: string): ReportRef | null {
  const match = REPORT_KEY.exec(key);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { accountId: match[1], weekStart: match[2] };
}

export function isWeekStart(value: unknown): value is string {
  return typeof value === 'string' && WEEK_START.test(value);
}
