import 'server-only';
import { errorCode, isPermanent, isRetryable } from '@/server/domain/errors';
import { isDraftableClassification, isClassification, type Classification, type LeadProcessingState } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { JobOutcomes, type JobContext, type JobFailureInfo, type JobOutcome, type JobRow, type Registration } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { classifyLead } from '@/server/services/classification';
import { applyDailyCap, fallbackDraft, generateDraft, type GenerateDraftResult, type NeedsTouchReason } from '@/server/services/drafting';
import type { NeedsTouchWhy } from '@/emails/NeedsTouch';
import { NotificationKeys } from '@/server/services/notifications/predicates';
import { getNotification } from '@/server/services/notifications/reserve';
import { sendInitialNotification, type InitialNotificationKind, type InitialNotificationResult } from './initial-notification';
import { registerLeadNotifications } from './notifications';

// The `lead_process` job (PLAN §6.2, §8.2, §8.3 step 6, §9.3, D-24, D-32, D-36, D-42):
// 1. re-read the lead, skip it when it can no longer be processed;
// 2-3. classify it (once), then file it as filtered or go on;
// 4. the daily cap: over MAX_DRAFTED_LEADS_PER_DAY → `deferred` + one `lead_cap` email a day;
// 5. the draft (one retry, the validator, the AI budget breaker; the minimal safe template when the
//    model declines, fails twice, is unavailable, or on the final delivery of a transient error);
// 6. the `new_lead` (or `needs_touch`) email, whose `sent` transaction sets `notified`,
//    `first_notified_at` and the two follow-up job rows.
// The failure path (the final delivery, a permanent error, the failure callback or the sweeper)
// marks the lead `failed` and sends the needs-touch email with the minimal safe template (no LLM)
// under the same notification key, so the owner is never left without an email (D-24). A send
// outage is not a failure: on the final delivery a reserved email still `sending` is left to the
// sweeper (the job ends done), and the failure path resumes a pending `new_lead` email as it is
// rather than downgrading it, so its `sent` transaction notifies the lead with its follow-ups.
//
// Idempotent under redelivery: the class and the draft are stored once (a later delivery reuses them
// instead of calling the model again), the email is exactly-once through its reservation (§8.4), and
// every lead write is a compare-and-set on `process_rev` and the expected processing states,
// committed only while this attempt still holds the job.

/** PLAN §8.2's dedupe key (without the env prefix) for the job of `processRev`. */
export function leadProcessDedupeKey(leadId: string, processRev: number): string {
  return `lead:${leadId}:process:r${processRev}`;
}

const DEDUPE_KEY_REV = /^lead:[^:]+:process:r(\d{1,9})$/;

/** The lead the job is for: the row's `lead_id`, else `payload.leadId`. */
function leadIdOf(job: Pick<JobRow, 'leadId' | 'payload'>): string | null {
  if (job.leadId !== null) return job.leadId;
  const fromPayload = job.payload.leadId;
  return typeof fromPayload === 'string' && fromPayload.length > 0 ? fromPayload : null;
}

