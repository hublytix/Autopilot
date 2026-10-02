'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { savePreferences } from '@/server/services/onboarding';
import { requireOwnerAction } from '../auth/context';
import { parsePreferencesForm, preferencesInputFromValues } from './parse';
import type { PreferencesFormState } from './types';

// /onboarding/preferences (PLAN §7.5, D-33, D-46). After a save the page shows what happened
// (counts and flags only in the query, never an address) and links on to the next step.

const PREFERENCES_PATH = '/onboarding/preferences';

export async function savePreferencesAction(_previous: PreferencesFormState, formData: FormData): Promise<PreferencesFormState> {
  const values = parsePreferencesForm(formData);
  const result = await withServerActionInstrumentation('onboarding.preferences_save', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return savePreferences(scope, deps, preferencesInputFromValues(values));
  });
  if (!result.ok) return { issues: result.issues, values };
  const query = [`saved=1`, `sent=${result.verificationsSent}`];
  if (result.verificationLimited) query.push('limited=1');
  if (result.bccWarning) query.push('bcc=1');
  redirect(`${PREFERENCES_PATH}?${query.join('&')}`);
}
