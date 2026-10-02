import 'server-only';
import type { Db } from '@/server/db';
import { JOB_COLUMNS, toJobRow } from './rows';
import { JOB_LEASE_MS, JobLeaseLostError, type JobRow } from './types';

// The claim and the writes that follow it (PLAN §8.3 steps 3 and 4). The claim is the only lock:
// one compare-and-set that takes a scheduled job, or one whose lease has expired. Every later write
// to the row is guarded by `attempt_id = $a AND status = 'running'`, so an attempt that lost its
// lease (or whose job was cancelled meanwhile) changes nothing.

/** Claims the job for `attemptId` until now + 6 min; null when it is not claimable. */
export async function claimJob(db: Db, jobId: string, attemptId: string, now: Date): Promise<JobRow | null> {
  const raw = await db.maybeOne(
    `update scheduled_jobs
        set status = 'running', attempt_id = $2, lease_until = $4, attempts = attempts + 1
      where id = $1 and (status = 'scheduled' or (status = 'running' and lease_until < $3))
      returning ${JOB_COLUMNS}`,
    [jobId, attemptId, now, new Date(now.getTime() + JOB_LEASE_MS)],
  );
  return raw === null ? null : toJobRow(raw);
}

export type FinishStatus = 'done' | 'skipped' | 'failed';

/** Ends the attempt with a terminal status; false when the attempt no longer owns the job. */
export async function finishJob(
  db: Db,
  job: Pick<JobRow, 'id'>,
  attemptId: string,
  status: FinishStatus,
  now: Date,
  errorCode: string | null = null,
): Promise<boolean> {
  const rows = await db.query(
    `update scheduled_jobs
        set status = $3, finished_at = $4, lease_until = null, last_error_code = coalesce($5, last_error_code)
      where id = $1 and attempt_id = $2 and status = 'running'
      returning id`,
    [job.id, attemptId, status, now, errorCode],
  );
  return rows.length === 1;
}

/** A transient error: back to `scheduled`, lease cleared, so the next delivery can claim it. */
export async function releaseJob(db: Db, job: Pick<JobRow, 'id'>, attemptId: string, errorCode: string): Promise<boolean> {
  const rows = await db.query(
    `update scheduled_jobs
        set status = 'scheduled', lease_until = null, last_error_code = $3
      where id = $1 and attempt_id = $2 and status = 'running'
      returning id`,
    [job.id, attemptId, errorCode],
  );
  return rows.length === 1;
}

/** Locks the row inside `tx` and throws JobLeaseLostError unless `attemptId` still holds it. */
export async function assertJobOwned(tx: Db, jobId: string, attemptId: string): Promise<void> {
  const row = await tx.maybeOne(
    `select id from scheduled_jobs where id = $1 and attempt_id = $2 and status = 'running' for update`,
    [jobId, attemptId],
  );
  if (row === null) throw new JobLeaseLostError();
}
