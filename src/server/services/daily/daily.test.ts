import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeHubSpot } from '@/server/adapters/fake/hubspot';
import { parseEnv } from '@/server/env';
import type { Deps } from '@/server/ports';
import { ciphertextKid, keyId } from '@/server/security/crypto';
import { seedInstalledConnection } from '@/server/services/accounts/testing';
import { getAccessToken } from '@/server/services/hubspot';
import { seedAccount, seedConnection } from '@/server/jobs/testing';
import portalFixture from '../../../../test/fixtures/hubspot-portal.json';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import {
  createRetentionRig,
  DAY,
  runDaily,
  seedInstalledAccount,
  seedSubscription,
  type RetentionRig,
} from '../../../../test/retention/support';
import { accountDailyOutcome } from './job';
import { probeConnection } from './introspect';
import { refreshAccountDetails } from './details';
import { reconcileAccountSubscriptions } from './reconcile';
import { reencryptConnectionTokens } from './reencrypt';
import { accountDailyDedupeKey, scheduleAccountDailyJobs } from './schedule';

// The account_daily job's steps (PLAN §9.1 step 4, D-10, D-12, D-19, D-51) and the cron's fan-out.
// The purge and orphan steps are covered by test/retention; the signal refresh by signals.test.ts.

const getDb = setUpTestDb();
let rig: RetentionRig;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createRetentionRig(getDb());
});

afterEach(() => {
  rig.stop();
  vi.useRealTimers();
});

describe('the introspection probe (D-10)', () => {
  it('keeps an active connection and refreshes its hub domain', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    await getDb().query(`update hubspot_connections set hub_domain = 'old.example' where account_id = $1`, [accountId]);
    expect(await probeConnection(rig.deps, accountId)).toBe('active');
    expect(await getDb().one(`select status, hub_domain from hubspot_connections where account_id = $1`, [accountId])).toEqual({
      status: 'active',
      hub_domain: rig.hubspot.portal.hubDomain,
    });
  });

  it('takes the revoked path for an inactive token even while the account is paused', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    await getDb().query(`update accounts set paused_at = $2, processing_state = 'paused' where id = $1`, [accountId, rig.clock.now()]);
    rig.hubspot.revokeToken();
    expect(await probeConnection(rig.deps, accountId)).toBe('revoked');
    expect(await getDb().one(`select c.status, c.status_reason, c.refresh_token_enc, a.processing_state, a.purge_after
                                from hubspot_connections c join accounts a on a.id = c.account_id where a.id = $1`, [accountId])).toEqual({
      status: 'revoked',
      status_reason: 'introspection_inactive',
      refresh_token_enc: null,
      processing_state: 'revoked',
      purge_after: new Date(rig.clock.now().getTime() + 30 * DAY),
    });
    expect(rig.fakes.mailer.sent.map((mail) => mail.kind)).toEqual(['reconnect']);
    expect(await probeConnection(rig.deps, accountId)).toBe('no_connection');
  });
});

