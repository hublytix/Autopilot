import 'server-only';
import { errorCode, isPermanent, isRetryable } from '@/server/domain/errors';
import { evaluateStops } from '@/server/domain/stops';
import type { FollowUpNumber } from '@/server/domain/followup-schedule';
import type { StopReason } from '@/server/domain/types';
import { cancelScheduledMessages } from '@/server/jobs/cancel';
import { JobOutcomes, type JobContext, type JobOutcome, type JobRow, type Registration } from '@/server/jobs';
import { log, type LogFields } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { generateDraft, type GenerateDraftResult } from '@/server/services/drafting';
import type { Sleep } from '@/server/services/hubspot';
import { followUpNotificationPlan } from '@/server/services/leads/follow-up-notification';
import { parseLeadNotificationKey, registerLeadNotifications } from '@/server/services/leads/notifications';
import { needsTouchWhyOf } from '@/server/services/leads/process';
import {
  getNotification,
  NotificationKeys,
  reserveAndSend,
  type NotificationFailureHook,
  type NotificationRegistry,
  type SendResult,
} from '@/server/services/notifications';
import { applySignals, loadStopState, resumePendingReplyEmail, type ReplyEmailOutcome } from '@/server/services/signals';
import { endFollowUpInTx } from './end';
import { followUpEmailFailedInTx, followUpFailurePath } from './failure';
import { asFollowUpNumber, followUpLabel, followUpRefOf, type FollowUpRef } from './job-ref';
import { fu2WaitsForFu1, loadFollowUpLead, quietHoursRetarget, type FollowUpLead } from './lead';

// The `followup` job (brief §5.6, PLAN §8.3, §8.4, §9.5, D-08, D-09, D-11, D-33, D-34, D-44). The
// dispatcher has already done the hop check and the claim. Then:
// 1. a `reply:{leadId}:s{stream}` email still `sending` from an earlier attempt (markReplied's send was
//    lost) is sent, and the job is done;
// 2. the stops on the database state (evaluateStops: test lead, privacy deletion, dismissed, replied,
//    a stored stop, superseded, account or connection not active, follow-ups off, a third follow-up),
//    and a job of an older follow-up stream ("Resume follow-ups" made a new one) → skipped; then the
//    current quiet hours and weekends in the portal's zone: a time they forbid is re-targeted to the
//    next allowed one (D-33), as is follow-up 2 while follow-up 1 of its stream has not run yet;
// 3-4. applySignals (the contact read, D-08/D-09; HubSpot errors propagate: the daily limit and other
//    long waits re-target through the dispatcher, D-11): a reply → markReplied (the reply_detected
//    email after its commit, the other follow-up cancelled) and done; contact deleted (404), opted out
//    or bounced → stopped, stored, the remaining follow-up cancelled;
// 5. the follow-up draft (≤ 70 words, quoting the first email while it is stored; the needs-touch
//    starter on refusal, two failures or the final delivery) and the email (`follow_up`, or
//    `needs_touch` on the same key `notify:{leadId}:fu{n}:s{stream}`), whose reservation predicates
//    re-check the database stops, so a dismiss, pause or disconnect during drafting sends nothing; the
//    honest notes (D-34) are rendered from `send_confirmed_at` (just refreshed) and `logging_mode`,
//    and "no reply is logged" only when step 3 read every logged email (D-73);
//    the `sent` transaction stamps `fu{n}_notified_at`;
// 6. done.
// A job that ends without its email records the end of the stream when nothing more can come
// (end.ts), so the lead can still read "No reply from lead (none logged)". The failure path
// (failure.ts) leaves a lead-page note, never an email.

export interface FollowUpJobOptions {
  /** The per-portal limiter's wait (the simulation and tests advance a FakeClock). */
  readonly sleep?: Sleep | undefined;
  /** The registry holding the follow_up / needs_touch / reply_detected resumers. */
  readonly notifications?: NotificationRegistry | undefined;
}

