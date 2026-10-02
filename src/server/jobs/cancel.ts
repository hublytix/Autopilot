import 'server-only';
import { errorCode, PermanentError } from '@/server/domain/errors';
import type { JobKind } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';

// Cancelling jobs (PLAN §8.3 step 8, D-15, QS-CANCEL). The row is marked `cancelled` inside the
// caller's transaction (dismiss, reply, revoke, disconnect, privacy deletion…); after commit each
// QStash message is cancelled by its id. A 404 counts as success (the Scheduler port maps it), and
// there is never a bulk or filter cancel: a message that still arrives finds the row cancelled and
// answers 200. A running job is cancelled too, so its attempt's guarded writes change nothing.

/** Why jobs were cancelled; stored in `cancel_reason`. */
export type JobCancelReason =
  | 'dismissed'
  | 'replied'
  | 'superseded'
  | 'revoked'
  | 'disconnected'
  | 'privacy_deletion'
  | 'followups_off'
  | 'account_purge'
  | 'owner_override';

export interface CancelJobsFilter {
  /** At least one of leadId and accountId is required. */
  leadId?: string | undefined;
  accountId?: string | undefined;
  /** Limit to these kinds (e.g. only `followup`). */
  kinds?: readonly JobKind[] | undefined;
  /** Leave this job alone (a follow-up job cancelling the remaining ones). */
  exceptJobId?: string | undefined;
  reason: JobCancelReason;
  /** `$now`. */
  now: Date;
}

/** The QStash messages to cancel after commit. */
export interface CancelledJobs {
  jobIds: string[];
  messageIds: string[];
}

export class CancelFilterRequiredError extends PermanentError<'job_cancel_filter_required'> {
  override readonly name: string = 'CancelFilterRequiredError';

  constructor() {
    super('job_cancel_filter_required');
  }
}

/** Marks the matching scheduled or running jobs `cancelled` inside `tx`. */
export async function cancelJobsInTx(tx: Db, filter: CancelJobsFilter): Promise<CancelledJobs> {
  if (filter.leadId === undefined && filter.accountId === undefined) throw new CancelFilterRequiredError();
  const params: unknown[] = [filter.reason, filter.now];
  const where: string[] = [`status in ('scheduled', 'running')`];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filter.leadId !== undefined) where.push(`lead_id = ${bind(filter.leadId)}`);
  if (filter.accountId !== undefined) where.push(`account_id = ${bind(filter.accountId)}`);
  if (filter.kinds !== undefined) where.push(`kind = any(${bind([...filter.kinds])}::text[])`);
  if (filter.exceptJobId !== undefined) where.push(`id <> ${bind(filter.exceptJobId)}`);
  const rows = await tx.query<{ id: string; external_id: string | null }>(
    `update scheduled_jobs
        set status = 'cancelled', cancel_reason = $1, finished_at = $2, lease_until = null
      where ${where.join(' and ')}
      returning id, external_id`,
    params,
  );
  return {
    jobIds: rows.map((row) => row.id),
    messageIds: rows.flatMap((row) => (row.external_id === null ? [] : [row.external_id])),
  };
}

/** After commit: cancels each message by id. Never throws; an uncancelled message finds its job cancelled. */
export async function cancelScheduledMessages(deps: Deps, cancelled: CancelledJobs): Promise<void> {
  for (const messageId of cancelled.messageIds) {
    if (messageId.length === 0) continue;
    try {
      await deps.scheduler.cancel(messageId);
    } catch (error) {
      log.warn('job message cancel failed', { event: 'job.cancel_failed', messageId, code: errorCode(error) }, error);
    }
  }
}

/** Both steps, with a transaction of its own. */
export async function cancelJobs(deps: Deps, filter: Omit<CancelJobsFilter, 'now'>): Promise<CancelledJobs> {
  const now = deps.clock.now();
  const cancelled = await deps.db.tx((tx) => cancelJobsInTx(tx, { ...filter, now }));
  await cancelScheduledMessages(deps, cancelled);
  return cancelled;
}
