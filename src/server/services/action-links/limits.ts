import 'server-only';
import type { Deps } from '@/server/ports';
import { sha256Hex } from '@/server/security/keys';
import { hitFixedWindow, rateLimitKeyHash } from '@/server/security/rate-limit';

// The `/a/*` rate limits (PLAN §7.4, D-36), shared by every owner action link (send, copy, beacon,
// verify-notify; M4: edit, dismiss): 30 requests a minute per client IP and 20 per token, so the
// per-IP count covers all of /a/* together.

export const ACTION_LINK_LIMITS = { perIp: 30, perToken: 20, windowMs: 60_000 } as const;

/** Counts one `/a/*` request against both limits; the retry delay in seconds when either is exceeded. */
export async function hitActionLinkLimits(deps: Pick<Deps, 'db' | 'env' | 'clock'>, ip: string, token: string): Promise<number | null> {
  const now = deps.clock.now();
  const { windowMs } = ACTION_LINK_LIMITS;
  const byIp = await hitFixedWindow(deps.db, { keyHash: rateLimitKeyHash(deps.env, `action_link:ip:${ip}`), windowMs, now });
  // The token is hashed before it reaches the HMAC input, like everywhere else it is stored.
  const byToken = await hitFixedWindow(deps.db, { keyHash: rateLimitKeyHash(deps.env, `action_link:token:${sha256Hex(token)}`), windowMs, now });
  if (byIp.count <= ACTION_LINK_LIMITS.perIp && byToken.count <= ACTION_LINK_LIMITS.perToken) return null;
  return Math.max(1, Math.ceil((byIp.windowEnd.getTime() - now.getTime()) / 1000));
}
