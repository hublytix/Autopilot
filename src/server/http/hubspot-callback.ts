import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { ensureJobHandlersRegistered } from '@/server/jobs/handlers';
import { log } from '@/server/obs/log';
import type { AuthUser, Deps } from '@/server/ports';
import { readRequestCookie, withSetCookies } from '@/server/security/cookies';
import { completeInstall, type CallbackOptions, type InstallOutcome } from '@/server/services/install/callback';
import { clearStateCookie, STATE_COOKIE_NAME } from '@/server/services/install/cookies';
import { clientIp, INSTALL_FAILED_PATH, redirect, tooManyAttempts } from './hubspot-install';

// GET /api/hubspot/oauth/callback (PLAN §7.3, §9.1 step 1, D-35, D-36). The service decides the
// branch; this maps it to a redirect (or a 429 over the per-IP limit), clears the single-use state
// cookie and sets the pending_install cookie for branches (a) and (b). The `code` is never logged; responses are never cached, and send no Referer
// (the callback URL carries the code).

export const ONBOARDING_EMAIL_PATH = '/onboarding/email';
export const RECONNECTED_PATH = '/dashboard?reconnected=1';
export const SIGN_IN_TO_RECONNECT_PATH = '/install/sign-in-to-reconnect';
export const CONNECTED_ELSEWHERE_PATH = '/install/connected-elsewhere';

function pathFor(outcome: Exclude<InstallOutcome, { type: 'rate_limited' }>): string {
  switch (outcome.type) {
    case 'onboarding':
      return ONBOARDING_EMAIL_PATH;
    case 'reconnected':
      return RECONNECTED_PATH;
    case 'sign_in_to_reconnect':
      return outcome.linkSent ? `${SIGN_IN_TO_RECONNECT_PATH}?sent=1` : SIGN_IN_TO_RECONNECT_PATH;
    case 'connected_elsewhere':
      return CONNECTED_ELSEWHERE_PATH;
    case 'failed':
      return `${INSTALL_FAILED_PATH}?reason=${outcome.reason}`;
  }
}

export async function handleHubSpotCallback(req: Request, deps: Deps, options: CallbackOptions = {}): Promise<Response> {
  // A reserved email sent from this request (e.g. after a reconnect) finds its renderer.
  ensureJobHandlersRegistered();
  const url = new URL(req.url);
  const sessionUser = async (): Promise<AuthUser | null> => {
    try {
      return await deps.auth.getVerifiedUser(req);
    } catch (error) {
      // No verifiable session: branch (d) changes nothing.
      log.warn('session check failed at install', { event: 'hubspot.install_session_failed', code: errorCode(error) });
      return null;
    }
  };

  let outcome: InstallOutcome;
  try {
    outcome = await completeInstall(
      deps,
      {
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
        stateCookie: readRequestCookie(req, STATE_COOKIE_NAME),
        ip: clientIp(req),
        sessionUser,
      },
      options,
    );
  } catch (error) {
    log.error('hubspot install callback failed', { event: 'hubspot.install_callback_failed', code: errorCode(error) }, error);
    outcome = { type: 'failed', reason: 'unavailable' };
  }

  // Rate limited: nothing was checked or spent, so the state cookie stays for a retry.
  if (outcome.type === 'rate_limited') return tooManyAttempts(outcome.retryAfterSeconds);
  const cookies = [clearStateCookie(deps.env), ...(outcome.type === 'onboarding' ? outcome.cookies : [])];
  return withSetCookies(redirect(`${deps.env.APP_URL}${pathFor(outcome)}`), cookies);
}