/** The `process_rev` the job was created for: `payload.processRev`, else the `:r{n}` of its dedupe key; null when neither says. */
export function jobProcessRev(job: Pick<JobRow, 'dedupeKey' | 'payload'>): number | null {
  const fromPayload = job.payload.processRev;
  if (typeof fromPayload === 'number' && Number.isInteger(fromPayload) && fromPayload >= 0) return fromPayload;
  const match = DEDUPE_KEY_REV.exec(job.dedupeKey);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** States a first run (no override) may still move on from: anything else means this job's work is done. */
const RESUMABLE_STATES: readonly LeadProcessingState[] = ['new', 'processing'];
/** An override ("This is a real lead", D-42) re-processes a lead from every state but `notified`. */
const OVERRIDE_STATES: readonly LeadProcessingState[] = ['new', 'processing', 'filtered', 'deferred', 'failed', 'skipped'];

/** What lead_process reads: ids, statuses, and the content the classifier needs (never logged). */
interface LeadForProcessing {
  id: string;
  accountId: string;
  isTest: boolean;
  classification: Classification | null;
  classificationOverride: Classification | null;
  processingState: LeadProcessingState;
  processRev: number;
  stopReason: string | null;
  dismissedAt: Date | null;
  accountState: string;
  /** False once the content is gone (privacy deletion, the 30-day purge). */
  hasContent: boolean;
  message: string | null;
  firstName: string | null;
  company: string | null;
  formName: string | null;
}

interface LeadRow {
  id: string;
  account_id: string;
  is_test: boolean;
  classification: string | null;
  classification_override: string | null;
  processing_state: LeadProcessingState;
  process_rev: number;
  stop_reason: string | null;
  dismissed_at: Date | null;
  account_state: string;
  has_content: boolean;
  message: string | null;
  first_name: string | null;
  company: string | null;
  form_name: string | null;
}

async function loadLead(db: Db, leadId: string): Promise<LeadForProcessing | null> {
  const row = await db.maybeOne<LeadRow>(
    `select l.id, l.account_id, l.is_test, l.classification, l.classification_override, l.processing_state, l.process_rev,
            l.stop_reason, l.dismissed_at, a.processing_state as account_state,
            m.lead_id is not null as has_content, m.message, m.first_name, m.company, f.form_name
       from leads l
       join accounts a on a.id = l.account_id
       left join lead_messages m on m.lead_id = l.id
       left join selected_forms f on f.account_id = l.account_id and f.form_id = l.form_id
      where l.id = $1`,
    [leadId],
  );
  if (row === null) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    isTest: row.is_test,
    classification: isClassification(row.classification) ? row.classification : null,
    classificationOverride: isClassification(row.classification_override) ? row.classification_override : null,
    processingState: row.processing_state,
    processRev: row.process_rev,
    stopReason: row.stop_reason,
    dismissedAt: row.dismissed_at,
    accountState: row.account_state,
    hasContent: row.has_content,
    message: row.message,
    firstName: row.first_name,
    company: row.company,
    formName: row.form_name,
  };
}

/** The owner said "This is a real lead" (D-42): the lead is drafted whatever its class. */
function isOverridden(lead: Pick<LeadForProcessing, 'processRev' | 'classificationOverride'>): boolean {
  return lead.processRev > 0 || lead.classificationOverride !== null;
}

type SkipReason = 'dismissed' | 'privacy_deletion' | 'content_purged' | 'account_not_active' | 'test_lead';

/** PLAN §9.3 step 1: a lead that can no longer be processed is skipped, not failed. */
function skipReasonOf(lead: LeadForProcessing): SkipReason | null {
  if (lead.dismissedAt !== null) return 'dismissed';
  if (lead.stopReason === 'privacy_deletion') return 'privacy_deletion';
  if (lead.accountState !== 'active') return 'account_not_active';
  // Test leads come from the inbox check and are never processed (D-14); defensive.
  if (lead.isTest) return 'test_lead';
  if (!lead.hasContent) return 'content_purged';
  return null;
}

/** The lead as the drafting step receives it. */
export interface ClassifiedLead {
  readonly id: string;
  readonly accountId: string;
  readonly processRev: number;
  readonly classification: Classification;
  /** The owner overrode a filtered class: draft it anyway. */
  readonly overridden: boolean;
}

/** Bounds the draft calls of one delivery, well inside the job's 6-minute lease. */
const DRAFT_BUDGET_MS = 4 * 60 * 1000;

/** The needs-touch reason in the owner's words (no codes, law 5). */
export function needsTouchWhyOf(reason: NeedsTouchReason): NeedsTouchWhy {
  switch (reason) {
    case 'refusal':
      return 'declined';
    case 'validation_failed':
    case 'invalid_output':
    case 'max_tokens':
      return 'checks';
    case 'fatal_config':
    case 'ai_budget':
      return 'unavailable';
    case 'transient':
    case 'job_failed':
      return 'failed';
    case 'no_brief':
      return 'no_brief';
    case 'earlier_attempt':
      return 'unknown';
  }
}

