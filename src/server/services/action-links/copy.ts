import 'server-only';
import { buildMailto, checkRecipient, fitsComposeLimit } from '@/server/domain/compose';
import type { Deps } from '@/server/ports';
import { verifyActionToken } from '@/server/security/action-tokens';
import { hitActionLinkLimits } from './limits';
import { issueBeacon } from './beacon';
import { loadSendContext } from './context';

// GET /a/{token}/copy (PLAN §7.4, D-13, D-46): the recipient, subject, body and BCC address, each with
// a copy button, for pasting into any mail app. Reached from the interstitial's "Copy your reply",
// from a send link whose compose URL is too long or whose recipient is unusual, and (M4) from the
// edit page. Opening it records nothing by itself: the page's beacon does (D-26), so a scanner that
// fetches it does not count.

export interface CopyView {
  /** The lead's address as stored; null when missing. */
  readonly recipient: string | null;
  /** False when the address is missing or not one bare address: the page asks the owner to check it. */
  readonly recipientValid: boolean;
  readonly subject: string;
  readonly body: string;
  /** The BCC logging address (D-46), when set. */
  readonly bcc: string | null;
  /** Whether "Open in my mail app" (the mailto: link) fits COMPOSE_URL_LIMIT. */
  readonly mailtoFits: boolean;
  readonly beaconNonce: string;
}

export type CopyLinkState =
  | { readonly type: 'copy'; readonly view: CopyView }
  | { readonly type: 'expired' }
  | { readonly type: 'invalid' }
  | { readonly type: 'rate_limited'; readonly retryAfterSeconds: number };

export interface CopyLinkRequest {
  /** The path segment, untrusted. */
  readonly token: string;
  /** Client IP, for the rate limit only (stored as an HMAC). */
  readonly ip: string;
}

export async function resolveCopyLink(deps: Deps, request: CopyLinkRequest): Promise<CopyLinkState> {
  const retryAfterSeconds = await hitActionLinkLimits(deps, request.ip, request.token);
  if (retryAfterSeconds !== null) return { type: 'rate_limited', retryAfterSeconds };
  const checked = await verifyActionToken(deps.db, request.token, 'send', deps.clock.now());
  if (!checked.ok) return { type: 'invalid' };
  const loaded = await loadSendContext(deps.db, checked.token);
  if (loaded.type !== 'ok') return loaded;
  const { context } = loaded;
  const recipientValid = context.recipient !== null && checkRecipient(context.recipient).ok;
  const mailtoFits =
    recipientValid &&
    context.recipient !== null &&
    fitsComposeLimit(
      buildMailto({ to: [context.recipient], bcc: context.bcc === null ? [] : [context.bcc], subject: context.subject, body: context.body }),
      deps.env.COMPOSE_URL_LIMIT,
    );
  return {
    type: 'copy',
    view: {
      recipient: context.recipient,
      recipientValid,
      subject: context.subject,
      body: context.body,
      bcc: context.bcc,
      mailtoFits,
      beaconNonce: await issueBeacon(deps, context.tokenId),
    },
  };
}