describe('the account details refresh (D-12)', () => {
  it('follows HubSpot’s IANA zone and stores the UI domain', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    await getDb().query(`update accounts set timezone = 'UTC', timezone_source = 'hubspot' where id = $1`, [accountId]);
    expect(await refreshAccountDetails(rig.deps, accountId, { sleep: rig.sleep })).toBe('refreshed');
    expect(await getDb().one(`select timezone, timezone_source from accounts where id = $1`, [accountId])).toEqual({ timezone: 'America/New_York', timezone_source: 'hubspot' });
    expect(await getDb().one(`select ui_domain, data_hosting_location, account_type from hubspot_connections where account_id = $1`, [accountId])).toEqual({
      ui_domain: 'app.hubspot.com',
      data_hosting_location: 'na1',
      account_type: 'STANDARD',
    });
  });

  it('falls back to the fixed UTC offset for a zone name that is not IANA', async () => {
    const hubspot = new FakeHubSpot({
      clock: rig.clock,
      portal: { ...portalFixture, portal: { ...portalFixture.portal, timeZone: 'India Standard Time', utcOffsetMilliseconds: 19_800_000 } },
    });
    const deps: Deps = { ...rig.deps, hubspot };
    const accountId = await seedAccount(getDb(), { now: rig.clock.now() });
    await seedInstalledConnection(deps, hubspot, { accountId, now: rig.clock.now() });
    await refreshAccountDetails(deps, accountId, { sleep: rig.sleep });
    expect(await getDb().one(`select timezone, timezone_source from accounts where id = $1`, [accountId])).toEqual({ timezone: 'UTC+5:30', timezone_source: 'utc_offset' });
  });

  it('keeps the stored zone when the call fails, and never overrides the owner’s choice', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    await getDb().query(`update accounts set timezone = 'Europe/London', timezone_source = 'hubspot' where id = $1`, [accountId]);
    rig.hubspot.injectFailure('accountDetails', { kind: 'server_error' });
    await expect(refreshAccountDetails(rig.deps, accountId, { sleep: rig.sleep })).rejects.toMatchObject({ code: 'hubspot_server_error' });
    expect(await getDb().one(`select timezone from accounts where id = $1`, [accountId])).toEqual({ timezone: 'Europe/London' });

    await getDb().query(`update accounts set timezone_source = 'owner' where id = $1`, [accountId]);
    await refreshAccountDetails(rig.deps, accountId, { sleep: rig.sleep });
    expect(await getDb().one(`select timezone, timezone_source from accounts where id = $1`, [accountId])).toEqual({ timezone: 'Europe/London', timezone_source: 'owner' });
  });

  it('makes the daily job retry a transient failure and skips the signal refresh in that attempt', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    rig.hubspot.injectFailure('accountDetails', { kind: 'server_error' });
    const result = await runDaily(rig, accountId);
    expect(result.failures).toEqual([{ step: 'details', code: 'hubspot_server_error', retryable: true }]);
    expect(result.signals).toBeNull();
    expect(accountDailyOutcome(result)).toMatchObject({ type: 'transient', code: 'hubspot_server_error' });
    expect(accountDailyOutcome(await runDaily(rig, accountId))).toEqual({ type: 'done' });
  });
});

describe('the subscription reconcile (D-19)', () => {
  it('applies what Razorpay says now, so a webhook that never arrived is caught up', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    const subscriptionId = await seedSubscription(rig, accountId, 'active');
    await getDb().query(`update subscriptions set status = 'pending', last_synced_at = $2 where provider_subscription_id = $1`, [subscriptionId, rig.clock.now()]);
    rig.clock.advance({ minutes: 5 });
    expect(await reconcileAccountSubscriptions(rig.deps, accountId)).toEqual({ reconciled: 1 });
    expect(await getDb().one(`select status from subscriptions where provider_subscription_id = $1`, [subscriptionId])).toEqual({ status: 'active' });
  });

  it('leaves terminal subscriptions alone', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    await seedSubscription(rig, accountId, 'cancelled');
    rig.billing.injectFailure('fetchSubscription', 'permanent');
    expect(await reconcileAccountSubscriptions(rig.deps, accountId)).toEqual({ reconciled: 0 });
  });
});

