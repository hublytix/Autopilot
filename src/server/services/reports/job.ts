import 'server-only';
import { computeWeeklyMetrics, type WeeklyMetrics } from '@/server/domain/weekly-metrics';
import { JobOutcomes, type JobContext, type JobFailureInfo, type JobHandler, type JobOutcome, type JobRow, type Registration } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { latestBaseline } from '@/server/services/baseline/repository';
import type { Sleep } from '@/server/services/hubspot';
import { hubspotContactRecordUrl } from '@/server/services/leads/record-link';
import { getNotification } from '@/server/services/notifications/reserve';
import type { NotificationRegistry } from '@/server/services/notifications/renderers';
import { reserveAndSend } from '@/server/services/notifications/send';
import { registerWeeklyReportNotifications, weeklyReportPlan } from './email';
import { isWeekStart, reportEmailKey, reportJobKey, type ReportRef } from './keys';
import { REPORT_REFRESH_BUDGET_MS, refreshReportSignals } from './refresh';
import {
  isReportable,
  loadMetricLeads,
  loadReport,
  loadReportAccount,
  markReportFailed,
  markReportSent,
  storeMetrics,
  type ReportAccount,
  type ReportRow,
} from './repository';

// The `weekly_report` job (PLAN §8.2, §9.8, D-17, D-37). After the dispatcher's claim:
// 1. the report row (`report:{acct}:{week_start}`); `sent` → done. Its email already `sent` → the
//    report is marked sent, done; already `failed` → the report is `failed`, skipped (it can never go);
// 2. the account must still get a report (onboarding complete, `active`, connection active), else
//    skipped: no report this week (D-17);
// 3. unless the email is already reserved (an earlier attempt computed what it is sending): the
//    signals are refreshed (refresh.ts), computeWeeklyMetrics runs on the rows, the baseline, the
//    logging mode and the granted scopes, and the metrics are stored BEFORE the email is reserved
//    (guarded by the claim), so a resume re-renders exactly them;
// 4. reserveAndSend `weekly_report` (guard = the claim), onSent → `sent`.
// Outcomes: sent / already sent / busy → done; the predicates failed (the account stopped being
// active meanwhile) → skipped; a permanent send error → permanent (the failure path: `failed`); a
// retryable error (HubSpot, Resend) → retried by QStash, and after the last delivery the failure
// path; the sweeper re-enqueues a failed report while attempts < 3, before local Tuesday 00:00.
// Logs carry ids, codes and counts only.

export interface WeeklyReportJobOptions {
  /** The portal limiter's wait; tests and the simulation advance their FakeClock. */
  readonly sleep?: Sleep | undefined;
  /** The registry holding the reply_detected resumer (a refresh may record a reply). */
  readonly notifications?: NotificationRegistry | undefined;
  /** Default REPORT_REFRESH_BUDGET_MS. */
  readonly refreshBudgetMs?: number | undefined;
}

/** The job's account and week: `job.account_id` and `payload.weekStart`, which must match the key. */
export function reportRefOf(job: Pick<JobRow, 'accountId' | 'dedupeKey' | 'payload'>): ReportRef | null {
  const weekStart = job.payload.weekStart;
  if (job.accountId === null || !isWeekStart(weekStart)) return null;
  const ref = { accountId: job.accountId, weekStart };
  return reportJobKey(ref) === job.dedupeKey ? ref : null;
}

async function computeAndStore(
  deps: Deps,
  ctx: JobContext,
  report: ReportRow,
  account: ReportAccount,
  unchecked: readonly string[],
): Promise<WeeklyMetrics | null> {
  const rows = await loadMetricLeads(deps.db, report.accountId, report.period);
  const baseline = await latestBaseline(deps.db, report.accountId);
  const metrics = computeWeeklyMetrics(
    rows,
    baseline,
    account.loggingMode,
    account.scopes,
    report.period,
    (contactId) => hubspotContactRecordUrl(account.uiDomain, account.portalId, contactId),
    { unchecked: new Set(unchecked) },
  );
  const stored = await deps.db.tx(async (tx) => {
    await ctx.assertOwned(tx);
    return storeMetrics(tx, report.id, metrics);
  });
  return stored ? metrics : null;
}

