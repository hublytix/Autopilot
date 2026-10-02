import 'server-only';
import { DateTime } from 'luxon';
import { errorCode, PermanentError } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import {
  failReservation,
  NOTIFICATION_COLUMNS,
  resumeReservation,
  toNotificationRow,
  type NotificationRegistry,
} from '@/server/services/notifications';
import { raiseAlert } from './alert';
import { failJobIfUnchanged, runFailurePath } from './failure';
import { ensureJobHandlersRegistered } from './handlers';
import { publishJob } from './outbox';
import type { JobRegistry } from './registry';
import { republishJob } from './republish';
import { JOB_COLUMNS, targetAtOf, toJobRow } from './rows';
import { JOB_MAX_ATTEMPTS, type JobRow } from './types';

// The sweeper (PLAN §8.3 step 7, D-15, D-45), run by the poll cron. Every action is a
// compare-and-set, so overlapping sweeps (or a delivery racing one) do each thing once:
// - a `scheduled` row never published (external_id null) for 2 min → publish. A re-published row
//   (hops > 0) counts from its run_at, not its created_at: right after a hop, re-target or
//   re-publish compare-and-set its publish is in flight, and publishing the same `:h{hops}` id
//   first would make that publish come back deduplicated (a false `job_republish_deduplicated`);
// - a `scheduled` row whose run_at is over 30 min past → re-publish (the message was lost);
// - a `running` row whose lease expired → re-publish (the attempt died);
//   both re-publish for the job's real target (`payload.targetAt`) when it is still ahead, so a
//   lost hop message never makes the job run early (publishJob clamps to the QStash maximum delay
//   and the next delivery hops again), else for now;
// - any of those with attempts ≥ 6 → the failure path instead;
// - a failed `weekly_report` job while weekly_reports.attempts < 3 and before local Tuesday 00:00
//   → back to scheduled (claim count reset) and re-published;
// - a `notifications_sent` row still `sending`, first reserved under 23 h ago and untouched for
//   min(10 min × 2^sweeper_resumes, 2 h) → resumed through the takeover (§8.4 step 2); rows first
//   reserved 23 h ago or more → failed with one alert each; `magic_link` rows → failed.

export const UNPUBLISHED_GRACE_MS = 2 * 60 * 1000;
export const MISSED_RUN_MS = 30 * 60 * 1000;
/** Inside Resend's 24 h idempotency window. */
export const NOTIFICATION_RESUME_WINDOW_MS = 23 * 60 * 60 * 1000;
export const WEEKLY_REPORT_MAX_ATTEMPTS = 3;

export interface SweepOptions {
  /** Default: the process registries with everything registered (ensureJobHandlersRegistered). */
  jobRegistry?: JobRegistry | undefined;
  notificationRegistry?: NotificationRegistry | undefined;
  /** Rows per rule per sweep. Default 50. */
  limit?: number | undefined;
}

export interface SweepSummary {
  published: number;
  republished: number;
  failed: number;
  weeklyReportsRequeued: number;
  notificationsResumed: number;
  notificationsExpired: number;
  errors: number;
}

