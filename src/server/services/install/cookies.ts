import 'server-only';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Env } from '@/server/env';
import { HUBSPOT_OAUTH_CALLBACK_PATH } from '@/server/hubspot/scopes';
import type { SessionCookie } from '@/server/ports';
import { deriveKey, hmacBase64Url, timingSafeEqualString } from '@/server/security/keys';

// The two install cookies (PLAN §7.3, §9.1, §10.2, D-35, D-51). Each is `<payload>.<signature>`:
// the payload is base64url JSON, the signature an HMAC-SHA256 with a purpose key derived by HKDF
// from APP_SECRET ('state' or 'pending'), both canonical unpadded base64url. Both are httpOnly,
// SameSite=Lax and Secure (except on a plain-http loopback APP_URL in development, where browsers
// would drop a Secure cookie).
// - `ap_hs_state` (10 min, path = the callback): a random nonce, also sent to HubSpot as `state`;
//   the callback accepts only the nonce its cookie carries (login CSRF on the install).
// - `ap_pending_install` (24 h): `{accountId, installerEmail}` for `/onboarding/email` (M3), which
//   pre-fills the installer's email. Signed, not encrypted: it lives in the installer's own browser.

export const STATE_COOKIE_NAME = 'ap_hs_state';
export const STATE_COOKIE_TTL_MS = 10 * 60 * 1000;
export const PENDING_INSTALL_COOKIE_NAME = 'ap_pending_install';
export const PENDING_INSTALL_TTL_MS = 24 * 60 * 60 * 1000;

const PART = /^[A-Za-z0-9_-]{1,4096}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

type CookiePurpose = 'state' | 'pending';
const keyCache = new WeakMap<Env, Map<CookiePurpose, Buffer>>();

function cookieKey(env: Env, purpose: CookiePurpose): Buffer {
  let keys = keyCache.get(env);
  if (keys === undefined) {
    keys = new Map();
    keyCache.set(env, keys);
  }
  let key = keys.get(purpose);
  if (key === undefined) {
    key = deriveKey(env.APP_SECRET, purpose);
    keys.set(purpose, key);
  }
  return key;
}

/** Secure everywhere except a plain-http loopback APP_URL (local development). */
export function secureCookies(env: Env): boolean {
  const url = new URL(env.APP_URL);
  return !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

export function signCookieValue(key: Uint8Array, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmacBase64Url(key, body)}`;
}

/** The payload of a value signed with `key`, or null when it is malformed, non-canonical or forged. */
export function verifyCookieValue(key: Uint8Array, value: string | undefined): unknown {
  if (value === undefined) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!PART.test(body) || !SIGNATURE.test(signature)) return null;
  // One valid spelling only: Buffer.from(…, 'base64url') would accept stray characters.
  const bytes = Buffer.from(body, 'base64url');
  if (bytes.toString('base64url') !== body) return null;
  if (!timingSafeEqualString(signature, hmacBase64Url(key, body))) return null;
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function cookie(env: Env, name: string, value: string, path: string, maxAgeMs: number): SessionCookie {
  return {
    name,
    value,
    options: { path, maxAge: Math.floor(maxAgeMs / 1000), httpOnly: true, secure: secureCookies(env), sameSite: 'lax' },
  };
}

// ---------------------------------------------------------------------------------------------
// OAuth state
// ---------------------------------------------------------------------------------------------

const statePayload = z.object({ n: z.string().regex(NONCE), exp: z.number().int() });

/** A fresh nonce for HubSpot's `state` parameter and the signed cookie that carries it. */
export function issueStateCookie(env: Env, now: Date): { state: string; cookie: SessionCookie } {
  const state = randomBytes(32).toString('base64url');
  const value = signCookieValue(cookieKey(env, 'state'), { n: state, exp: now.getTime() + STATE_COOKIE_TTL_MS });
  return { state, cookie: cookie(env, STATE_COOKIE_NAME, value, HUBSPOT_OAUTH_CALLBACK_PATH, STATE_COOKIE_TTL_MS) };
}

/** True when the cookie is genuine, unexpired and carries exactly the `state` HubSpot echoed back. */
export function verifyState(env: Env, cookieValue: string | undefined, state: string | null, now: Date): boolean {
  if (state === null || !NONCE.test(state)) return false;
  const parsed = statePayload.safeParse(verifyCookieValue(cookieKey(env, 'state'), cookieValue));
  if (!parsed.success || parsed.data.exp <= now.getTime()) return false;
  return timingSafeEqualString(parsed.data.n, state);
}

/** Clears the state cookie (single use). */
export function clearStateCookie(env: Env): SessionCookie {
  return cookie(env, STATE_COOKIE_NAME, '', HUBSPOT_OAUTH_CALLBACK_PATH, 0);
}

// ---------------------------------------------------------------------------------------------
// pending_install
// ---------------------------------------------------------------------------------------------

export interface PendingInstall {
  readonly accountId: string;
  /** The introspected installer email (lower-cased), the default owner email; null when HubSpot gave none. */
  readonly installerEmail: string | null;
}

const pendingPayload = z.object({ a: z.uuid(), e: z.string().max(320).nullable(), exp: z.number().int() });

export function issuePendingInstallCookie(env: Env, pending: PendingInstall, now: Date): SessionCookie {
  const value = signCookieValue(cookieKey(env, 'pending'), { a: pending.accountId, e: pending.installerEmail, exp: now.getTime() + PENDING_INSTALL_TTL_MS });
  return cookie(env, PENDING_INSTALL_COOKIE_NAME, value, '/', PENDING_INSTALL_TTL_MS);
}

/** The pending install a genuine, unexpired `ap_pending_install` cookie carries; null otherwise (M3's /onboarding/email). */
export function readPendingInstall(env: Env, cookieValue: string | undefined, now: Date): PendingInstall | null {
  const parsed = pendingPayload.safeParse(verifyCookieValue(cookieKey(env, 'pending'), cookieValue));
  if (!parsed.success || parsed.data.exp <= now.getTime()) return null;
  return { accountId: parsed.data.a, installerEmail: parsed.data.e };
}
