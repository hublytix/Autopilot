import 'server-only';
import { z } from 'zod';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { readPendingInstall, type PendingInstall } from '@/server/services/install/cookies';
import { normaliseEmail, ONBOARDING_NEXT } from './login';
import { deliverMagicLink, ensureAuthUser, issueMagicLink } from './magic-link';
import { isAdminEmail } from './owner-scope';
import { AUTH_RATE_LIMITS, hitAuthLimit, takeInstallEmailSlot } from './rate-limits';

// /onboarding/email (PLAN §7.5, §9.1, D-35, D-36): the installer names the owner's email. It needs
// the signed pending_install cookie (24 h) from the OAuth callback, and every pending-owner write is
// conditional on `last_install_at = installedAt`, so a newer reinstall invalidates an older
// cookie. It stores pending_owner_email (+24 h), creates or reuses the auth user and emails an
// onboarding magic link. pending_owner_auth_user_id records only a user THIS flow created for this
// account; a replaced one is deleted only when nothing refers to it, its address is no admin's, no
// owner's and no other pending install's (D-62). Binding happens later in POST /auth/confirm, in any
// browser: the cookie is not needed again.
//
// Every new address costs one of the install's 3 slots BEFORE the "already owns an account" answer,
// so an installer cannot probe more than 3 addresses per install for being Autopilot owners (D-62).

export const PENDING_OWNER_TTL_MS = 24 * 60 * 60 * 1000;

export type OnboardingEmailOutcome =
  /** No valid pending_install cookie: start from Install. */
  | { readonly type: 'no_install' }
  /** A newer install replaced this one, or the account is gone. */
  | { readonly type: 'superseded' }
  /** The account already has its owner. */
  | { readonly type: 'already_set_up' }
  | { readonly type: 'invalid_email' }
  /** This email already owns an Autopilot account (one owner per account). */
  | { readonly type: 'already_owner' }
  | { readonly type: 'rate_limited' }
  /** Too many different addresses for this install. */
  | { readonly type: 'too_many_emails' }
  /** The email could not be sent; trying again may work. */
  | { readonly type: 'send_failed' }
  | { readonly type: 'sent' };

export interface OnboardingEmailInput {
  /** The `ap_pending_install` cookie value. */
  readonly pendingCookie: string | undefined;
  readonly email: unknown;
  /** Only its HMAC is stored. */
  readonly ip: string;
}

/** What the email page shows before submitting. */
export type OnboardingEmailContext =
  | { readonly type: 'no_install' }
  | { readonly type: 'superseded' }
  | { readonly type: 'already_set_up' }
  /** `email`: the pending owner email if one is waiting, else the installer's email (may be null). */
  | { readonly type: 'ready'; readonly email: string | null; readonly linkSent: boolean };

const accountRow = z.object({
  last_install_at: z.date(),
  owner_user_id: z.string().nullable(),
  pending_owner_email: z.string().nullable(),
  pending_owner_expires_at: z.date().nullable(),
});

async function loadInstall(deps: Deps, pending: PendingInstall) {
  const raw = await deps.db.maybeOne(
    `select last_install_at, owner_user_id, pending_owner_email, pending_owner_expires_at from accounts where id = $1`,
    [pending.accountId],
  );
  return raw === null ? null : accountRow.parse(raw);
}

/** The page's state for this browser's pending_install cookie (read-only). */
export async function onboardingEmailContext(deps: Deps, pendingCookie: string | undefined): Promise<OnboardingEmailContext> {
  const now = deps.clock.now();
  const pending = readPendingInstall(deps.env, pendingCookie, now);
  if (pending === null) return { type: 'no_install' };
  const account = await loadInstall(deps, pending);
  if (account === null) return { type: 'superseded' };
  if (account.owner_user_id !== null) return { type: 'already_set_up' };
  if (account.last_install_at.getTime() !== pending.installedAt.getTime()) return { type: 'superseded' };
  const waiting = account.pending_owner_email !== null && account.pending_owner_expires_at !== null && account.pending_owner_expires_at > now;
  return { type: 'ready', email: waiting ? account.pending_owner_email : pending.installerEmail, linkSent: waiting };
}

/**
 * Deletes the replaced pending user `authUserId` (one this flow created for this account, last
 * pending for `email`) only when nothing refers to it any more (D-35, D-48, D-62): no users row, no
 * account lists it, its address is not in ADMIN_EMAILS, owns no account and is no other install's
 * unexpired pending owner email.
 */
