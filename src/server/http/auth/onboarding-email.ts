import 'server-only';
import type { Deps } from '@/server/ports';
import { readRequestCookie } from '@/server/security/cookies';
import { onboardingEmailContext, type OnboardingEmailContext } from '@/server/services/auth/onboarding-email';
import { PENDING_INSTALL_COOKIE_NAME } from '@/server/services/install/cookies';
import { requestFromHeaders, type HeadersLike } from './request';

// The /onboarding/email page's read side (PLAN §7.5): what this browser's pending_install cookie
// allows, and which email to pre-fill. The form posts to onboardingEmailAction.

export type { OnboardingEmailContext };

export async function onboardingEmailPageState(deps: Deps, headers: HeadersLike): Promise<OnboardingEmailContext> {
  const request = requestFromHeaders(deps.env.APP_URL, headers);
  return onboardingEmailContext(deps, readRequestCookie(request, PENDING_INSTALL_COOKIE_NAME));
}
