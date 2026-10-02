import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_WIRE, FakeHubSpot, REFRESH_WIRE, type FakeWireResponse } from '@/server/adapters/fake/hubspot';
import { gatewayWire, migrationWire, NO_RESPONSE, refreshError } from '@/server/adapters/fake/hubspot/wire';
import { ConfigError, isRevoked, RevokedError, TransientError } from '@/server/domain/errors';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, seedAccount, seedSettings, type JobTestRig } from '@/server/jobs/testing';
import { classifyRefreshFailure } from '@/server/hubspot/refresh-classifier';
import type { Deps, TokenSet } from '@/server/ports';
import { hubspotTokenAad } from '@/server/security/crypto';
import { RECONNECT_HUBSPOT_SUBJECT } from '@/emails/ReconnectHubSpot';
import { PURGE_AFTER_MS } from '@/server/services/accounts/apply-processing-state';
import { seedInstalledConnection, seedOwner } from '@/server/services/accounts/testing';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import {
  ConnectionInactiveError,
  getAccessToken,
  inlineBackoffMs,
  INLINE_BACKOFF_MAX_MS,
  REFRESH_LEASE_MS,
  REFRESH_POLL_INTERVAL_MS,
  type Sleep,
} from './token-manager';
import { decryptAccessToken, decryptRefreshToken, encryptTokens, tokenCipher } from './tokens';

const getDb = setUpTestDb();
const MINUTE = 60_000;

let rig: JobTestRig;
let hubspot: FakeHubSpot;
let deps: Deps;
let alerts: RaisedAlert[];
let stopAlerts: () => void;
let accountId: string;
let connectionId: string;
let sleeps: number[];

/** Advances the fake clock instead of waiting. */
const sleep: Sleep = async (ms) => {
  sleeps.push(ms);
  rig.clock.advance(ms);
};

beforeEach(async () => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  // The real D-11 classifier decides how the fake's HubSpot-shaped refresh failures are thrown.
  hubspot = new FakeHubSpot({ clock: rig.clock, appUrl: rig.deps.env.APP_URL, classifyRefreshFailure });
  deps = { ...rig.deps, hubspot };
  alerts = [];
  sleeps = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
  const now = rig.clock.now();
  accountId = await seedAccount(getDb(), { now });
  await seedSettings(getDb(), { accountId, now });
  await seedOwner(getDb(), accountId);
  ({ connectionId } = await seedInstalledConnection(deps, hubspot, { accountId, now }));
});

afterEach(() => {
  stopAlerts();
  vi.restoreAllMocks();
});

interface ConnectionState {
  status: string;
  token_version: number;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  access_expires_at: Date | null;
  refresh_lease_id: string | null;
  refresh_lease_until: Date | null;
  transient_failures: number;
  next_refresh_attempt_at: Date | null;
  status_reason: string | null;
  status_changed_at: Date;
  last_refresh_at: Date | null;
}

async function connection(): Promise<ConnectionState> {
  return getDb().one<ConnectionState>(
    `select status, token_version, access_token_enc, refresh_token_enc, access_expires_at, refresh_lease_id, refresh_lease_until,
            transient_failures, next_refresh_attempt_at, status_reason, status_changed_at, last_refresh_at
       from hubspot_connections where id = $1`,
    [connectionId],
  );
}

/** Moves past the 5-minute skew, so the next call must refresh. */
function expireAccessToken(): void {
  rig.clock.advance({ minutes: 26 });
}

function refreshFailingWith(cls: ReturnType<typeof classifyRefreshFailure>, wire: FakeWireResponse): void {
  vi.spyOn(hubspot, 'refresh').mockImplementation(async () => {
    throw refreshError(cls, wire);
  });
}

