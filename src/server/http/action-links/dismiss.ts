import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { requestFromHeaders, type HeadersLike } from '@/server/http/auth/request';
import { clientIp } from '@/server/http/hubspot-install';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { dismissLead, resolveDismissLink } from '@/server/services/action-links/dismiss';
import { actionLinkPath } from '@/server/services/action-links/paths';
import { ownValue } from '@/shared/own-key';
import { formFromSameOrigin } from './edit';
import { ACTION_LINK_MESSAGES, type PageMessage } from './messages';

// /a/{token}/dismiss (PLAN §7.4, D-26): the confirmation page's state (GET, which never dismisses)
// and the confirmation itself (POST from the page's Server Action, same origin only). After the
// POST the action redirects back to the page (post/redirect/get), which shows what is true in the
// database: a used dismiss token shows "Done", so a second POST shows the same page and changes
// nothing. Only a refused or failed POST adds `?result=` (a code; never anything else).

export type DismissPageState =
  | { readonly type: 'confirm' }
  | { readonly type: 'dismissed' }
  | { readonly type: 'message'; readonly message: PageMessage };

export type DismissSubmitResult = 'dismissed' | 'unchanged' | 'invalid' | 'rate_limited' | 'refused' | 'failed';

/** `?result=` codes the page explains (own keys only, shared/own-key). */
export const DISMISS_RESULT_ALERTS: Readonly<Record<string, string>> = {
  refused: 'This page could not confirm it. Open the link from the email again, then tap the button.',
  failed: "We couldn't mark it just now. Please try again in a minute.",
};

function ipOf(deps: Deps, headers: HeadersLike): string {
  return clientIp(requestFromHeaders(deps.env.APP_URL, headers));
}

/** GET /a/{token}/dismiss. */
export async function dismissPageState(deps: Deps, token: string, headers: HeadersLike): Promise<DismissPageState> {
  try {
    const state = await resolveDismissLink(deps, { token, ip: ipOf(deps, headers) });
    switch (state.type) {
      case 'confirm':
      case 'dismissed':
        return state;
      case 'invalid':
        return { type: 'message', message: ACTION_LINK_MESSAGES.invalid };
      case 'rate_limited':
        return { type: 'message', message: ACTION_LINK_MESSAGES.rateLimited };
    }
  } catch (error) {
    log.error('dismiss page failed', { event: 'action_link.dismiss_page_failed', code: errorCode(error) }, error);
    return { type: 'message', message: ACTION_LINK_MESSAGES.unavailable };
  }
}

/** POST /a/{token}/dismiss (the Server Action's body). */
export async function submitDismissForm(deps: Deps, token: string, headers: HeadersLike): Promise<DismissSubmitResult> {
  if (!formFromSameOrigin(deps.env.APP_URL, headers)) return 'refused';
  try {
    return (await dismissLead(deps, { token, ip: ipOf(deps, headers) })).type;
  } catch (error) {
    log.error('dismiss failed', { event: 'action_link.dismiss_failed', code: errorCode(error) }, error);
    return 'failed';
  }
}

/** Where the action sends the browser after the POST. */
export function dismissResultPath(token: string, result: DismissSubmitResult): string {
  const path = actionLinkPath(token, 'dismiss');
  return result === 'refused' || result === 'failed' ? `${path}?result=${result}` : path;
}

/** The alert for a `?result=` code, or null. */
export function dismissResultAlert(result: string | undefined): string | null {
  return ownValue(DISMISS_RESULT_ALERTS, result) ?? null;
}
