import 'server-only';
import { createElement } from 'react';
import { MagicLink, magicLinkSubject, type MagicLinkVariant } from '@/emails/MagicLink';
import { isAppError } from '@/server/domain/errors';
import type { LoginIntentPurpose } from '@/server/domain/types';
import { renderEmail } from '@/server/email/render';
import type { Deps } from '@/server/ports';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import { reserveAndSend } from '@/server/services/notifications/send';
import type { SendResult } from '@/server/services/notifications/types';
import { insertLoginIntent, loginIntentKey } from './login-intents';
import { safeNextPath } from './next-path';

// Magic links (D-22, PLAN §7.2): Supabase mints the token (`admin.generateLink`, which sends
// nothing), we store a login intent keyed by its sha256 and email
// `${APP_URL}/auth/confirm#th=<hashed_token>&type=email` ourselves, through reserveAndSend
// (kind `magic_link`, key `magic:{intent key}`), Reply-To EMAIL_REPLY_TO. The token sits in the
// URL fragment, so it never reaches a server log. The link URL is never logged or stored.
//
// Call these only for (a) a bound owner's email, (b) an account's pending owner email and (c) an
// ADMIN_EMAILS address: generateLink would sign up any other address (D-22).

export const CONFIRM_PATH = '/auth/confirm';

/** The emailed link: the hashed token and `type=email` in the fragment only. */
export function magicLinkUrl(appUrl: string, hashedToken: string): string {
  return `${appUrl}${CONFIRM_PATH}#th=${encodeURIComponent(hashedToken)}&type=email`;
}

/**
 * Creates the auth user for `email` unless it exists (public sign-ups are off; D-21, D-22). True when
 * this call created it: only such a user may later be deleted as "replaced" by the onboarding flow.
 */
export async function ensureAuthUser(deps: Deps, email: string): Promise<boolean> {
  try {
    await deps.auth.createUser(email);
    return true;
  } catch (error) {
    if (isAppError(error) && error.code === 'auth_user_exists') return false;
    throw error;
  }
}

const PORTAL_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?$/i;

/**
 * How an onboarding email names the HubSpot account it sets up (D-62): the portal's domain when it is
 * a plain host name, and always its portal ID (the domain is the portal owner's to choose; the ID is
 * not). Null when the account is gone.
 */
export async function onboardingPortalLabel(deps: Pick<Deps, 'db'>, accountId: string): Promise<string | null> {
  const row = await deps.db.maybeOne<{ portal_id: string; hub_domain: string | null }>(
    `select a.hubspot_portal_id as portal_id, c.hub_domain
       from accounts a left join hubspot_connections c on c.account_id = a.id
      where a.id = $1`,
    [accountId],
  );
  if (row === null) return null;
  const domain = row.hub_domain?.trim() ?? '';
  return PORTAL_HOST.test(domain) ? `${domain} (ID ${row.portal_id})` : `with ID ${row.portal_id}`;
}

export interface MagicLinkRequest {
  /** Lower-cased. */
  readonly email: string;
  readonly purpose: LoginIntentPurpose;
  /** Null only for an admin login. */
  readonly accountId: string | null;
  /** Where to land after confirming; allow-listed again here. */
  readonly next: string;
  /** The email's wording; default: `onboarding` for an onboarding intent, else `sign_in`. */
  readonly variant?: MagicLinkVariant | undefined;
}

/** A link whose intent is stored but not yet emailed. Holds the token: never log it. */
export interface IssuedMagicLink {
  readonly email: string;
  readonly accountId: string | null;
  /** The auth user the link signs in. */
  readonly userId: string;
  readonly intentKey: string;
  readonly url: string;
  readonly variant: MagicLinkVariant;
}

/** Mints the token and stores its login intent (the user must exist: ensureAuthUser). */
export async function issueMagicLink(deps: Deps, request: MagicLinkRequest): Promise<IssuedMagicLink> {
  const { hashedToken, userId } = await deps.auth.generateLink(request.email);
  const intentKey = loginIntentKey(hashedToken);
  await insertLoginIntent(deps.db, {
    key: intentKey,
    purpose: request.purpose,
    accountId: request.accountId,
    next: safeNextPath(request.next, deps.env.APP_URL),
    now: deps.clock.now(),
  });
  return {
    email: request.email,
    accountId: request.accountId,
    userId,
    intentKey,
    url: magicLinkUrl(deps.env.APP_URL, hashedToken),
    variant: request.variant ?? (request.purpose === 'onboarding' ? 'onboarding' : 'sign_in'),
  };
}

/** Emails an issued link exactly once (its own reservation). Throws TransientError when Resend should be retried. */
export async function deliverMagicLink(deps: Deps, link: IssuedMagicLink): Promise<SendResult> {
  const productName = deps.env.PRODUCT_NAME;
  const portal = link.variant === 'onboarding' && link.accountId !== null ? await onboardingPortalLabel(deps, link.accountId) : null;
  return reserveAndSend(deps, {
    kind: 'magic_link',
    dedupeKey: NotificationKeys.magicLink(link.intentKey),
    accountId: link.accountId,
    predicates: NotificationPredicates.magicLink(),
    render: async () => {
      const { html, text } = await renderEmail(createElement(MagicLink, { productName, variant: link.variant, url: link.url, portal }));
      return { to: [link.email], replyTo: deps.env.EMAIL_REPLY_TO, subject: magicLinkSubject(link.variant, productName), html, text };
    },
  });
}

/** issueMagicLink + deliverMagicLink. */
export async function sendMagicLink(deps: Deps, request: MagicLinkRequest): Promise<{ userId: string; result: SendResult }> {
  const link = await issueMagicLink(deps, request);
  return { userId: link.userId, result: await deliverMagicLink(deps, link) };
}
