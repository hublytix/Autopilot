import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { requestFromHeaders, type HeadersLike } from '@/server/http/auth/request';
import { clientIp } from '@/server/http/hubspot-install';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { actionLinkPath, resolveCopyLink, type CopyView } from '@/server/services/action-links';
import { ACTION_LINK_MESSAGES, neverSendsLine, type PageMessage } from './messages';

// GET /a/{token}/copy (PLAN §7.4): the page's state for the Server Component. The page shows the
// recipient, subject, body and BCC address with copy buttons, and posts the page beacon (D-26).

export type CopyPageState =
  | {
      readonly type: 'copy';
      readonly view: CopyView;
      /** `/a/{token}/beacon`. */
      readonly beaconPath: string;
      /** `/a/{token}/send?via=mailto`, when the mailto: link fits COMPOSE_URL_LIMIT. */
      readonly mailtoPath: string | null;
      readonly neverSends: string;
    }
  | { readonly type: 'message'; readonly message: PageMessage };

export async function copyPageState(deps: Deps, token: string, headers: HeadersLike): Promise<CopyPageState> {
  try {
    const state = await resolveCopyLink(deps, { token, ip: clientIp(requestFromHeaders(deps.env.APP_URL, headers)) });
    switch (state.type) {
      case 'copy':
        return {
          type: 'copy',
          view: state.view,
          beaconPath: actionLinkPath(token, 'beacon'),
          mailtoPath: state.view.mailtoFits ? `${actionLinkPath(token, 'send')}?via=mailto` : null,
          neverSends: neverSendsLine(deps.env.PRODUCT_NAME),
        };
      case 'expired':
        return { type: 'message', message: ACTION_LINK_MESSAGES.expired };
      case 'invalid':
        return { type: 'message', message: ACTION_LINK_MESSAGES.invalid };
      case 'rate_limited':
        return { type: 'message', message: ACTION_LINK_MESSAGES.rateLimited };
    }
  } catch (error) {
    log.error('copy page failed', { event: 'action_link.copy_failed', code: errorCode(error) }, error);
    return { type: 'message', message: ACTION_LINK_MESSAGES.unavailable };
  }
}