export async function runSweeper(deps: Deps, options: SweepOptions = {}): Promise<SweepSummary> {
  const jobRegistry = options.jobRegistry ?? ensureJobHandlersRegistered().jobs;
  const notificationRegistry = options.notificationRegistry ?? ensureJobHandlersRegistered().notifications;
  const limit = options.limit ?? 50;
  const summary: SweepSummary = {
    published: 0,
    republished: 0,
    failed: 0,
    weeklyReportsRequeued: 0,
    notificationsResumed: 0,
    notificationsExpired: 0,
    errors: 0,
  };
  const now = deps.clock.now();

  const unpublished = await selectJobs(
    deps,
    `status = 'scheduled' and external_id is null and created_at < $1 and (hops = 0 or run_at < $1) order by created_at`,
    [new Date(now.getTime() - UNPUBLISHED_GRACE_MS)],
    limit,
  );
  for (const job of unpublished) {
    await sweepJob(deps, job, jobRegistry, summary, async () => {
      await publishJob(deps, job, 'first');
      summary.published += 1;
    });
  }

  const missed = await selectJobs(
    deps,
    `status = 'scheduled' and external_id is not null and run_at < $1 order by run_at`,
    [new Date(now.getTime() - MISSED_RUN_MS)],
    limit,
  );
  const expired = await selectJobs(deps, `status = 'running' and lease_until < $1 order by lease_until`, [now], limit);
  for (const job of [...missed, ...expired]) {
    await sweepJob(deps, job, jobRegistry, summary, async () => {
      const at = deps.clock.now();
      const target = targetAtOf(job);
      const runAt = target !== null && target.getTime() > at.getTime() ? target : at;
      const moved = await republishJob(deps, job, runAt, { type: 'hops', hops: job.hops });
      if (moved !== null) summary.republished += 1;
    });
  }

  await requeueWeeklyReports(deps, summary, limit);
  await sweepNotifications(deps, notificationRegistry, summary, limit);

  for (const [action, count] of Object.entries(summary)) {
    if (count > 0) log.info('sweeper action count', { event: `jobs.sweep.${action}`, count });
  }
  return summary;
}

async function selectJobs(deps: Deps, where: string, params: unknown[], limit: number): Promise<JobRow[]> {
  const rows = await deps.db.query(`select ${JOB_COLUMNS} from scheduled_jobs where ${where} limit ${Math.max(1, Math.floor(limit))}`, params);
  return rows.map(toJobRow);
}

/** Runs `action` for a row, or the failure path when the row has been claimed too often. */
async function sweepJob(deps: Deps, job: JobRow, registry: JobRegistry, summary: SweepSummary, action: () => Promise<void>): Promise<void> {
  try {
    if (job.attempts >= JOB_MAX_ATTEMPTS) {
      const won = await failJobIfUnchanged(deps, job);
      if (won !== null) {
        summary.failed += 1;
        await runFailurePath(deps, won, { reason: 'sweeper', code: won.lastErrorCode ?? 'job_too_many_attempts' }, registry);
      }
      return;
    }
    await action();
  } catch (error) {
    summary.errors += 1;
    log.warn('sweeper action failed', { event: 'jobs.sweep_error', jobId: job.id, jobKind: job.kind, code: errorCode(error) }, error);
  }
}

class ReportChangedError extends PermanentError<'weekly_report_changed'> {
  constructor() {
    super('weekly_report_changed');
  }
}

interface FailedReportJob {
  job: JobRow;
  reportId: string;
  weekStart: string;
  timezone: string;
  reportAttempts: number;
}