/** Bounds the draft calls of one delivery, well inside the job's 6-minute lease (as lead_process). */
const DRAFT_BUDGET_MS = 4 * 60 * 1000;

function skipped(fields: LogFields, reason: string): JobOutcome {
  log.info('follow-up skipped', { ...fields, event: 'followup.skipped', reason });
  return JobOutcomes.skipped();
}

/** The reply email after markReplied (or step 1): a transient send error gets a QStash retry sooner than the sweeper. */
function afterReplyEmail(outcome: ReplyEmailOutcome, ctx: JobContext): JobOutcome {
  if (outcome === 'pending' && !ctx.isFinalDelivery) return { type: 'transient', code: 'followup_reply_email_pending' };
  return JobOutcomes.done();
}

/** Drafting found the lead or its content gone (privacy deletion, the 30-day purge). */
function isContentGone(error: unknown): boolean {
  if (!isPermanent(error)) return false;
  const code = errorCode(error);
  return code === 'draft_content_missing' || code === 'draft_lead_not_found';
}

interface Ending {
  readonly deps: Deps;
  readonly ctx: JobContext;
  readonly job: JobRow;
  readonly lead: FollowUpLead;
  readonly ref: FollowUpRef;
  readonly fields: LogFields;
}

/** The job ends without its email: the stop (or the stream's end) recorded while this attempt holds the job. */
async function stopFollowUp(ending: Ending, stop: StopReason | null, reason: string): Promise<JobOutcome> {
  const { deps, ctx, job, lead, ref } = ending;
  const now = deps.clock.now();
  const ended = await deps.db.tx(async (tx) => {
    await ctx.assertOwned(tx);
    return endFollowUpInTx(tx, { accountId: lead.accountId, leadId: lead.id, followupStream: ref.followupStream, jobId: job.id, stop, now });
  });
  await cancelScheduledMessages(deps, ended.cancelled);
  log.info('follow-up stopped', {
    ...ending.fields,
    event: 'followup.stopped',
    reason: stop ?? reason,
    status: ended.stored,
    count: ended.cancelled.jobIds.length,
  });
  return JobOutcomes.skipped();
}

/** The stop the database shows now (after a reservation predicate failed). */
async function currentStop(ending: Ending): Promise<StopReason | null> {
  const state = await loadStopState(ending.deps.db, { leadId: ending.lead.id, accountId: ending.lead.accountId, followUpNumber: ending.ref.n });
  return state === null ? null : evaluateStops(state).stop;
}

async function outcomeOfSend(ending: Ending, result: SendResult): Promise<JobOutcome> {
  switch (result.status) {
    case 'sent':
    case 'already_sent':
      return JobOutcomes.done();
    case 'failed':
      // A permanent send error (the reservation is failed and alerted): the failure path leaves the note.
      return { type: 'permanent', code: 'followup_notification_failed' };
    case 'skipped':
      switch (result.reason) {
        case 'busy':
          // Another attempt (or the sweeper) holds the reservation and finishes the send.
          return JobOutcomes.done();
        case 'predicates':
        case 'failed_earlier':
          // A stop arrived between the claim and the send (dismissed, paused, disconnected, replied,
          // superseded, follow-ups off): the reservation SQL refused it (PLAN §6.2, §8.4).
          return stopFollowUp(ending, await currentStop(ending), 'notification_predicates');
        case 'kind_mismatch':
        case 'not_reserved':
        case 'no_renderer':
          return { type: 'permanent', code: `followup_notification_${result.reason}` };
      }
  }
}

