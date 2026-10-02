import 'server-only';

// The draft engine (PLAN §9.3 steps 4-5, §9.5 step 5, D-24, D-36, D-47). Import from here.
//
// lead_process, after classification (PLAN §9.3):
//   1. applyDailyCap(deps, {accountId, leadId, processRev, guard}) → 'deferred' (done; the lead_cap
//      email is handled) | 'lead_changed' (skip) | 'allowed';
//   2. generateDraft(deps, {accountId, leadId, kind: 'initial', finalDelivery, signal, guard}) →
//      {ok: true, draft} → new_lead | {ok: false, needsTouch: true, reason, draft} → needs_touch;
//      throws TransientError (retry the job) or PermanentError (lead or content gone);
//   3. the failure path / final delivery without a draft: fallbackDraft(deps, {...}) (no LLM).
// The AI budget breaker is checked inside generateDraft and classifyLead.
export { aiAccountShareMicroUsd, aiAccountSpendTodayMicroUsd, aiDailyBudgetMicroUsd, aiSpendTodayMicroUsd, isAiDailyBudgetTripped, utcDayStart } from './budget';
export type { BudgetDeps } from './budget';
export {
  applyDailyCap,
  countDraftedLeads,
  ensureDraftingNotificationsRegistered,
  leadCapPlan,
  localDay,
  registerDraftingNotifications,
  resumeLeadCap,
} from './cap';
export type { DailyCapInput, DailyCapResult, LocalDay } from './cap';
export { fallbackDraft, generateDraft, MAX_DRAFT_ATTEMPTS } from './generate';
export type { DraftingDeps, GenerateDraftInput, GenerateDraftResult, NeedsTouchReason } from './generate';
export { findCompletedDraft, loadDraftContext, storeDraft, toDraftRecord, DRAFT_COLUMNS } from './repository';
export type { DraftContext, DraftRecord, DraftToStore } from './repository';
export { minimalSafeTemplate } from './template';
export type { TemplateDraft, TemplateInput } from './template';