describe('token re-encryption (D-51)', () => {
  it('re-encrypts tokens made with the previous key under the current one, keeping them usable', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    const previous = rig.deps.env.TOKEN_ENCRYPTION_KEY;
    const current = Buffer.from('another-fake-only-token-key-0000', 'utf8').toString('base64');
    const rotated: Deps = { ...rig.deps, env: parseEnv({ APP_MODE: 'fake', TOKEN_ENCRYPTION_KEY: current, TOKEN_ENCRYPTION_KEY_PREVIOUS: previous }) };
    const before = await getDb().one<{ access_token_enc: string; refresh_token_enc: string }>(`select access_token_enc, refresh_token_enc from hubspot_connections where account_id = $1`, [accountId]);

    expect(await reencryptConnectionTokens(rotated, accountId)).toBe('reencrypted');
    const after = await getDb().one<{ access_token_enc: string; refresh_token_enc: string }>(`select access_token_enc, refresh_token_enc from hubspot_connections where account_id = $1`, [accountId]);
    const currentKid = keyId(Buffer.from(current, 'base64'));
    expect([ciphertextKid(after.access_token_enc), ciphertextKid(after.refresh_token_enc)]).toEqual([currentKid, currentKid]);
    expect(after.access_token_enc).not.toBe(before.access_token_enc);
    expect((await getAccessToken(rotated, accountId)).accessToken.length).toBeGreaterThan(0);
    expect(await reencryptConnectionTokens(rotated, accountId)).toBe('current');
  });

  it('alerts and changes nothing when neither key opens a ciphertext', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    const stranger: Deps = {
      ...rig.deps,
      env: parseEnv({ APP_MODE: 'fake', TOKEN_ENCRYPTION_KEY: Buffer.from('a-third-fake-only-token-key-0000', 'utf8').toString('base64') }),
    };
    expect(await reencryptConnectionTokens(stranger, accountId)).toBe('unreadable');
    expect(rig.alerts.map((alert) => alert.code)).toEqual(['token_reencrypt_failed']);
  });

  it('does nothing for a connection without tokens', async () => {
    const accountId = await seedAccount(getDb(), { now: rig.clock.now() });
    await seedConnection(getDb(), { accountId, now: rig.clock.now(), status: 'revoked' });
    expect(await reencryptConnectionTokens(rig.deps, accountId)).toBe('no_tokens');
  });
});

describe('the daily fan-out (PLAN §8.2)', () => {
  it('schedules one account_daily job per account and local date, once', async () => {
    const db = getDb();
    // 03:17 UTC on Wed 2026-10-07: still Tuesday in New York, already Wednesday in Kolkata.
    rig.clock.set(new Date('2026-10-07T03:17:00.000Z'));
    const ny = await seedAccount(db, { now: rig.clock.now(), timezone: 'America/New_York' });
    const kolkata = await seedAccount(db, { now: rig.clock.now(), timezone: 'Asia/Kolkata' });

    expect(await scheduleAccountDailyJobs(rig.deps)).toEqual({ accounts: 2, created: 2, existing: 0, published: 2, publishFailed: 0 });
    expect(await scheduleAccountDailyJobs(rig.deps)).toMatchObject({ accounts: 2, created: 0, existing: 2 });
    const keys = (await db.query<{ dedupe_key: string }>(`select dedupe_key from scheduled_jobs where kind = 'account_daily' order by dedupe_key`)).map((row) => row.dedupe_key);
    expect(keys.sort()).toEqual([accountDailyDedupeKey(ny, '2026-10-06'), accountDailyDedupeKey(kolkata, '2026-10-07')].sort());

    rig.clock.advance({ days: 1 });
    expect(await scheduleAccountDailyJobs(rig.deps)).toMatchObject({ created: 2 });
  });

  it('runs the job through the dispatcher and ends it done', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    await scheduleAccountDailyJobs(rig.deps);
    rig.clock.advance({ seconds: 1 });
    await rig.fakes.scheduler.runDue();
    expect(await getDb().one(`select status from scheduled_jobs where kind = 'account_daily' and account_id = $1`, [accountId])).toEqual({ status: 'done' });
  });

  it('skips a job whose account is gone (purged since the fan-out)', async () => {
    const result = await runDaily(rig, '00000000-0000-4000-8000-000000000000');
    expect(result.status).toBe('not_found');
    expect(accountDailyOutcome(result)).toEqual({ type: 'skipped' });
  });
});
