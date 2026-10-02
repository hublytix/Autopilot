import 'server-only';
import { errorCode, isRetryable } from '@/server/domain/errors';
import { evaluateStops } from '@/server/domain/stops';
import type { FollowUpNumber } from '@/server/domain/followup-schedule';
import type { StopReason } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { cancelScheduledMessages, type CancelledJobs } from '@/server/jobs/cancel';
import type { JobFailureInfo, JobRow } from '@/server/jobs/types';
import { log, type LogFields } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { ensureLeadNotificationsRegistered } from '@/server/services/leads/notifications';
import {
  defaultNotificationRegistry,
  getNotification,
  NotificationKeys,
  sendReserved,
  type NotificationRegistry,
} from '@/server/services/notifications';
import { loadStopState } from '@/server/services/signals';
import { endFollowUpInTx } from './end';
import { asFollowUpNumber, followUpLabel, followUpRefOf } from './job-ref';
import { loadFollowUpLead, type FollowUpLead } from './lead';
import { recordFollowUpFailedNote } from './notes';

// The `followup` failure path (PLAN §8.3 step 6, D-15): a lead-page note, never an email. It runs
// for the attempt's permanent error or final delivery, the failure callback's winner and the
// sweeper's attempt limit, after the `job_failed` alert, and may run more than once:
// 1. a follow-up email of this job already `sent` (a crash after the send) → nothing to say;
//    one still `sending` → resumed as it is (it may already be out: Resend's 409 then marks it
//    sent), and only if it cannot go does the note follow (as lead_process, D-68);
// 2. a stop that arrived meanwhile (dismissed, replied, paused, …) is the reason, not the failure:
//    recorded like the handler's stops (end.ts), no note;
// 3. otherwise the note (notes.ts) and the end of the stream when nothing more can come (end.ts), in
//    one transaction, so the lead is not left "follow-ups pending" forever (D-66 open point (2)).
// A job of an older stream, a test lead, or a lead that is gone gets nothing.

export interface FollowUpFailureOptions {
  readonly notifications?: NotificationRegistry | undefined;
}

function registryOf(options: FollowUpFailureOptions): NotificationRegistry {
  if (options.notifications !== undefined) return options.notifications;
  ensureLeadNotificationsRegistered();
  return defaultNotificationRegistry;
}

type ResumeOutcome = 'sent' | 'later' | 'stopped' | 'not_sent';

/** Step 1's resume of the job's own reservation. */
async function resumePendingFollowUp(deps: Deps, key: string, options: FollowUpFailureOptions): Promise<ResumeOutcome> {
  try {
    const result = await sendReserved(deps, key, registryOf(options));
    switch (result.status) {
      case 'sent':
      case 'already_sent':
        return 'sent';
      case 'failed':
        return 'not_sent';
      case 'skipped':
        if (result.reason === 'busy') return 'later';
        return result.reason === 'predicates' ? 'stopped' : 'not_sent';
    }
  } catch (error) {
    if (!isRetryable(error)) throw error;
    // Still `sending`: the sweeper resumes it (and a lost one expires to the note, followUpReservationExpired).
    log.warn('follow-up email not sent yet: the sweeper resumes it', { event: 'followup.notification_retry_later', errorCode: errorCode(error) });
    return 'later';
  }
}

interface NoteOrStopInput {
  readonly lead: FollowUpLead;
  readonly n: FollowUpNumber;
  readonly followupStream: number;
  /** The failed job (left out of "another follow-up still pending"); null when no job is running. */
  readonly jobId: string | null;
  /** `$now`. */
  readonly now: Date;
}

interface NoteOrStopResult {
  /** The stop the database showed (then no note); null when the follow-up simply did not go out. */
  readonly stop: StopReason | null;
  /** The `stop_reason` stored (the stop, or the stream's end); null when none was. */
  readonly stored: StopReason | null;
  /** This call wrote the lead-page note. */
  readonly noted: boolean;
  /** Follow-up jobs cancelled by a lead stop; their QStash messages after commit. */
  readonly cancelled: CancelledJobs;
}

/** Steps 2-3 for follow-up `n` of the lead's current stream, inside `tx` (database statements only). */
async function noteOrStopInTx(tx: Db, input: NoteOrStopInput): Promise<NoteOrStopResult> {
  const { lead, n } = input;
  const end = { accountId: lead.accountId, leadId: lead.id, followupStream: input.followupStream, jobId: input.jobId, now: input.now };
  const state = await loadStopState(tx, { leadId: lead.id, accountId: lead.accountId, followUpNumber: n });
  const stop = state === null ? null : evaluateStops(state).stop;
  if (stop !== null) {
    const ended = await endFollowUpInTx(tx, { ...end, stop });
    return { stop, stored: ended.stored, noted: false, cancelled: ended.cancelled };
  }
  const noted = await recordFollowUpFailedNote(tx, { accountId: lead.accountId, leadId: lead.id, n, followupStream: input.followupStream });
  const ended = await endFollowUpInTx(tx, { ...end, stop: null });
  return { stop: null, stored: ended.stored, noted, cancelled: ended.cancelled };
}

