'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { saveFormSelection } from '@/server/services/onboarding';
import { requireOwnerAction } from '../auth/context';

// /onboarding/forms (PLAN §7.5, D-07): the ticked forms. Outcome codes go back in the query.

const FORMS_PATH = '/onboarding/forms';
const NEXT_PATH = '/onboarding/preferences';

export async function saveFormsAction(formData: FormData): Promise<void> {
  const formIds = formData.getAll('form_id').filter((value): value is string => typeof value === 'string');
  const result = await withServerActionInstrumentation('onboarding.forms_save', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return saveFormSelection(scope, deps, { formIds });
  });
  redirect(result.ok ? NEXT_PATH : `${FORMS_PATH}?error=${result.reason}`);
}