/** Step 5: the draft and the email for follow-up `n`; `repliesChecked`: step 3 read every logged email. */
async function draftAndSend(ending: Ending, n: FollowUpNumber, repliesChecked: boolean): Promise<JobOutcome> {
  const { deps, ctx, lead, ref, fields } = ending;
  let drafted: GenerateDraftResult;
  try {
    drafted = await generateDraft(deps, {
      accountId: lead.accountId,
      leadId: lead.id,
      kind: followUpLabel(n),
      finalDelivery: ctx.isFinalDelivery,
      signal: AbortSignal.timeout(DRAFT_BUDGET_MS),
      guard: (tx) => ctx.assertOwned(tx),
    });
  } catch (error) {
    if (isContentGone(error)) return stopFollowUp(ending, null, 'content_purged');
    throw error;
  }

  const built = await followUpNotificationPlan(deps, {
    accountId: lead.accountId,
    leadId: lead.id,
    n,
    followupStream: ref.followupStream,
    why: drafted.ok ? undefined : needsTouchWhyOf(drafted.reason),
    repliesChecked,
  });
  // The draft is stored, so the content was there a moment ago: nobody to email, or a purge raced us.
  if (built === null) return { type: 'permanent', code: 'followup_unsendable' };

  let result: SendResult;
  try {
    // The reservation (or the takeover of an earlier attempt's) runs after the ownership check in one
    // transaction: a job cancelled meanwhile (a reply, a dismiss, a resume) never reserves (D-73).
    result = await reserveAndSend(deps, {
      kind: built.kind,
      dedupeKey: built.dedupeKey,
      accountId: lead.accountId,
      leadId: lead.id,
      ...built.plan,
      guard: (tx) => ctx.assertOwned(tx),
    });
  } catch (error) {
    // A send outage on the final delivery is not a failed follow-up (as lead_process, D-68): the
    // reservation stays `sending` and the sweeper resumes it; its `sent` transaction stamps fu{n}.
    if (ctx.isFinalDelivery && isRetryable(error) && (await getNotification(deps.db, built.dedupeKey))?.status === 'sending') {
      log.warn('follow-up email not sent yet: the sweeper resumes it', {
        ...fields,
        event: 'followup.notification_retry_later',
        notificationKind: built.kind,
        errorCode: errorCode(error),
      });
      return JobOutcomes.done();
    }
    throw error;
  }
  log.info('follow-up email', { ...fields, event: 'followup.notification', draftId: drafted.draft.id, notificationKind: built.kind, outcome: result.status });
  return outcomeOfSend(ending, result);
}

