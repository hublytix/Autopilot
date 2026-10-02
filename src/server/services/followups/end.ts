import 'server-only';
import { FOLLOW_UP_NUMBERS } from '@/server/domain/followup-schedule';
import { STREAM_ENDED_STOP } from '@/server/domain/stops';
import type { StopReason } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { cancelJobsInTx, type CancelledJobs } from '@/server/jobs/cancel';
import { NotificationKeys } from '@/server/services/notifications/predicates';
import { followUpDedupeKey } from './schedule';

// What a follow-up job leaves behind when it ends without sending its email (PLAN §6.2, §9.5 steps
// 2-3, D-09, D-44; closes D-66 open point (2)):
//
// - A stop that is a fact about the lead's contact or a newer enquiry (contact deleted, opted out,
//   bounced, superseded) never clears on its own: it is stored (`stop_reason = coalesce(stop_reason,
//   $stop)`) and the lead's other follow-up jobs are cancelled with it as the reason (PLAN §8.3 step 8;
//   their QStash messages after commit).
// - Any other ending (the account not active or follow-ups off when this one came due, a third
//   follow-up, the content purged, a failure) keeps the rest of the stream: the next follow-up still
//   runs and re-checks everything live. Only when nothing more can come for the lead (no other
//   follow-up job of its current stream scheduled or running, no follow-up email of the stream still
//   `sending` for the sweeper, follow-up 2 never emailed) is the stream's end recorded as a
//   `stop_reason`: the stop found, else STREAM_ENDED_STOP. Without it deriveLeadStatus would read
//   the lead as "follow-ups pending" forever and never reach "No reply from lead (none logged)" (D-32).
// - Reasons other writers store (dismissed, replied, privacy_deletion, test_lead) are already there;
//   test leads are never written.

/** Stops that never clear on their own: stored at once, and the lead's remaining follow-ups cancelled. */
export const LEAD_STOPS = ['contact_deleted', 'opted_out', 'bounced', 'superseded'] as const satisfies readonly StopReason[];
type LeadStop = (typeof LEAD_STOPS)[number];

export { STREAM_ENDED_STOP };

function isLeadStop(stop: StopReason): stop is LeadStop {
  return (LEAD_STOPS as readonly StopReason[]).includes(stop);
}

export interface EndFollowUpInput {
  readonly accountId: string;
  readonly leadId: string;
  readonly followupStream: number;
  /** The job that ends: left out of the cancel and of "another follow-up still pending". Null when no job is running (a sweeper expiry). */
  readonly jobId: string | null;
  /** The stop the job found; null when it ended for another reason (a failure, the content purged). */
  readonly stop: StopReason | null;
  /** `$now`. */
  readonly now: Date;
}

export interface EndFollowUpResult {
  /** The `stop_reason` this call stored; null when it stored none (one was there already, or the stream goes on). */
  readonly stored: StopReason | null;
  /** The other follow-up jobs it cancelled (a lead stop); their messages are cancelled after commit. */
  readonly cancelled: CancelledJobs;
}

const NOTHING_CANCELLED: CancelledJobs = { jobIds: [], messageIds: [] };

/** Marks the lead's other scheduled or running follow-up jobs `cancelled` with the stop as the reason (PLAN §8.3 step 8). */
export async function cancelRemainingFollowUpsInTx(
  tx: Db,
  input: { leadId: string; exceptJobId: string | null; reason: LeadStop; now: Date },
): Promise<CancelledJobs> {
  return cancelJobsInTx(tx, { leadId: input.leadId, kinds: ['followup'], exceptJobId: input.exceptJobId ?? undefined, reason: input.reason, now: input.now });
}

/** Inside the caller's transaction (the job's, after its ownership check). Idempotent. */
export async function endFollowUpInTx(tx: Db, input: EndFollowUpInput): Promise<EndFollowUpResult> {
  if (input.stop !== null && isLeadStop(input.stop)) {
    const stored = await tx.maybeOne<{ stop_reason: StopReason }>(
      `update leads set stop_reason = $3
        where id = $1 and account_id = $2 and not is_test and stop_reason is null
        returning stop_reason`,
      [input.leadId, input.accountId, input.stop],
    );
    // A test lead never has a contact read or a newer lead superseding it, so it never gets here.
    const cancelled = await cancelRemainingFollowUpsInTx(tx, { leadId: input.leadId, exceptJobId: input.jobId, reason: input.stop, now: input.now });
    return { stored: stored?.stop_reason ?? null, cancelled };
  }

  const jobKeys = FOLLOW_UP_NUMBERS.map((n) => followUpDedupeKey(input.leadId, n, input.followupStream));
  const emailKeys = FOLLOW_UP_NUMBERS.map((n) => NotificationKeys.followUp(input.leadId, n, input.followupStream));
  const stored = await tx.maybeOne<{ stop_reason: StopReason }>(
    `update leads l set stop_reason = $4
      where l.id = $1 and l.account_id = $2 and not l.is_test and l.stop_reason is null
        and l.followup_stream = $3 and l.fu2_notified_at is null
        and not exists (
          select 1 from scheduled_jobs j
           where j.lead_id = l.id and j.kind = 'followup' and j.dedupe_key = any($5::text[])
             and ($7::uuid is null or j.id <> $7::uuid) and j.status in ('scheduled', 'running'))
        and not exists (select 1 from notifications_sent ns where ns.dedupe_key = any($6::text[]) and ns.status = 'sending')
      returning l.stop_reason`,
    [input.leadId, input.accountId, input.followupStream, input.stop ?? STREAM_ENDED_STOP, jobKeys, emailKeys, input.jobId],
  );
  return { stored: stored?.stop_reason ?? null, cancelled: NOTHING_CANCELLED };
}
