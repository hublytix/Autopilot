import 'server-only';
import { TransientError } from '@/server/domain/errors';
import { DRAFT_FLAGS, type AiCallOutcome, type DraftFlag, type DraftKind, type ValidationErrorCode } from '@/server/domain/types';
import { stripControls } from '@/server/domain/defang';
import { validateDraft, type ValidationContext } from '@/server/domain/validator';
import { stripInvisible } from '@/server/domain/validator/text';
import type { Db } from '@/server/db';
import { raiseAlert } from '@/server/jobs/alert';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import type { BriefDraft, DraftOutput, DraftRetryCode, LlmResult } from '@/server/ports/llm';
import { aiCallRecord, recordAiCall } from '@/server/services/classification/ai-calls';
import { isAiDailyBudgetTripped } from './budget';
import { findCompletedDraft, loadDraftContext, storeDraft, type DraftContext, type DraftRecord, type DraftToStore } from './repository';
import { minimalSafeTemplate } from './template';

// The draft engine (brief §5.4, PLAN §9.3 step 5, §9.5 step 5, D-24, D-36, D-47):
//   LLM (structured output) → Zod (enums lower-cased, in the adapter) → invisible/bidi and control
//   characters removed (normaliseModelText) → validator; the normalised text is what is stored.
// - A draft that fails the validator, invalid output, or a `max_tokens` stop gets ONE retry: a fresh
//   single-turn request carrying the error codes (after `max_tokens`, with the doubled budget).
//   `max_tokens` therefore counts as the retry [AI-SO-REFUSAL-MAXTOKENS].
// - A refusal (never retried), a second failure or a FATAL-CONFIG error (plus an admin alert) →
//   needs touch: the minimal safe template is stored instead (no LLM).
// - A transient error throws TransientError so the job retries; on the job's final delivery the
//   caller passes `finalDelivery` and gets the needs-touch template instead (never silent, D-24).
// - While the AI budget breaker is tripped no call is made: needs touch (D-36).
// - Every attempt writes one `ai_calls` row (no content). The `drafts` row is written once per
//   (lead, kind), first writer wins; a redelivered job gets the stored draft back without a call.

export type DraftingDeps = Pick<Deps, 'db' | 'clock' | 'llm' | 'env'>;

/** Why a lead's draft is the needs-touch template. */
export type NeedsTouchReason =
  /** The model declined (no retry on the same model). */
  | 'refusal'
  /** Both attempts produced drafts the validator rejected. */
  | 'validation_failed'
  /** The last attempt's answer did not match the schema. */
  | 'invalid_output'
  /** The last attempt was cut off at max_tokens. */
  | 'max_tokens'
  /** A FATAL-CONFIG API error (bad key, retired model, spend cap): the admin was alerted. */
  | 'fatal_config'
  /** The AI daily budget breaker is tripped. */
  | 'ai_budget'
  /** A transient error on the job's final delivery. */
  | 'transient'
  /** The job failed before a draft was stored (failure path, `fallbackDraft`). */
  | 'job_failed'
  /** The owner has not saved a brief (should not happen for an active account). */
  | 'no_brief'
  /** A needs-touch draft stored by an earlier delivery (its reason is not stored). */
  | 'earlier_attempt';

export type GenerateDraftResult =
  | { readonly ok: true; readonly draft: DraftRecord }
  | { readonly ok: false; readonly needsTouch: true; readonly reason: NeedsTouchReason; readonly draft: DraftRecord };

export interface GenerateDraftInput {
  readonly accountId: string;
  readonly leadId: string;
  readonly kind: DraftKind;
  /**
   * The job's final delivery (`ctx.isFinalDelivery`): a transient error then stores the needs-touch
   * template instead of throwing, so the owner still gets an email.
   */
  readonly finalDelivery?: boolean | undefined;
  /** Bounds each LLM call (and the SDK's retry sleeps) to the caller's budget. */
  readonly signal?: AbortSignal | undefined;
  /** Runs inside the transaction that stores the draft (lead_process passes `ctx.assertOwned`). */
  readonly guard?: ((tx: Db) => Promise<void>) | undefined;
}

/** The most attempts per draft: the first and ONE retry (brief §5.4). */
export const MAX_DRAFT_ATTEMPTS = 2;

