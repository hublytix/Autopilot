import 'server-only';
import type { Db } from '@/server/db';
import type { Env } from '@/server/env';
import { deriveKey, hmacHex } from '@/server/security/keys';

// Fixed-window counters in Postgres (PLAN §3 "rate limit", D-36): one `rate_limits` row per (key,
// window), keyed by an HMAC of the limited thing (an IP and route, a portal and bucket) with the
// HKDF 'ratelimit' key, so the table never holds an IP address or an email. One upsert per hit:
// the returned count includes this hit. Old windows are pruned by the daily retention step (PLAN
// §9.10 step 7).
//
// claimOnce is the same row used as a once-only marker (a single-use OAuth state, one alert per
// quota episode): the first caller creates it, every later one finds it.
//
// Used by the per-portal HubSpot limiter, the install and OAuth-callback per-IP limits, the OAuth
// state's single use and the Resend quota alert. The other public routes' limits (M3, M7) share it.

const keys = new WeakMap<Env, Buffer>();

function rateLimitKey(env: Env): Buffer {
  let key = keys.get(env);
  if (key === undefined) {
    key = deriveKey(env.APP_SECRET, 'ratelimit');
    keys.set(env, key);
  }
  return key;
}

/** HMAC-SHA256 (hex) of `material` with the 'ratelimit' key: the `rate_limits.key_hash`. */
export function rateLimitKeyHash(env: Env, material: string): string {
  return hmacHex(rateLimitKey(env), material);
}

export interface FixedWindowHit {
  /** Hits in this window, this one included. */
  readonly count: number;
  readonly windowStart: Date;
  /** When the next window starts. */
  readonly windowEnd: Date;
}

/** Counts one hit for `keyHash` in the window containing `now` (windows are aligned to multiples of `windowMs`). */
export async function hitFixedWindow(db: Db, input: { keyHash: string; windowMs: number; now: Date }): Promise<FixedWindowHit> {
  const startMs = Math.floor(input.now.getTime() / input.windowMs) * input.windowMs;
  const windowStart = new Date(startMs);
  const row = await db.one<{ count: number }>(
    `insert into rate_limits (key_hash, window_start, count) values ($1, $2, 1)
     on conflict (key_hash, window_start) do update set count = rate_limits.count + 1
     returning count`,
    [input.keyHash, windowStart],
  );
  return { count: row.count, windowStart, windowEnd: new Date(startMs + input.windowMs) };
}

/**
 * A once-only marker: true for the first caller with this key and window start, false for every
 * later one. `windowStart` is the episode the marker covers (a UTC day, the state's expiry…); the
 * retention step prunes it like any old window.
 */
export async function claimOnce(db: Db, input: { keyHash: string; windowStart: Date }): Promise<boolean> {
  const rows = await db.query(
    `insert into rate_limits (key_hash, window_start, count) values ($1, $2, 1)
     on conflict (key_hash, window_start) do nothing
     returning count`,
    [input.keyHash, input.windowStart],
  );
  return rows.length === 1;
}
