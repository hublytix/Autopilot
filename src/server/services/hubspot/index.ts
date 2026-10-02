import 'server-only';

// HubSpot connection management (PLAN §9.1, D-10, D-11, D-36): the token manager, the per-account
// client wrapper with the per-portal limiter, and the revoked path.
export { forAccount, EMAIL_BATCH_SIZE } from './portal-client';
export type { PortalClientOptions, PortalHubSpotClient } from './portal-client';
export { acquirePortalSlot, PORTAL_LIMITER_MAX_WAITS, PORTAL_RATE_LIMITS, PORTAL_WINDOW_MS, portalLimiterKey } from './portal-limiter';
export type { PortalBucket } from './portal-limiter';
export { hitFixedWindow, rateLimitKeyHash } from './fixed-window';
export type { FixedWindowHit } from './fixed-window';
export { revokeConnection, revokeConnectionInTx } from './revoke';
export type { RevokeConnectionInput, RevokeOutcome, RevokeReason } from './revoke';
export {
  ACCESS_TOKEN_SKEW_MS,
  ConnectionInactiveError,
  getAccessToken,
  INLINE_BACKOFF_MAX_MS,
  INLINE_FAILURE_ALERT_AT,
  inlineBackoffMs,
  realSleep,
  refreshBackoffActive,
  REFRESH_LEASE_MS,
  REFRESH_POLL_INTERVAL_MS,
  REFRESH_POLL_MAX_MS,
  REFRESH_TIMEOUT_MS,
  resetRefreshFailures,
} from './token-manager';
export type { AccessToken, GetAccessTokenOptions, Sleep } from './token-manager';
export { decryptAccessToken, decryptRefreshToken, encryptTokens, tokenCipher } from './tokens';
export type { EncryptedTokens } from './tokens';