/** The `followup` handler (PLAN §9.5); registered by registerFollowUpJob. */
export async function followUpHandler(deps: Deps, job: JobRow, ctx: JobContext, options: FollowUpJobOptions = {}): Promise<JobOutcome> {
  const ref = followUpRefOf(job);
  if (ref === null) return { type: 'permanent', code: 'followup_bad_payload' };
  const number = asFollowUpNumber(ref.n);
  const fields: LogFields = { jobId: job.id, leadId: ref.leadId, accountId: job.accountId, kind: number === null ? 'fu_extra' : followUpLabel(number) };

  // Step 1: a reply email an earlier attempt reserved but did not get out.
  const pendingReply = await resumePendingReplyEmail(deps, { leadId: ref.leadId, followupStream: ref.followupStream }, { notifications: options.notifications });
  if (pendingReply !== 'none') {
    log.info('follow-up finished a pending reply email', { ...fields, event: 'followup.reply_email_resumed', outcome: pendingReply });
    return afterReplyEmail(pendingReply, ctx);
  }

  // Step 2: the stops on the database state.
  const now = deps.clock.now();
  const lead = await loadFollowUpLead(deps.db, ref.leadId, job.accountId, now);
  if (lead === null) return skipped(fields, 'lead_missing');
  // "Resume follow-ups" started a new stream with its own jobs; this one belongs to the old one.
  if (lead.followupStream !== ref.followupStream) return skipped(fields, 'stale_stream');
  const ending: Ending = { deps, ctx, job, lead, ref, fields };
  const stop = await currentStop(ending);
  if (stop !== null) return stopFollowUp(ending, stop, 'stopped');
  if (number === null) return stopFollowUp(ending, 'max_followups', 'max_followups');

  // A redelivery after the `sent` transaction committed: nothing left to do. Follow-up n already
  // emailed in an earlier stream (the sweeper finished it after a resume) is never sent again (D-73).
  if ((number === 1 ? lead.fu1NotifiedAt : lead.fu2NotifiedAt) !== null) return JobOutcomes.done();
  if ((await getNotification(deps.db, NotificationKeys.followUp(lead.id, number, ref.followupStream)))?.status === 'sent') {
    return JobOutcomes.done();
  }

  // D-33 at fire time: the current settings decide, in the portal's zone.
  const quietUntil = quietHoursRetarget(lead, now);
  if (quietUntil !== null) {
    log.info('follow-up re-targeted out of quiet hours', { ...fields, event: 'followup.retargeted', reason: 'quiet_hours', delayMs: quietUntil.getTime() - now.getTime() });
    return JobOutcomes.retarget(quietUntil);
  }
  if (number === 2) {
    const fu1Wait = await fu2WaitsForFu1(deps.db, lead, { followupStream: ref.followupStream, jobId: job.id, now });
    if (fu1Wait !== null) {
      log.info('follow-up 2 waits for follow-up 1', { ...fields, event: 'followup.retargeted', reason: 'fu1_pending', delayMs: fu1Wait.getTime() - now.getTime() });
      return JobOutcomes.retarget(fu1Wait);
    }
  }

  // Steps 3-4: the contact read and the signals (D-08, D-09). This job was still scheduled, so a reply gets the email.
  const signals = await applySignals(deps, lead.id, {
    caller: 'followup_job',
    followUpStillScheduled: true,
    jobId: job.id,
    accountId: lead.accountId,
    sleep: options.sleep,
    notifications: options.notifications,
  });
  if (signals.replied) {
    log.info('follow-up stopped: the lead replied', { ...fields, event: 'followup.replied', outcome: signals.replyEmail });
    return afterReplyEmail(signals.replyEmail, ctx);
  }
  if (signals.stop !== null) return stopFollowUp(ending, signals.stop, 'contact');
  if (signals.outcome === 'skipped') return skipped(fields, 'signals_skipped');

  // Steps 5-6. When the emails logged in HubSpot could not all be read, the email says so instead of
  // "no reply is logged" (law 3, D-73).
  return draftAndSend(ending, number, signals.emailsAvailable);
}

/**
 * A follow-up email that became `failed` unsent outside its job (the sweeper's 23 h expiry, or a
 * resume that found its predicates failing, could not rebuild it or got a permanent error; D-72, D-73):
 * the same stop or lead-page note and stream end as a failed job, inside the transaction that fails
 * the reservation (followUpEmailFailedInTx). Registered for follow_up and needs_touch; other keys
 * (an initial needs-touch email) are left to their own hook.
 */
export const followUpEmailFailed: NotificationFailureHook = {
  inTx: async (tx, row, failure) => {
    const key = parseLeadNotificationKey(row.dedupeKey);
    if (key?.type !== 'follow_up') return undefined;
    return followUpEmailFailedInTx(tx, {
      accountId: row.accountId,
      leadId: key.leadId,
      n: key.n,
      followupStream: key.followupStream,
      now: failure.now,
      reason: failure.reason,
    });
  },
};

/**
 * Wiring for src/server/jobs/handlers.ts (REGISTRATIONS): the `followup` handler, its failure path
 * (a lead-page note) and the follow-up email's failure hook. The follow-up email resumers come with the
 * lead emails (registered here too when lead_process has not done it; registering twice is a no-op).
 */
export const registerFollowUpJob: Registration = (registries) => {
  const options: FollowUpJobOptions = { sleep: registries.limiterSleep, notifications: registries.notifications };
  registerLeadNotifications(registries);
  registries.notifications.onFailed('follow_up', followUpEmailFailed);
  registries.notifications.onFailed('needs_touch', followUpEmailFailed);
  registries.jobs.register('followup', (deps, job, ctx) => followUpHandler(deps, job, ctx, options));
  registries.jobs.registerFailurePath('followup', (deps, job, info) => followUpFailurePath(deps, job, info, options));
};
