import 'server-only';
import { errorCode, isRetryable } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { cancelJobsInTx, cancelScheduledMessages, type CancelledJobs } from '@/server/jobs/cancel';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { ensureLeadNotificationsRegistered } from '@/server/services/leads/notifications';
import {
  defaultNotificationRegistry,
  getNotification,
  NotificationKeys,
  NotificationPredicates,
  reserveInTx,
  sendReserved,
  type NotificationRegistry,
} from '@/server/services/notifications';

// markReplied (PLAN §9.5 step 4, §8.4, D-08): the one place a lead's reply is recorded.
//
// ONE transaction (no network I/O inside):
//   UPDATE leads SET replied_at = $reply, stop_reason = 'replied'
//    WHERE id = $1 AND replied_at IS NULL AND NOT is_test (and not privacy-deleted) RETURNING …
// The caller that gets the row back (the winner) marks the lead's remaining `followup` jobs
// cancelled (reason `replied`; the calling follow-up job itself is left to finish `done`) and,
// only when follow-ups were still scheduled (the caller is a follow-up job, or it cancelled at
// least one), reserves the `reply_detected` email (`reply:{leadId}:s{followup_stream}`, sending,
// with its §8.4 predicates). A reply found after the follow-ups finished only updates the status.
// After commit: the QStash cancels, then the email through sendReserved (the registered resumer
// rebuilds it). A transient send error leaves the reservation `sending`: the follow-up job's
// redelivery (§9.5 step 1), a later applySignals, or the sweeper sends it, once (D-45).
// Any later caller gets no row back: it only keeps the earliest reply time (D-08 `LEAST`) and sends
// nothing. A reply at or before `replies_ignored_before` ("Resume follow-ups", D-42) is never
// recorded, by the winner's UPDATE or the LEAST: a check that read HubSpot before the resume committed
// cannot bring the ignored auto-reply back (D-73).
//
// stop_reason: the reply replaces any stored reason except privacy_deletion (never touched) and
// test_lead (test leads are excluded): every other reason is re-derived from live facts when
// "Resume follow-ups" clears `replied` (D-42), so nothing is lost, and an account-level reason
// (paused, follow-ups off, a failed follow-up) does not block a later resume.

export interface MarkRepliedInput {
  readonly accountId: string;
  readonly leadId: string;
  /** HubSpot's time of the reply (`hs_timestamp`, or the fallback property). */
  readonly repliedAt: Date;
  /** Follow-ups were still scheduled when the caller started (a follow-up job about to run). */
  readonly followUpStillScheduled: boolean;
  /** The calling follow-up job: not cancelled here, it finishes on its own. */
  readonly exceptJobId?: string | undefined;
}

export type MarkRepliedTxResult =
  | {
      readonly won: true;
      readonly followupStream: number;
      readonly cancelled: CancelledJobs;
      /** The reply_detected key when it was reserved here; null when no email is due. */
      readonly reservationKey: string | null;
    }
  /** Another caller recorded the reply first (or the lead is gone, test or privacy-deleted): `repliedAt` is the stored time, if any. */
  | { readonly won: false; readonly repliedAt: Date | null };

/** The transaction's statements; the caller commits, then runs the QStash cancels and sendReserved. */
export async function markRepliedInTx(tx: Db, input: MarkRepliedInput & { readonly now: Date }): Promise<MarkRepliedTxResult> {
  // A reply at or before `replies_ignored_before` was ignored by "Resume follow-ups" (D-42): a caller
  // that evaluated the signals before the resume committed never records it again (D-73).
  const won = await tx.maybeOne<{ followup_stream: number }>(
    `update leads set replied_at = $3, stop_reason = 'replied'
      where id = $1 and account_id = $2 and replied_at is null and not is_test
        and stop_reason is distinct from 'privacy_deletion'
        and (replies_ignored_before is null or $3::timestamptz > replies_ignored_before)
      returning followup_stream`,
    [input.leadId, input.accountId, input.repliedAt],
  );
  if (won === null) {
    const existing = await tx.maybeOne<{ replied_at: Date }>(
      `update leads set replied_at = least(replied_at, $3)
        where id = $1 and account_id = $2 and replied_at is not null and not is_test
          and (replies_ignored_before is null or $3::timestamptz > replies_ignored_before)
        returning replied_at`,
      [input.leadId, input.accountId, input.repliedAt],
    );
    if (existing === null) {
      const stored = await tx.maybeOne<{ replied_at: Date | null }>(
        `select replied_at from leads where id = $1 and account_id = $2 and not is_test`,
        [input.leadId, input.accountId],
      );
      return { won: false, repliedAt: stored?.replied_at ?? null };
    }
    return { won: false, repliedAt: existing.replied_at };
  }

  const cancelled = await cancelJobsInTx(tx, {
    leadId: input.leadId,
    kinds: ['followup'],
    exceptJobId: input.exceptJobId,
    reason: 'replied',
    now: input.now,
  });
  if (!input.followUpStillScheduled && cancelled.jobIds.length === 0) {
    return { won: true, followupStream: won.followup_stream, cancelled, reservationKey: null };
  }
  const key = NotificationKeys.replyDetected(input.leadId, won.followup_stream);
  const reserved = await reserveInTx(tx, {
    kind: 'reply_detected',
    dedupeKey: key,
    accountId: input.accountId,
    leadId: input.leadId,
    predicates: NotificationPredicates.replyDetected({ accountId: input.accountId, leadId: input.leadId }),
    now: input.now,
  });
  return { won: true, followupStream: won.followup_stream, cancelled, reservationKey: reserved === null ? null : key };
}