interface Spend {
  attempts: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

function sortedFlags(flags: readonly DraftFlag[]): DraftFlag[] {
  return DRAFT_FLAGS.filter((flag) => flags.includes(flag));
}

/**
 * The model's subject and body as they are validated and stored: invisible and bidi format characters
 * removed (a lead steering the model could otherwise reorder or hide what the owner reviews, D-47),
 * and in the body every control character but the line break (CRLF → LF). The subject keeps its
 * controls, so a line break there still fails `bad_subject`.
 */
export function normaliseModelText(draft: { subject: string; body: string }): { subject: string; body: string } {
  return { subject: stripInvisible(draft.subject), body: stripControls(draft.body) };
}

function validationContext(context: DraftContext, brief: BriefDraft): ValidationContext {
  return { kind: context.kind, brief, firstName: context.lead.firstName, leadMessage: context.lead.message, siteUrl: context.siteUrl };
}

function followUpNumber(kind: DraftKind): 1 | 2 {
  return kind === 'fu2' ? 2 : 1;
}

async function callModel(
  deps: DraftingDeps,
  context: DraftContext,
  brief: BriefDraft,
  previous: readonly DraftRetryCode[],
  signal: AbortSignal | undefined,
): Promise<LlmResult<DraftOutput>> {
  const options = signal === undefined ? undefined : { signal };
  if (context.kind === 'initial') return deps.llm.draft({ brief, lead: context.lead, previousErrorCodes: previous }, options);
  return deps.llm.draftFollowUp(
    { brief, lead: context.lead, previousErrorCodes: previous, followUpNumber: followUpNumber(context.kind), original: context.original },
    options,
  );
}

async function storeTemplate(
  db: Db,
  context: DraftContext,
  reason: NeedsTouchReason,
  spend: Spend,
  modelErrors: readonly ValidationErrorCode[],
  guard: GenerateDraftInput['guard'],
): Promise<GenerateDraftResult> {
  const template = minimalSafeTemplate({
    kind: context.kind,
    brief: context.brief,
    firstName: context.lead.firstName,
    leadMessage: context.lead.message,
    siteUrl: context.siteUrl,
  });
  if (template.validationErrors.length > 0) {
    log.warn('needs-touch template fails the validator', { event: 'draft.template_invalid', leadId: context.leadId, codes: [...template.validationErrors] });
  }
  const draft = await storeDraft(
    db,
    { accountId: context.accountId, leadId: context.leadId, kind: context.kind, purgeAt: context.purgeAt },
    {
      subject: template.subject,
      body: template.body,
      flags: [],
      usedBookingLink: template.usedBookingLink,
      validationOk: false,
      validationErrors: modelErrors,
      ...spend,
      needsTouch: true,
    },
    guard,
  );
  log.info('draft needs touch', {
    event: 'draft.needs_touch',
    accountId: context.accountId,
    leadId: context.leadId,
    draftId: draft.id,
    kind: context.kind,
    reason,
    attempts: spend.attempts,
    codes: [...modelErrors],
  });
  return draft.needsTouch ? { ok: false, needsTouch: true, reason, draft } : { ok: true, draft };
}

/**
 * Drafts the lead's `kind` email and stores it (see the module comment). Throws TransientError for a
 * transient LLM error (unless `finalDelivery`), PermanentError when the lead or its content is gone,
 * and DbError for a database failure.
 */
export async function generateDraft(deps: DraftingDeps, input: GenerateDraftInput): Promise<GenerateDraftResult> {
  const context = await loadDraftContext(deps.db, input);
  const stored = await findCompletedDraft(deps.db, input.leadId, input.kind);
  if (stored !== null) {
    return stored.needsTouch ? { ok: false, needsTouch: true, reason: 'earlier_attempt', draft: stored } : { ok: true, draft: stored };
  }

  const spend: Spend = { attempts: 0, model: null, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 };
  const brief = context.brief;
  if (brief === null) return storeTemplate(deps.db, context, 'no_brief', spend, [], input.guard);

  const purpose = context.kind === 'initial' ? 'draft' : 'followup';
  const ids = { accountId: input.accountId, leadId: input.leadId, kind: input.kind, purpose };
  const validation = validationContext(context, brief);
  let previous: DraftRetryCode[] = [];
  let modelErrors: ValidationErrorCode[] = [];
  let lastFailure: NeedsTouchReason = 'validation_failed';

  for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt += 1) {
    if (await isAiDailyBudgetTripped(deps, { accountId: input.accountId })) return storeTemplate(deps.db, context, 'ai_budget', spend, modelErrors, input.guard);

    const startedAt = deps.clock.now();
    const result = await callModel(deps, context, brief, previous, input.signal);
    const finishedAt = deps.clock.now();

    let outcome: AiCallOutcome = result.ok ? 'ok' : result.failure;
    let codes: ValidationErrorCode[] = [];
    let emptyBody = false;
    // The text the validator checks is exactly the text stored, emailed and put in the compose link.
    const output = result.ok ? normaliseModelText(result.value) : null;
    if (output !== null) {
      emptyBody = output.body.trim() === '';
      codes = validateDraft(output, validation);
      if (codes.length > 0 || emptyBody) outcome = emptyBody && codes.length === 0 ? 'invalid_output' : 'validator_fail';
    }
    const record = aiCallRecord(
      { accountId: input.accountId, leadId: input.leadId, purpose, attempt, requestedModel: deps.env.ANTHROPIC_MODEL_DRAFT, startedAt, finishedAt },
      result,
      outcome,
    );
    await recordAiCall(deps.db, record);
    spend.attempts = attempt;
    spend.model = record.model;
    spend.inputTokens += record.inputTokens;
    spend.outputTokens += record.outputTokens;
    spend.costMicroUsd += record.costMicroUsd;

    if (result.ok && output !== null && outcome === 'ok') {
      const link = context.bookingLink;
      const toStore: DraftToStore = {
        subject: output.subject,
        body: output.body,
        flags: sortedFlags(result.value.flags),
        // What the body actually contains, not what the model says (never overstate).
        usedBookingLink: link !== null && output.body.includes(link),
        validationOk: true,
        validationErrors: [],
        ...spend,
        needsTouch: false,
      };
      const draft = await storeDraft(deps.db, { accountId: input.accountId, leadId: input.leadId, kind: input.kind, purgeAt: context.purgeAt }, toStore, input.guard);
      log.info('draft generated', { event: 'draft.generated', ...ids, draftId: draft.id, attempts: attempt, outcome: 'ok' });
      return draft.needsTouch ? { ok: false, needsTouch: true, reason: 'earlier_attempt', draft } : { ok: true, draft };
    }

    if (result.ok) {
      // Valid JSON the validator rejected (or an empty body): retry with the codes.
      modelErrors = codes;
      previous = emptyBody ? [...codes, 'invalid_output'] : codes;
      lastFailure = codes.length > 0 ? 'validation_failed' : 'invalid_output';
      log.info('draft rejected by the validator', { event: 'draft.validator_fail', ...ids, attempt, codes });
      continue;
    }

    switch (result.failure) {
      case 'refusal':
        return storeTemplate(deps.db, context, 'refusal', spend, modelErrors, input.guard);
      case 'fatal_config':
        raiseAlert('ai_fatal_config', { purpose, model: record.model, errorCode: result.errorCode });
        return storeTemplate(deps.db, context, 'fatal_config', spend, modelErrors, input.guard);
      case 'transient':
        if (input.finalDelivery === true) return storeTemplate(deps.db, context, 'transient', spend, modelErrors, input.guard);
        log.warn('draft call failed: retrying the job', { event: 'draft.transient', ...ids, attempt, errorCode: result.errorCode, retryAfterMs: result.retryAfterMs });
        throw new TransientError('ai_draft_transient', { retryAfterMs: result.retryAfterMs });
      case 'max_tokens':
        previous = ['max_tokens'];
        lastFailure = 'max_tokens';
        continue;
      case 'invalid_output':
        previous = ['invalid_output'];
        lastFailure = 'invalid_output';
        continue;
    }
  }
  return storeTemplate(deps.db, context, lastFailure, spend, modelErrors, input.guard);
}

/**
 * The needs-touch fallback for a job that could not draft (its final delivery, or the failure
 * callback, PLAN §8.3 step 6, D-24): the stored draft if one exists, else the minimal safe template
 * (no LLM call). Throws PermanentError when the lead or its content is gone.
 */
export async function fallbackDraft(
  deps: Pick<Deps, 'db'>,
  input: { accountId: string; leadId: string; kind: DraftKind; guard?: ((tx: Db) => Promise<void>) | undefined },
): Promise<GenerateDraftResult> {
  const stored = await findCompletedDraft(deps.db, input.leadId, input.kind);
  if (stored !== null) {
    return stored.needsTouch ? { ok: false, needsTouch: true, reason: 'earlier_attempt', draft: stored } : { ok: true, draft: stored };
  }
  const context = await loadDraftContext(deps.db, input);
  return storeTemplate(deps.db, context, 'job_failed', { attempts: 0, model: null, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 }, [], input.guard);
}