/** Drafting found the lead or its content gone (privacy deletion, purge) after classification. */
function isContentGone(error: unknown): boolean {
  if (!isPermanent(error)) return false;
  const code = errorCode(error);
  return code === 'draft_content_missing' || code === 'draft_lead_not_found';
}

type LateSkipReason = 'content_purged' | 'notification_predicates';

/** The lead can no longer be notified (dismissed, paused, content gone, …): `skipped`, while this attempt holds the job. */
async function skipLead(deps: Deps, lead: ClassifiedLead, ctx: JobContext, reason: LateSkipReason): Promise<JobOutcome> {
  await deps.db.tx(async (tx) => {
    await ctx.assertOwned(tx);
    await tx.query(`update leads set processing_state = 'skipped' where id = $1 and process_rev = $2 and processing_state = 'processing'`, [
      lead.id,
      lead.processRev,
    ]);
  });
  log.info('lead process skipped', { event: 'lead.process_skipped', accountId: lead.accountId, leadId: lead.id, reason });
  return JobOutcomes.skipped();
}

/** Maps the email's outcome to the job's. */
async function outcomeOfNotification(deps: Deps, lead: ClassifiedLead, ctx: JobContext, result: InitialNotificationResult): Promise<JobOutcome> {
  switch (result.status) {
    case 'sent':
    case 'already_sent':
      return JobOutcomes.done();
    case 'skipped':
      // A predicate failed (dismissed, stopped, account paused or disconnected) → no email, as §8.4 says.
      if (result.reason === 'predicates') return skipLead(deps, lead, ctx, 'notification_predicates');
      // Another attempt (or the sweeper) holds the reservation and finishes the send.
      if (result.reason === 'busy') return JobOutcomes.done();
      return { type: 'permanent', code: `lead_notification_${result.reason}` };
    case 'failed':
      // A permanent send error (alerted): the failure path marks the lead failed.
      return { type: 'permanent', code: 'lead_notification_failed' };
    case 'unsendable':
      if (result.problem === 'content_missing' || result.problem === 'lead_missing') return skipLead(deps, lead, ctx, 'content_purged');
      return { type: 'permanent', code: `lead_notification_${result.problem}` };
  }
}

/**
 * PLAN §9.3 steps 4-6, after the lead is classified as `lead`/`unclear` (or overridden) and stored
 * as `processing`: the daily cap, the draft, the email. Idempotent: a redelivery finds its slot,
 * its stored draft and its reservation again.
 */
