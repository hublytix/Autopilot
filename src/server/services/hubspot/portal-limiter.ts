import 'server-only';
import { TransientError } from '@/server/domain/errors';
import type { Deps } from '@/server/ports';
import { hitFixedWindow, rateLimitKeyHash } from './fixed-window';
import { realSleep, type Sleep } from './token-manager';

// The per-portal HubSpot limiter (D-36, HS-RATE-LIMITS): at most 9 requests per second in general
// and 4 per second for CRM search, below HubSpot's 110 per 10 s and 5 per second, counted in
// Postgres so every function instance shares the budget. Fixed one-second windows keyed by
// HMAC('hubspot:' + portalId + ':' + bucket). A caller over the limit waits for the next window and
// tries again; after MAX_WAITS windows it gives up with a TransientError (the job retries later).

export type PortalBucket = 'general' | 'search';

export const PORTAL_RATE_LIMITS: Readonly<Record<PortalBucket, number>> = { general: 9, search: 4 };
export const PORTAL_WINDOW_MS = 1000;
export const PORTAL_LIMITER_MAX_WAITS = 30;

export function portalLimiterKey(deps: Deps, portalId: string, bucket: PortalBucket): string {
  return rateLimitKeyHash(deps.env, `hubspot:${portalId}:${bucket}`);
}

/** Waits until this request fits the portal's budget for `bucket`. */
export async function acquirePortalSlot(deps: Deps, portalId: string, bucket: PortalBucket, sleep: Sleep = realSleep): Promise<void> {
  const keyHash = portalLimiterKey(deps, portalId, bucket);
  for (let waits = 0; ; waits += 1) {
    const now = deps.clock.now();
    const hit = await hitFixedWindow(deps.db, { keyHash, windowMs: PORTAL_WINDOW_MS, now });
    if (hit.count <= PORTAL_RATE_LIMITS[bucket]) return;
    if (waits >= PORTAL_LIMITER_MAX_WAITS) throw new TransientError('hubspot_portal_rate_limited');
    await sleep(Math.max(1, hit.windowEnd.getTime() - now.getTime()));
  }
}
