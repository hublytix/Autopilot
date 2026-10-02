import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, errorCode, isConfigError, isRevoked, RevokedError, TransientError } from '@/server/domain/errors';
import { CONNECTION_STATUSES, type ConnectionStatus } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { raiseAlert } from '@/server/jobs/alert';
import { log } from '@/server/obs/log';
import type { Deps, TokenSet } from '@/server/ports';
import { revokeConnection } from './revoke';
import { decryptAccessToken, decryptRefreshToken, encryptTokens } from './tokens';

// The HubSpot token manager (PLAN §9.1 step 3, D-11):
// - The stored access token is used while `access_expires_at − 5 min > $now`.
// - Otherwise one caller takes the refresh lease (compare-and-set on `refresh_lease_until`, 20 s,
//   guarded by `token_version`). A loser re-reads the row every 250 ms for up to 10 s.
// - The winner makes ONE refresh call (8 s timeout) with no transaction open.
//   - success: a conditional update (status active, same token_version) bumps token_version and
//     stores the newest refresh token, encrypted with an AAD bound to the row and column (D-51);
//   - revoked: the revoked path (./revoke.ts) in one transaction; the reconnect email after commit;
//   - transient: the lease is released and the TransientError rethrown (jobs rely on QStash's
//     backoff). Only inline callers (the poll cron, the lead-page refresh) count the failure:
//     `transient_failures + 1` and `next_refresh_attempt_at = $now + min(2^(n−1) × 5 min, 30 min)`;
//     the fifth consecutive inline failure raises one alert;
//   - config: one alert per episode (`status_reason = 'oauth_config'` marks it); the connection
//     stays active.
// - Any successful refresh, and any successful API call (portal-client.ts), resets both counters.
// Tokens are never logged or put into errors (law 4).

export const ACCESS_TOKEN_SKEW_MS = 5 * 60 * 1000;
export const REFRESH_LEASE_MS = 20 * 1000;
export const REFRESH_POLL_INTERVAL_MS = 250;
export const REFRESH_POLL_MAX_MS = 10 * 1000;
export const REFRESH_TIMEOUT_MS = 8 * 1000;
export const INLINE_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const INLINE_BACKOFF_MAX_MS = 30 * 60 * 1000;
/** The inline failure count that raises the alert (once: at exactly this count). */
export const INLINE_FAILURE_ALERT_AT = 5;
/** `status_reason` while a refresh keeps failing as a config error (the alert's once-per-episode marker). */
export const OAUTH_CONFIG_REASON = 'oauth_config';

export type Sleep = (ms: number) => Promise<void>;

/** Real waiting; tests inject a sleep that advances their FakeClock instead. */
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `next_refresh_attempt_at − $now` after the n-th consecutive inline failure: min(2^(n−1) × 5 min, 30 min). */
export function inlineBackoffMs(failures: number): number {
  const exponent = Math.max(0, Math.min(failures - 1, 3));
  return Math.min(2 ** exponent * INLINE_BACKOFF_BASE_MS, INLINE_BACKOFF_MAX_MS);
}

/** The connection is not `active` (revoked or disconnected): terminal for this connection, like RevokedError. */
export class ConnectionInactiveError extends RevokedError<'hubspot_connection_inactive'> {
  override readonly name: string = 'ConnectionInactiveError';
  readonly status: ConnectionStatus | 'missing';

  constructor(status: ConnectionStatus | 'missing') {
    super('hubspot_connection_inactive');
    this.status = status;
  }
}

export interface GetAccessTokenOptions {
  /** The poll cron and the lead-page refresh: they have no QStash backoff, so failures are counted (D-11). */
  inline?: boolean | undefined;
  /**
   * The 401 rule: refresh even though the stored token looks fresh, unless `token_version` has moved
   * past this version (another caller refreshed after the token that got the 401 was read).
   */
  forceRefreshFromVersion?: number | undefined;
  /** Default: real timers. */
  sleep?: Sleep | undefined;
  /** Bounds the refresh call further (the 8 s timeout always applies). */
  signal?: AbortSignal | undefined;
}

