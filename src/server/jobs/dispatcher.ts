import 'server-only';
import { randomUUID } from 'node:crypto';
import { errorCode, isRetryable, TransientError } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { assertJobOwned, claimJob, finishJob, releaseJob } from './claim';
import { runFailurePath } from './failure';
import { defaultJobRegistry, type JobRegistry } from './registry';
import { republishJob } from './republish';
import { getJob, isJobId, targetAtOf } from './rows';
import {
  isJobLeaseLost,
  isTerminalJobStatus,
  JOB_HOP_TOLERANCE_MS,
  JOB_LEASE_RETRY_AFTER_MAX_SECONDS,
  JOB_LONG_WAIT_MS,
  JOB_MAX_ATTEMPTS,
  JOB_RETRIES,
  type JobContext,
  type JobFailureReason,
  type JobOutcome,
  type JobRow,
} from './types';

// One delivery of `/api/jobs/run` (PLAN §8.3 steps 2-4, D-11, D-15): hop check, claim, the kind's
// handler, then exactly one guarded write for the outcome. The answer tells QStash what to do:
// 200 (finished, or nothing to do), 5xx (back off and retry), 489 + Upstash-NonRetryable-Error
// (permanent: stop), 503 + Retry-After (another attempt holds a live lease).

export interface RunJobInput {
  jobId: string;
  /** `Upstash-Message-Id`. */
  messageId: string | null;
  /** `Upstash-Retried` (0 on the first delivery). */
  retried: number;
}

export type RunJobDoneOutcome =
  | 'done'
  | 'skipped'
  | 'retargeted'
  | 'hopped'
  | 'failed'
  | 'already_finished'
  | 'not_found'
  | 'lease_lost';

export type RunJobResult =
  | { readonly status: 200; readonly outcome: RunJobDoneOutcome }
  | { readonly status: 500; readonly outcome: 'transient'; readonly code: string; readonly retryAfterSeconds?: number | undefined }
  | { readonly status: 489; readonly outcome: 'permanent'; readonly code: string }
  | { readonly status: 503; readonly outcome: 'lease_held'; readonly retryAfterSeconds: number };

/** The response headers QStash reads for a result. */
export function jobRunHeaders(result: RunJobResult): Headers {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (result.status === 489) headers.set('Upstash-NonRetryable-Error', 'true');
  if ((result.status === 500 || result.status === 503) && result.retryAfterSeconds !== undefined) {
    headers.set('Retry-After', String(result.retryAfterSeconds));
  }
  return headers;
}

function ok(outcome: RunJobDoneOutcome): RunJobResult {
  return { status: 200, outcome };
}

function claimable(job: JobRow, now: Date): boolean {
  return job.status === 'scheduled' || (job.status === 'running' && job.leaseUntil !== null && job.leaseUntil < now);
}

function leaseHeld(job: JobRow, now: Date): RunJobResult {
  const remainingMs = (job.leaseUntil?.getTime() ?? now.getTime()) - now.getTime();
  const seconds = Math.min(Math.max(Math.ceil(remainingMs / 1000) + 1, 1), JOB_LEASE_RETRY_AFTER_MAX_SECONDS);
  return { status: 503, outcome: 'lease_held', retryAfterSeconds: seconds };
}

function outcomeOfError(error: unknown): JobOutcome {
  if (isRetryable(error)) {
    return { type: 'transient', code: errorCode(error), retryAfterMs: error instanceof TransientError ? error.retryAfterMs : undefined };
  }
  return { type: 'permanent', code: errorCode(error) };
}

/** Runs one delivery. Never throws for a handler error; database errors before the claim do throw (the route answers 500). */
export async function runJob(deps: Deps, input: RunJobInput, registry: JobRegistry = defaultJobRegistry): Promise<RunJobResult> {
  if (!isJobId(input.jobId)) return ok('not_found');
  const now = deps.clock.now();
  const current = await getJob(deps.db, input.jobId);
  if (current === null) return ok('not_found');
  if (isTerminalJobStatus(current.status)) return ok('already_finished');

  // Step 2: a delivery well before the job's target is re-published for later, without a claim.
  const target = targetAtOf(current);
  if (target !== null && target.getTime() - now.getTime() > JOB_HOP_TOLERANCE_MS && claimable(current, now)) {
    // A stale copy of an earlier message: the job's current message already covers the target.
    if (input.messageId !== null && current.externalId !== null && input.messageId !== current.externalId) return ok('hopped');
    try {
      const moved = await republishJob(deps, current, target, { type: 'hops', hops: current.hops });
      if (moved !== null) log.info('job hopped', { event: 'job.hopped', jobId: current.id, jobKind: current.kind, hops: moved.job.hops });
    } catch (error) {
      // The row is `scheduled` without a message: the sweeper publishes it.
      log.warn('job hop publish failed', { event: 'job.hop_failed', jobId: current.id, code: errorCode(error) }, error);
    }
    return ok('hopped');
  }

  // Step 3: the claim is the only lock.
  const attemptId = randomUUID();
  const job = await claimJob(deps.db, input.jobId, attemptId, now);
  if (job === null) {
    const latest = await getJob(deps.db, input.jobId);
    if (latest === null) return ok('not_found');
    if (isTerminalJobStatus(latest.status)) return ok('already_finished');
    if (latest.status === 'running') return leaseHeld(latest, now);
    return { status: 503, outcome: 'lease_held', retryAfterSeconds: 1 };
  }

  const ctx: JobContext = {
    attemptId,
    messageId: input.messageId,
    retried: input.retried,
    isFinalDelivery: input.retried >= JOB_RETRIES,
    claimedAt: now,
    assertOwned: (tx) => assertJobOwned(tx, job.id, attemptId, job.leadId),
  };
  const handler = registry.handler(job.kind);
  let outcome: JobOutcome;
  if (handler === undefined) {
    outcome = { type: 'permanent', code: 'job_handler_missing' };
  } else {
    try {
      outcome = await handler(deps, job, ctx);
    } catch (error) {
      if (isJobLeaseLost(error)) return finished(job, 'lease_lost');
      outcome = outcomeOfError(error);
    }
  }
  return settle(deps, job, ctx, outcome, registry);
}