export async function processLeadAfterClassification(deps: Deps, lead: ClassifiedLead, ctx: JobContext): Promise<JobOutcome> {
  const guard = (tx: Db): Promise<void> => ctx.assertOwned(tx);

  // Step 4: the daily cap, counted after classification (D-36).
  const cap = await applyDailyCap(deps, { accountId: lead.accountId, leadId: lead.id, processRev: lead.processRev, guard });
  if (cap.type === 'lead_changed') {
    log.info('lead process skipped', { event: 'lead.process_skipped', accountId: lead.accountId, leadId: lead.id, reason: 'lead_changed' });
    return JobOutcomes.skipped();
  }
  if (cap.type === 'deferred') return JobOutcomes.done();

  // Step 5: the draft; the AI budget breaker is checked before each attempt (D-36).
  let drafted: GenerateDraftResult;
  try {
    drafted = await generateDraft(deps, {
      accountId: lead.accountId,
      leadId: lead.id,
      kind: 'initial',
      finalDelivery: ctx.isFinalDelivery,
      signal: AbortSignal.timeout(DRAFT_BUDGET_MS),
      guard,
    });
  } catch (error) {
    if (isContentGone(error)) return skipLead(deps, lead, ctx, 'content_purged');
    throw error;
  }

  // Step 6: the new_lead email, or needs_touch with the draft we have (PLAN §8.4).
  const notificationKind: InitialNotificationKind = drafted.ok ? 'new_lead' : 'needs_touch';
  let result: InitialNotificationResult;
  try {
    result = await sendInitialNotification(
      deps,
      drafted.ok
        ? { accountId: lead.accountId, leadId: lead.id, processRev: lead.processRev, kind: 'new_lead' }
        : { accountId: lead.accountId, leadId: lead.id, processRev: lead.processRev, kind: 'needs_touch', why: needsTouchWhyOf(drafted.reason) },
    );
  } catch (error) {
    // A send outage on the final delivery (a Resend blip, or a response lost after the email went
    // out) is not a failed lead: the reservation stays `sending` with its kind, and the sweeper
    // resumes it; its `sent` transaction then sets `notified` and the follow-up rows (PLAN §6.2,
    // §8.4 step 5). Only when the reservation exists, so the owner is never left without an email.
    if (ctx.isFinalDelivery && isRetryable(error) && (await initialReservationPending(deps, lead))) {
      log.warn('lead email not sent yet: the sweeper resumes it', {
        event: 'lead.notification_retry_later',
        accountId: lead.accountId,
        leadId: lead.id,
        notificationKind,
        errorCode: errorCode(error),
      });
      return JobOutcomes.done();
    }
    throw error;
  }
  log.info('lead email', {
    event: 'lead.notification',
    accountId: lead.accountId,
    leadId: lead.id,
    draftId: drafted.draft.id,
    notificationKind,
    outcome: result.status,
  });
  return outcomeOfNotification(deps, lead, ctx, result);
}

/** The lead's first email is reserved and still `sending` (the job's retry or the sweeper sends it). */
async function initialReservationPending(deps: Deps, lead: Pick<ClassifiedLead, 'id' | 'processRev'>): Promise<boolean> {
  const row = await getNotification(deps.db, NotificationKeys.initial(lead.id, lead.processRev));
  return row !== null && row.status === 'sending';
}

/**
 * The `lead_process` handler (PLAN §9.3). The integrator registers it with `registerLeadProcessJob`
 * in src/server/jobs/handlers.ts.
 */
export async function leadProcessHandler(deps: Deps, job: JobRow, ctx: JobContext): Promise<JobOutcome> {
  const leadId = leadIdOf(job);
  if (leadId === null) return { type: 'permanent', code: 'lead_process_without_lead' };
  const fields = { jobId: job.id, leadId, accountId: job.accountId };

  const lead = await loadLead(deps.db, leadId);
  if (lead === null) {
    log.info('lead process skipped', { ...fields, event: 'lead.process_skipped', reason: 'lead_missing' });
    return JobOutcomes.skipped();
  }

  // An override bumped process_rev and enqueued its own job: this one is superseded.
  const rev = jobProcessRev(job) ?? lead.processRev;
  if (rev !== lead.processRev) {
    log.info('lead process skipped', { ...fields, event: 'lead.process_skipped', reason: 'superseded' });
    return JobOutcomes.skipped();
  }

  const overridden = isOverridden(lead);
  const allowedStates = overridden ? OVERRIDE_STATES : RESUMABLE_STATES;
  if (!allowedStates.includes(lead.processingState)) {
    // An earlier delivery of this job finished its work (filtered, skipped, …) before it crashed.
    log.info('lead process already finished', { ...fields, event: 'lead.process_already_finished', processingState: lead.processingState });
    return JobOutcomes.done();
  }

  const skipReason = skipReasonOf(lead);
  if (skipReason !== null) {
    await deps.db.tx(async (tx) => {
      await ctx.assertOwned(tx);
      await tx.query(
        `update leads set processing_state = 'skipped'
          where id = $1 and process_rev = $2 and processing_state = any($3::text[])`,
        [lead.id, rev, allowedStates],
      );
    });
    log.info('lead process skipped', { ...fields, event: 'lead.process_skipped', reason: skipReason });
    return JobOutcomes.skipped();
  }

  // The class is stored once; a redelivery or an override reuses it rather than asking again.
  let classification = lead.classification;
  if (classification === null) {
    const result = await classifyLead(deps, {
      accountId: lead.accountId,
      leadId: lead.id,
      message: lead.message,
      formName: lead.formName ?? '',
      firstName: lead.firstName,
      company: lead.company,
      attempt: job.attempts,
    });
    classification = result.classification;
  }

  // brief §5.2: only `lead` and `unclear` are drafted; an owner override skips the filter (D-42).
  const filtered = !overridden && !isDraftableClassification(classification);
  const nextState: LeadProcessingState = filtered ? 'filtered' : 'processing';
  const now = deps.clock.now();
  const written = await deps.db.tx(async (tx) => {
    await ctx.assertOwned(tx);
    return tx.maybeOne<{ id: string }>(
      `update leads
          set classification = $3, classified_at = coalesce(classified_at, $4), processing_state = $5
        where id = $1 and process_rev = $2 and processing_state = any($6::text[])
        returning id`,
      [lead.id, rev, classification, now, nextState, allowedStates],
    );
  });
  if (written === null) {
    // The lead moved on meanwhile (a newer override, or another attempt finished it).
    log.info('lead process skipped', { ...fields, event: 'lead.process_skipped', reason: 'lead_changed' });
    return JobOutcomes.skipped();
  }
  log.info('lead classified', { ...fields, event: 'lead.classified', outcome: classification, processingState: nextState });
  if (filtered) return JobOutcomes.done();

  return processLeadAfterClassification(deps, { id: lead.id, accountId: lead.accountId, processRev: rev, classification, overridden }, ctx);
}

