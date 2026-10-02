import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLease, LeaseNames } from '@/server/services/leases';
import { useTestDb as setUpTestDb } from '../../../test/db/harness';
import { createIntakeRig, cronRequest, leadsOf, MINUTE, runCron, type IntakeRig } from '../../../test/intake/support';
import { CRON_POLL_PATH, handleCronPoll, runRetentionGuard } from './cron-poll';

// GET|POST /api/cron/poll (PLAN §7.3, §8.1, D-11, D-16): cron auth, global lease, processing
// states, per-account polls within the budget (skipping portals in the inline refresh backoff),
// sweeper, retention guard; a JSON summary of counts only.

const getDb = setUpTestDb();

let rig: IntakeRig;

beforeEach(async () => {
  rig = await createIntakeRig(getDb());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(rig.clock.now());
});

afterEach(() => {
  vi.useRealTimers();
});

async function qstashScheduleRequest(): Promise<Request> {
  const url = `${rig.deps.env.APP_URL}${CRON_POLL_PATH}`;
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

describe('GET|POST /api/cron/poll', () => {
  it('refuses requests without the cron secret or a QStash signature', async () => {
    for (const request of [
      cronRequest(rig, null),
      cronRequest(rig, 'not-the-cron-secret-000000000000000000'),
      new Request(`${rig.deps.env.APP_URL}${CRON_POLL_PATH}`, { method: 'POST', body: '' }),
    ]) {
      const response = await handleCronPoll(request, rig.deps);
      expect(response.status).toBe(401);
    }
    expect(await getDb().query(`select name from leases`)).toHaveLength(0);
  });

  it('accepts a signed QStash schedule POST', async () => {
    const response = await handleCronPoll(await qstashScheduleRequest(), rig.deps, { sleep: rig.sleep, sweep: async () => emptySweep() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'ran', polled: 1 });
  });

  it('polls each active account, runs the sweeper and the retention guard, and answers counts only', async () => {
    rig.hubspot.submitForm({ formId: rig.contactUs, email: 'tom.reyes@example.org', message: 'Faucets.', at: rig.clock.now() });
    const summary = await runCron(rig);
    expect(summary).toMatchObject({
      ok: true,
      status: 'ran',
      accounts: 1,
      pollable: 1,
      polled: 1,
      leadsCreated: 1,
      sweepFailed: false,
      retentionGuard: { ran: false },
    });
    expect(summary.sweep).toMatchObject({ published: 0, errors: 0 });
    const text = JSON.stringify(summary);
    expect(text).not.toContain(rig.accountId);
    expect(text).not.toContain('tom.reyes');
    expect(await getDb().query(`select name from leases`)).toHaveLength(0);
    expect(await runRetentionGuard(rig.deps)).toEqual({ ran: false });
  });

  it('applies the processing state first, so an account whose trial ended is not polled', async () => {
    const now = rig.clock.now();
    await getDb().query(`update accounts set trial_started_at = $2, trial_ends_at = $3 where id = $1`, [
      rig.accountId,
      new Date(now.getTime() - 20 * 24 * 60 * MINUTE),
      new Date(now.getTime() - MINUTE),
    ]);
    rig.hubspot.submitForm({ formId: rig.contactUs, email: 'tom.reyes@example.org', message: 'Faucets.', at: now });
    const summary = await runCron(rig);
    expect(summary).toMatchObject({ stateChanges: 1, pollable: 0, polled: 0 });
    const account = await getDb().one<{ processing_state: string }>(`select processing_state from accounts where id = $1`, [rig.accountId]);
    expect(account.processing_state).toBe('inactive');
    expect(await leadsOf(getDb(), rig.accountId)).toHaveLength(0);
  });

  it('skips a portal while its token needs a refresh and the inline backoff holds, and only then', async () => {
    const now = rig.clock.now();
    await getDb().query(`update hubspot_connections set access_expires_at = $2, next_refresh_attempt_at = $3 where id = $1`, [
      rig.connectionId,
      new Date(now.getTime() - MINUTE),
      new Date(now.getTime() + 5 * MINUTE),
    ]);
    const refresh = vi.spyOn(rig.hubspot, 'refresh');
    expect(await runCron(rig)).toMatchObject({ pollable: 1, skippedRefreshBackoff: 1, polled: 0 });
    expect(refresh).not.toHaveBeenCalled();

    // A fresh token is used even inside the backoff window.
    await getDb().query(`update hubspot_connections set access_expires_at = $2 where id = $1`, [rig.connectionId, new Date(now.getTime() + 20 * MINUTE)]);
    expect(await runCron(rig)).toMatchObject({ skippedRefreshBackoff: 0, polled: 1 });
  });

  it('does nothing while another run holds the global lease', async () => {
    await acquireLease(getDb(), { name: LeaseNames.pollCron, ttlMs: 6 * 60_000, now: rig.clock.now() });
    expect(await runCron(rig)).toMatchObject({ ok: true, status: 'busy', polled: 0 });
  });

  it('defers the remaining portals once the budget is spent', async () => {
    expect(await runCron(rig, { budgetMs: 0 })).toMatchObject({ status: 'ran', pollable: 1, polled: 0, deferredByBudget: 1 });
  });
});

describe('/api/cron/poll route file', () => {
  it('matches the vercel.json schedule and serves both triggers (GET from Vercel Cron, POST from QStash)', async () => {
    const config = JSON.parse(readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] };
    expect(config.crons).toContainEqual({ path: CRON_POLL_PATH, schedule: '*/5 * * * *' });
    const route = await import('@/app/api/cron/poll/route');
    expect(typeof route.GET).toBe('function');
    expect(typeof route.POST).toBe('function');
    expect(route.maxDuration).toBe(300);
  });
});

function emptySweep() {
  return { published: 0, republished: 0, failed: 0, weeklyReportsRequeued: 0, notificationsResumed: 0, notificationsExpired: 0, errors: 0 };
}
