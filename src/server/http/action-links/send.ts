import 'server-only';
import { NextResponse } from 'next/server';
import { errorCode } from '@/server/domain/errors';
import { PRIVATE_HEADERS } from '@/server/http/auth/request';
import { clientIp } from '@/server/http/hubspot-install';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { NONCE_HEADER } from '@/server/security/csp';
import { actionLinkPath, isPrefetchRequest, resolveSendLink } from '@/server/services/action-links';
import { expiredDraftResponse, interstitialResponse, invalidLinkResponse, rateLimitedResponse, unavailableResponse } from './html';

// GET (and HEAD) /a/{token}/send[?via=mailto] (PLAN §7.4, D-13, D-26). The decision lives in
// services/action-links; this maps it to a response:
// - desktop Gmail/Outlook within COMPOSE_URL_LIMIT → 302 to the compose URL (NextResponse.redirect
//   defaults to 307, so 302 is explicit);
// - phone, "Other" or ?via=mailto → 200 mailto interstitial;
// - too long or an unusual recipient → 303 to /a/{token}/copy;
// - content purged → 410 "This draft has expired"; token not usable → 404 neutral page;
//   rate limited → 429 with Retry-After.
// Every response is private, no-store, noindex and sends no Referer, so neither the compose URL nor
// the token leaks to another site or a cache. Compose URLs and tokens are never logged.

export async function handleSendLink(req: Request, deps: Deps, token: string): Promise<Response> {
  const productName = deps.env.PRODUCT_NAME;
  try {
    const outcome = await resolveSendLink(deps, {
      token,
      ip: clientIp(req),
      method: req.method,
      userAgent: req.headers.get('user-agent'),
      chUaMobile: req.headers.get('sec-ch-ua-mobile'),
      prefetch: isPrefetchRequest(req.headers),
      viaMailto: new URL(req.url).searchParams.get('via') === 'mailto',
    });
    switch (outcome.type) {
      case 'redirect':
        return NextResponse.redirect(outcome.url, { status: 302, headers: PRIVATE_HEADERS });
      case 'interstitial':
        return interstitialResponse({
          productName,
          view: outcome.view,
          beaconPath: actionLinkPath(token, 'beacon'),
          copyPath: actionLinkPath(token, 'copy'),
          proxyNonce: req.headers.get(NONCE_HEADER),
        });
      case 'copy':
        return new Response(null, { status: 303, headers: { Location: actionLinkPath(token, 'copy'), ...PRIVATE_HEADERS } });
      case 'expired':
        return expiredDraftResponse(productName);
      case 'invalid':
        return invalidLinkResponse(productName);
      case 'rate_limited':
        return rateLimitedResponse(productName, outcome.retryAfterSeconds);
    }
  } catch (error) {
    log.error('send link failed', { event: 'action_link.send_failed', code: errorCode(error) }, error);
    return unavailableResponse(productName);
  }
}
