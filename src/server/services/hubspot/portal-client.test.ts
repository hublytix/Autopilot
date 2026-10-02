import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeHubSpot } from '@/server/adapters/fake/hubspot';
import { RevokedError, TransientError } from '@/server/domain/errors';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, seedAccount, seedSettings, type JobTestRig } from '@/server/jobs/testing';
import { classifyRefreshFailure } from '@/server/hubspot/refresh-classifier';
import type { Deps } from '@/server/ports';
import { seedInstalledConnection, seedOwner } from '@/server/services/accounts/testing';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { forAccount } from './portal-client';
import { PORTAL_RATE_LIMITS, portalLimiterKey } from './portal-limiter';
import { getAccessToken, type Sleep } from './token-manager';

const getDb = setUpTestDb();

let rig: JobTestRig;
let hubspot: FakeHubSpot;
let deps: Deps;
let accountId: string;
let connectionId: string;
let sleeps: number[];

const sleep: Sleep = async (ms) => {
  sleeps.push(ms);
  rig.clock.advance(ms);
};

beforeEach(async () => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  hubspot = new FakeHubSpot({ clock: rig.clock, appUrl: rig.deps.env.APP_URL, classifyRefreshFailure });
  deps = { ...rig.deps, hubspot };
  sleeps = [];
  const now = rig.clock.now();
  accountId = await seedAccount(getDb(), { now });
  await seedSettings(getDb(), { accountId, now });
  await seedOwner(getDb(), accountId);
  ({ connectionId } = await seedInstalledConnection(deps, hubspot, { accountId, now }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function tokenVersion(): Promise<number> {
  return (await getDb().one<{ token_version: number }>(`select token_version from hubspot_connections where id = $1`, [connectionId])).token_version;
}

/** The stored token looks fresh to us, but HubSpot has expired it: the next call gets a 401. */
async function staleButStoredAsFresh(): Promise<void> {
  rig.clock.advance({ minutes: 31 });
  await getDb().query(`update hubspot_connections set access_expires_at = $2 where id = $1`, [connectionId, new Date(rig.clock.now().getTime() + 20 * 60_000)]);
}

describe('forAccount', () => {
  it('calls HubSpot with the account token, without the caller ever handling it', async () => {
    const client = forAccount(deps, accountId, { sleep });
    expect(await client.accountDetails()).toMatchObject({ portalId: '1234567', timeZone: 'America/New_York' });
    const forms = await client.listForms();
    expect(forms.map((form) => form.name)).toContain('Contact us');
  });

  it('401 rule: one forced refresh, then one retry that succeeds', async () => {
    await staleButStoredAsFresh();
    const refresh = vi.spyOn(hubspot, 'refresh');
    const details = await forAccount(deps, accountId, { sleep }).accountDetails();
    expect(details.portalId).toBe('1234567');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await tokenVersion()).toBe(2);
  });

  it('401 rule: uses a token another caller refreshed meanwhile instead of refreshing again', async () => {
    const client = forAccount(deps, accountId, { sleep });
    await client.accountDetails();
    await staleButStoredAsFresh();
    // Another caller refreshes first (version 2).
    await getAccessToken(deps, accountId, { sleep, forceRefreshFromVersion: 1 });
    const refresh = vi.spyOn(hubspot, 'refresh');
    expect(await client.accountDetails()).toMatchObject({ portalId: '1234567' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('401 rule: a refresh classified revoked takes the revoked path (one reconnect email)', async () => {
    await staleButStoredAsFresh();
    hubspot.setRefreshMode('revoked');
    const error = await forAccount(deps, accountId, { sleep })
      .getContact('101', { properties: ['email'] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RevokedError);
    const row = await getDb().one<{ status: string }>(`select status from hubspot_connections where id = $1`, [connectionId]);
    expect(row.status).toBe('revoked');
    expect(rig.fakes.mailer.sent.filter((mail) => mail.kind === 'reconnect')).toHaveLength(1);
  });

  it('401 rule: any other refresh failure is transient', async () => {
    await staleButStoredAsFresh();
    hubspot.setRefreshMode({ kind: 'transient', times: 1, failure: 502 });
    await expect(forAccount(deps, accountId, { sleep }).accountDetails()).rejects.toBeInstanceOf(TransientError);
    hubspot.setRefreshMode('config');
    const error = await forAccount(deps, accountId, { sleep })
      .accountDetails()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect((error as TransientError).code).toBe('hubspot_unauthorized');
    expect((await getDb().one<{ status: string }>(`select status from hubspot_connections where id = $1`, [connectionId])).status).toBe('active');
  });

  it('401 rule: a second 401 after the refresh is transient, and only one refresh is made', async () => {
    hubspot.injectFailure('accountDetails', { kind: 'unauthorized', times: 2 });
    const refresh = vi.spyOn(hubspot, 'refresh');
    const error = await forAccount(deps, accountId, { sleep })
      .accountDetails()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect((error as TransientError).code).toBe('hubspot_unauthorized');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('passes other API errors through unchanged', async () => {
    hubspot.injectFailure('listForms', { kind: 'rate_limited', retryAfterSeconds: 2 });
    const error = await forAccount(deps, accountId, { sleep })
      .listForms()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ code: 'hubspot_rate_limited', retryAfterMs: 2000 });
  });

  it('a successful API call resets the inline failure counters', async () => {
    await getDb().query(`update hubspot_connections set transient_failures = 3, next_refresh_attempt_at = $2 where id = $1`, [
      connectionId,
      new Date(rig.clock.now().getTime() + 20 * 60_000),
    ]);
    await forAccount(deps, accountId, { sleep, inline: true }).accountDetails();
    const row = await getDb().one(`select transient_failures, next_refresh_attempt_at from hubspot_connections where id = $1`, [connectionId]);
    expect(row).toEqual({ transient_failures: 0, next_refresh_attempt_at: null });
  });
});

describe('the per-portal limiter (D-36)', () => {
  it('allows 9 general requests per second, then waits for the next window', async () => {
    const client = forAccount(deps, accountId, { sleep });
    rig.clock.set(new Date('2026-10-06T14:00:10.000Z'));
    for (let i = 0; i < PORTAL_RATE_LIMITS.general; i += 1) await client.accountDetails();
    expect(sleeps).toEqual([]);
    await client.accountDetails();
    expect(sleeps).toEqual([1000]);
    expect(rig.clock.now()).toEqual(new Date('2026-10-06T14:00:11.000Z'));
  });

  it('allows 4 search requests per second, counted apart from general requests', async () => {
    const client = forAccount(deps, accountId, { sleep });
    rig.clock.set(new Date('2026-10-06T14:00:20.250Z'));
    for (let i = 0; i < 4; i += 1) await client.searchEmailsCount({ direction: 'outbound', since: new Date('2026-09-01T00:00:00.000Z') });
    await client.accountDetails();
    expect(sleeps).toEqual([]);
    await client.searchEmailsCount({ direction: 'inbound', since: new Date('2026-09-01T00:00:00.000Z') });
    expect(sleeps).toEqual([750]);
  });

  it('keys the counters by an HMAC of portal and bucket, never the portal id itself', async () => {
    await forAccount(deps, accountId, { sleep }).accountDetails();
    const rows = await getDb().query<{ key_hash: string; count: number }>(`select key_hash, count from rate_limits`);
    expect(rows).toEqual([{ key_hash: portalLimiterKey(deps, '1234567', 'general'), count: 1 }]);
    expect(rows[0]?.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.key_hash).not.toContain('1234567');
  });

  it('takes one slot per batch of 100 email ids', async () => {
    const batchRead = vi.spyOn(hubspot, 'batchReadEmails');
    const ids = Array.from({ length: 250 }, (_, i) => String(900000 + i));
    await forAccount(deps, accountId, { sleep }).batchReadEmails(ids, ['hs_timestamp']);
    expect(batchRead.mock.calls.map((call) => call[1].length)).toEqual([100, 100, 50]);
    const rows = await getDb().query<{ count: number }>(`select count from rate_limits`);
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(3);
  });
});
