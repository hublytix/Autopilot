import 'server-only';
import { buildCompose, checkRecipient, chooseComposeClient, fitsComposeLimit, isPhone, type ComposeClient, type ComposeLink } from '@/server/domain/compose';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { verifyActionToken } from '@/server/security/action-tokens';
import { hitActionLinkLimits } from './limits';
import { issueBeacon } from './beacon';
import { judgeClick, recordClick } from './click';
import { loadSendContext, type SendContext } from './context';

// GET /a/{token}/send[?via=mailto] (PLAN §7.4, D-13, D-26): one tap from the "Send from my email"
// button to a pre-filled compose window in the owner's own mail app. Autopilot never sends (law 1).
//
// 1. /a/* rate limits (30/min per IP, 20/min per token, D-36).
// 2. The token must be a live `send` token (else a neutral "not available" page).
// 3. The draft's content must still exist (else "This draft has expired").
// 4. The click is recorded when D-26's heuristic says a person opened it.
// 5. Target: a desktop with Gmail or Outlook gets that web compose URL as a 302; a phone, the "Other"
//    client and `?via=mailto` get a 200 interstitial that opens the `mailto:` URL (D-13). If the
//    lead's address is not one bare address, or the chosen URL is over COMPOSE_URL_LIMIT, the copy
//    page is shown instead.

export interface SendLinkRequest {
  /** The path segment, untrusted. */
  readonly token: string;
  /** Client IP, for the rate limit only (stored as an HMAC). */
  readonly ip: string;
  readonly method: string;
  readonly userAgent: string | null;
  /** Sec-CH-UA-Mobile. */
  readonly chUaMobile: string | null;
  /** Prefetch/prerender request headers were present. */
  readonly prefetch: boolean;
  /** `?via=mailto`: the email's "Open in default mail app" link. */
  readonly viaMailto: boolean;
}

export interface InterstitialView {
  readonly mailtoUrl: string;
  readonly recipient: string;
  readonly subject: string;
  readonly bcc: string | null;
  /** Null on a HEAD (nothing is rendered, so no nonce is issued). */
  readonly beaconNonce: string | null;
}

export type CopyReason = 'too_long' | 'invalid_recipient';

export type SendLinkOutcome =
  | { readonly type: 'redirect'; readonly url: string; readonly client: Exclude<ComposeClient, 'other' | 'mailto'> }
  | { readonly type: 'interstitial'; readonly view: InterstitialView }
  | { readonly type: 'copy'; readonly reason: CopyReason }
  | { readonly type: 'expired' }
  | { readonly type: 'invalid' }
  | { readonly type: 'rate_limited'; readonly retryAfterSeconds: number };

type Target = { readonly type: 'link'; readonly client: ComposeClient; readonly link: ComposeLink } | { readonly type: 'copy'; readonly reason: CopyReason };

/** The compose link for this context and target client, or why the copy page is shown instead. */
export function composeTarget(deps: Pick<Deps, 'env'>, context: SendContext, client: ComposeClient): Target {
  if (context.recipient === null || !checkRecipient(context.recipient).ok) return { type: 'copy', reason: 'invalid_recipient' };
  const { env } = deps;
  const link = buildCompose({
    client,
    to: [context.recipient],
    bcc: context.bcc === null ? [] : [context.bcc],
    subject: context.subject,
    body: context.body,
    gmailAccount: context.gmailAccount,
    gmailForm: env.COMPOSE_GMAIL_FORM,
    outlookMode: env.COMPOSE_OUTLOOK_MODE,
    outlookWorkBase: env.COMPOSE_OUTLOOK_WORK_BASE,
    outlookPersonalBase: env.COMPOSE_OUTLOOK_PERSONAL_BASE,
  });
  if (!fitsComposeLimit(link, env.COMPOSE_URL_LIMIT)) return { type: 'copy', reason: 'too_long' };
  return { type: 'link', client, link };
}

export async function resolveSendLink(deps: Deps, request: SendLinkRequest): Promise<SendLinkOutcome> {
  const retryAfterSeconds = await hitActionLinkLimits(deps, request.ip, request.token);
  if (retryAfterSeconds !== null) return { type: 'rate_limited', retryAfterSeconds };

  const now = deps.clock.now();
  const checked = await verifyActionToken(deps.db, request.token, 'send', now);
  if (!checked.ok) return { type: 'invalid' };
  const loaded = await loadSendContext(deps.db, checked.token);
  if (loaded.type !== 'ok') return loaded;
  const { context } = loaded;

  const verdict = judgeClick({
    method: request.method,
    userAgent: request.userAgent,
    prefetch: request.prefetch,
    beacon: false,
    now,
    sentAt: context.sentAt,
  });
  if (verdict.human) await recordClick(deps.db, { tokenId: context.tokenId, accountId: context.accountId, now });

  const client = chooseComposeClient({
    mailClient: context.mailClient,
    phone: isPhone({ userAgent: request.userAgent, chUaMobile: request.chUaMobile }),
    viaMailto: request.viaMailto,
  });
  const target = composeTarget(deps, context, client);
  log.info('send link opened', {
    event: 'action_link.send',
    accountId: context.accountId,
    leadId: context.leadId,
    mode: target.type === 'copy' ? 'copy' : target.client,
    outcome: verdict.human ? 'click_recorded' : 'click_not_recorded',
    reason: verdict.human ? undefined : verdict.reason,
  });
  if (target.type === 'copy') return { type: 'copy', reason: target.reason };
  if (target.client === 'mailto' || target.client === 'other') {
    const beaconNonce = request.method.toUpperCase() === 'HEAD' ? null : await issueBeacon(deps, context.tokenId);
    return {
      type: 'interstitial',
      view: { mailtoUrl: target.link.url, recipient: context.recipient ?? '', subject: context.subject, bcc: context.bcc, beaconNonce },
    };
  }
  return { type: 'redirect', url: target.link.url, client: target.client };
}
