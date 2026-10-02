import 'server-only';
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { decodeKey } from './crypto';

// Per-purpose keys derived from APP_SECRET (D-51, PLAN §10.2) with HKDF-SHA256: an empty salt
// (APP_SECRET is already 32 uniformly random bytes) and `info` = "hublytix-autopilot/v1/<purpose>",
// so a key used for one purpose (e.g. signing the OAuth state cookie) cannot verify another, and a
// future key schedule can move to /v2/ without renaming purposes.
//
// The purposes are exactly D-51's. Action tokens are not among them: they are random and stored
// only as plain sha256 hashes (D-45, PLAN §10.2), with no key involved.

export const KEY_PURPOSES = ['state', 'pending', 'ratelimit', 'dedupe', 'fake-session'] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];
export type DerivedKeys = Readonly<Record<KeyPurpose, Buffer>>;

const DERIVED_KEY_BYTES = 32;
const EMPTY_SALT = Buffer.alloc(0);
/** The application and key-schedule version every `info` starts with. */
export const KEY_INFO_PREFIX = 'hublytix-autopilot/v1/';

/** HKDF-SHA256(APP_SECRET, salt = empty, info = KEY_INFO_PREFIX + purpose) → 32 bytes. */
export function deriveKey(appSecret: string | Uint8Array, purpose: KeyPurpose): Buffer {
  const ikm = decodeKey(appSecret);
  return Buffer.from(hkdfSync('sha256', ikm, EMPTY_SALT, Buffer.from(`${KEY_INFO_PREFIX}${purpose}`, 'utf8'), DERIVED_KEY_BYTES));
}

/** Every purpose key at once (the container builds this once from env.APP_SECRET). */
export function deriveKeys(appSecret: string | Uint8Array): DerivedKeys {
  const ikm = decodeKey(appSecret);
  const keys = {} as Record<KeyPurpose, Buffer>;
  for (const purpose of KEY_PURPOSES) keys[purpose] = deriveKey(ikm, purpose);
  return Object.freeze(keys);
}

/** HMAC-SHA256 as lower-case hex (the DB stores hashes as ^[0-9a-f]{64}$). */
export function hmacHex(key: Uint8Array, data: string | Uint8Array): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** HMAC-SHA256 as base64url without padding (signed cookie values). */
export function hmacBase64Url(key: Uint8Array, data: string | Uint8Array): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

/** SHA-256 as lower-case hex (action tokens and login intents store only this, D-45). */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Constant-time byte comparison. Different lengths return false after a comparison of the same
 * cost, so callers need no length check of their own.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Constant-time string comparison (UTF-8). Both sides are hashed first, so neither the content
 * nor the length of the expected value leaks through timing.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

/** Constant-time comparison of two hex digests, ignoring case. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  return timingSafeEqualString(a.toLowerCase(), b.toLowerCase());
}