/**
 * What happened to the reply_detected email in this call:
 * - `none`: none is due from this call (follow-ups had finished, already sent, or another caller's);
 * - `sent`: sent now (or Resend showed an earlier attempt had sent it);
 * - `pending`: reserved but not sent yet (a transient error): a retry or the sweeper sends it;
 * - `not_sent`: its predicates failed (dismissed, account or connection not active) or the send failed permanently.
 */
export type ReplyEmailOutcome = 'none' | 'sent' | 'pending' | 'not_sent';

export interface MarkRepliedOptions {
  /** The registry holding the reply_detected resumer. Default: the process registry (registered on demand). */
  readonly notifications?: NotificationRegistry | undefined;
}

export interface MarkRepliedResult {
  readonly won: boolean;
  /** The lead's stored reply time after this call; null when the lead is gone. */
  readonly repliedAt: Date | null;
  readonly cancelledJobs: number;
  readonly replyEmail: ReplyEmailOutcome;
}

function registryOf(options: MarkRepliedOptions): NotificationRegistry {
  if (options.notifications !== undefined) return options.notifications;
  ensureLeadNotificationsRegistered();
  return defaultNotificationRegistry;
}

/** sendReserved for a reply_detected key; a retryable error leaves the reservation for a retry. */
async function sendReplyDetected(deps: Deps, key: string, leadId: string, registry: NotificationRegistry): Promise<ReplyEmailOutcome> {
  try {
    const result = await sendReserved(deps, key, registry);
    switch (result.status) {
      case 'sent':
      case 'already_sent':
        return 'sent';
      case 'failed':
        return 'not_sent';
      case 'skipped':
        // `busy`: another attempt holds the reservation and sends it.
        return result.reason === 'busy' ? 'pending' : 'not_sent';
    }
  } catch (error) {
    if (!isRetryable(error)) throw error;
    log.warn('reply email left for a retry', { event: 'signals.reply_email_pending', leadId, code: errorCode(error) });
    return 'pending';
  }
}

/**
 * Sends a reply_detected reservation of the lead's current follow-up stream that is still
 * `sending` (an earlier attempt's transient error or crash; PLAN §9.5 step 1). `none` when there is
 * none to send.
 */
export async function resumePendingReplyEmail(
  deps: Deps,
  input: { readonly leadId: string; readonly followupStream: number },
  options: MarkRepliedOptions = {},
): Promise<ReplyEmailOutcome> {
  const key = NotificationKeys.replyDetected(input.leadId, input.followupStream);
  const row = await getNotification(deps.db, key);
  if (row?.status !== 'sending') return 'none';
  return sendReplyDetected(deps, key, input.leadId, registryOf(options));
}

/** markRepliedInTx in its own transaction, then the QStash cancels and the email (winner only). */
export async function markReplied(deps: Deps, input: MarkRepliedInput, options: MarkRepliedOptions = {}): Promise<MarkRepliedResult> {
  const now = deps.clock.now();
  const result = await deps.db.tx((tx) => markRepliedInTx(tx, { ...input, now }));
  if (!result.won) return { won: false, repliedAt: result.repliedAt, cancelledJobs: 0, replyEmail: 'none' };

  await cancelScheduledMessages(deps, result.cancelled);
  const replyEmail =
    result.reservationKey === null ? 'none' : await sendReplyDetected(deps, result.reservationKey, input.leadId, registryOf(options));
  log.info('lead reply recorded', {
    event: 'signals.replied',
    accountId: input.accountId,
    leadId: input.leadId,
    count: result.cancelled.jobIds.length,
    outcome: replyEmail,
  });
  return { won: true, repliedAt: input.repliedAt, cancelledJobs: result.cancelled.jobIds.length, replyEmail };
}