/**
 * The "needs your touch" email of the failure path (PLAN §8.3 step 6, §8.4, D-24), after the lead was
 * marked `failed`: the stored draft if one exists, else the minimal safe template (no LLM), under the
 * initial notification key, taking over an unsent new_lead reservation (a lead gets at most one of
 * the two). Idempotent: a repeated run finds the reservation `sent` (or takes it over again). A
 * transient send error leaves the reservation `sending` for the sweeper; it is not rethrown.
 */
export async function sendNeedsTouchAfterFailure(deps: Deps, lead: { id: string; accountId: string; processRev: number }): Promise<void> {
  const fields = { accountId: lead.accountId, leadId: lead.id };
  try {
    await fallbackDraft(deps, { accountId: lead.accountId, leadId: lead.id, kind: 'initial' });
  } catch (error) {
    if (!isContentGone(error)) throw error;
    log.info('needs-touch email not possible: the lead content is gone', { ...fields, event: 'lead.needs_touch_unsendable', reason: 'content_purged' });
    return;
  }
  try {
    const result = await sendInitialNotification(deps, { accountId: lead.accountId, leadId: lead.id, processRev: lead.processRev, kind: 'needs_touch', why: 'failed' });
    log.info('needs-touch email after a failed job', { ...fields, event: 'lead.needs_touch_after_failure', outcome: result.status });
  } catch (error) {
    if (!isRetryable(error)) throw error;
    log.warn('needs-touch email not sent yet: the sweeper resumes it', { ...fields, event: 'lead.needs_touch_retry_later', errorCode: errorCode(error) });
  }
}

/** States the failure path may mark `failed`; `failed` itself is included so a repeated run resumes the email. */
const FAILABLE_STATES: readonly LeadProcessingState[] = ['new', 'processing', 'failed'];
/** For an overridden lead, also the states the override was re-processing it from. */
const FAILABLE_STATES_IF_OVERRIDDEN: readonly LeadProcessingState[] = ['filtered', 'deferred', 'skipped'];

/**
 * The failure path's first question: is the lead's checked draft already on its way? A `new_lead`
 * reservation still `sending` for a lead still `processing` means an attempt reached the send and
 * then died or timed out (the email may well be out). That email is resumed as it is, never
 * downgraded to "something went wrong": its `sent` transaction marks the lead `notified` and writes
 * the follow-up rows, whether the send goes out now or Resend answers 409 for the earlier one.
 * True when the failure path has nothing more to do.
 */
