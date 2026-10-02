import 'server-only';
import { errorCode, PermanentError } from '@/server/domain/errors';
import type { JobKind } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { raiseAlert } from './alert';
import { JOB_COLUMNS, toJobRow } from './rows';
import { JOB_RETRIES, type JobPayload, type JobRow } from './types';

// The outbox (PLAN §8.3 step 1, D-15). A job row is inserted in the same transaction as the state
// change that needs it; after commit, publishJobs hands it to the Scheduler and stores the QStash
// message id. A failed publish leaves the row (`external_id` null) for the sweeper.

export interface InsertJobInput {
  kind: JobKind;
  accountId: string | null;
  leadId?: string | null | undefined;
  /** PLAN §8.2's key without the `{ENV_NAMESPACE}:` prefix, e.g. `lead:{id}:fu:1:s0`. */
  dedupeKey: string;
  /** Ids only, never content. `targetAt` is added for a delayed job. */
  payload?: JobPayload | undefined;
  /** When the job should run (may be beyond the QStash maximum delay: it then hops). */
  runAt: Date;
  /** `$now`, from the injected Clock. */
  now: Date;
  /** `scheduled_jobs.seq`, e.g. the follow-up or inbox-check number. */
  seq?: number | undefined;
}

// Ids, dates, ISO instants and short tags: never content.
const DEDUPE_KEY = /^[a-z][a-z0-9-]*:[A-Za-z0-9:._@+-]{1,200}$/;

export class InvalidDedupeKeyError extends PermanentError<'job_invalid_dedupe_key'> {
  override readonly name: string = 'InvalidDedupeKeyError';

  constructor() {
    super('job_invalid_dedupe_key');
  }
}

export function assertDedupeKey(key: string): void {
  if (!DEDUPE_KEY.test(key)) throw new InvalidDedupeKeyError();
}

/**
 * Inserts a `scheduled` job row (`external_id` null, `created_at = now`, `hops = 0`), or returns
 * null when a row with this dedupe key already exists (ON CONFLICT DO NOTHING). Call it inside the
 * transaction that makes the job necessary; call publishJobs after that transaction commits.
 */
export async function insertJob(tx: Db, input: InsertJobInput): Promise<JobRow | null> {
  assertDedupeKey(input.dedupeKey);
  const payload: Record<string, unknown> = { ...(input.payload ?? {}) };
  // The hop check (PLAN §8.3 step 2) compares deliveries with the job's real target.
  if (input.runAt.getTime() > input.now.getTime()) payload.targetAt = input.runAt.toISOString();
  const raw = await tx.maybeOne(
    `insert into scheduled_jobs
       (account_id, lead_id, kind, seq, dedupe_key, payload, run_at, status, hops, attempts, created_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, 'scheduled', 0, 0, $8)
     on conflict (dedupe_key) do nothing
     returning ${JOB_COLUMNS}`,
    [input.accountId, input.leadId ?? null, input.kind, input.seq ?? 0, input.dedupeKey, payload, input.runAt, input.now],
  );
  return raw === null ? null : toJobRow(raw);
}

/** The QStash deduplication id: `{ENV_NAMESPACE}:{dedupe_key}`, plus `:h{hops}` after a re-publish. */
export function dedupeIdFor(envNamespace: string, dedupeKey: string, hops: number): string {
  return hops > 0 ? `${envNamespace}:${dedupeKey}:h${hops}` : `${envNamespace}:${dedupeKey}`;
}

export type PublishMode =
  /** The row's first message for its current `hops` (outbox, sweeper): `deduplicated` means it was already published. */
  | 'first'
  /** Right after a re-publish compare-and-set incremented `hops`: `deduplicated` is an error. */
  | 'republish';

export interface PublishOutcome {
  jobId: string;
  messageId: string;
  deduplicated: boolean;
  /** When the message is due: `run_at`, or the maximum QStash delay for a far target (a hop). */
  publishAt: Date;
}

/** Re-publish got `deduplicated: true`: the fresh `:h{hops}` id was already used, which should be impossible. */
export class RepublishDeduplicatedError extends PermanentError<'job_republish_deduplicated'> {
  override readonly name: string = 'RepublishDeduplicatedError';

  constructor() {
    super('job_republish_deduplicated');
  }
}

/**
 * Publishes one row's message and stores `external_id`/`published_at` with a compare-and-set on
 * id and hops (a delivery may already have claimed the row; that is fine). Targets beyond
 * QSTASH_MAX_DELAY_SECONDS are published at the maximum delay, and `run_at` records that instant.
 * Throws on a publish error; the caller decides whether the sweeper picks it up.
 */
export async function publishJob(deps: Deps, job: JobRow, mode: PublishMode): Promise<PublishOutcome> {
  const now = deps.clock.now();
  const latest = now.getTime() + deps.env.QSTASH_MAX_DELAY_SECONDS * 1000;
  const publishAt = job.runAt.getTime() > latest ? new Date(latest) : job.runAt;
  const result = await deps.scheduler.publish({
    jobId: job.id,
    kind: job.kind,
    runAt: publishAt,
    dedupeId: dedupeIdFor(deps.env.ENV_NAMESPACE, job.dedupeKey, job.hops),
    retries: JOB_RETRIES,
  });
  if (mode === 'republish' && result.deduplicated) {
    raiseAlert('job_republish_deduplicated', { jobId: job.id, jobKind: job.kind, hops: job.hops });
    throw new RepublishDeduplicatedError();
  }
  await deps.db.query(
    `update scheduled_jobs set external_id = $3, published_at = $4, run_at = $5
      where id = $1 and hops = $2`,
    [job.id, job.hops, result.messageId, now, publishAt],
  );
  return { jobId: job.id, messageId: result.messageId, deduplicated: result.deduplicated, publishAt };
}

export interface PublishJobsSummary {
  published: PublishOutcome[];
  /** Rows whose publish failed; the sweeper publishes them after 2 minutes. */
  failed: string[];
}

/**
 * After commit: publishes each inserted row (nulls from ON CONFLICT are skipped). Never throws for a
 * publish failure: the row stays unpublished and the sweeper retries it (PLAN §8.3 step 7).
 */
export async function publishJobs(deps: Deps, rows: readonly (JobRow | null)[]): Promise<PublishJobsSummary> {
  const summary: PublishJobsSummary = { published: [], failed: [] };
  for (const row of rows) {
    if (row === null) continue;
    try {
      summary.published.push(await publishJob(deps, row, 'first'));
    } catch (error) {
      summary.failed.push(row.id);
      log.warn('job publish failed', { event: 'job.publish_failed', jobId: row.id, jobKind: row.kind, code: errorCode(error) }, error);
    }
  }
  return summary;
}