export interface AccessToken {
  /** The plaintext access token: pass it to the HubSpot client, never log it. */
  readonly accessToken: string;
  readonly accountId: string;
  readonly connectionId: string;
  readonly portalId: string;
  readonly tokenVersion: number;
  readonly expiresAt: Date;
  /** The connection has inline failures recorded; the first successful API call resets them. */
  readonly hasFailureCount: boolean;
}

const connectionSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  portal_id: z.string(),
  status: z.enum(CONNECTION_STATUSES),
  access_token_enc: z.string().nullable(),
  refresh_token_enc: z.string().nullable(),
  access_expires_at: z.date().nullable(),
  token_version: z.number(),
  refresh_lease_until: z.date().nullable(),
  transient_failures: z.number(),
  next_refresh_attempt_at: z.date().nullable(),
});

type ConnectionRow = z.infer<typeof connectionSchema>;

const CONNECTION_COLUMNS =
  'id, account_id, portal_id, status, access_token_enc, refresh_token_enc, access_expires_at, token_version, refresh_lease_until, ' +
  'transient_failures, next_refresh_attempt_at';

async function loadConnection(db: Db, accountId: string): Promise<ConnectionRow | null> {
  const raw = await db.maybeOne(`select ${CONNECTION_COLUMNS} from hubspot_connections where account_id = $1`, [accountId]);
  return raw === null ? null : connectionSchema.parse(raw);
}

function requireActive(connection: ConnectionRow | null): ConnectionRow {
  if (connection === null) throw new ConnectionInactiveError('missing');
  if (connection.status !== 'active' || connection.access_token_enc === null || connection.refresh_token_enc === null) {
    throw new ConnectionInactiveError(connection.status);
  }
  return connection;
}

function isFresh(connection: ConnectionRow, now: Date): boolean {
  return (
    connection.access_token_enc !== null &&
    connection.access_expires_at !== null &&
    connection.access_expires_at.getTime() - ACCESS_TOKEN_SKEW_MS > now.getTime()
  );
}

/** Whether the inline backoff holds this connection's refresh back (the poll cron skips the portal then). */
export function refreshBackoffActive(connection: { next_refresh_attempt_at: Date | null }, now: Date): boolean {
  return connection.next_refresh_attempt_at !== null && now.getTime() < connection.next_refresh_attempt_at.getTime();
}

function toAccessToken(deps: Deps, connection: ConnectionRow): AccessToken {
  if (connection.access_token_enc === null || connection.access_expires_at === null) throw new ConnectionInactiveError(connection.status);
  return {
    accessToken: decryptAccessToken(deps.env, connection.id, connection.access_token_enc),
    accountId: connection.account_id,
    connectionId: connection.id,
    portalId: connection.portal_id,
    tokenVersion: connection.token_version,
    expiresAt: connection.access_expires_at,
    hasFailureCount: connection.transient_failures > 0 || connection.next_refresh_attempt_at !== null,
  };
}

/** A usable access token for the account's connection, refreshing it when needed (see the header). */
export async function getAccessToken(deps: Deps, accountId: string, options: GetAccessTokenOptions = {}): Promise<AccessToken> {
  const connection = requireActive(await loadConnection(deps.db, accountId));
  const now = deps.clock.now();
  const forced = options.forceRefreshFromVersion;
  if (isFresh(connection, now) && (forced === undefined || connection.token_version > forced)) return toAccessToken(deps, connection);
  if (options.inline === true && refreshBackoffActive(connection, now)) throw new TransientError('hubspot_refresh_backoff');

  const leaseId = randomUUID();
  const leased = await deps.db.maybeOne(
    `update hubspot_connections set refresh_lease_id = $2, refresh_lease_until = $3
      where id = $1 and status = 'active' and token_version = $4 and (refresh_lease_until is null or refresh_lease_until <= $5)
      returning id`,
    [connection.id, leaseId, new Date(now.getTime() + REFRESH_LEASE_MS), connection.token_version, now],
  );
  if (leased === null) return waitForRefresh(deps, connection, options);
  return refreshAsWinner(deps, connection, leaseId, options);
}