async function deleteReplacedAuthUser(deps: Deps, authUserId: string, email: string | null, accountId: string): Promise<void> {
  if (email !== null && isAdminEmail(deps.env, email)) return;
  const referenced = await deps.db.maybeOne(
    `select 1 as referenced
      where exists (select 1 from users where auth_user_id = $1 or ($2::text is not null and lower(email) = $2))
         or exists (select 1 from accounts where pending_owner_auth_user_id = $1)
         or ($2::text is not null and exists (
              select 1 from accounts where lower(pending_owner_email) = $2 and pending_owner_expires_at > $3 and owner_user_id is null))`,
    [authUserId, email?.toLowerCase() ?? null, deps.clock.now()],
  );
  if (referenced !== null) return;
  try {
    await deps.auth.deleteUser(authUserId);
    log.info('replaced pending auth user deleted', { event: 'auth.pending_user_deleted', accountId });
  } catch (error) {
    // Left behind: it owns nothing, and the orphan purge's guarded delete covers it later.
    log.warn('replaced pending auth user not deleted', { event: 'auth.pending_user_delete_failed', accountId, code: errorCode(error) });
  }
}

export async function submitOnboardingEmail(deps: Deps, input: OnboardingEmailInput): Promise<OnboardingEmailOutcome> {
  const now = deps.clock.now();
  const pending = readPendingInstall(deps.env, input.pendingCookie, now);
  if (pending === null) return { type: 'no_install' };

  const byIp = await hitAuthLimit(deps, 'onboarding_email', `ip:${input.ip}`, AUTH_RATE_LIMITS.onboardingEmail.ip);
  const email = normaliseEmail(input.email);
  if (email === null) return byIp.limited ? { type: 'rate_limited' } : { type: 'invalid_email' };
  const byEmail = await hitAuthLimit(deps, 'onboarding_email', `email:${email}`, AUTH_RATE_LIMITS.onboardingEmail.email);
  if (byIp.limited || byEmail.limited) {
    log.warn('onboarding email rate limited', { event: 'auth.onboarding_email_rate_limited', accountId: pending.accountId, reason: byIp.limited ? 'ip' : 'email' });
    return { type: 'rate_limited' };
  }

  const account = await loadInstall(deps, pending);
  if (account === null) return { type: 'superseded' };
  if (account.owner_user_id !== null) return { type: 'already_set_up' };
  if (account.last_install_at.getTime() !== pending.installedAt.getTime()) return { type: 'superseded' };

  // A new address takes one of the install's slots first, so probing for owners costs slots too.
  if (!(await takeInstallEmailSlot(deps, pending, email))) {
    log.warn('onboarding email refused: too many addresses', { event: 'auth.onboarding_email_too_many', accountId: pending.accountId });
    return { type: 'too_many_emails' };
  }
  // One owner per account, one account per owner (D-35).
  const owner = await deps.db.maybeOne(`select 1 as owner from users where lower(email) = $1`, [email]);
  if (owner !== null) return { type: 'already_owner' };

  // Only the newest install's cookie may set the pending owner (PLAN §9.1 (b), D-55). The old values
  // come from the locked row as it was before this update.
  const stored = await deps.db.maybeOne<{ previous_auth_user_id: string | null; previous_email: string | null }>(
    `with old as (
       select id, pending_owner_auth_user_id, pending_owner_email from accounts
        where id = $1 and owner_user_id is null and last_install_at = $4
        for update
     )
     update accounts a set pending_owner_email = $2, pending_owner_expires_at = $3
       from old
      where a.id = old.id
      returning old.pending_owner_auth_user_id as previous_auth_user_id, old.pending_owner_email as previous_email`,
    [pending.accountId, email, new Date(now.getTime() + PENDING_OWNER_TTL_MS), pending.installedAt],
  );
  if (stored === null) return { type: 'superseded' };

  try {
    const created = await ensureAuthUser(deps, email);
    const link = await issueMagicLink(deps, { email, purpose: 'onboarding', accountId: pending.accountId, next: ONBOARDING_NEXT });
    const previous = stored.previous_auth_user_id;
    // Remember the auth user only when this flow made it for this account (now, or on an earlier
    // submit of the same address): an existing user (an admin, another install's pending owner) is
    // never this account's to delete later. Skipped when the pending email changed again meanwhile.
    const ours = created || previous === link.userId;
    await deps.db.query(
      `update accounts set pending_owner_auth_user_id = $2
        where id = $1 and owner_user_id is null and last_install_at = $3 and lower(pending_owner_email) = $4`,
      [pending.accountId, ours ? link.userId : null, pending.installedAt, email],
    );
    if (previous !== null && previous !== link.userId) await deleteReplacedAuthUser(deps, previous, stored.previous_email, pending.accountId);
    await deliverMagicLink(deps, link);
  } catch (error) {
    log.warn('onboarding magic link failed', { event: 'auth.onboarding_email_failed', accountId: pending.accountId, code: errorCode(error) }, error);
    return { type: 'send_failed' };
  }
  log.info('onboarding magic link sent', { event: 'auth.onboarding_email_sent', accountId: pending.accountId });
  return { type: 'sent' };
}
