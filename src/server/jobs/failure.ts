import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { raiseAlert } from './alert';
import { defaultJobRegistry, type JobRegistry } from './registry';
import { JOB_COLUMNS, toJobRow } from './rows';
import type { JobFailureInfo, JobRow } from './types';

// The failure path (PLAN §8.3 steps 4, 6 and 7, D-11, D-15). Whoever wins the right to fail a job
// (the attempt itself on a permanent error or its final delivery, the failure callback's
// compare-and-set, or the sweeper's) raises one alert and runs the kind's registered behaviour.

/** The code recorded when QStash gave up without our handler reporting an error. */
export const RETRIES_EXHAUSTED_CODE = 'qstash_retries_exhausted';

/**
 * Raises the alert and runs `job.kind`'s failure behaviour. Never throws: a failing failure path is
 * logged and alerted, and the job is still marked failed by the caller.
 */
export async function runFailurePath(deps: Deps, job: JobRow, info: JobFailureInfo, registry: JobRegistry = defaultJobRegistry): Promise<void> {
  raiseAlert('job_failed', {
    jobId: job.id,
    jobKind: job.kind,
    accountId: job.accountId,
    leadId: job.leadId,
    reason: info.reason,
    errorCode: info.code,
    attempts: job.attempts,
  });
  const path = registry.failurePath(job.kind);
  if (path === undefined) return;
  try {
    await path(deps, job, info);
  } catch (error) {
    raiseAlert('job_failure_path_error', { jobId: job.id, jobKind: job.kind, errorCode: errorCode(error) });
  }
}

export interface FailureCallbackInput {
  /** From the original body `{jobId}`; when missing, the job is found by `external_id`. */
  jobId: string | null;
  /** The failure callback's `sourceMessageId`. */
  sourceMessageId: string;
}

export type FailureCallbackResult = 'won' | 'lost';

/**
 * `/api/jobs/failed` (PLAN §8.3 step 6): fails the job only through a compare-and-set on
 * `external_id = sourceMessageId` and no live attempt. A job that a live attempt still holds, that
 * already finished, or that was re-published (new message id) is left alone. Only the winner runs
 * the failure path.
 */
export async function handleFailureCallback(
  deps: Deps,
  input: FailureCallbackInput,
  registry: JobRegistry = defaultJobRegistry,
): Promise<FailureCallbackResult> {
  const now = deps.clock.now();
  const params: unknown[] = [input.sourceMessageId, now, RETRIES_EXHAUSTED_CODE];
  if (input.jobId !== null) params.push(input.jobId);
  const raw = await deps.db.maybeOne(
    `update scheduled_jobs
        set status = 'failed', finished_at = $2, lease_until = null, last_error_code = coalesce(last_error_code, $3)
      where external_id = $1
        and id = ${input.jobId !== null ? '$4' : '(select id from scheduled_jobs where external_id = $1 limit 1)'}
        and (status = 'scheduled' or (status = 'running' and lease_until < $2))
      returning ${JOB_COLUMNS}`,
    params,
  );
  if (raw === null) {
    log.info('job failure callback lost', { event: 'job.failure_callback_lost', jobId: input.jobId, messageId: input.sourceMessageId });
    return 'lost';
  }
  const job = toJobRow(raw);
  await runFailurePath(deps, job, { reason: 'failure_callback', code: job.lastErrorCode ?? RETRIES_EXHAUSTED_CODE }, registry);
  return 'won';
}

/**
 * The sweeper's compare-and-set for a job that has been claimed too often (PLAN §8.3 step 7): fails
 * it unless something moved it meanwhile (hops changed, or a live attempt holds it). Returns the row
 * when this caller won.
 */
export async function failJobIfUnchanged(deps: Deps, job: Pick<JobRow, 'id' | 'hops'>): Promise<JobRow | null> {
  const now = deps.clock.now();
  const raw = await deps.db.maybeOne(
    `update scheduled_jobs
        set status = 'failed', finished_at = $3, lease_until = null,
            last_error_code = coalesce(last_error_code, 'job_too_many_attempts')
      where id = $1 and hops = $2 and (status = 'scheduled' or (status = 'running' and lease_until < $3))
      returning ${JOB_COLUMNS}`,
    [job.id, job.hops, now],
  );
  return raw === null ? null : toJobRow(raw);
}
