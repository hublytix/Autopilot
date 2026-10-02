import 'server-only';
import { z } from 'zod';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { ensureAuthUser, sendMagicLink, type MagicLinkRequest } from './magic-link';
import { isAdminEmail } from './owner-scope';
import { AUTH_RATE_LIMITS, hitAuthLimit } from './rate-limits';

// /login (PLAN §7.2, D-22, D-36): the same neutral answer whatever happens, after exactly the ~800 ms
// floor, so neither the words nor the timing tell whether an address has an account. The work (rate
// limits, the account lookup and, for an address that may sign in, createUser + generateLink + the
// intent + the email) runs beside the floor and is handed to `defer` (Next's `after()`), never
// awaited by the answer: a slow Supabase or Resend call cannot stretch one branch's answer. A link is
// emailed only to (a) a bound owner (login intent → /dashboard), (b) an unexpired pending owner
// email (onboarding intent for that account → /onboarding/brief: it binds on confirm) or (c) an
// ADMIN_EMAILS address (→ /admin). Limits: 5 per 15 min per IP, 3 per 15 min per email (an
// over-limit request still gets the neutral answer and nothing is sent).

export const LOGIN_LATENCY_FLOOR_MS = 800;
export const OWNER_HOME = '/dashboard';
export const ONBOARDING_NEXT = '/onboarding/brief';
export const ADMIN_HOME = '/admin';

/** What /login shows, always. */
export const LOGIN_NEUTRAL_MESSAGE = "If that email can sign in, we've sent a link. It works once and expires in 1 hour.";

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** The submitted address, trimmed and lower-cased; null when it is not an email address. */
export function normaliseEmail(value: unknown): string | null {
  const parsed = emailSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface LoginInput {
  readonly email: unknown;
  /** Only its HMAC is stored. */
  readonly ip: string;
}

export interface LoginOptions {
  /** The latency floor's timer; default the global setTimeout (fake timers in tests). */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Keeps the work alive after the answer: Next's `after()` in the Server Action; tests collect and
   * await it. The work never rejects (failures are logged), and the answer never waits for it.
   */
  readonly defer: (work: Promise<void>) => void;
}

export interface LoginResult {
  readonly type: 'neutral';
}

type Branch = 'owner' | 'pending_owner' | 'admin' | 'none';

/** Which link (if any) this address gets. */
async function chooseLink(deps: Deps, email: string): Promise<{ branch: Branch; request: MagicLinkRequest | null }> {
  const owner = await deps.db.maybeOne<{ account_id: string }>(
    `select u.account_id
       from users u join accounts a on a.id = u.account_id and a.owner_user_id = u.auth_user_id
      where lower(u.email) = $1`,
    [email],
  );
  if (owner !== null) {
    return { branch: 'owner', request: { email, purpose: 'login', accountId: owner.account_id, next: OWNER_HOME } };
  }
  const pending = await deps.db.maybeOne<{ id: string }>(
    `select id from accounts
      where lower(pending_owner_email) = $1 and pending_owner_expires_at > $2 and owner_user_id is null
      order by last_install_at desc, id
      limit 1`,
    [email, deps.clock.now()],
  );
  if (pending !== null) {
    return { branch: 'pending_owner', request: { email, purpose: 'onboarding', accountId: pending.id, next: ONBOARDING_NEXT } };
  }
  if (isAdminEmail(deps.env, email)) return { branch: 'admin', request: { email, purpose: 'login', accountId: null, next: ADMIN_HOME } };
  return { branch: 'none', request: null };
}

async function attempt(deps: Deps, input: LoginInput): Promise<void> {
  const byIp = await hitAuthLimit(deps, 'login', `ip:${input.ip}`, AUTH_RATE_LIMITS.login.ip);
  const email = normaliseEmail(input.email);
  if (email === null) return;
  const byEmail = await hitAuthLimit(deps, 'login', `email:${email}`, AUTH_RATE_LIMITS.login.email);
  if (byIp.limited || byEmail.limited) {
    log.warn('login rate limited', { event: 'auth.login_rate_limited', reason: byIp.limited ? 'ip' : 'email' });
    return;
  }
  const { branch, request } = await chooseLink(deps, email);
  if (request === null) return;
  // A pending owner's and an admin's auth user may not exist yet; generateLink must never create one.
  if (branch !== 'owner') await ensureAuthUser(deps, email);
  await sendMagicLink(deps, request);
  log.info('login link sent', { event: 'auth.login_link_sent', accountId: request.accountId ?? undefined });
}

/**
 * Starts sending a link when the address may sign in (handed to `options.defer`) and resolves to the
 * neutral result when the floor ends, whatever the work is doing by then.
 */
export async function requestLoginLink(deps: Deps, input: LoginInput, options: LoginOptions): Promise<LoginResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const floor = sleep(LOGIN_LATENCY_FLOOR_MS);
  const work = attempt(deps, input).catch((error: unknown) => {
    // Still neutral: a failure must look exactly like "no such account".
    log.warn('login link failed', { event: 'auth.login_link_failed', code: errorCode(error) }, error);
  });
  options.defer(work);
  await floor;
  return { type: 'neutral' };
}
