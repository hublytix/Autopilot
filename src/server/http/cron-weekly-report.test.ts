import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountProcessingState } from '@/server/domain/types';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, seedAccount, seedConnection, seedSettings, type JobTestRig } from '@/server/jobs/testing';
import type { Deps } from '@/server/ports';
import { REPORT_INTAKE_GRACE_MS, reportRunAt, reportStaggerMs } from '@/server/services/reports/schedule';
import { useTestDb as setUpTestDb } from '../../../test/db/harness';
import { interceptBefore } from '../../../test/db/intercept';
import { CRON_WEEKLY_REPORT_PATH, handleCronWeeklyReport } from './cron-weekly-report';

// GET|POST /api/cron/weekly-report (PLAN §7.3, §8.1, D-17): cron auth; for each account that gets a
// report and is due without this week's row, the row and its staggered job in one transaction,
// published after commit; never a re-enqueue (the sweeper's job); a JSON summary of counts only.

const getDb = setUpTestDb();
const MINUTE = 60_000;
// Mon 2026-10-12 08:00 America/New_York (EDT).
const MONDAY_8AM_NY = new Date('2026-10-12T12:00:00.000Z');

let rig: JobTestRig;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createJobTestRig(getDb(), createJobRegistry(), { start: MONDAY_8AM_NY });
});

afterEach(() => {
  vi.useRealTimers();
});

async function account(input: { timezone?: string; processingState?: AccountProcessingState } = {}): Promise<string> {
  const db = getDb();
  const now = rig.clock.now();
  const accountId = await seedAccount(db, { now, timezone: input.timezone ?? 'America/New_York', processingState: input.processingState ?? 'active' });
  await seedConnection(db, { accountId, now });
  await seedSettings(db, { accountId, now });
  return accountId;
}

async function portalOf(accountId: string): Promise<string> {
  return (await getDb().one<{ hubspot_portal_id: string }>(`select hubspot_portal_id from accounts where id = $1`, [accountId])).hubspot_portal_id;
}

function cronGet(secret: string | null = rig.deps.env.CRON_SECRET): Request {
  const headers: Record<string, string> = secret === null ? {} : { Authorization: `Bearer ${secret}` };
  return new Request(`${rig.deps.env.APP_URL}${CRON_WEEKLY_REPORT_PATH}`, { method: 'GET', headers });
}

async function qstashSchedulePost(): Promise<Request> {
  const url = `${rig.deps.env.APP_URL}${CRON_WEEKLY_REPORT_PATH}`;
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

async function run(deps: Deps = rig.deps): Promise<Record<string, unknown>> {
  const response = await handleCronWeeklyReport(cronGet(), deps);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return (await response.json()) as Record<string, unknown>;
}

interface ReportRowLite {
  account_id: string;
  week_start: string;
  timezone: string;
  period_start: Date;
  period_end: Date;
  status: string;
  attempts: number;
  metrics: unknown;
}

async function reports(): Promise<ReportRowLite[]> {
  return getDb().query<ReportRowLite>(
    `select account_id, week_start::text as week_start, timezone, period_start, period_end, status, attempts, metrics
       from weekly_reports order by account_id, week_start`,
  );
}

interface JobLite {
  account_id: string;
  dedupe_key: string;
  status: string;
  run_at: Date;
  created_at: Date;
  payload: Record<string, unknown>;
  external_id: string | null;
}

async function reportJobs(): Promise<JobLite[]> {
  return getDb().query<JobLite>(
    `select account_id, dedupe_key, status, run_at, created_at, payload, external_id from scheduled_jobs where kind = 'weekly_report' order by account_id`,
  );
}

describe('GET|POST /api/cron/weekly-report: auth', () => {
  it('refuses requests without the cron secret or a QStash signature, and creates nothing', async () => {
    await account();
    for (const request of [
      cronGet(null),
      cronGet('not-the-cron-secret-000000000000000000'),
      new Request(`${rig.deps.env.APP_URL}${CRON_WEEKLY_REPORT_PATH}`, { method: 'POST', body: '' }),
    ]) {
      const response = await handleCronWeeklyReport(request, rig.deps);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false, code: 'unauthorized' });
    }
    expect(await reports()).toHaveLength(0);
  });

  it('accepts a signed QStash schedule POST', async () => {
    // The signature's iat/exp are checked against the platform time, as for the poll cron.
    vi.setSystemTime(rig.clock.now());
    await account();
    const response = await handleCronWeeklyReport(await qstashSchedulePost(), rig.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, created: 1 });
  });
});