describe('getAccessToken: the stored token', () => {
  it('uses the stored token while it has more than 5 minutes left, without a refresh', async () => {
    const refresh = vi.spyOn(hubspot, 'refresh');
    rig.clock.advance({ minutes: 24, seconds: 59 });
    const token = await getAccessToken(deps, accountId, { sleep });
    expect(refresh).not.toHaveBeenCalled();
    expect(token).toMatchObject({ accountId, connectionId, portalId: '1234567', tokenVersion: 1 });
    expect(await hubspot.accountDetails(token.accessToken)).toMatchObject({ portalId: '1234567' });
  });

  it('refuses a connection that is not active', async () => {
    await getDb().query(`update hubspot_connections set status = 'disconnected', access_token_enc = null, refresh_token_enc = null where id = $1`, [connectionId]);
    const error = await getAccessToken(deps, accountId, { sleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionInactiveError);
    expect(isRevoked(error)).toBe(true);
    expect((error as ConnectionInactiveError).status).toBe('disconnected');
  });
});

describe('getAccessToken: a refresh', () => {
  it('refreshes once inside the 5-minute window, bumps token_version and stores encrypted tokens bound to the row and column', async () => {
    const refresh = vi.spyOn(hubspot, 'refresh');
    rig.clock.advance({ minutes: 25, seconds: 1 });
    const token = await getAccessToken(deps, accountId, { sleep });

    expect(refresh).toHaveBeenCalledTimes(1);
    const signal = refresh.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    const row = await connection();
    expect(row).toMatchObject({ status: 'active', token_version: 2, refresh_lease_id: null, refresh_lease_until: null, transient_failures: 0 });
    expect(row.last_refresh_at).toEqual(rig.clock.now());
    expect(row.access_expires_at).toEqual(new Date(rig.clock.now().getTime() + 1800 * 1000));
    expect(token.tokenVersion).toBe(2);
    expect(decryptAccessToken(deps.env, connectionId, row.access_token_enc ?? '')).toBe(token.accessToken);
    expect(row.access_token_enc).not.toContain(token.accessToken);
    // The AAD binds each ciphertext to its column: the access token does not decrypt as a refresh token.
    expect(() => tokenCipher(deps.env).decrypt(row.access_token_enc ?? '', hubspotTokenAad(connectionId, 'refresh_token'))).toThrow();
    expect(decryptRefreshToken(deps.env, connectionId, row.refresh_token_enc ?? '')).toMatch(/^na1-fake-refresh-/);
  });

  it('always stores the newest refresh token (a rotated one replaces the old)', async () => {
    const original = hubspot.refresh.bind(hubspot);
    vi.spyOn(hubspot, 'refresh').mockImplementation(async (refreshToken, options): Promise<TokenSet> => {
      const tokens = await original(refreshToken, options);
      return { ...tokens, refreshToken: `${tokens.refreshToken}-rotated` };
    });
    expireAccessToken();
    await getAccessToken(deps, accountId, { sleep });
    const row = await connection();
    expect(decryptRefreshToken(deps.env, connectionId, row.refresh_token_enc ?? '')).toMatch(/-rotated$/);
  });

  it('version compare-and-set: a refresh that lost the race keeps the stored tokens and still returns a usable token', async () => {
    const original = hubspot.refresh.bind(hubspot);
    vi.spyOn(hubspot, 'refresh').mockImplementation(async (refreshToken, options) => {
      // Meanwhile a reconnect stores fresh tokens (version 2).
      await getDb().query(`update hubspot_connections set token_version = token_version + 1, access_expires_at = $2 where id = $1`, [
        connectionId,
        new Date(rig.clock.now().getTime() + 30 * MINUTE),
      ]);
      return original(refreshToken, options);
    });
    expireAccessToken();
    const before = await connection();
    const token = await getAccessToken(deps, accountId, { sleep });
    const after = await connection();
    expect(after.token_version).toBe(2);
    expect(after.access_token_enc).toBe(before.access_token_enc);
    expect(after.refresh_lease_id).toBeNull();
    expect(token.tokenVersion).toBe(2);
    expect(await hubspot.accountDetails(token.accessToken)).toMatchObject({ portalId: '1234567' });
  });
});

describe('getAccessToken: the refresh lease', () => {
  async function holdLease(): Promise<void> {
    await getDb().query(`update hubspot_connections set refresh_lease_id = 'other', refresh_lease_until = $2 where id = $1`, [
      connectionId,
      new Date(rig.clock.now().getTime() + REFRESH_LEASE_MS),
    ]);
  }

  it('the winner takes a 20-second lease before calling HubSpot', async () => {
    expireAccessToken();
    let leaseDuringCall: Date | null = null;
    const original = hubspot.refresh.bind(hubspot);
    vi.spyOn(hubspot, 'refresh').mockImplementation(async (token, options) => {
      leaseDuringCall = (await connection()).refresh_lease_until;
      return original(token, options);
    });
    await getAccessToken(deps, accountId, { sleep });
    expect(leaseDuringCall).toEqual(new Date(rig.clock.now().getTime() + REFRESH_LEASE_MS));
  });

  it('a lease loser polls every 250 ms and returns the token the winner stored, without calling HubSpot', async () => {
    expireAccessToken();
    await holdLease();
    const refresh = vi.spyOn(hubspot, 'refresh');
    const winnerTokens = hubspot.installTokens();
    const loserSleep: Sleep = async (ms) => {
      await sleep(ms);
      if (sleeps.length === 3) {
        // The winner finishes: new version, fresh token, lease released.
        const enc = encryptTokens(deps.env, connectionId, winnerTokens);
        await getDb().query(
          `update hubspot_connections set access_token_enc = $2, refresh_token_enc = $3, access_expires_at = $4, token_version = 2,
                  refresh_lease_id = null, refresh_lease_until = null where id = $1`,
          [connectionId, enc.accessTokenEnc, enc.refreshTokenEnc, new Date(rig.clock.now().getTime() + 30 * MINUTE)],
        );
      }
    };
    const token = await getAccessToken(deps, accountId, { sleep: loserSleep });
    expect(refresh).not.toHaveBeenCalled();
    expect(sleeps).toEqual([REFRESH_POLL_INTERVAL_MS, REFRESH_POLL_INTERVAL_MS, REFRESH_POLL_INTERVAL_MS]);
    expect(token).toMatchObject({ tokenVersion: 2, accessToken: winnerTokens.accessToken });
  });

  it('a lease loser gives up with a TransientError after 10 s', async () => {
    expireAccessToken();
    await holdLease();
    const refresh = vi.spyOn(hubspot, 'refresh');
    const error = await getAccessToken(deps, accountId, { sleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect((error as TransientError).code).toBe('hubspot_refresh_lease_wait_timeout');
    expect(sleeps).toHaveLength(40);
    expect(sleeps.every((ms) => ms === REFRESH_POLL_INTERVAL_MS)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a lease loser stops waiting when the winner released the lease without a new token', async () => {
    expireAccessToken();
    await holdLease();
    const loserSleep: Sleep = async (ms) => {
      await sleep(ms);
      await getDb().query(`update hubspot_connections set refresh_lease_id = null, refresh_lease_until = null where id = $1`, [connectionId]);
    };
    const error = await getAccessToken(deps, accountId, { sleep: loserSleep }).catch((e: unknown) => e);
    expect((error as TransientError).code).toBe('hubspot_refresh_failed_elsewhere');
  });

  it('an expired lease can be taken over', async () => {
    expireAccessToken();
    await getDb().query(`update hubspot_connections set refresh_lease_id = 'crashed', refresh_lease_until = $2 where id = $1`, [connectionId, rig.clock.now()]);
    const token = await getAccessToken(deps, accountId, { sleep });
    expect(token.tokenVersion).toBe(2);
  });
});

describe('getAccessToken: refresh failures with exact HubSpot fixtures (D-11)', () => {
  const revokedCases: readonly [string, FakeWireResponse][] = [
    ['invalid_grant / BAD_REFRESH_TOKEN', REFRESH_WIRE.badRefreshToken],
    ['BAD_HUB / access_denied', REFRESH_WIRE.badHub],
  ];

  it.each(revokedCases)('%s → the revoked path, with exactly one reconnect email', async (_name, wire) => {
    expect(classifyRefreshFailure(wire.status, wire.body)).toBe('revoked');
    const db = getDb();
    const now = rig.clock.now();
    const job = await insertJob(db, { kind: 'portal_poll', accountId, dedupeKey: `poll:${accountId}:1:a`, runAt: now, now });
    await publishJobs(deps, [job]);
    refreshFailingWith('revoked', wire);
    expireAccessToken();

    const error = await getAccessToken(deps, accountId, { sleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RevokedError);
    expect((error as RevokedError).code).toBe('hubspot_refresh_revoked');

    const row = await connection();
    expect(row).toMatchObject({ status: 'revoked', status_reason: 'refresh_revoked', access_token_enc: null, refresh_token_enc: null, refresh_lease_id: null });
    expect(row.status_changed_at).toEqual(rig.clock.now());
    const account = await db.one<{ processing_state: string; purge_after: Date }>(`select processing_state, purge_after from accounts where id = $1`, [accountId]);
    expect(account).toEqual({ processing_state: 'revoked', purge_after: new Date(rig.clock.now().getTime() + PURGE_AFTER_MS) });
    expect((await db.one<{ status: string }>(`select status from scheduled_jobs where id = $1`, [job?.id])).status).toBe('cancelled');

    const reconnect = rig.fakes.mailer.sent.filter((mail) => mail.kind === 'reconnect');
    expect(reconnect).toHaveLength(1);
    expect(reconnect[0]).toMatchObject({ subject: RECONNECT_HUBSPOT_SUBJECT, to: ['owner@brightside-plumbing.example'] });
    expect(reconnect[0]?.idempotencyKey).toBe(`${deps.env.ENV_NAMESPACE}:reconnect:${connectionId}:${row.status_changed_at.toISOString()}`);
    expect(reconnect[0]?.text).toContain('stopped checking for new leads');
    expect(reconnect[0]?.text).toContain(`${deps.env.APP_URL}/api/hubspot/install`);
    expect(reconnect[0]?.text).toMatch(/delete your .* data for this HubSpot account on November 5, 2026/);
    const sentRow = await db.one<{ reconnect_email_sent_at: Date | null }>(`select reconnect_email_sent_at from hubspot_connections where id = $1`, [connectionId]);
    expect(sentRow.reconnect_email_sent_at).toEqual(rig.clock.now());

    // Later callers find the connection inactive; nothing is sent again.
    const again = await getAccessToken(deps, accountId, { sleep }).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ConnectionInactiveError);
    expect(rig.fakes.mailer.sent.filter((mail) => mail.kind === 'reconnect')).toHaveLength(1);
  });

  it('the fake portal in revoked mode takes the same path through the real classifier', async () => {
    hubspot.setRefreshMode('revoked');
    expireAccessToken();
    await expect(getAccessToken(deps, accountId, { sleep })).rejects.toBeInstanceOf(RevokedError);
    expect((await connection()).status).toBe('revoked');
  });

  it('invalid_client → config: one alert per episode, the connection stays active, the lease is released', async () => {
    const wire = REFRESH_WIRE.invalidClient;
    expect(classifyRefreshFailure(wire.status, wire.body)).toBe('config');
    hubspot.setRefreshMode('config');
    expireAccessToken();

    for (let i = 0; i < 3; i += 1) {
      const error = await getAccessToken(deps, accountId, { sleep, inline: true }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe('hubspot_oauth_config');
    }
    expect(alerts.filter((alert) => alert.code === 'hubspot_oauth_config')).toHaveLength(1);
    const row = await connection();
    expect(row).toMatchObject({ status: 'active', status_reason: 'oauth_config', refresh_lease_id: null, token_version: 1, transient_failures: 0 });
    expect(rig.fakes.mailer.sent).toHaveLength(0);

    // Fixed: a refresh succeeds and ends the episode.
    hubspot.setRefreshMode('ok');
    await getAccessToken(deps, accountId, { sleep });
    expect((await connection()).status_reason).toBeNull();
  });

  const transientCases: readonly [string, FakeWireResponse, string][] = [
    ['429 TEN_SECONDLY_ROLLING', API_WIRE.tenSecondly, 'hubspot_rate_limited'],
    ['429 DAILY', API_WIRE.daily, 'hubspot_daily_limit'],
    ['477 + Retry-After', migrationWire(7200), 'hubspot_migration_in_progress'],
    ['502', gatewayWire(502), 'hubspot_server_error'],
    ['timeout', NO_RESPONSE, 'hubspot_timeout'],
  ];

  it.each(transientCases)('%s → transient: the lease is released, the connection stays active, jobs count nothing', async (_name, wire, code) => {
    expect(classifyRefreshFailure(wire.status, wire.body)).toBe('transient');
    refreshFailingWith('transient', wire);
    expireAccessToken();
    const error = await getAccessToken(deps, accountId, { sleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect((error as TransientError).code).toBe(code);
    if (wire.status === 477) expect((error as TransientError).retryAfterMs).toBe(7_200_000);
    expect(await connection()).toMatchObject({ status: 'active', refresh_lease_id: null, refresh_lease_until: null, transient_failures: 0, next_refresh_attempt_at: null, token_version: 1 });
    expect(rig.fakes.mailer.sent).toHaveLength(0);
  });
});

describe('getAccessToken: the inline backoff (D-11)', () => {
  it('backs off 5, 10, 20, 30, 30… minutes, never above 30, and alerts once at the fifth failure', async () => {
    hubspot.setRefreshMode({ kind: 'transient', times: 20, failure: 502 });
    expireAccessToken();
    const delays: number[] = [];
    for (let n = 1; n <= 8; n += 1) {
      const startedAt = rig.clock.now();
      await expect(getAccessToken(deps, accountId, { sleep, inline: true })).rejects.toBeInstanceOf(TransientError);
      const row = await connection();
      expect(row.transient_failures).toBe(n);
      const delay = (row.next_refresh_attempt_at?.getTime() ?? 0) - startedAt.getTime();
      delays.push(delay);
      expect(delay).toBeLessThanOrEqual(INLINE_BACKOFF_MAX_MS);
      rig.clock.set(row.next_refresh_attempt_at ?? startedAt);
    }
    expect(delays.map((ms) => ms / MINUTE)).toEqual([5, 10, 20, 30, 30, 30, 30, 30]);
    expect(alerts.filter((alert) => alert.code === 'hubspot_refresh_failing')).toHaveLength(1);
  });

  it('an inline caller inside the backoff does not call HubSpot; the first success resets both fields', async () => {
    hubspot.setRefreshMode({ kind: 'transient', times: 1, failure: 'timeout' });
    expireAccessToken();
    await expect(getAccessToken(deps, accountId, { sleep, inline: true })).rejects.toBeInstanceOf(TransientError);
    const refresh = vi.spyOn(hubspot, 'refresh');

    rig.clock.advance({ minutes: 4 });
    const held = await getAccessToken(deps, accountId, { sleep, inline: true }).catch((e: unknown) => e);
    expect((held as TransientError).code).toBe('hubspot_refresh_backoff');
    expect(refresh).not.toHaveBeenCalled();

    rig.clock.advance({ minutes: 1 });
    await getAccessToken(deps, accountId, { sleep, inline: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await connection()).toMatchObject({ transient_failures: 0, next_refresh_attempt_at: null });
  });

  it('a job (not inline) ignores the inline backoff and resets it on success', async () => {
    hubspot.setRefreshMode({ kind: 'transient', times: 1, failure: 503 });
    expireAccessToken();
    await expect(getAccessToken(deps, accountId, { sleep, inline: true })).rejects.toBeInstanceOf(TransientError);
    await getAccessToken(deps, accountId, { sleep });
    expect(await connection()).toMatchObject({ transient_failures: 0, next_refresh_attempt_at: null, token_version: 2 });
  });

  it('ten failed job deliveries during a blip do not delay the next cron poll', async () => {
    hubspot.setRefreshMode({ kind: 'transient', times: 10, failure: 502 });
    expireAccessToken();
    for (let delivery = 0; delivery < 10; delivery += 1) {
      await expect(getAccessToken(deps, accountId, { sleep })).rejects.toBeInstanceOf(TransientError);
      rig.clock.advance({ seconds: 10 * 2 ** Math.min(delivery, 3) });
    }
    expect(await connection()).toMatchObject({ transient_failures: 0, next_refresh_attempt_at: null });
    const token = await getAccessToken(deps, accountId, { sleep, inline: true });
    expect(token.tokenVersion).toBe(2);
    expect(alerts.filter((alert) => alert.code === 'hubspot_refresh_failing')).toHaveLength(0);
  });

  it('inlineBackoffMs follows min(2^(n−1) × 5 min, 30 min)', () => {
    expect([1, 2, 3, 4, 5, 10, 1000].map((n) => inlineBackoffMs(n) / MINUTE)).toEqual([5, 10, 20, 30, 30, 30, 30]);
  });
});
