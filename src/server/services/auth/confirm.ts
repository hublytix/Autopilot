import 'server-only';
import { z } from 'zod';
import { errorCode } from '@/server/domain/errors';
import { AUTH_OTP_TYPES } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { isDbError } from '@/server/db';
import { log } from '@/server/obs/log';
import type { Deps, SessionCookie } from '@/server/ports';
import { insertAuditOnce } from '@/server/services/audit/audit-log';
import { consumeLoginIntent, loginIntentKey } from './login-intents';
import { safeNextPath } from './next-path';
import { AUTH_RATE_LIMITS, hitAuthLimit } from './rate-limits';

// POST /auth/confirm (PLAN §7.2, §9.1 step 2, D-22, D-35): rate limit (10 per 15 min per IP) →
// verifyOtp({token_hash, type ∈ email|magiclink|signup}) → consume the login intent by
// compare-and-set (sha256(token_hash), unexpired, unused) → for an onboarding intent, bind the owner
// in ONE statement, by verified email = pending email, in whatever browser the link was opened →
// the session cookies and the intent's allow-listed `next`. Nothing here depends on a cookie the
// email step set, so a link opened on another device binds too; a login-CSRF cannot bind a stranger
// because the verified email must equal the account's pending email.

export type ConfirmOutcome =
  | { readonly type: 'rate_limited'; readonly retryAfterSeconds: number }
  /** Malformed input, a wrong `type`, or a token that is unknown, used or expired (the intent too). */
  | { readonly type: 'invalid_link' }
  /** The verified email already owns another account: nothing bound, this account's pending owner cleared. */
  | { readonly type: 'already_owner' }
  /** An onboarding link whose account no longer waits for this email (changed, expired, or bound to someone else). */
  | { readonly type: 'setup_mismatch' }
  | { readonly type: 'signed_in'; readonly location: string; readonly cookies: readonly SessionCookie[]; readonly accountId: string | null };

const inputSchema = z.object({
  // Supabase's hashed token: hex today, possibly with a flow prefix; nothing that needs escaping.
  tokenHash: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
  type: z.enum(AUTH_OTP_TYPES),
});

export interface ConfirmInput {
  readonly tokenHash: unknown;
  readonly type: unknown;
  /** Only its HMAC is stored. */
  readonly ip: string;
}

export type BindResult = 'bound' | 'already_owner' | 'not_bound';

/**
 * PLAN §9.1 step 2, one statement: the account takes this owner only while it has none and its
 * unexpired pending email is the verified email. A unique violation (the email or auth user already
 * owns an account) binds nothing; the losing account's pending owner is then cleared.
 */
export async function bindOwner(db: Db, input: { accountId: string; userId: string; email: string; now: Date }): Promise<BindResult> {
  try {
    const rows = await db.query(
      `with b as (
         update accounts set owner_user_id = $1, pending_owner_email = null,
                pending_owner_expires_at = null, pending_owner_auth_user_id = null
          where id = $2 and owner_user_id is null
            and lower(pending_owner_email) = $3 and pending_owner_expires_at > $4
          returning id)
       insert into users (auth_user_id, account_id, email) select $1, b.id, $3 from b
       returning account_id`,
      [input.userId, input.accountId, input.email, input.now],
    );
    return rows.length === 1 ? 'bound' : 'not_bound';
  } catch (error) {
    if (!isDbError(error) || !error.isUniqueViolation()) throw error;
    await db.query(
      `update accounts set pending_owner_email = null, pending_owner_expires_at = null, pending_owner_auth_user_id = null
        where id = $1 and owner_user_id is null`,
      [input.accountId],
    );
    return 'already_owner';
  }
}

export async function confirmMagicLink(deps: Deps, input: ConfirmInput): Promise<ConfirmOutcome> {
  const limit = await hitAuthLimit(deps, 'confirm', `ip:${input.ip}`, AUTH_RATE_LIMITS.confirm.ip);
  if (limit.limited) {
    log.warn('magic link confirm rate limited', { event: 'auth.confirm_rate_limited' });
    return { type: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
  }
  const parsed = inputSchema.safeParse({ tokenHash: input.tokenHash, type: input.type });
  if (!parsed.success) return { type: 'invalid_link' };
  const { tokenHash, type } = parsed.data;

  // A wrong type fails here without using the token up, so the right one can still follow.
  const session = await deps.auth.verify(tokenHash, type);
  if (session === null) {
    log.info('magic link not accepted', { event: 'auth.confirm_rejected', reason: 'verify' });
    return { type: 'invalid_link' };
  }
  const now = deps.clock.now();
  const intent = await consumeLoginIntent(deps.db, { key: loginIntentKey(tokenHash), now });
  if (intent === null) {
    // Supabase accepted it, but our side has no live intent (expired at the hour, used, or not ours).
    log.warn('magic link without a live intent', { event: 'auth.confirm_rejected', reason: 'intent', userId: session.userId });
    return { type: 'invalid_link' };
  }
  const location = safeNextPath(intent.next, deps.env.APP_URL);
  const email = session.email.toLowerCase();

  if (intent.purpose === 'onboarding' && intent.accountId !== null) {
    const accountId = intent.accountId;
    const bound = await bindOwner(deps.db, { accountId, userId: session.userId, email, now });
    if (bound === 'already_owner') {
      log.info('owner bind refused', { event: 'auth.bind_refused', reason: 'already_owner', accountId });
      return { type: 'already_owner' };
    }
    if (bound === 'not_bound') {
      // A second onboarding link for an account this user already owns just signs them in.
      const owns = await deps.db.maybeOne(`select 1 as owns from accounts where id = $1 and owner_user_id = $2`, [accountId, session.userId]);
      if (owns === null) {
        log.info('owner bind refused', { event: 'auth.bind_refused', reason: 'not_pending', accountId });
        return { type: 'setup_mismatch' };
      }
    } else {
      log.info('owner bound', { event: 'auth.owner_bound', accountId, userId: session.userId });
      try {
        await insertAuditOnce(deps.db, { accountId, actor: 'owner', action: 'auth.owner_bound', level: 'info', meta: {} }, []);
      } catch (error) {
        log.warn('audit row not written', { event: 'auth.audit_failed', accountId, code: errorCode(error) });
      }
    }
    return { type: 'signed_in', location, cookies: session.cookies, accountId };
  }

  log.info('signed in', { event: 'auth.signed_in', accountId: intent.accountId ?? undefined, userId: session.userId });
  return { type: 'signed_in', location, cookies: session.cookies, accountId: intent.accountId };
}
