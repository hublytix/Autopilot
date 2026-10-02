import 'server-only';
import { randomBytes } from 'node:crypto';
import type { Deps } from '@/server/ports';
import { claimOnce, rateLimitKeyHash } from '@/server/security/rate-limit';

// The page beacon (D-26): the mailto interstitial (and M4's edit page, and the copy page) embeds a
// fresh random nonce and its CSP-nonce'd script posts it back to /a/{token}/beacon. A link scanner
// that only fetches the page never runs the script, so a beacon is the click signal that holds even
// within 60 s of delivery.
//
// The nonce is a once-only marker in `rate_limits` (the same table claimOnce uses for single-use OAuth
// states): the key is the HMAC of the token id and the nonce, the window start is when the page was
// rendered. A beacon is accepted at most once, within BEACON_TTL_MS, by deleting its marker in one
// statement. The daily retention step prunes unused markers like any old window.

export const BEACON_TTL_MS = 15 * 60_000;
/** 16 random bytes, base64url without padding. */
export const BEACON_NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function markerKey(deps: Pick<Deps, 'env'>, tokenId: string, nonce: string): string {
  return rateLimitKeyHash(deps.env, `action_link:beacon:${tokenId}:${nonce}`);
}

/** A new beacon nonce for a page rendered now for this token. */
export async function issueBeacon(deps: Pick<Deps, 'db' | 'env' | 'clock'>, tokenId: string): Promise<string> {
  const nonce = randomBytes(16).toString('base64url');
  await claimOnce(deps.db, { keyHash: markerKey(deps, tokenId, nonce), windowStart: deps.clock.now() });
  return nonce;
}

/** Uses the nonce up: true once for a nonce issued for this token within BEACON_TTL_MS, false otherwise. */
export async function consumeBeacon(deps: Pick<Deps, 'db' | 'env' | 'clock'>, tokenId: string, nonce: string): Promise<boolean> {
  if (!BEACON_NONCE_PATTERN.test(nonce)) return false;
  const now = deps.clock.now();
  const rows = await deps.db.query(
    `delete from rate_limits where key_hash = $1 and window_start > $2 and window_start <= $3 returning key_hash`,
    [markerKey(deps, tokenId, nonce), new Date(now.getTime() - BEACON_TTL_MS), now],
  );
  return rows.length > 0;
}