/** The lease loser: re-reads the row every 250 ms for up to 10 s, until the winner stores a new token. */
async function waitForRefresh(deps: Deps, seen: ConnectionRow, options: GetAccessTokenOptions): Promise<AccessToken> {
  const sleep = options.sleep ?? realSleep;
  for (let waited = 0; waited < REFRESH_POLL_MAX_MS; waited += REFRESH_POLL_INTERVAL_MS) {
    await sleep(REFRESH_POLL_INTERVAL_MS);
    const row = requireActive(await loadConnection(deps.db, seen.account_id));
    const now = deps.clock.now();
    if (row.token_version !== seen.token_version && isFresh(row, now)) return toAccessToken(deps, row);
    const leaseFree = row.refresh_lease_until === null || row.refresh_lease_until.getTime() <= now.getTime();
    // The winner gave the lease up without a new token: its refresh failed (transient or config).
    if (leaseFree && row.token_version === seen.token_version) throw new TransientError('hubspot_refresh_failed_elsewhere');
  }
  throw new TransientError('hubspot_refresh_lease_wait_timeout');
}

function refreshSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

async function refreshAsWinner(deps: Deps, connection: ConnectionRow, leaseId: string, options: GetAccessTokenOptions): Promise<AccessToken> {
  let refreshToken: string;
  try {
    refreshToken = decryptRefreshToken(deps.env, connection.id, connection.refresh_token_enc ?? '');
  } catch (error) {
    await releaseLease(deps.db, connection.id, leaseId);
    throw error;
  }
  let tokens: TokenSet;
  try {
    // One HTTP call, no transaction open (D-28).
    tokens = await deps.hubspot.refresh(refreshToken, { signal: refreshSignal(options.signal) });
  } catch (error) {
    throw await onRefreshFailure(deps, connection, leaseId, options, error);
  }

  const now = deps.clock.now();
  const encrypted = encryptTokens(deps.env, connection.id, tokens);
  const expiresAt = new Date(now.getTime() + tokens.expiresInSeconds * 1000);
  const stored = await deps.db.maybeOne<{ token_version: number }>(
    `update hubspot_connections
        set access_token_enc = $3, refresh_token_enc = $4, access_expires_at = $5, token_version = token_version + 1,
            last_refresh_at = $6, transient_failures = 0, next_refresh_attempt_at = null,
            status_reason = case when status_reason = $8 then null else status_reason end,
            refresh_lease_id = case when refresh_lease_id = $7 then null else refresh_lease_id end,
            refresh_lease_until = case when refresh_lease_id = $7 then null else refresh_lease_until end
      where id = $1 and status = 'active' and token_version = $2
      returning token_version`,
    [connection.id, connection.token_version, encrypted.accessTokenEnc, encrypted.refreshTokenEnc, expiresAt, now, leaseId, OAUTH_CONFIG_REASON],
  );
  if (stored !== null) {
    log.info('hubspot token refreshed', { event: 'hubspot.token_refreshed', accountId: connection.account_id, connectionId: connection.id });
    return {
      accessToken: tokens.accessToken,
      accountId: connection.account_id,
      connectionId: connection.id,
      portalId: connection.portal_id,
      tokenVersion: stored.token_version,
      expiresAt,
      hasFailureCount: false,
    };
  }

  // The version moved (a reconnect stored new tokens) or the connection is no longer active: keep
  // what is stored. Our access token is still valid, so use it unless the connection is gone.
  await releaseLease(deps.db, connection.id, leaseId);
  const current = requireActive(await loadConnection(deps.db, connection.account_id));
  log.info('hubspot token refresh superseded', { event: 'hubspot.token_refresh_superseded', accountId: connection.account_id });
  return {
    accessToken: tokens.accessToken,
    accountId: current.account_id,
    connectionId: current.id,
    portalId: current.portal_id,
    tokenVersion: current.token_version,
    expiresAt,
    hasFailureCount: current.transient_failures > 0 || current.next_refresh_attempt_at !== null,
  };
}