function finished(job: JobRow, outcome: RunJobDoneOutcome, code?: string): RunJobResult {
  log.info('job delivery finished', { event: 'job.delivery', jobId: job.id, jobKind: job.kind, outcome, attempts: job.attempts, code });
  return ok(outcome);
}

// Step 4: exactly one write per outcome, each guarded by attempt_id and status = 'running'.
async function settle(deps: Deps, job: JobRow, ctx: JobContext, outcome: JobOutcome, registry: JobRegistry): Promise<RunJobResult> {
  switch (outcome.type) {
    case 'done':
    case 'skipped': {
      const owned = await finishJob(deps.db, job, ctx.attemptId, outcome.type, deps.clock.now());
      return finished(job, owned ? outcome.type : 'lease_lost');
    }
    case 'retarget': {
      try {
        const moved = await republishJob(deps, job, outcome.runAt, { type: 'attempt', attemptId: ctx.attemptId });
        if (moved === null) return finished(job, 'lease_lost');
      } catch (error) {
        log.warn('job retarget publish failed', { event: 'job.retarget_failed', jobId: job.id, code: errorCode(error) }, error);
      }
      return finished(job, 'retargeted');
    }
    case 'transient': {
      // D-11: a Retry-After over 60 s (a 477, a long 429) re-schedules the job instead of spending
      // QStash's retries; bounded by the claim count, so a provider that never recovers still fails.
      if (outcome.retryAfterMs !== undefined && outcome.retryAfterMs > JOB_LONG_WAIT_MS && job.attempts < JOB_MAX_ATTEMPTS) {
        const runAt = new Date(deps.clock.now().getTime() + outcome.retryAfterMs);
        return settle(deps, job, ctx, { type: 'retarget', runAt }, registry);
      }
      if (ctx.isFinalDelivery) {
        const failed = await failInline(deps, job, ctx, 'final_delivery', outcome.code, registry);
        return finished(job, failed ? 'failed' : 'lease_lost', outcome.code);
      }
      const owned = await releaseJob(deps.db, job, ctx.attemptId, outcome.code);
      if (!owned) return finished(job, 'lease_lost', outcome.code);
      log.info('job delivery failed transiently', { event: 'job.transient', jobId: job.id, jobKind: job.kind, code: outcome.code, retries: ctx.retried });
      const retryAfterSeconds = outcome.retryAfterMs === undefined ? undefined : Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
      return { status: 500, outcome: 'transient', code: outcome.code, retryAfterSeconds };
    }
    case 'permanent': {
      const failed = await failInline(deps, job, ctx, 'permanent', outcome.code, registry);
      if (!failed) return finished(job, 'lease_lost', outcome.code);
      log.info('job failed permanently', { event: 'job.permanent', jobId: job.id, jobKind: job.kind, code: outcome.code });
      return { status: 489, outcome: 'permanent', code: outcome.code };
    }
  }
}

/** The failure path while this attempt still owns the job, then `failed`. False when the claim was lost first. */
async function failInline(
  deps: Deps,
  job: JobRow,
  ctx: JobContext,
  reason: JobFailureReason,
  code: string,
  registry: JobRegistry,
): Promise<boolean> {
  const stillOwned = await deps.db.maybeOne(`select id from scheduled_jobs where id = $1 and attempt_id = $2 and status = 'running'`, [
    job.id,
    ctx.attemptId,
  ]);
  if (stillOwned === null) return false;
  await runFailurePath(deps, job, { reason, code }, registry);
  return finishJob(deps.db, job, ctx.attemptId, 'failed', deps.clock.now(), code);
}
