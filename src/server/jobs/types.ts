import 'server-only';
import { PermanentError } from '@/server/domain/errors';
import type { JobKind, JobStatus } from '@/server/domain/types';
import type { Db } from '@/server/db';
import type { Deps } from '@/server/ports';

// Shared types and constants of the job system (PLAN §8.2, §8.3, D-11, D-15).

/** The routes QStash delivers to (`{APP_URL}` + path): the publish destination, the failure callback, and each one's signature `sub`. */
export const JOB_RUN_PATH = '/api/jobs/run';
export const JOB_FAILED_PATH = '/api/jobs/failed';

/** Redeliveries after the first: 5 deliveries in all, 10/20/40/80 s apart (brief §5.1, D-11). */
export const JOB_RETRIES = 4;
/** QStash's backoff between deliveries, in milliseconds (`Upstash-Retry-Delay`). */
export const JOB_RETRY_DELAY_EXPRESSION = 'pow(2, retried) * 10000';
/** How long a claim holds a job: longer than the run route's maxDuration (300 s). */
export const JOB_LEASE_MS = 6 * 60 * 1000;
/** A delivery more than this before `payload.targetAt` is re-published for later (PLAN §8.3 step 2). */
export const JOB_HOP_TOLERANCE_MS = 60 * 1000;
/** `Retry-After` for a delivery that meets a live lease: at most this many seconds. */
export const JOB_LEASE_RETRY_AFTER_MAX_SECONDS = 60;
/** A transient error asking to wait longer than this is re-scheduled rather than retried by QStash (D-11). */
export const JOB_LONG_WAIT_MS = 60 * 1000;
/** The sweeper runs the failure path instead of re-publishing once a job has been claimed this often. */
export const JOB_MAX_ATTEMPTS = 6;
/** Terminal statuses: a delivery for such a job answers 200 and does nothing. */
export const TERMINAL_JOB_STATUSES = ['done', 'cancelled', 'skipped', 'failed'] as const satisfies readonly JobStatus[];

export function isTerminalJobStatus(status: JobStatus): boolean {
  return (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

/** A JSON scalar: job payloads hold ids (and `targetAt`) only, never content. */
export type JobPayloadValue = string | number | boolean | null;
export type JobPayload = Readonly<Record<string, JobPayloadValue>>;

/** One `scheduled_jobs` row. */
export interface JobRow {
  readonly id: string;
  readonly accountId: string | null;
  readonly leadId: string | null;
  readonly kind: JobKind;
  readonly seq: number;
  /** Without the `{ENV_NAMESPACE}:` prefix, which only the QStash dedupe id carries. */
  readonly dedupeKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** When the current QStash message is due (a hop's time when the target is further out). */
  readonly runAt: Date;
  readonly status: JobStatus;
  readonly externalId: string | null;
  readonly publishedAt: Date | null;
  readonly hops: number;
  readonly attempts: number;
  readonly attemptId: string | null;
  readonly leaseUntil: Date | null;
  readonly lastErrorCode: string | null;
  readonly cancelReason: string | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

/**
 * What a handler reports. Errors may also be thrown: a retryable one (`isRetryable`) counts as
 * `transient`, anything else as `permanent`.
 */
export type JobOutcome =
  | { readonly type: 'done' }
  | { readonly type: 'skipped' }
  /** Back to `scheduled` and a 5xx, so QStash backs off; the failure path on the final delivery. */
  | { readonly type: 'transient'; readonly code: string; readonly retryAfterMs?: number | undefined }
  /** The failure path inline, then `failed` and 489 + `Upstash-NonRetryable-Error`. */
  | { readonly type: 'permanent'; readonly code: string }
  /** Re-publish for `runAt` (quiet hours, a long wait; PLAN §8.3 step 5). */
  | { readonly type: 'retarget'; readonly runAt: Date };

export const JobOutcomes = {
  done: (): JobOutcome => ({ type: 'done' }),
  skipped: (): JobOutcome => ({ type: 'skipped' }),
  retarget: (runAt: Date): JobOutcome => ({ type: 'retarget', runAt }),
} as const;

/** What a handler knows about its delivery and claim. */
export interface JobContext {
  /** This claim's id; every write to the job row is guarded by it. */
  readonly attemptId: string;
  /** `Upstash-Message-Id`, when the delivery carried one. */
  readonly messageId: string | null;
  /** `Upstash-Retried`: 0 on the first delivery of this message. */
  readonly retried: number;
  /** `retried` has reached JOB_RETRIES: a transient error now runs the failure path. */
  readonly isFinalDelivery: boolean;
  /** The instant of the claim. */
  readonly claimedAt: Date;
  /**
   * Inside a handler's own transaction: locks the job row and throws `JobLeaseLostError` unless this
   * attempt still holds it, so the handler's writes commit only while it owns the job.
   */
  assertOwned(tx: Db): Promise<void>;
}

export type JobHandler = (deps: Deps, job: JobRow, ctx: JobContext) => Promise<JobOutcome>;

/** Why the failure path runs (PLAN §8.3 steps 4, 6, 7). */
export type JobFailureReason = 'final_delivery' | 'permanent' | 'failure_callback' | 'sweeper';

export interface JobFailureInfo {
  readonly reason: JobFailureReason;
  /** The last error code, e.g. `hubspot_server_error` or `qstash_retries_exhausted`. */
  readonly code: string;
}

/**
 * A kind's failure behaviour (PLAN §8.3 step 6): `lead_process` → needs-touch, `followup` → a lead
 * note, `brief_generate` → `brief_jobs.status='failed'`, `weekly_report` → `weekly_reports.status=
 * 'failed'`, `inbox_check` → open legs `failed`. The alert is raised for every kind before it runs.
 * It must be idempotent: a job can reach it more than once (e.g. a crash before the job is marked
 * failed).
 */
export type JobFailurePath = (deps: Deps, job: JobRow, info: JobFailureInfo) => Promise<void>;

/** A handler's write found that its claim is gone (the lease expired and another attempt claimed, or the job was cancelled). */
export class JobLeaseLostError extends PermanentError<'job_lease_lost'> {
  override readonly name: string = 'JobLeaseLostError';

  constructor() {
    super('job_lease_lost');
  }
}

export function isJobLeaseLost(e: unknown): e is JobLeaseLostError {
  return e instanceof JobLeaseLostError;
}
