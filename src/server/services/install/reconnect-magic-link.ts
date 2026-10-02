import 'server-only';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { sendMagicLink } from '@/server/services/auth/magic-link';
import { AUTH_RATE_LIMITS, hitAuthLimit } from '@/server/services/auth/rate-limits';

// Branch (d) of the OAuth callback when the installer is the owner but has no session (D-35, PLAN
// §9.1 (d)): nothing changes; the page says "Sign in to finish reconnecting" and the owner gets a
// magic link (login intent, next `/dashboard?reconnect=1`) at their login email. Signed in, they
// tap Reconnect on the dashboard, which runs the install again as branch (c). The link shares
// /login's per-email limit (3 per 15 min), so repeated installs cannot flood the owner's inbox.

export const RECONNECT_NEXT = '/dashboard?reconnect=1';

export interface ReconnectMagicLinkInput {
  readonly accountId: string;
}

/** Resolves true when a link was emailed now, so the page only says so when it is true (law 5). */
export type SendReconnectMagicLink = (deps: Deps, input: ReconnectMagicLinkInput) => Promise<boolean>;

export const sendReconnectMagicLink: SendReconnectMagicLink = async (deps, input) => {
  const owner = await deps.db.maybeOne<{ email: string }>(
    `select u.email from accounts a join users u on u.account_id = a.id and u.auth_user_id = a.owner_user_id where a.id = $1`,
    [input.accountId],
  );
  if (owner === null) {
    log.warn('reconnect magic link without a bound owner', { event: 'install.reconnect_magic_link_no_owner', accountId: input.accountId });
    return false;
  }
  const email = owner.email.toLowerCase();
  const limit = await hitAuthLimit(deps, 'login', `email:${email}`, AUTH_RATE_LIMITS.login.email);
  if (limit.limited) {
    log.warn('reconnect magic link rate limited', { event: 'install.reconnect_magic_link_rate_limited', accountId: input.accountId });
    return false;
  }
  const { result } = await sendMagicLink(deps, {
    email,
    purpose: 'login',
    accountId: input.accountId,
    next: RECONNECT_NEXT,
    variant: 'reconnect',
  });
  const sent = result.status === 'sent' || result.status === 'already_sent';
  log.info(sent ? 'reconnect magic link sent' : 'reconnect magic link not sent', {
    event: sent ? 'install.reconnect_magic_link_sent' : 'install.reconnect_magic_link_not_sent',
    accountId: input.accountId,
  });
  return sent;
};