async function resumePendingNewLead(deps: Deps, leadId: string, rev: number | null): Promise<boolean> {
  const lead = await deps.db.maybeOne<{ account_id: string; process_rev: number }>(
    `select account_id, process_rev from leads
      where id = $1 and process_rev = coalesce($2::int, process_rev) and processing_state = 'processing'`,
    [leadId, rev],
  );
  if (lead === null) return false;
  const reservation = await getNotification(deps.db, NotificationKeys.initial(leadId, lead.process_rev));
  if (reservation === null || reservation.status !== 'sending' || reservation.kind !== 'new_lead') return false;
  const fields = { accountId: lead.account_id, leadId };
  let result: InitialNotificationResult;
  try {
    result = await sendInitialNotification(deps, { accountId: lead.account_id, leadId, processRev: lead.process_rev, kind: 'new_lead' });
  } catch (error) {
    if (!isRetryable(error)) return false;
    log.warn('lead email not sent yet: the sweeper resumes it', { ...fields, event: 'lead.notification_retry_later', notificationKind: 'new_lead', errorCode: errorCode(error) });
    return true;
  }
  log.info('pending lead email resumed by the failure path', { ...fields, event: 'lead.notification_resumed', notificationKind: 'new_lead', outcome: result.status });
  switch (result.status) {
    case 'sent':
    case 'already_sent':
      return true;
    case 'skipped':
      if (result.reason === 'busy') return true;
      if (result.reason === 'predicates') {
        await deps.db.query(`update leads set processing_state = 'skipped' where id = $1 and process_rev = $2 and processing_state = 'processing'`, [
          leadId,
          lead.process_rev,
        ]);
        return true;
      }
      return false;
    case 'failed':
    case 'unsendable':
      return false;
  }
}

/**
 * The `lead_process` failure path (PLAN §8.3 step 6): a pending new_lead email is resumed as it is
 * (above); otherwise the lead becomes `failed` ("not processed", D-32) unless it already finished
 * (notified, or filtered without an override) or a newer override superseded the job; then the
 * needs-touch email.
 */
export async function leadProcessFailurePath(deps: Deps, job: JobRow, info: JobFailureInfo): Promise<void> {
  const leadId = leadIdOf(job);
  if (leadId === null) return;
  const rev = jobProcessRev(job);
  if (await resumePendingNewLead(deps, leadId, rev)) return;
  const row = await deps.db.maybeOne<{ id: string; account_id: string; process_rev: number }>(
    `update leads set processing_state = 'failed'
      where id = $1
        and process_rev = coalesce($2::int, process_rev)
        and (processing_state = any($3::text[])
             or ((process_rev > 0 or classification_override is not null) and processing_state = any($4::text[])))
      returning id, account_id, process_rev`,
    [leadId, rev, FAILABLE_STATES, FAILABLE_STATES_IF_OVERRIDDEN],
  );
  if (row === null) {
    log.info('lead process failure path: nothing to mark', { event: 'lead.process_failed_noop', jobId: job.id, leadId, reason: info.reason });
    return;
  }
  log.warn('lead processing failed', { event: 'lead.process_failed', jobId: job.id, leadId, accountId: row.account_id, reason: info.reason, errorCode: info.code });
  await sendNeedsTouchAfterFailure(deps, { id: row.id, accountId: row.account_id, processRev: row.process_rev });
}

/**
 * Wiring for src/server/jobs/handlers.ts (REGISTRATIONS): the handler, its failure path, and the
 * resumers of the lead emails (new_lead, needs_touch, follow_up, reply_detected).
 */
export const registerLeadProcessJob: Registration = (registries) => {
  registries.jobs.register('lead_process', leadProcessHandler);
  registries.jobs.registerFailurePath('lead_process', leadProcessFailurePath);
  registerLeadNotifications(registries);
};
