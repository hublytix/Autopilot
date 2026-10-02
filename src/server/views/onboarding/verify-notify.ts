import 'server-only';
import { requestFromHeaders, type HeadersLike } from '@/server/http/auth/request';
import { clientIp } from '@/server/http/hubspot-install';
import type { Deps } from '@/server/ports';
import { verifyNotifyLinkState, type VerifyNotifyState } from '@/server/services/onboarding';

// GET /a/[token]/verify-notify (PLAN §7.4, D-46): the confirmation page's state. No sign-in: the
// action token is the authorisation. Opening the page changes nothing (mail scanners open links);
// the page's button posts the confirmation.

export type { VerifyNotifyState };

export async function verifyNotifyPageState(deps: Deps, token: string, headers: HeadersLike): Promise<VerifyNotifyState> {
  const ip = clientIp(requestFromHeaders(deps.env.APP_URL, headers));
  return verifyNotifyLinkState(deps, { token, ip });
}
