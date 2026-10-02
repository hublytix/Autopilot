import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLease } from '@/server/services/leases';
import { DAILY_CRON_LEASE } from '@/server/services/daily';
import { useTestDb as setUpTestDb } from '../../../test/db/harness';
import { interceptBefore } from '../../../test/db/intercept';
import { contentOf, createRetentionRig, seedInstalledAccount, seedLeadContent, type RetentionRig } from '../../../test/retention/support';
import { CRON_DAILY_PATH, handleCronDaily } from './cron-daily';

// GET|POST /api/cron/daily (PLAN §7.3, §8.1 `17 3 * * *` UTC, D-16): cron auth, the daily lease, the
// DB-local retention steps, the billing-tombstone reconcile and one account_daily job per account;
// a JSON summary of counts only.

const getDb = setUpTestDb();
let rig: RetentionRig;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createRetentionRig(getDb(), { start: new Date('2026-10-07T03:17:00.000Z') });
});

afterEach(() => {
  rig.stop();
  vi.useRealTimers();
});

function cronGet(secret: string | null = rig.deps.env.CRON_SECRET): Request {
  const headers: Record<string, string> = secret === null ? {} : { Authorization: `Bearer ${secret}` };
  return new Request(`${rig.deps.env.APP_URL}${CRON_DAILY_PATH}`, { method: 'GET', headers });
}

async function qstashSchedulePost(): Promise<Request> {
  const url = `${rig.deps.env.APP_URL}${CRON_DAILY_PATH}`;
  const body = '';
  const iat = Math.floor(rig.clock.now().getTime() / 1000);
  const token = await new SignJWT({ body: createHash('sha256').update(body).digest('base64url') })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('Upstash')
    .setSubject(url)
    .setIssuedAt(iat)
    .setNotBefore(0)
    .setExpirationTime(iat + 300)
    .sign(new TextEncoder().encode(rig.deps.env.QSTASH_CURRENT_SIGNING_KEY));
  return new Request(url, { method: 'POST', headers: { 'Upstash-Signature': token }, body });
}

describe('GET|POST /api/cron/daily', () => {
  it('refuses requests without the cron secret or a QStash signature', async () => {
    for (const request of [
      cronGet(null),
      cronGet('not-the-cron-secret-000000000000000000'),
      new Request(`${rig.deps.env.APP_URL}${CRON_DAILY_PATH}`, { method: 'POST', body: '' }),
    ]) {
      expect((await handleCronDaily(request, rig.deps)).status).toBe(401);
    }
    expect(await getDb().query(`select id from scheduled_jobs`)).toEqual([]);
  });

  it('purges due content, schedules each account’s job once, and answers counts only', async () => {
    const db = getDb();
    const { accountId } = await seedInstalledAccount(rig);
    const lead = await seedLeadContent(db, { accountId, submittedAt: new Date('2026-09-06T00:00:00.000Z') });

    const response = await handleCronDaily(cronGet(), rig.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      status: 'ran',
      errors: 0,
      retention: { leadMessagesDeleted: 1, draftsPurged: 2 },
      tombstones: { checked: 0, stopped: false },
      jobs: { accounts: 1, created: 1, published: 1 },
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(accountId);
    expect(text).not.toContain('maya');
    expect((await contentOf(db, lead.leadId)).message).toBe(false);

    const again = (await (await handleCronDaily(cronGet(), rig.deps)).json()) as Record<string, unknown>;
    expect(again).toMatchObject({ jobs: { created: 0, existing: 1 } });
    expect(await db.query(`select name from leases`)).toEqual([]);

    // The FakeScheduler delivers the job; it runs the account's daily steps and ends done.
    rig.clock.advance({ seconds: 1 });
    await rig.fakes.scheduler.runDue();
    expect(await db.one(`select status from scheduled_jobs where kind = 'account_daily'`)).toEqual({ status: 'done' });
  });

  it('accepts a signed QStash schedule POST', async () => {
    // The signature's iat/exp are checked against the platform time, as for the other crons.
    vi.setSystemTime(rig.clock.now());
    const response = await handleCronDaily(await qstashSchedulePost(), rig.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'ran' });
  });

  it('runs every part even when an earlier one fails: retention throws, the jobs are still scheduled and the error counted', async () => {
    const db = getDb();
    await seedInstalledAccount(rig);
    const failing = interceptBefore(db, /delete from webhook_events where recorded_at/, async () => {
      throw new Error('simulated database failure');
    });
    const response = await handleCronDaily(cronGet(), { ...rig.deps, db: failing.db });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, status: 'ran', errors: 1, retention: null, jobs: { accounts: 1, created: 1, published: 1 }, tombstones: { checked: 0 } });
    expect(await db.query(`select kind, status from scheduled_jobs`)).toEqual([{ kind: 'account_daily', status: 'scheduled' }]);
  });

  it('a non-config failure in the tombstone reconcile is counted per row, and the jobs are scheduled before it', async () => {
    const db = getDb();
    await seedInstalledAccount(rig);
    await db.query(`insert into billing_tombstones (provider_subscription_id, last_status, purged_at) values ('sub_Gone0000000001', 'pending', $1)`, [rig.clock.now()]);
    rig.fakes.billing.injectFailure('fetchSubscription', 'transient', 1);
    const body = (await (await handleCronDaily(cronGet(), rig.deps)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: 'ran', errors: 0, jobs: { created: 1 }, tombstones: { checked: 1, failed: 1, stopped: false } });
  });

  it('does nothing while another run holds the daily lease', async () => {
    await seedInstalledAccount(rig);
    await acquireLease(getDb(), { name: DAILY_CRON_LEASE, ttlMs: 60_000, now: rig.clock.now() });
    const body = (await (await handleCronDaily(cronGet(), rig.deps)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: 'busy', jobs: null });
    expect(await getDb().query(`select id from scheduled_jobs`)).toEqual([]);
  });
});
