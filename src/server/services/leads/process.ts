import 'server-only';
import { isDraftableClassification, isClassification, type Classification, type LeadProcessingState } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { JobOutcomes, type JobContext, type JobFailureInfo, type JobOutcome, type JobRow, type Registration } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { classifyLead } from '@/server/services/classification';

// The `lead_process` job, M2 part (PLAN §6.2, §8.2, §8.3 step 6, §9.3 steps 1-3, D-32, D-42):
// re-read the lead, skip it when it can no longer be processed, classify it, then either file it as
// filtered or hand it to the drafting step. Drafting, the daily cap and the "new lead" email arrive
// in M4 behind processLeadAfterClassification(); the needs-touch email of the failure path arrives
// behind sendNeedsTouchAfterFailure().
//
// Idempotent under redelivery: the class is stored once (a later delivery reuses it instead of
// calling the model again), and every lead write is a compare-and-set on `process_rev` and the
// expected processing states, committed only while this attempt still holds the job.

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

/** The lead as the drafting step (M4) receives it. */
export interface ClassifiedLead {
  readonly id: string;
  readonly accountId: string;
  readonly processRev: number;
  readonly classification: Classification;
  /** The owner overrode a filtered class: draft it anyway. */
  readonly overridden: boolean;
}

/**
 * ── M4 SEAM: drafting and the "new lead" email (PLAN §9.3 steps 4-6) ────────────────────────────
 * Runs after the lead is classified as `lead`/`unclear` (or overridden) and stored as `processing`.
 * M4 fills it in: the daily cap (→ `deferred` + one `lead_cap` email), the AI budget breaker, the
 * draft with one retry and the validator, the needs-touch fallback, and the `new_lead`/`needs_touch`
 * reservation whose `sent` transaction sets `notified`, `first_notified_at` and the follow-up jobs.
 * It must stay idempotent (the job may be redelivered after it ran) and will likely need the job
 * context (`isFinalDelivery` for the needs-touch fallback, `assertOwned`). Until then the lead
 * stays `processing` and the job ends `done`.
 */
export async function processLeadAfterClassification(_deps: Deps, _lead: ClassifiedLead): Promise<JobOutcome> {
  return JobOutcomes.done();
}

/**
 * The `lead_process` handler (PLAN §9.3 steps 1-3). The integrator registers it with
 * `registerLeadProcessJob` in src/server/jobs/handlers.ts.
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

  return processLeadAfterClassification(deps, { id: lead.id, accountId: lead.accountId, processRev: rev, classification, overridden });
}

/**
 * ── M4 SEAM: the "needs your touch" email of the failure path (PLAN §8.3 step 6, §8.4, D-24) ────
 * Called after the failure path set the lead `failed`. M4 sends the needs-touch email with the
 * minimal safe template through `reserveAndSend` under the initial notification key
 * (`NotificationKeys.initial(leadId, processRev)`, shared with `new_lead`, so a lead gets at most one
 * of the two). It must be idempotent: the failure path can run more than once for a job.
 */
export async function sendNeedsTouchAfterFailure(_deps: Deps, _lead: { id: string; accountId: string; processRev: number }): Promise<void> {
  // Nothing to send until M4 builds the needs-touch template.
}

/** States the failure path may mark `failed`; `failed` itself is included so a repeated run resumes the email. */
const FAILABLE_STATES: readonly LeadProcessingState[] = ['new', 'processing', 'failed'];
/** For an overridden lead, also the states the override was re-processing it from. */
const FAILABLE_STATES_IF_OVERRIDDEN: readonly LeadProcessingState[] = ['filtered', 'deferred', 'skipped'];

/**
 * The `lead_process` failure path (PLAN §8.3 step 6): the lead becomes `failed` ("not processed",
 * D-32) unless it already finished (notified, or filtered without an override) or a newer override
 * superseded the job; then the needs-touch email (M4).
 */
export async function leadProcessFailurePath(deps: Deps, job: JobRow, info: JobFailureInfo): Promise<void> {
  const leadId = leadIdOf(job);
  if (leadId === null) return;
  const rev = jobProcessRev(job);
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

/** Wiring for src/server/jobs/handlers.ts (REGISTRATIONS): the handler and its failure path. */
export const registerLeadProcessJob: Registration = ({ jobs }) => {
  jobs.register('lead_process', leadProcessHandler);
  jobs.registerFailurePath('lead_process', leadProcessFailurePath);
};
