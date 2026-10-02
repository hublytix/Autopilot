import 'server-only';
import { createElement } from 'react';
import { z } from 'zod';
import { VerifyNotify, verifyNotifySubject } from '@/emails/VerifyNotify';
import type { Db } from '@/server/db';
import { renderEmail } from '@/server/email/render';
import type { Env } from '@/server/env';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { ACTION_TOKEN_TTL_MS, hashActionToken, verifyActionToken } from '@/server/security/action-tokens';
import { ACTION_LINK_LIMITS, hitActionLinkLimits } from '@/server/services/action-links/limits';
import { emailHmac } from '@/server/services/intake/submission';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import type { NotificationResumer } from '@/server/services/notifications/renderers';
import type { NotificationSendPlan, RenderedMail } from '@/server/services/notifications/types';

// Extra lead-alert addresses (D-46, PLAN §7.4 `/a/[token]/verify-notify`, §8.4 `verify_notify`):
// - every notify address other than the owner's verified sign-in email gets a confirmation email
//   with a `verify_notify` action token (7 days) and receives nothing until it is confirmed;
// - the token's notification key names the address only by its HMAC (`verify-notify:{acct}:{hmac}:…`),
//   so neither the key nor the token row stores the address; the page finds it among the account's
//   listed addresses;
// - GET shows a confirmation page and changes nothing (mail scanners open links); the POST (same
//   origin) uses the token once and adds the address to `notify_emails_verified`;
// - `/a/*` is rate-limited per IP (30/min) and per token (20/min) (D-36).

/** `/a/{token}/verify-notify`. */
export function verifyNotifyPath(token: string): string {
  return `/a/${token}/verify-notify`;
}

export const VERIFY_LINK_VALID_DAYS = Math.round(ACTION_TOKEN_TTL_MS / 86_400_000);

/** HMAC of the lower-cased address: the only form of it the key and the token row carry. */
export function addressHmac(env: Env, address: string): string {
  return emailHmac(env, address);
}

/**
 * `verify-notify:{acct}:{addrHmac}:{UTC date}`: PLAN §8.4's key plus the day, so an address still
 * unconfirmed can get a fresh link on a later save (at most one email per address per day).
 */
export function verifyNotifyKey(env: Env, accountId: string, address: string, now: Date): string {
  return `${NotificationKeys.verifyNotify(accountId, addressHmac(env, address))}:${now.toISOString().slice(0, 10)}`;
}

const KEY_PATTERN = /^verify-notify:([0-9a-f-]{36}):([0-9a-f]{64})(?::\d{4}-\d{2}-\d{2})?$/;

export function parseVerifyNotifyKey(key: string): { accountId: string; addressHmac: string } | null {
  const match = KEY_PATTERN.exec(key);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  return { accountId: match[1], addressHmac: match[2] };
}

/** The owner's saved business name (only once they have saved a brief), for the email's first line. */
async function businessName(db: Db, accountId: string): Promise<string | null> {
  const row = await db.maybeOne<{ name: string | null }>(
    `select nullif(trim(brief ->> 'company_name'), '') as name from briefs where account_id = $1 and booking_link_choice <> 'unset'`,
    [accountId],
  );
  return row?.name ?? null;
}

/** How to send (and resend) the confirmation email to `address` (lower-cased, listed in settings). */
export function verifyNotifyPlan(deps: Deps, accountId: string, address: string): NotificationSendPlan {
  return {
    predicates: NotificationPredicates.verifyNotify(accountId, address),
    buttons: ['verify_notify'],
    render: async (tokens): Promise<RenderedMail> => {
      const token = tokens.verify_notify;
      if (token === undefined) throw new Error('verify_notify_token_missing');
      const productName = deps.env.PRODUCT_NAME;
      const { html, text } = await renderEmail(
        createElement(VerifyNotify, {
          productName,
          businessName: await businessName(deps.db, accountId),
          url: `${deps.env.APP_URL}${verifyNotifyPath(token)}`,
          validDays: VERIFY_LINK_VALID_DAYS,
        }),
      );
      return { to: [address], subject: verifyNotifySubject(productName), html, text };
    },
  };
}

const settingsRow = z.object({ notify_emails: z.array(z.string()), notify_emails_verified: z.array(z.string()) });

async function loadNotifySettings(db: Db, accountId: string): Promise<{ listed: string[]; verified: string[] } | null> {
  const raw = await db.maybeOne(`select notify_emails, notify_emails_verified from settings where account_id = $1`, [accountId]);
  if (raw === null) return null;
  const row = settingsRow.parse(raw);
  return { listed: row.notify_emails, verified: row.notify_emails_verified };
}

/** The listed address whose HMAC is `hmac`, if any. */
function findListed(env: Env, listed: readonly string[], hmac: string): string | null {
  return listed.find((address) => addressHmac(env, address) === hmac) ?? null;
}

/** Rebuilds the plan from the reservation alone: the address is found again by its HMAC. */
export const resumeVerifyNotify: NotificationResumer = async (deps, row) => {
  const parsed = parseVerifyNotifyKey(row.dedupeKey);
  if (parsed === null) return null;
  const settings = await loadNotifySettings(deps.db, parsed.accountId);
  if (settings === null) return null;
  const address = findListed(deps.env, settings.listed, parsed.addressHmac);
  if (address === null || settings.verified.includes(address)) return null;
  return verifyNotifyPlan(deps, parsed.accountId, address);
};