export function createWeeklyReportHandler(options: WeeklyReportJobOptions = {}): JobHandler {
  return async function weeklyReportHandler(deps: Deps, job: JobRow, ctx: JobContext): Promise<JobOutcome> {
    const ref = reportRefOf(job);
    if (ref === null) return { type: 'permanent', code: 'weekly_report_payload_invalid' };
    const fields = { accountId: ref.accountId, jobId: job.id };

    const report = await loadReport(deps.db, ref);
    if (report === null) {
      log.info('weekly report skipped: no report row', { event: 'weekly_report.skipped', reason: 'no_report', ...fields });
      return JobOutcomes.skipped();
    }
    if (report.status === 'sent') return JobOutcomes.done();
    const emailKey = reportEmailKey(ref);
    const existing = await getNotification(deps.db, emailKey);
    if (existing?.status === 'sent') {
      await markReportSent(deps.db, report.id);
      return JobOutcomes.done();
    }
    if (existing?.status === 'failed') {
      await markReportFailed(deps.db, ref);
      log.info('weekly report skipped: its email failed earlier', { event: 'weekly_report.skipped', reason: 'email_failed', reportId: report.id, ...fields });
      return JobOutcomes.skipped();
    }

    const account = await loadReportAccount(deps.db, ref.accountId);
    if (account === null || !isReportable(account)) {
      log.info('weekly report skipped: account not active', {
        event: 'weekly_report.skipped',
        reason: 'account_not_active',
        processingState: account?.processingState ?? null,
        reportId: report.id,
        ...fields,
      });
      return JobOutcomes.skipped();
    }

    let metrics = existing === null ? null : report.metrics;
    if (metrics === null) {
      const refreshed = await refreshReportSignals(deps, {
        accountId: ref.accountId,
        period: report.period,
        deadlineMs: ctx.claimedAt.getTime() + (options.refreshBudgetMs ?? REPORT_REFRESH_BUDGET_MS),
        sleep: options.sleep,
        notifications: options.notifications,
      });
      if (refreshed.type === 'revoked') {
        log.info('weekly report skipped: connection revoked', { event: 'weekly_report.skipped', reason: 'revoked', code: refreshed.code, reportId: report.id, ...fields });
        return JobOutcomes.skipped();
      }
      metrics = await computeAndStore(deps, ctx, report, account, refreshed.unchecked);
      // Sent meanwhile by another attempt (or the sweeper): nothing more to do.
      if (metrics === null) return JobOutcomes.done();
      log.info('weekly report computed', {
        event: 'weekly_report.computed',
        reportId: report.id,
        count: refreshed.refreshed,
        skipped: refreshed.unchecked.length,
        remaining: refreshed.unread,
        total: metrics.cohort.leadsIn,
        ...fields,
      });
    }

    const plan = weeklyReportPlan(deps, { account, report, metrics });
    if (plan === null) return { type: 'permanent', code: 'weekly_report_no_recipients' };
    const result = await reserveAndSend(deps, {
      kind: 'weekly_report',
      dedupeKey: emailKey,
      accountId: ref.accountId,
      ...plan,
      guard: (tx) => ctx.assertOwned(tx),
    });
    switch (result.status) {
      case 'sent':
      case 'already_sent':
        await markReportSent(deps.db, report.id);
        return JobOutcomes.done();
      case 'failed':
        return { type: 'permanent', code: result.code };
      case 'skipped':
        switch (result.reason) {
          case 'busy':
            return JobOutcomes.done();
          case 'predicates':
            log.info('weekly report skipped: account not active', { event: 'weekly_report.skipped', reason: 'predicates', reportId: report.id, ...fields });
            return JobOutcomes.skipped();
          case 'failed_earlier':
            await markReportFailed(deps.db, ref);
            return JobOutcomes.skipped();
          default:
            return { type: 'permanent', code: `weekly_report_${result.reason}` };
        }
    }
  };
}

/** PLAN §8.3 step 6: `weekly_reports.status = 'failed'` (never over `sent`); the sweeper may re-enqueue it. */
export async function weeklyReportFailurePath(deps: Deps, job: JobRow, info: JobFailureInfo): Promise<void> {
  const ref = reportRefOf(job);
  if (ref === null) return;
  const changed = await markReportFailed(deps.db, ref);
  log.warn('weekly report failed', { event: 'weekly_report.failed', accountId: ref.accountId, jobId: job.id, code: info.code, reason: info.reason, count: changed ? 1 : 0 });
}

/** Added to REGISTRATIONS in src/server/jobs/handlers.ts: the job, its failure path, the email's resumer and failure hook. */
export const registerWeeklyReportJob: Registration = ({ jobs, notifications, limiterSleep }) => {
  jobs.register('weekly_report', createWeeklyReportHandler({ sleep: limiterSleep, notifications }));
  jobs.registerFailurePath('weekly_report', weeklyReportFailurePath);
  registerWeeklyReportNotifications({ notifications });
};