describe('GET|POST /api/cron/weekly-report: the due-check', () => {
  it('inserts the pending report row and its staggered job for a due account, publishes it, and answers counts only', async () => {
    const accountId = await account();
    const summary = await run();
    expect(summary).toEqual({ ok: true, accounts: 1, due: 1, created: 1, existing: 0, published: 1, publishFailed: 0, errors: 0 });
    expect(JSON.stringify(summary)).not.toContain(accountId);

    const [report] = await reports();
    expect(report).toEqual({
      account_id: accountId,
      week_start: '2026-10-12',
      timezone: 'America/New_York',
      period_start: new Date('2026-10-05T12:00:00.000Z'),
      period_end: MONDAY_8AM_NY,
      status: 'pending',
      attempts: 0,
      metrics: null,
    });
    const [job] = await reportJobs();
    const reportId = (await getDb().one<{ id: string }>(`select id from weekly_reports where account_id = $1`, [accountId])).id;
    const stagger = reportStaggerMs(await portalOf(accountId));
    expect(stagger).toBeGreaterThanOrEqual(0);
    expect(stagger).toBeLessThanOrEqual(10 * MINUTE);
    expect(job).toMatchObject({
      account_id: accountId,
      dedupe_key: `report:${accountId}:2026-10-12`,
      status: 'scheduled',
      created_at: MONDAY_8AM_NY,
      // 15 min after Monday 08:00 (leads submitted just before it are in by then), plus the stagger.
      run_at: new Date(MONDAY_8AM_NY.getTime() + 15 * MINUTE + stagger),
    });
    expect(job?.external_id).not.toBeNull();
    expect(job?.payload).toMatchObject({ reportId, weekStart: '2026-10-12' });
    // The QStash message waits for the grace and the stagger (notBefore).
    const pending = rig.fakes.scheduler.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.runAt).toEqual(new Date(MONDAY_8AM_NY.getTime() + 15 * MINUTE + stagger));
  });

  it('staggers accounts by a stable offset of their portal id within 0–10 min', async () => {
    const ids = await Promise.all([account(), account(), account(), account()]);
    await run();
    const jobs = await reportJobs();
    expect(jobs).toHaveLength(4);
    for (const job of jobs) {
      const offset = job.run_at.getTime() - MONDAY_8AM_NY.getTime() - REPORT_INTAKE_GRACE_MS;
      expect(offset).toBe(reportStaggerMs(await portalOf(job.account_id)));
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(10 * MINUTE);
    }
    const portals = await Promise.all(ids.map(portalOf));
    expect(new Set(portals.map(reportStaggerMs)).size).toBeGreaterThan(1);
  });

  it('pins each portal\'s stagger to the same second on every run (the simulation\'s repeat runs depend on it)', () => {
    // D-33's FNV-1a of the portal id, modulo 601 s. The simulation portal (1234567) runs at 08:15:03.
    expect(reportStaggerMs('1234567')).toBe(3000);
    expect(reportStaggerMs('42')).toBe(409_000);
    expect(reportStaggerMs('9876543')).toBe(286_000);
    expect(reportStaggerMs('20000001')).toBe(525_000);
  });

  it('waits 15 minutes after the period end, or runs at once (plus the stagger) when the cron is later', () => {
    expect(REPORT_INTAKE_GRACE_MS).toBe(15 * MINUTE);
    expect(reportRunAt(MONDAY_8AM_NY, MONDAY_8AM_NY, '1234567')).toEqual(new Date('2026-10-12T12:15:03.000Z'));
    // Kolkata's first due cron is 08:30 local: already past the grace.
    expect(reportRunAt(new Date('2026-10-12T03:00:00.000Z'), new Date('2026-10-12T02:30:00.000Z'), '1234567')).toEqual(new Date('2026-10-12T03:00:03.000Z'));
    // A cron 5 minutes after 08:00 (a delayed tick) still waits for the grace.
    expect(reportRunAt(new Date(MONDAY_8AM_NY.getTime() + 5 * MINUTE), MONDAY_8AM_NY, '42')).toEqual(new Date(MONDAY_8AM_NY.getTime() + 15 * MINUTE + 409_000));
  });

  it('creates nothing more on a second run in the same hour or later that Monday', async () => {
    await account();
    await run();
    expect(await run()).toMatchObject({ due: 1, created: 0, existing: 1, published: 0 });
    rig.clock.set(new Date('2026-10-13T03:00:00.000Z'));
    expect(await run()).toMatchObject({ due: 1, created: 0, existing: 1 });
    expect(await reports()).toHaveLength(1);
    expect(await reportJobs()).toHaveLength(1);
  });

  it('is not due before Monday 08:00 local or from Tuesday 00:00 local', async () => {
    await account();
    for (const at of ['2026-10-12T11:00:00.000Z', '2026-10-11T12:00:00.000Z', '2026-10-13T04:00:00.000Z', '2026-10-14T12:00:00.000Z']) {
      rig.clock.set(new Date(at));
      expect(await run(), at).toMatchObject({ accounts: 1, due: 0, created: 0 });
    }
    expect(await reports()).toHaveLength(0);
  });

  it('uses each account\'s own zone (Kolkata and Kathmandu are due before New York)', async () => {
    const kolkata = await account({ timezone: 'Asia/Kolkata' });
    const kathmandu = await account({ timezone: 'Asia/Kathmandu' });
    const newYork = await account();
    rig.clock.set(new Date('2026-10-12T03:00:00.000Z'));
    expect(await run()).toMatchObject({ accounts: 3, due: 2, created: 2 });
    const rows = await reports();
    expect(rows.find((row) => row.account_id === kolkata)).toMatchObject({
      timezone: 'Asia/Kolkata',
      week_start: '2026-10-12',
      period_start: new Date('2026-10-05T02:30:00.000Z'),
      period_end: new Date('2026-10-12T02:30:00.000Z'),
    });
    expect(rows.find((row) => row.account_id === kathmandu)).toMatchObject({
      timezone: 'Asia/Kathmandu',
      period_start: new Date('2026-10-05T02:15:00.000Z'),
      period_end: new Date('2026-10-12T02:15:00.000Z'),
    });
    expect(rows.find((row) => row.account_id === newYork)).toBeUndefined();
  });

  it('stores UTC for an account without a usable zone', async () => {
    const accountId = await account();
    await getDb().query(`update accounts set timezone = null where id = $1`, [accountId]);
    rig.clock.set(new Date('2026-10-12T08:00:00.000Z'));
    await run();
    expect((await reports())[0]).toMatchObject({ timezone: 'UTC', period_end: new Date('2026-10-12T08:00:00.000Z') });
  });

  it('gives no report to accounts that are not active or have not finished onboarding (D-17)', async () => {
    for (const processingState of ['onboarding', 'paused', 'inactive', 'revoked', 'disconnected'] as const) {
      await account({ processingState });
    }
    const unfinished = await account();
    await getDb().query(`update accounts set onboarding_completed_at = null where id = $1`, [unfinished]);
    expect(await run()).toMatchObject({ accounts: 0, due: 0, created: 0 });
    expect(await reports()).toHaveLength(0);
  });

  it('never re-enqueues a failed report (the sweeper does)', async () => {
    const accountId = await account();
    await run();
    await getDb().query(`update weekly_reports set status = 'failed' where account_id = $1`, [accountId]);
    await getDb().query(`update scheduled_jobs set status = 'failed' where account_id = $1 and kind = 'weekly_report'`, [accountId]);
    rig.clock.advance(60 * MINUTE);
    expect(await run()).toMatchObject({ created: 0, existing: 1 });
    expect((await reports())[0]).toMatchObject({ status: 'failed', attempts: 0 });
    expect((await reportJobs())[0]).toMatchObject({ status: 'failed' });
  });

  it('inserts the row and the job in one transaction: a failed job insert leaves no row', async () => {
    await account();
    const failing = interceptBefore(getDb(), /insert into scheduled_jobs/, async () => {
      throw new Error('job insert failed');
    });
    expect(await run({ ...rig.deps, db: failing.db })).toMatchObject({ due: 1, created: 0, errors: 1 });
    expect(failing.fired()).toBe(1);
    expect(await reports()).toHaveLength(0);
    // The next hourly run creates both.
    expect(await run()).toMatchObject({ created: 1 });
  });

  it('leaves an unpublished job for the sweeper when QStash refuses it', async () => {
    await account();
    vi.spyOn(rig.fakes.scheduler, 'publish').mockRejectedValueOnce(new Error('qstash down'));
    expect(await run()).toMatchObject({ created: 1, published: 0, publishFailed: 1 });
    expect((await reportJobs())[0]).toMatchObject({ status: 'scheduled', external_id: null });
  });
});