/** Handles a failed refresh and returns the error to throw. */
async function onRefreshFailure(deps: Deps, connection: ConnectionRow, leaseId: string, options: GetAccessTokenOptions, error: unknown): Promise<AppError> {
  const ids = { accountId: connection.account_id, connectionId: connection.id };
  if (isRevoked(error)) {
    // The revoke's compare-and-set also wipes the lease.
    const outcome = await revokeConnection(deps, { ...ids, tokenVersion: connection.token_version, reason: 'refresh_revoked' });
    if (outcome !== 'superseded') return error;
    // A reconnect stored fresh tokens meanwhile: the caller retries with those.
    await releaseLease(deps.db, connection.id, leaseId);
    return new TransientError('hubspot_refresh_superseded');
  }

  await releaseLease(deps.db, connection.id, leaseId);
  if (isConfigError(error)) {
    const firstOfEpisode = await deps.db.maybeOne(
      `update hubspot_connections set status_reason = $2
        where id = $1 and status = 'active' and status_reason is distinct from $2 returning id`,
      [connection.id, OAUTH_CONFIG_REASON],
    );
    if (firstOfEpisode !== null) raiseAlert('hubspot_oauth_config', { ...ids, errorCode: error.code });
    return error;
  }

  const transient = error instanceof TransientError ? error : new TransientError('hubspot_refresh_failed', { httpStatus: error instanceof AppError ? error.httpStatus : undefined });
  log.warn('hubspot token refresh failed', { event: 'hubspot.token_refresh_transient', ...ids, code: errorCode(error), httpStatus: transient.httpStatus });
  if (options.inline === true) await countInlineFailure(deps, connection);
  return transient;
}

async function releaseLease(db: Db, connectionId: string, leaseId: string): Promise<void> {
  await db.query(
    `update hubspot_connections set refresh_lease_id = null, refresh_lease_until = null where id = $1 and refresh_lease_id = $2`,
    [connectionId, leaseId],
  );
}

/** D-11's inline backoff: count the failure, push the next attempt out, alert on the fifth. */
async function countInlineFailure(deps: Deps, connection: ConnectionRow): Promise<void> {
  const now = deps.clock.now();
  const failures = await deps.db.tx(async (tx) => {
    const row = await tx.maybeOne<{ transient_failures: number }>(
      `update hubspot_connections set transient_failures = transient_failures + 1 where id = $1 and status = 'active' returning transient_failures`,
      [connection.id],
    );
    if (row === null) return null;
    await tx.query(`update hubspot_connections set next_refresh_attempt_at = $2 where id = $1`, [
      connection.id,
      new Date(now.getTime() + inlineBackoffMs(row.transient_failures)),
    ]);
    return row.transient_failures;
  });
  if (failures === INLINE_FAILURE_ALERT_AT) {
    raiseAlert('hubspot_refresh_failing', { accountId: connection.account_id, connectionId: connection.id, count: failures });
  }
}

/** After a successful API call: resets the inline failure counters (D-11 "any success"). */
export async function resetRefreshFailures(db: Db, connectionId: string): Promise<void> {
  await db.query(
    `update hubspot_connections set transient_failures = 0, next_refresh_attempt_at = null
      where id = $1 and (transient_failures > 0 or next_refresh_attempt_at is not null)`,
    [connectionId],
  );
}