/** A failed report is retried while attempts < 3 and it is still before Tuesday 00:00 in the report's zone (D-17). */
async function requeueWeeklyReports(deps: Deps, summary: SweepSummary, limit: number): Promise<void> {
  const jobColumns = JOB_COLUMNS.split(', ')
    .map((column) => `j.${column}`)
    .join(', ');
  const rows = await deps.db.query<Record<string, unknown> & { report_id: string; week_start: string; timezone: string; report_attempts: number }>(
    `select ${jobColumns}, wr.id as report_id, wr.week_start::text as week_start, wr.timezone, wr.attempts as report_attempts
       from scheduled_jobs j
       join weekly_reports wr
         on wr.account_id = j.account_id and j.dedupe_key = 'report:' || wr.account_id::text || ':' || wr.week_start::text
      where j.kind = 'weekly_report' and j.status = 'failed' and wr.attempts < $1 and wr.status <> 'sent'
      limit ${Math.max(1, Math.floor(limit))}`,
    [WEEKLY_REPORT_MAX_ATTEMPTS],
  );
  const now = deps.clock.now();
  const candidates: FailedReportJob[] = rows.map((row) => ({
    // toJobRow keeps only the job's columns.
    job: toJobRow(row),
    reportId: row.report_id,
    weekStart: row.week_start,
    timezone: row.timezone,
    reportAttempts: row.report_attempts,
  }));
  for (const candidate of candidates) {
    const tuesday = DateTime.fromISO(candidate.weekStart, { zone: candidate.timezone }).plus({ days: 1 });
    if (!tuesday.isValid || now.getTime() >= tuesday.toMillis()) continue;
    try {
      const requeued = await deps.db
        .tx(async (tx) => {
          const raw = await tx.maybeOne(
            `update scheduled_jobs
                set status = 'scheduled', run_at = $2, lease_until = null, attempts = 0, hops = hops + 1,
                    external_id = null, published_at = null, finished_at = null
              where id = $1 and status = 'failed'
              returning ${JOB_COLUMNS}`,
            [candidate.job.id, deps.clock.now()],
          );
          if (raw === null) return null;
          const report = await tx.query(
            `update weekly_reports set status = 'pending', attempts = attempts + 1 where id = $1 and attempts = $2 returning id`,
            [candidate.reportId, candidate.reportAttempts],
          );
          if (report.length !== 1) throw new ReportChangedError();
          return toJobRow(raw);
        })
        .catch((error: unknown) => {
          if (error instanceof ReportChangedError) return null;
          throw error;
        });
      if (requeued === null) continue;
      summary.weeklyReportsRequeued += 1;
      await publishJob(deps, requeued, 'republish');
    } catch (error) {
      summary.errors += 1;
      log.warn('weekly report requeue failed', { event: 'jobs.sweep_error', jobId: candidate.job.id, reportId: candidate.reportId, code: errorCode(error) }, error);
    }
  }
}

async function sweepNotifications(deps: Deps, registry: NotificationRegistry, summary: SweepSummary, limit: number): Promise<void> {
  const now = deps.clock.now();
  const windowStart = new Date(now.getTime() - NOTIFICATION_RESUME_WINDOW_MS);
  const cap = Math.max(1, Math.floor(limit));

  const expired = await deps.db.query(
    `select ${NOTIFICATION_COLUMNS} from notifications_sent
      where status = 'sending' and first_reserved_at <= $1 order by first_reserved_at limit ${cap}`,
    [windowStart],
  );
  for (const row of expired.map(toNotificationRow)) {
    if (await failReservation(deps.db, row)) {
      summary.notificationsExpired += 1;
      raiseAlert('notification_expired', { notificationKind: row.kind, reservationId: row.id, attempts: row.sendAttempts });
    }
  }

  // Spacing doubles with each sweeper resume: 10, 20, 40, 80 min, then every 2 h.
  const due = await deps.db.query(
    `select ${NOTIFICATION_COLUMNS} from notifications_sent
      where status = 'sending' and first_reserved_at > $1
        and reserved_at < $2::timestamptz - least(10 * power(2, least(sweeper_resumes, 6)), 120) * interval '1 minute'
      order by reserved_at limit ${cap}`,
    [windowStart, now],
  );
  for (const row of due.map(toNotificationRow)) {
    try {
      if (row.kind === 'magic_link') {
        // The hashed token cannot be re-rendered; the owner asks for a new link.
        if (await failReservation(deps.db, row)) {
          log.warn('magic link reservation failed', { event: 'notification.magic_link_failed', reservationId: row.id });
        }
        continue;
      }
      const result = await resumeReservation(deps, row, { bySweeper: true }, registry);
      if (result.status === 'sent') summary.notificationsResumed += 1;
    } catch (error) {
      // A transient send error leaves the row `sending` (with its resume counted) for a later sweep.
      summary.errors += 1;
      log.warn('notification resume failed', { event: 'notification.resume_error', reservationId: row.id, code: errorCode(error) }, error);
    }
  }
}