function logNoteOrStop(result: NoteOrStopResult, fields: LogFields, reason: string): void {
  if (result.stop !== null) {
    log.info('follow-up not sent: the lead was stopped meanwhile', { ...fields, event: 'followup.failed_stopped', reason: result.stop, status: result.stored });
    return;
  }
  log.warn('follow-up not sent', { ...fields, event: 'followup.failed', reason, status: result.stored, outcome: result.noted ? 'noted' : 'already_noted' });
}

/** Steps 2-3 in one transaction (the note and the stream's end commit together), then the QStash cancels. */
async function noteOrStop(deps: Deps, input: Omit<NoteOrStopInput, 'now'>, reason: string): Promise<void> {
  const result = await deps.db.tx((tx) => noteOrStopInTx(tx, { ...input, now: deps.clock.now() }));
  await cancelScheduledMessages(deps, result.cancelled);
  logNoteOrStop(result, { accountId: input.lead.accountId, leadId: input.lead.id, jobId: input.jobId, kind: followUpLabel(input.n) }, reason);
}

/** The `followup` failure path (registered by registerFollowUpJob). Idempotent. */
export async function followUpFailurePath(deps: Deps, job: JobRow, info: JobFailureInfo, options: FollowUpFailureOptions = {}): Promise<void> {
  const ref = followUpRefOf(job);
  const n = ref === null ? null : asFollowUpNumber(ref.n);
  if (ref === null || n === null) return;
  const lead = await loadFollowUpLead(deps.db, ref.leadId, job.accountId, deps.clock.now());
  if (lead === null || lead.isTest || lead.followupStream !== ref.followupStream) return;

  const key = NotificationKeys.followUp(lead.id, n, ref.followupStream);
  const reservation = await getNotification(deps.db, key);
  if (reservation?.status === 'sent') return;
  if (reservation?.status === 'sending') {
    const resumed = await resumePendingFollowUp(deps, key, options);
    log.info('pending follow-up email resumed by the failure path', {
      event: 'followup.notification_resumed',
      accountId: lead.accountId,
      leadId: lead.id,
      jobId: job.id,
      kind: followUpLabel(n),
      outcome: resumed,
    });
    if (resumed === 'sent' || resumed === 'later') return;
  }
  await noteOrStop(deps, { lead, n, followupStream: ref.followupStream, jobId: job.id }, info.code);
}

export interface FollowUpEmailFailedInput {
  readonly accountId: string | null;
  readonly leadId: string;
  readonly n: FollowUpNumber;
  readonly followupStream: number;
  /** `$now`. */
  readonly now: Date;
  /** Why the reservation failed (for the log): expired, predicates, not_resumable, permanent. */
  readonly reason: string;
}

/**
 * A follow-up email (`notify:{leadId}:fu{n}:s{stream}`) became `failed` unsent outside its job (D-72,
 * D-73): the sweeper expired it after 23 h, or a resume (the sweeper's, after the job ended on a send
 * outage; the failure path's) found its predicates failing, could not rebuild it, or got a permanent
 * send error. The lead gets what a failed job leaves: the stop the database shows (paused, dismissed,
 * disconnected, …) or else the lead-page note, and the stream's end when nothing more can come — inside
 * the transaction that fails the reservation, so an error rolls both back and the next sweep retries.
 * A follow-up that went out (stamped), an older stream's email, a test lead or a missing lead get
 * nothing. Returns the jobs a lead stop cancelled (QStash after commit).
 */
export async function followUpEmailFailedInTx(tx: Db, input: FollowUpEmailFailedInput): Promise<CancelledJobs | undefined> {
  const lead = await loadFollowUpLead(tx, input.leadId, input.accountId, input.now);
  if (lead === null || lead.isTest || lead.followupStream !== input.followupStream) return undefined;
  if (input.n === 1 ? lead.fu1NotifiedAt !== null : lead.fu2NotifiedAt !== null) return undefined;
  const result = await noteOrStopInTx(tx, { lead, n: input.n, followupStream: input.followupStream, jobId: null, now: input.now });
  logNoteOrStop(result, { accountId: lead.accountId, leadId: lead.id, kind: followUpLabel(input.n) }, `notification_${input.reason}`);
  return result.cancelled;
}

/** followUpEmailFailedInTx in its own transaction (a reservation the sweeper expired), then the QStash cancels. */
export async function followUpReservationExpired(deps: Deps, input: { leadId: string; n: FollowUpNumber; followupStream: number }): Promise<void> {
  const now = deps.clock.now();
  const cancelled = await deps.db.tx((tx) => followUpEmailFailedInTx(tx, { ...input, accountId: null, now, reason: 'expired' }));
  if (cancelled !== undefined) await cancelScheduledMessages(deps, cancelled);
}
