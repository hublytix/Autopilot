'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { requireOwnerAction } from '@/server/actions/auth/context';
import { skipInboxCheck, startInboxCheck } from '@/server/services/inbox-check';

// The /onboarding/inbox forms (PLAN §7.5, §9.7, D-14). Owner only. The outcome goes back to the page
// as a code in the query, never the address (the page reads the check from the database).
// "Continue — we'll keep checking" is a plain link: it changes nothing.

const INBOX_PATH = '/onboarding/inbox';
const NEXT_STEP_PATH = '/onboarding/baseline';
const DASHBOARD_PATH = '/dashboard';

export async function startInboxCheckAction(formData: FormData): Promise<void> {
  const result = await withServerActionInstrumentation('onboarding.inbox.start', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return startInboxCheck(scope, deps, { testAddress: formData.get('test_address') });
  });
  redirect(`${INBOX_PATH}?result=${result.type}`);
}

export async function skipInboxCheckAction(): Promise<void> {
  const result = await withServerActionInstrumentation('onboarding.inbox.skip', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return skipInboxCheck(scope, deps);
  });
  redirect(result.onboardingComplete ? DASHBOARD_PATH : NEXT_STEP_PATH);
}
