import 'server-only';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { disconnectHubSpot, type DisconnectBillingOutcome, type DisconnectOptions } from '@/server/services/disconnect';
import { saveFormSelection, savePreferences } from '@/server/services/onboarding';
import { pauseAll, resumeAll } from '@/server/services/owner-controls';
import { parsePreferencesForm, preferencesInputFromValues } from '@/server/actions/onboarding/parse';
import type { PreferencesFormState } from '@/server/actions/onboarding/types';

// The bodies of /dashboard/settings' Server Actions (PLAN §7.5, brief §5.11): each runs on the
// caller's OwnerScope (requireOwnerAction) and returns where to send the browser next
// (post/redirect/get) with the outcome as codes in the query: never an address or any content.
// Kept out of the 'use server' module so the tests call them with a test scope.

export const SETTINGS_PATH = '/dashboard/settings';
export const SETTINGS_FORMS_PATH = '/dashboard/settings/forms';
export const SETTINGS_DISCONNECT_PATH = '/dashboard/settings/disconnect';

/** Every `?result=` code /dashboard/settings can show (the page has the words). */
export const SETTINGS_RESULT_CODES = [
  'preferences_saved',
  'forms_saved',
  'paused',
  'already_paused',
  'resumed',
  'resumed_not_active',
  'not_paused',
  'disconnected',
  'already_disconnected',
] as const;
export type SettingsResultCode = (typeof SETTINGS_RESULT_CODES)[number];

/** `?billing=` after a disconnect: what happened to the subscription. */
export const DISCONNECT_BILLING_CODES = [
  'not_requested',
  'cancelled',
  'cancelled_after_payment',
  'cancel_scheduled',
  'already_cancelled',
  'not_cancellable',
  'nothing_to_cancel',
  'failed',
] as const satisfies readonly DisconnectBillingOutcome[];

function withResult(code: SettingsResultCode, extra: readonly string[] = []): string {
  return `${SETTINGS_PATH}?${[`result=${code}`, ...extra].join('&')}`;
}

/**
 * Saves the preferences section (the onboarding form's fields, D-33, D-46: extra addresses get a
 * confirmation email, address and BCC changes alert the owner). An invalid form comes back as state
 * (the owner's input kept); a saved one is a path to redirect to.
 */
export async function runSavePreferences(deps: Deps, scope: OwnerScope, formData: FormData): Promise<PreferencesFormState | { redirect: string }> {
  const values = parsePreferencesForm(formData);
  const result = await savePreferences(scope, deps, preferencesInputFromValues(values));
  if (!result.ok) return { issues: result.issues, values };
  const extra = [`sent=${result.verificationsSent}`];
  if (result.verificationLimited) extra.push('limited=1');
  if (result.bccWarning) extra.push('bcc=1');
  if (result.alertReserved) extra.push('alert=1');
  return { redirect: withResult('preferences_saved', extra) };
}

/** Saves the ticked forms (a newly ticked form gets its intake floor now, D-07). */
export async function runSaveForms(deps: Deps, scope: OwnerScope, formData: FormData): Promise<string> {
  const formIds = formData.getAll('form_id').filter((value): value is string => typeof value === 'string');
  const result = await saveFormSelection(scope, deps, { formIds });
  return result.ok ? withResult('forms_saved') : `${SETTINGS_FORMS_PATH}?error=${result.reason}`;
}

/** Pause all / Resume (PLAN §6.1, §9.6), back to settings. */
export async function runSettingsPause(deps: Deps, scope: OwnerScope, pause: boolean): Promise<string> {
  if (pause) {
    const result = await pauseAll(deps, scope);
    return withResult(result.changed ? 'paused' : 'already_paused');
  }
  const result = await resumeAll(deps, scope);
  return withResult(!result.changed ? 'not_paused' : result.processingState === 'active' ? 'resumed' : 'resumed_not_active');
}

/** Disconnect HubSpot (PLAN §9.1 step 5): `cancel_billing=on` is the dialog's "also cancel" choice. */
export async function runDisconnect(deps: Deps, scope: OwnerScope, formData: FormData, options: DisconnectOptions = {}): Promise<string> {
  const cancelBilling = formData.get('cancel_billing') === 'on';
  const result = await disconnectHubSpot(deps, scope, { cancelBilling }, options);
  if (result.type === 'account_missing') return SETTINGS_PATH;
  return withResult(result.type, [`billing=${result.billing}`]);
}
