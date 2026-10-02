import 'server-only';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { verifyActionToken, type VerifyActionTokenResult } from '@/server/security/action-tokens';
import { hitActionLinkLimits } from './limits';
import { consumeBeacon } from './beacon';
import { judgeClick, recordClick } from './click';

// POST /a/{token}/beacon (D-26): the interstitial's, the copy page's and (M4) the edit page's script
// posts the page's nonce. A live `send` or `edit` token plus an unused nonce issued for it within
// BEACON_TTL_MS counts as the owner opening the link, unless the request comes from a scanner user
// agent (some gateways run pages in a headless browser).

export interface BeaconRequest {
  /** The path segment, untrusted. */
  readonly token: string;
  readonly ip: string;
  /** The nonce from the body, untrusted. */
  readonly nonce: string;
  readonly userAgent: string | null;
}

export type BeaconOutcome =
  | { readonly type: 'recorded' }
  /** A scanner user agent: accepted, nothing recorded. */
  | { readonly type: 'ignored' }
  /** Not a live send/edit token, or the nonce is unknown, used or expired. */
  | { readonly type: 'invalid' }
  | { readonly type: 'rate_limited'; readonly retryAfterSeconds: number };

/** Beacons come from the send flow's pages and from M4's edit page. */
async function verifySendOrEdit(deps: Deps, token: string, now: Date): Promise<VerifyActionTokenResult> {
  const send = await verifyActionToken(deps.db, token, 'send', now);
  if (send.ok || send.reason !== 'wrong_purpose') return send;
  return verifyActionToken(deps.db, token, 'edit', now);
}

export async function recordBeacon(deps: Deps, request: BeaconRequest): Promise<BeaconOutcome> {
  const retryAfterSeconds = await hitActionLinkLimits(deps, request.ip, request.token);
  if (retryAfterSeconds !== null) return { type: 'rate_limited', retryAfterSeconds };
  const now = deps.clock.now();
  const checked = await verifySendOrEdit(deps, request.token, now);
  if (!checked.ok || checked.token.leadId === null) return { type: 'invalid' };
  const { token } = checked;
  if (!(await consumeBeacon(deps, token.id, request.nonce))) return { type: 'invalid' };
  const verdict = judgeClick({ method: 'POST', userAgent: request.userAgent, prefetch: false, beacon: true, now, sentAt: null });
  if (!verdict.human) {
    log.info('action link beacon ignored', { event: 'action_link.beacon', accountId: token.accountId, leadId: token.leadId, outcome: 'ignored', reason: verdict.reason });
    return { type: 'ignored' };
  }
  await recordClick(deps.db, { tokenId: token.id, accountId: token.accountId, now });
  log.info('action link beacon recorded', { event: 'action_link.beacon', accountId: token.accountId, leadId: token.leadId, outcome: 'click_recorded', purpose: token.purpose });
  return { type: 'recorded' };
}
