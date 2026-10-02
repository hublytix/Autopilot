import 'server-only';
import { z } from 'zod';
import type { JobRow } from '@/server/jobs';

// Dedupe keys and payloads (PLAN §8.2, §8.4): the `inbox_check` job `inbox:{acct}:{check}:{n}` (n =
// the run number, from 1, also `scheduled_jobs.seq`) with payload {checkId}; the `inbox_test` email
// `inbox-test:{checkId}` (NotificationKeys.inboxTest).

export function inboxCheckDedupeKey(accountId: string, checkId: string, run: number): string {
  return `inbox:${accountId}:${checkId}:${run}`;
}

const PayloadSchema = z.object({ checkId: z.uuid() });

export function checkIdOfJob(job: Pick<JobRow, 'payload'>): string | null {
  const parsed = PayloadSchema.safeParse(job.payload);
  return parsed.success ? parsed.data.checkId : null;
}

/** The run number: `seq`, else the key's last part, else 1. */
export function runNumberOfJob(job: Pick<JobRow, 'seq' | 'dedupeKey'>): number {
  if (Number.isInteger(job.seq) && job.seq >= 1) return job.seq;
  const match = /:(\d{1,4})$/.exec(job.dedupeKey);
  const n = match === null ? Number.NaN : Number(match[1]);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

const INBOX_TEST_KEY = /^inbox-test:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The check id of an `inbox-test:{checkId}` reservation, or null. */
export function checkIdOfInboxTestKey(dedupeKey: string): string | null {
  return INBOX_TEST_KEY.exec(dedupeKey)?.[1] ?? null;
}
