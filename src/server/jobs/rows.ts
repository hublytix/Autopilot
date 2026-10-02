import 'server-only';
import { z } from 'zod';
import { JOB_KINDS, JOB_STATUSES } from '@/server/domain/types';
import type { Db } from '@/server/db';
import type { JobRow } from './types';

// Reading `scheduled_jobs` rows. Every statement that returns a job row selects JOB_COLUMNS and
// maps it with toJobRow, so a schema drift fails loudly instead of being cast through.

export const JOB_COLUMNS =
  'id, account_id, lead_id, kind, seq, dedupe_key, payload, run_at, status, external_id, published_at, hops, attempts, ' +
  'attempt_id, lease_until, last_error_code, cancel_reason, created_at, finished_at';

const jobRowSchema = z.object({
  id: z.string(),
  account_id: z.string().nullable(),
  lead_id: z.string().nullable(),
  kind: z.enum(JOB_KINDS),
  seq: z.number(),
  dedupe_key: z.string(),
  payload: z.record(z.string(), z.unknown()),
  run_at: z.date(),
  status: z.enum(JOB_STATUSES),
  external_id: z.string().nullable(),
  published_at: z.date().nullable(),
  hops: z.number(),
  attempts: z.number(),
  attempt_id: z.string().nullable(),
  lease_until: z.date().nullable(),
  last_error_code: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  created_at: z.date(),
  finished_at: z.date().nullable(),
});

export function toJobRow(raw: unknown): JobRow {
  const r = jobRowSchema.parse(raw);
  return {
    id: r.id,
    accountId: r.account_id,
    leadId: r.lead_id,
    kind: r.kind,
    seq: r.seq,
    dedupeKey: r.dedupe_key,
    payload: r.payload,
    runAt: r.run_at,
    status: r.status,
    externalId: r.external_id,
    publishedAt: r.published_at,
    hops: r.hops,
    attempts: r.attempts,
    attemptId: r.attempt_id,
    leaseUntil: r.lease_until,
    lastErrorCode: r.last_error_code,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export async function getJob(db: Db, jobId: string): Promise<JobRow | null> {
  const raw = await db.maybeOne(`select ${JOB_COLUMNS} from scheduled_jobs where id = $1`, [jobId]);
  return raw === null ? null : toJobRow(raw);
}

/** `payload.targetAt` (ISO), the instant the job is really for; null when absent or malformed. */
export function targetAtOf(job: Pick<JobRow, 'payload'>): Date | null {
  const value = job.payload.targetAt;
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Job ids are uuids; anything else cannot name a job (and must not reach a uuid cast). */
export function isJobId(value: string): boolean {
  return UUID.test(value);
}