// ---------------------------------------------------------------------------------------------
// The confirmation page (GET) and the confirmation (POST)
// ---------------------------------------------------------------------------------------------

/** D-36: `/a/*` allows 30 requests a minute per IP and 20 a minute per token (shared with services/action-links). */
export { ACTION_LINK_LIMITS, hitActionLinkLimits };

export type VerifyNotifyState =
  /** The link is good: show the address and the confirm button. */
  | { readonly type: 'confirm'; readonly address: string }
  /** The address is confirmed (by this link, now or earlier). */
  | { readonly type: 'confirmed'; readonly address: string }
  /** The link was used before, and the address is not confirmed now (it was removed and added again). */
  | { readonly type: 'used' }
  /** The owner removed the address after sending the link. */
  | { readonly type: 'removed' }
  | { readonly type: 'expired' }
  /** Not a link we issued, a different purpose, revoked, or the account is disconnected. */
  | { readonly type: 'invalid' }
  | { readonly type: 'rate_limited'; readonly retryAfterSeconds: number };

export interface VerifyNotifyRequest {
  /** The path segment, untrusted. */
  token: string;
  /** Client IP, for the rate limit only (stored as an HMAC). */
  ip: string;
}

interface ResolvedLink {
  readonly tokenId: string;
  readonly accountId: string;
  readonly used: boolean;
  readonly address: string | null;
  readonly verified: boolean;
}

/** Checks the token and finds its address; a state to show instead when it cannot be used. */
async function resolveLink(deps: Deps, token: string): Promise<ResolvedLink | VerifyNotifyState> {
  const checked = await verifyActionToken(deps.db, token, 'verify_notify', deps.clock.now());
  if (!checked.ok) return checked.reason === 'expired' ? { type: 'expired' } : { type: 'invalid' };
  const key = checked.token.notificationKey === null ? null : parseVerifyNotifyKey(checked.token.notificationKey);
  if (key === null || key.accountId !== checked.token.accountId) return { type: 'invalid' };
  const settings = await loadNotifySettings(deps.db, key.accountId);
  const address = settings === null ? null : findListed(deps.env, settings.listed, key.addressHmac);
  return {
    tokenId: checked.token.id,
    accountId: key.accountId,
    used: checked.token.useCount > 0,
    address,
    verified: address !== null && settings !== null && settings.verified.includes(address),
  };
}

function stateOf(link: ResolvedLink): VerifyNotifyState {
  if (link.address === null) return link.used ? { type: 'used' } : { type: 'removed' };
  if (link.verified) return { type: 'confirmed', address: link.address };
  return link.used ? { type: 'used' } : { type: 'confirm', address: link.address };
}

class TokenRaceLost extends Error {
  override readonly name: string = 'TokenRaceLost';
}

function isState(value: ResolvedLink | VerifyNotifyState): value is VerifyNotifyState {
  return 'type' in value;
}

/** GET: what the confirmation page shows. Changes nothing but the rate-limit counters. */
export async function verifyNotifyLinkState(deps: Deps, request: VerifyNotifyRequest): Promise<VerifyNotifyState> {
  const retryAfterSeconds = await hitActionLinkLimits(deps, request.ip, request.token);
  if (retryAfterSeconds !== null) return { type: 'rate_limited', retryAfterSeconds };
  const link = await resolveLink(deps, request.token);
  return isState(link) ? link : stateOf(link);
}

/**
 * POST: confirms the address. The token is used once (a compare-and-set on `use_count = 0`), in the
 * same transaction that adds the address to `notify_emails_verified`, so a double submit confirms
 * once and a used link cannot confirm the address again after it was removed and re-added.
 */
export async function confirmNotifyAddress(deps: Deps, request: VerifyNotifyRequest): Promise<VerifyNotifyState> {
  const retryAfterSeconds = await hitActionLinkLimits(deps, request.ip, request.token);
  if (retryAfterSeconds !== null) return { type: 'rate_limited', retryAfterSeconds };
  const link = await resolveLink(deps, request.token);
  if (isState(link)) return link;
  const address = link.address;
  if (address === null || link.used || link.verified) return stateOf(link);

  const now = deps.clock.now();
  let confirmed = false;
  try {
    confirmed = await deps.db.tx(async (tx) => {
      const added = await tx.maybeOne(
        `update settings set notify_emails_verified = array_append(notify_emails_verified, $2::text)
          where account_id = $1 and $2::text = any(notify_emails) and not ($2::text = any(notify_emails_verified))
          returning account_id`,
        [link.accountId, address],
      );
      if (added === null) return false;
      const used = await tx.maybeOne(
        `update action_tokens set use_count = use_count + 1, first_used_at = coalesce(first_used_at, $3)
          where id = $1 and token_hash = $2 and purpose = 'verify_notify' and use_count = 0
            and revoked_at is null and expires_at > $3
          returning id`,
        [link.tokenId, hashActionToken(request.token), now],
      );
      // Rolls the settings change back: another request used the token first.
      if (used === null) throw new TokenRaceLost();
      return true;
    });
  } catch (error) {
    if (!(error instanceof TokenRaceLost)) throw error;
  }
  if (confirmed) {
    log.info('notify address confirmed', { event: 'settings.notify_confirmed', accountId: link.accountId });
    return { type: 'confirmed', address };
  }
  // Someone else's request got there first, or the settings changed in between: show what is true now.
  const again = await resolveLink(deps, request.token);
  return isState(again) ? again : stateOf(again);
}
