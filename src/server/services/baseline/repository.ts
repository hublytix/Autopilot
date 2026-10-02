import 'server-only';
import { z } from 'zod';
import { baselineReason, MAX_BASELINE_SUBMISSIONS, type BaselineReason } from '@/server/domain/baseline';
import { BASELINE_STATUSES, JOB_STATUSES, type BaselineStatus } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { percentWithout } from './figures';

// `baselines` rows (PLAN §5, D-38): ids, counts and figures only, never content. The newest row is
// the account's baseline; the Monday report (M6) compares against it.

// The reason rule is domain/baseline.ts's (the Monday report reads it too); re-exported here.
export { baselineReason, MAX_BASELINE_SUBMISSIONS };
export type { BaselineReason };

export interface BaselineRecord {
  status: BaselineStatus;
  submissionsRead: number;
  leadsCounted: number;
  medianSecondsToFirstOutbound: number | null;
  withoutOutboundCount: number | null;
  /** The "% with no logged outbound email" may be shown (D-38). */
  percentAvailable: boolean;
  createdAt: Date;
}

export interface NewBaseline {
  accountId: string;
  status: BaselineStatus;
  submissionsRead: number;
  leadsCounted: number;
  medianSecondsToFirstOutbound: number | null;
  withoutOutboundCount: number | null;
  percentAvailable: boolean;
  now: Date;
  /** A row created at or after this instant (the job's creation) means this run already stored one. */
  notBefore: Date;
}

/** Inserts the row unless this run already stored one (a redelivery after a crash). True when written. */
export async function insertBaseline(db: Db, input: NewBaseline): Promise<boolean> {
  const rows = await db.query(
    `insert into baselines (account_id, status, submissions_read, leads_counted, median_seconds_to_first_outbound,
                            without_outbound_count, percent_available, created_at)
     select $1, $2, $3, $4, $5, $6, $7, $8
      where not exists (select 1 from baselines where account_id = $1 and created_at >= $9)
     returning id`,
    [
      input.accountId,
      input.status,
      input.submissionsRead,
      input.leadsCounted,
      input.medianSecondsToFirstOutbound,
      input.withoutOutboundCount,
      input.percentAvailable,
      input.now,
      input.notBefore,
    ],
  );
  return rows.length === 1;
}

const recordRow = z.object({
  status: z.enum(BASELINE_STATUSES),
  submissions_read: z.number(),
  leads_counted: z.number(),
  median_seconds_to_first_outbound: z.number().nullable(),
  without_outbound_count: z.number().nullable(),
  percent_available: z.boolean(),
  created_at: z.date(),
});

function toRecord(raw: unknown): BaselineRecord {
  const row = recordRow.parse(raw);
  return {
    status: row.status,
    submissionsRead: row.submissions_read,
    leadsCounted: row.leads_counted,
    medianSecondsToFirstOutbound: row.median_seconds_to_first_outbound,
    withoutOutboundCount: row.without_outbound_count,
    percentAvailable: row.percent_available,
    createdAt: row.created_at,
  };
}

/** The account's newest baseline, or null. */
export async function latestBaseline(db: Db, accountId: string): Promise<BaselineRecord | null> {
  const raw = await db.maybeOne(
    `select status, submissions_read, leads_counted, median_seconds_to_first_outbound, without_outbound_count, percent_available, created_at
       from baselines where account_id = $1 order by created_at desc, id desc limit 1`,
    [accountId],
  );
  return raw === null ? null : toRecord(raw);
}

export type BaselineView =
  | { readonly state: 'not_started' }
  | { readonly state: 'running' }
  | {
      readonly state: 'done';
      readonly baseline: BaselineRecord;
      readonly reason: BaselineReason | null;
      /** Whole percent, only when `percentAvailable`. */
      readonly percentWithout: number | null;
    };

const jobRow = z.object({ status: z.enum(JOB_STATUSES), created_at: z.date() });

/** What the baseline step shows: running while its newest job can still run and has stored nothing. */
export async function baselineView(db: Db, accountId: string): Promise<BaselineView> {
  const record = await latestBaseline(db, accountId);
  const jobRaw = await db.maybeOne(
    `select status, created_at from scheduled_jobs where account_id = $1 and kind = 'baseline' order by created_at desc, id desc limit 1`,
    [accountId],
  );
  const job = jobRaw === null ? null : jobRow.parse(jobRaw);
  const jobLive = job !== null && (job.status === 'scheduled' || job.status === 'running');
  if (jobLive && (record === null || record.createdAt.getTime() < job.created_at.getTime())) return { state: 'running' };
  if (record === null) return { state: 'not_started' };
  return {
    state: 'done',
    baseline: record,
    reason: baselineReason(record),
    percentWithout: record.percentAvailable && record.withoutOutboundCount !== null ? percentWithout(record.withoutOutboundCount, record.leadsCounted) : null,
  };
}
