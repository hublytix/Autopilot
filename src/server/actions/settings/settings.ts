'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import type { PreferencesFormState } from '@/server/actions/onboarding/types';
import { requireOwnerAction } from '../auth/context';
import { runDisconnect, runSaveForms, runSavePreferences, runSettingsPause } from './controls';

// /dashboard/settings' Server Actions (PLAN §7.5, brief §5.11): owner only (requireOwnerAction),
// wrapped for Sentry without the form data (recordResponse off, nothing of the input recorded), each
// ending in a redirect back with codes. Next's built-in Origin check covers CSRF (PLAN §10.6).

export async function saveSettingsPreferencesAction(_previous: PreferencesFormState, formData: FormData): Promise<PreferencesFormState> {
  const outcome = await withServerActionInstrumentation('settings.preferences_save', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return runSavePreferences(deps, scope, formData);
  });
  if ('redirect' in outcome) redirect(outcome.redirect);
  return outcome;
}

export async function saveSettingsFormsAction(formData: FormData): Promise<void> {
  const path = await withServerActionInstrumentation('settings.forms_save', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return runSaveForms(deps, scope, formData);
  });
  redirect(path);
}

export async function pauseFromSettingsAction(): Promise<void> {
  const path = await withServerActionInstrumentation('settings.pause', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return runSettingsPause(deps, scope, true);
  });
  redirect(path);
}

export async function resumeFromSettingsAction(): Promise<void> {
  const path = await withServerActionInstrumentation('settings.resume', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return runSettingsPause(deps, scope, false);
  });
  redirect(path);
}

export async function disconnectHubSpotAction(formData: FormData): Promise<void> {
  const path = await withServerActionInstrumentation('settings.disconnect', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return runDisconnect(deps, scope, formData);
  });
  redirect(path);
}
