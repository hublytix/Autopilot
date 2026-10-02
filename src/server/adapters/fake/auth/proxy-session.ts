import 'server-only';
import { z } from 'zod';
import { SystemClock } from '@/server/adapters/live/system-clock';
import { getEnv } from '@/server/env';
import type { RefreshedSession } from '@/server/ports/auth';
import type { Clock } from '@/server/ports/clock';
import { readRequestCookie } from '@/server/security/cookies';
import { deriveKey, hmacBase64Url, timingSafeEqualString } from '@/server/security/keys';
import { SESSION_COOKIE_NAME } from './fake-auth';

// Fake mode's session check for src/proxy.ts (PLAN §7.7: "fake, a check of the signed ap_session
// cookie"). The proxy runs apart from the app's module state, so it cannot see FakeAuthProvider's
// session records: it checks only that the cookie is FakeAuthProvider's, untampered and not past
// its own expiry, and never sets a cookie (the fake refreshes nothing here). Pages still verify the
// session against the provider (requireOwner), which also catches signed-out sessions.
// The cookie format (`<base64url JSON {sid, uid, exp}>.<HMAC-SHA256 base64url>`, key = HKDF
// 'fake-session' of APP_SECRET) must match fake-auth.ts; proxy-session.test.ts checks they agree.

const PAYLOAD = /^[A-Za-z0-9_-]+$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const claimsSchema = z.object({ sid: z.string().min(1), uid: z.string().min(1), exp: z.number() });

export interface FakeSessionClaims {
  readonly userId: string;
  readonly expiresAtMs: number;
}

/** The claims of a genuine, unexpired `ap_session` value; null otherwise. */
export function readFakeSessionCookie(raw: string | undefined, key: Uint8Array, nowMs: number): FakeSessionClaims | null {
  if (raw === undefined || raw.length === 0) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!PAYLOAD.test(payload) || !SIGNATURE.test(signature)) return null;
  if (!timingSafeEqualString(signature, hmacBase64Url(key, payload))) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const claims = claimsSchema.safeParse(decoded);
  if (!claims.success || nowMs >= claims.data.exp) return null;
  return { userId: claims.data.uid, expiresAtMs: claims.data.exp };
}

export interface FakeProxySessionOptions {
  /** HKDF 'fake-session' key; default derived from APP_SECRET. */
  readonly key?: Uint8Array | undefined;
  /** Default SystemClock: the proxy cannot read fake mode's persisted clock offset (it never touches the DB). */
  readonly clock?: Clock | undefined;
}

/**
 * The proxy's fake-mode refreshSession: the response unchanged, and a user when the cookie checks
 * out. The cookie carries no email, so `email` is empty: the proxy only decides whether to send
 * the browser to /login.
 */
export async function checkFakeProxySession(request: Request, response: Response, options: FakeProxySessionOptions = {}): Promise<RefreshedSession> {
  const key = options.key ?? deriveKey(getEnv().APP_SECRET, 'fake-session');
  const nowMs = (options.clock ?? new SystemClock()).now().getTime();
  const claims = readFakeSessionCookie(readRequestCookie(request, SESSION_COOKIE_NAME), key, nowMs);
  return { response, user: claims === null ? null : { userId: claims.userId, email: '' } };
}
