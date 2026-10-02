import 'server-only';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '@/server/db';
import { cancelJobsInTx, cancelScheduledMessages, JobOutcomes, type CancelledJobs, type JobHandler } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { revokeTokens } from '@/server/security/action-tokens';

// HubSpot privacy deletion (D-06, PLAN §7.3; HS-WH-GDPR-PRIVACY-DELETION). For every lead of that
// contact in that account, in one transaction:
// - delete its `lead_messages` (the form message and the contact fields, D-31);
// - null the drafts' subject and body and empty their flags (`'{}'`: the column is NOT NULL, §9.10
//   step 2, D-53), marking them purged;
// - replace `submission_key` (an HMAC of the email, or HubSpot's conversion id) with a random value;
// - revoke the leads' action tokens;
// - cancel the leads' jobs (QStash messages are cancelled after commit);
// - set `stop_reason = 'privacy_deletion'`.
// It runs for every known portal whatever its state, and is idempotent: a replay finds nothing left
// to remove. Ids, timestamps and statuses stay (law 4 allows them).

export interface PrivacyDeleteInput {
  accountId: string;
  /** The HubSpot contact id from the event's `objectId`. */
  contactId: string;
}

export interface PrivacyDeleteResult {
  leads: number;
  messagesDeleted: number;
  draftsCleared: number;
  tokensRevoked: number;
  jobsCancelled: number;
}

export interface PrivacyDeleteOutcome {
  readonly result: PrivacyDeleteResult;
  /** QStash messages to cancel after commit. */
  readonly cancelled: readonly CancelledJobs[];
}

/** Inside the caller's transaction (no network I/O); cancel `cancelled` after commit. */
export async function privacyDeleteInTx(tx: Db, input: PrivacyDeleteInput, now: Date): Promise<PrivacyDeleteOutcome> {
  const leads = await tx.query<{ id: string }>(
    `select id from leads where account_id = $1 and hubspot_contact_id = $2 order by id for update`,
    [input.accountId, input.contactId],
  );
  const ids = leads.map((lead) => lead.id);
  const result: PrivacyDeleteResult = { leads: ids.length, messagesDeleted: 0, draftsCleared: 0, tokensRevoked: 0, jobsCancelled: 0 };
  if (ids.length === 0) return { result, cancelled: [] };

  const messages = await tx.query(`delete from lead_messages where lead_id = any($1::uuid[]) returning lead_id`, [ids]);
  result.messagesDeleted = messages.length;
  const drafts = await tx.query(
    `update drafts set subject = null, body = null, flags = '{}', purged_at = coalesce(purged_at, $2)
      where lead_id = any($1::uuid[]) returning id`,
    [ids, now],
  );
  result.draftsCleared = drafts.length;

  const cancelled: CancelledJobs[] = [];
  for (const leadId of ids) {
    await tx.query(`update leads set submission_key = $2, stop_reason = 'privacy_deletion' where id = $1`, [
      leadId,
      randomBytes(32).toString('hex'),
    ]);
    result.tokensRevoked += await revokeTokens(tx, { leadId, now });
    const jobs = await cancelJobsInTx(tx, { leadId, reason: 'privacy_deletion', now });
    result.jobsCancelled += jobs.jobIds.length;
    cancelled.push(jobs);
  }
  return { result, cancelled };
}

/** privacyDeleteInTx in its own transaction, then the QStash cancels. */
export async function privacyDelete(deps: Deps, input: PrivacyDeleteInput): Promise<PrivacyDeleteResult> {
  const now = deps.clock.now();
  const outcome = await deps.db.tx((tx) => privacyDeleteInTx(tx, input, now));
  for (const cancelled of outcome.cancelled) await cancelScheduledMessages(deps, cancelled);
  return outcome.result;
}

const payloadSchema = z.object({ contactId: z.string().regex(/^\d{1,20}$/) });

/** The `privacy_delete` job (PLAN §8.2): commits only while this attempt still holds the job. */
export const privacyDeleteJobHandler: JobHandler = async (deps, job, ctx) => {
  const payload = payloadSchema.safeParse(job.payload);
  if (job.accountId === null || !payload.success) return { type: 'permanent', code: 'privacy_delete_bad_payload' };
  const input = { accountId: job.accountId, contactId: payload.data.contactId };
  const now = deps.clock.now();
  const outcome = await deps.db.tx(async (tx) => {
    await ctx.assertOwned(tx);
    return privacyDeleteInTx(tx, input, now);
  });
  for (const cancelled of outcome.cancelled) await cancelScheduledMessages(deps, cancelled);
  log.info('privacy deletion applied', {
    event: 'privacy.deleted',
    accountId: input.accountId,
    contactId: input.contactId,
    jobId: job.id,
    count: outcome.result.leads,
  });
  return JobOutcomes.done();
};
