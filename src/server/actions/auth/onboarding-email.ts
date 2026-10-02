'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { readRequestCookie } from '@/server/security/cookies';
import { submitOnboardingEmail, type OnboardingEmailOutcome } from '@/server/services/auth/onboarding-email';
import { PENDING_INSTALL_COOKIE_NAME } from '@/server/services/install/cookies';
import { actionContext } from './context';

// The /onboarding/email form (PLAN §7.5, D-35): the outcome comes back as a code in the query
// (never the address), and the page reads the pending email itself.

const ONBOARDING_EMAIL_PATH = '/onboarding/email';

export async function onboardingEmailAction(formData: FormData): Promise<void> {
  const outcome: OnboardingEmailOutcome = await withServerActionInstrumentation('onboarding.email', { recordResponse: false }, async () => {
    const { deps, request, ip } = await actionContext();
    return submitOnboardingEmail(deps, {
      pendingCookie: readRequestCookie(request, PENDING_INSTALL_COOKIE_NAME),
      email: formData.get('email'),
      ip,
    });
  });
  redirect(outcome.type === 'sent' ? `${ONBOARDING_EMAIL_PATH}?sent=1` : `${ONBOARDING_EMAIL_PATH}?error=${outcome.type}`);
}
