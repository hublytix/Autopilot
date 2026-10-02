import 'server-only';
import { z } from 'zod';
import { errorCode, isAppError, isRevoked } from '@/server/domain/errors';
import { isOfferedFormType, type OfferedFormType } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { Deps, HubSpotForm } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth';
import { forAccount, type Sleep } from '@/server/services/hubspot';
import { isLikelyNewsletter } from './newsletter';

// Form selection (brief §4 step 2.3, PLAN §7.5 /onboarding/forms, D-07):
// - the list is the portal's live `hubspot` and `flow` forms (captured forms are excluded in v1);
// - a form with a `selected_forms` row shows its stored choice; any other form starts ticked
//   unless it looks like a newsletter form;
// - ticking a form that is not selected yet sets `intake_floor_at` (and the cursor) to $now, so no
//   submission from before the tick ever becomes a lead; a form that stays ticked keeps its floor;
// - unticking keeps the row with `selected = false`, so a later tick starts a fresh floor.

export interface FormChoice {
  id: string;
  name: string;
  formType: OfferedFormType;
  newsletterDetected: boolean;
  /** What the checkbox shows: the stored choice, or "ticked unless newsletter-like" for a new form. */
  checked: boolean;
  /** A `selected_forms` row exists for this form. */
  stored: boolean;
}

export type FormsUnavailableReason = 'hubspot_unavailable' | 'connection_inactive';

export type FormsListResult = { ok: true; forms: FormChoice[] } | { ok: false; reason: FormsUnavailableReason };

export interface FormsOptions {
  /** For the portal limiter; tests advance their FakeClock instead of waiting. */
  sleep?: Sleep | undefined;
}

interface StoredForm {
  form_id: string;
  selected: boolean;
}

async function storedForms(db: Db, accountId: string): Promise<Map<string, StoredForm>> {
  const rows = await db.query<StoredForm>(`select form_id, selected from selected_forms where account_id = $1`, [accountId]);
  return new Map(rows.map((row) => [row.form_id, row]));
}

type OfferedForm = HubSpotForm & { formType: OfferedFormType };

/** The portal's offered forms (HubSpot reads only); a failure is a reason code, never an exception. */
async function fetchForms(deps: Deps, accountId: string, options: FormsOptions): Promise<{ ok: true; forms: OfferedForm[] } | { ok: false; reason: FormsUnavailableReason }> {
  try {
    const forms = await forAccount(deps, accountId, { sleep: options.sleep }).listForms();
    // The client already lists only `hubspot` and `flow` forms; this keeps the rule here too (D-07).
    return { ok: true, forms: forms.filter((form): form is OfferedForm => !form.archived && isOfferedFormType(form.formType)) };
  } catch (error) {
    if (!isAppError(error)) throw error;
    const reason: FormsUnavailableReason = isRevoked(error) ? 'connection_inactive' : 'hubspot_unavailable';
    log.warn('forms list unavailable', { event: 'onboarding.forms_unavailable', accountId, reason, code: errorCode(error) });
    return { ok: false, reason };
  }
}

/** The forms the owner can choose from, with each checkbox's starting state. */
export async function listFormsForSelection(scope: OwnerScope, deps: Deps, options: FormsOptions = {}): Promise<FormsListResult> {
  const fetched = await fetchForms(deps, scope.accountId, options);
  if (!fetched.ok) return fetched;
  const stored = await storedForms(deps.db, scope.accountId);
  const forms = fetched.forms.map((form): FormChoice => {
    const newsletterDetected = isLikelyNewsletter(form);
    const row = stored.get(form.id);
    return {
      id: form.id,
      name: form.name,
      formType: form.formType,
      newsletterDetected,
      checked: row === undefined ? !newsletterDetected : row.selected,
      stored: row !== undefined,
    };
  });
  forms.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id));
  return { ok: true, forms };
}

/** Form GUIDs as the form posts them: at most a few hundred short ids. */
export const FormSelectionSchema = z.object({
  formIds: z.array(z.string().trim().min(1).max(100)).max(500),
});

export type FormSelectionRefusal = 'none_selected' | 'unknown_form' | 'invalid' | FormsUnavailableReason;

export type FormSelectionResult = { ok: true; selected: number } | { ok: false; reason: FormSelectionRefusal };

/**
 * Saves the owner's ticks for every listed form (PLAN §7.5). At least one form must be ticked.
 * The list is read from HubSpot again, so only the portal's own forms can be stored, and a stored
 * form HubSpot no longer lists (deleted or archived) is unticked: it can no longer satisfy the
 * "at least one selected form" gate (PLAN §6.1) or feed the baseline.
 */
export async function saveFormSelection(scope: OwnerScope, deps: Deps, input: unknown, options: FormsOptions = {}): Promise<FormSelectionResult> {
  const parsed = FormSelectionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const ticked = new Set(parsed.data.formIds);
  if (ticked.size === 0) return { ok: false, reason: 'none_selected' };

  const fetched = await fetchForms(deps, scope.accountId, options);
  if (!fetched.ok) return fetched;
  const known = new Set(fetched.forms.map((form) => form.id));
  if ([...ticked].some((id) => !known.has(id))) return { ok: false, reason: 'unknown_form' };

  const now = deps.clock.now();
  await deps.db.tx(async (tx) => {
    for (const form of fetched.forms) {
      const newsletter = isLikelyNewsletter(form);
      if (ticked.has(form.id)) {
        // In ON CONFLICT, `selected_forms.*` is the stored row: a form already selected keeps its floor.
        await tx.query(
          `insert into selected_forms
             (account_id, form_id, form_name, form_type, selected, newsletter_detected, intake_floor_at, cursor_submitted_at)
           values ($1, $2, $3, $4, true, $5, $6, $6)
           on conflict (account_id, form_id) do update set
             form_name = excluded.form_name,
             form_type = excluded.form_type,
             newsletter_detected = excluded.newsletter_detected,
             selected = true,
             intake_floor_at = case when selected_forms.selected then selected_forms.intake_floor_at else excluded.intake_floor_at end,
             cursor_submitted_at = case when selected_forms.selected then selected_forms.cursor_submitted_at
                                        else greatest(selected_forms.cursor_submitted_at, excluded.cursor_submitted_at) end`,
          [scope.accountId, form.id, form.name, form.formType, newsletter, now],
        );
      } else {
        await tx.query(
          `update selected_forms set selected = false, form_name = $3, form_type = $4, newsletter_detected = $5
            where account_id = $1 and form_id = $2`,
          [scope.accountId, form.id, form.name, form.formType, newsletter],
        );
      }
    }
    await tx.query(`update selected_forms set selected = false where account_id = $1 and selected and form_id <> all($2::text[])`, [
      scope.accountId,
      fetched.forms.map((form) => form.id),
    ]);
  });
  log.info('forms selected', { event: 'onboarding.forms_saved', accountId: scope.accountId, count: ticked.size, total: fetched.forms.length });
  return { ok: true, selected: ticked.size };
}

/** How many forms are selected (the onboarding gate needs at least one, PLAN §6.1). */
export async function selectedFormCount(db: Db, accountId: string): Promise<number> {
  const row = await db.one<{ n: number }>(`select count(*)::int as n from selected_forms where account_id = $1 and selected`, [accountId]);
  return row.n;
}
