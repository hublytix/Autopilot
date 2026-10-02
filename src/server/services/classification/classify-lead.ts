import 'server-only';
import type { Classification } from '@/server/domain/types';
import { raiseAlert } from '@/server/jobs/alert';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { aiCallRecord, recordAiCall } from './ai-calls';
import { isAiDailyBudgetTripped } from './budget';

// Lead classification (brief §5.2, PLAN §9.3 step 2, D-24): the fast model sorts one submission;
// the lead's message, form name, first name and company go inside untrusted-input delimiters (the
// adapter builds the prompt, D-47). Classification never blocks a lead: any failure — refusal,
// truncation, invalid output, a transient or fatal API error, or a tripped AI budget breaker —
// becomes `unclear`, which gets a draft. Each call writes one `ai_calls` row (no content).
// The caller (lead_process) stores the class on the lead; this function writes only ai_calls.

export type ClassifyDeps = Pick<Deps, 'db' | 'clock' | 'llm' | 'env'>;

export interface ClassifyLeadInput {
  accountId: string;
  /** Null for the baseline's in-memory classification (no lead row exists, D-38). */
  leadId: string | null;
  message: string | null;
  formName: string;
  firstName: string | null;
  company: string | null;
  /** Default `classify`; the baseline records `baseline_classify`. */
  purpose?: 'classify' | 'baseline_classify' | undefined;
  /** Recorded as `ai_calls.attempt` (e.g. the job's delivery number); default 1. */
  attempt?: number | undefined;
  /** Bounds the call (and the SDK's retry sleeps) to the caller's remaining budget. */
  signal?: AbortSignal | undefined;
}

export interface ClassifyLeadResult {
  classification: Classification;
  /** True when the class is the `unclear` fallback rather than the model's answer. */
  failed: boolean;
}

export interface ClassifyLeadOptions {
  /** The D-36 breaker check; default `isAiDailyBudgetTripped` (M4 hook, never trips yet). */
  isBudgetTripped?: ((deps: ClassifyDeps) => Promise<boolean>) | undefined;
}

const FALLBACK: ClassifyLeadResult = Object.freeze({ classification: 'unclear', failed: true });

export async function classifyLead(deps: ClassifyDeps, input: ClassifyLeadInput, options: ClassifyLeadOptions = {}): Promise<ClassifyLeadResult> {
  const purpose = input.purpose ?? 'classify';
  const fields = { accountId: input.accountId, leadId: input.leadId ?? undefined, purpose };
  const isBudgetTripped = options.isBudgetTripped ?? isAiDailyBudgetTripped;

  if (await isBudgetTripped(deps)) {
    // No call, so no ai_calls row; lead_process sends needs-touch and alerts (PLAN §9.3 step 4).
    log.warn('classification skipped: AI budget breaker tripped', { ...fields, event: 'classify_skipped', reason: 'ai_budget_tripped' });
    return FALLBACK;
  }

  const startedAt = deps.clock.now();
  const result = await deps.llm.classify(
    { message: input.message, formName: input.formName, firstName: input.firstName, company: input.company },
    input.signal === undefined ? undefined : { signal: input.signal },
  );
  const finishedAt = deps.clock.now();

  await recordAiCall(
    deps.db,
    aiCallRecord(
      {
        accountId: input.accountId,
        leadId: input.leadId,
        purpose,
        attempt: input.attempt ?? 1,
        requestedModel: deps.env.ANTHROPIC_MODEL_FAST,
        startedAt,
        finishedAt,
      },
      result,
    ),
  );

  if (result.ok) return { classification: result.value.classification, failed: false };

  const model = result.model ?? deps.env.ANTHROPIC_MODEL_FAST;
  log.warn('classification failed: using unclear', {
    ...fields,
    event: 'classify_failed',
    outcome: result.failure,
    errorCode: result.errorCode,
    model,
    requestId: result.requestId,
  });
  if (result.failure === 'fatal_config') {
    // A bad key, a retired model (404), the spend cap…: the draft call will fail the same way (D-24, D-25).
    raiseAlert('ai_fatal_config', { purpose, model, errorCode: result.errorCode });
  }
  return FALLBACK;
}
