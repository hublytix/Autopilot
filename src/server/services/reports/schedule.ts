import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { shiftOffsetSeconds } from '@/server/domain/quiet-hours';
import { isReportDue } from '@/server/domain/report-due';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import type { JobRow } from '@/server/jobs/types';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { reportJobKey } from './keys';

// The hourly due-check (PLAN §7.3 `/api/cron/weekly-report`, §8.1, D-17). For each account that gets
// a report (onboarding complete, processing_state `active`) and is due (Monday 08:00 local or later,
// before Tuesday 00:00, in its zone) without a `weekly_reports` row for that week: the report row
// (`pending`, attempts 0, the zone and the period) and its `weekly_report` job
// (`report:{acct}:{week_start}`) are inserted in ONE transaction. The job runs no earlier than
// REPORT_INTAKE_GRACE_MS after the period end, so a lead submitted just before Monday 08:00 has been
// taken in by then (two 5-minute polls plus processing; D-77) — the next week's cohort starts at
// 08:00 by submission time and would never count it — then staggered by a stable 0–10 min offset
// of the account's HubSpot portal id so the accounts of one zone don't all read HubSpot at once (the
// portal id, not the random account id, so a replayed week lands at the same minute: the
// simulation's repeat runs are identical, D-74); the jobs are published after commit (a failed
// publish is left to the sweeper). An existing row (any status) is never touched: a failed report
// is re-enqueued only by the sweeper. Counts only.

export interface WeeklyReportScheduleSummary {
  /** Accounts that get a report (onboarding complete, `active`). */
  accounts: number;
  /** Of those, due now. */
  due: number;
  /** Report rows and jobs created by this run. */
  created: number;
  /** Due, but the week's row already exists. */
  existing: number;
  published: number;
  publishFailed: number;
  errors: number;
}

/** How long after the period end the report waits for leads submitted just before it to be taken in (D-77). */
export const REPORT_INTAKE_GRACE_MS = 15 * 60 * 1000;

/** The account's stagger: a stable 0–600 s of its portal id (D-33's FNV offset, D-74). */
export function reportStaggerMs(portalId: string): number {
  return shiftOffsetSeconds(portalId) * 1000;
}

/** When the report job runs: the grace after the period end (or now, if later), plus the stagger. */
export function reportRunAt(now: Date, periodEnd: Date, portalId: string): Date {
  return new Date(Math.max(now.getTime(), periodEnd.getTime() + REPORT_INTAKE_GRACE_MS) + reportStaggerMs(portalId));
}

interface AccountRow {
  id: string;
  hubspot_portal_id: string;
  timezone: string | null;
  last_week_start: string | null;
}

export async function scheduleWeeklyReports(deps: Deps): Promise<WeeklyReportScheduleSummary> {
  const now = deps.clock.now();
  const summary: WeeklyReportScheduleSummary = { accounts: 0, due: 0, created: 0, existing: 0, published: 0, publishFailed: 0, errors: 0 };
  const accounts = await deps.db.query<AccountRow>(
    `select a.id, a.hubspot_portal_id, a.timezone,
            (select max(wr.week_start)::text from weekly_reports wr where wr.account_id = a.id) as last_week_start
       from accounts a
      where a.processing_state = 'active' and a.onboarding_completed_at is not null
      order by a.id`,
  );
  summary.accounts = accounts.length;

  const jobs: JobRow[] = [];
  for (const account of accounts) {
    const due = isReportDue(now, account.timezone);
    if (!due.due) continue;
    summary.due += 1;
    if (account.last_week_start !== null && account.last_week_start >= due.weekStart) {
      summary.existing += 1;
      continue;
    }
    try {
      const job = await deps.db.tx(async (tx) => {
        const report = await tx.maybeOne<{ id: string }>(
          `insert into weekly_reports (account_id, week_start, timezone, period_start, period_end, status, attempts)
           values ($1, $2::date, $3, $4, $5, 'pending', 0)
           on conflict (account_id, week_start) do nothing
           returning id`,
          [account.id, due.weekStart, due.timezone, due.periodStart, due.periodEnd],
        );
        if (report === null) return null;
        return insertJob(tx, {
          kind: 'weekly_report',
          accountId: account.id,
          dedupeKey: reportJobKey({ accountId: account.id, weekStart: due.weekStart }),
          payload: { reportId: report.id, weekStart: due.weekStart },
          runAt: reportRunAt(now, due.periodEnd, account.hubspot_portal_id),
          now,
        });
      });
      if (job === null) {
        summary.existing += 1;
        continue;
      }
      summary.created += 1;
      jobs.push(job);
    } catch (error) {
      summary.errors += 1;
      log.warn('weekly report not scheduled', { event: 'weekly_report.schedule_error', accountId: account.id, code: errorCode(error) }, error);
    }
  }

  const published = await publishJobs(deps, jobs);
  summary.published = published.published.length;
  summary.publishFailed = published.failed.length;
  if (summary.created > 0 || summary.errors > 0) {
    log.info('weekly reports scheduled', { event: 'weekly_report.scheduled', count: summary.created, total: summary.due, skipped: summary.existing });
  }
  return summary;
}
