import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermanentError, TransientError } from '@/server/domain/errors';
import { claimJob } from '@/server/jobs/claim';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import { createJobRegistry, type JobRegistry } from '@/server/jobs/registry';
import { getJob } from '@/server/jobs/rows';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { JobOutcomes, type JobRow } from '@/server/jobs/types';
import { useTestDb as setUpTestDb } from '../../../test/db/harness';
import { handleJobFailed, handleJobRun } from './jobs';

// Route tests with real Request objects signed like QStash (PLAN §12): HS256 over the configured
// signing keys, `sub` = the route's own URL, `body` = base64url sha256 of the raw body.

const getDb = setUpTestDb();

let registry: JobRegistry;
let rig: JobTestRig;

beforeEach(() => {
  registry = createJobRegistry();
  rig = createJobTestRig(getDb(), registry);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(rig.deps.clock.now());
});

afterEach(() => {
  vi.useRealTimers();
});

async function signed(path: '/api/jobs/run' | '/api/jobs/failed', body: string, headers: Record<string, string> = {}, key?: string): Promise<Request> {
  const url = `${rig.deps.env.APP_URL}${path}`;
  const iat = Math.floor(rig.deps.clock.now().getTime() / 1000);
  const token = await new SignJWT({ body: createHash('sha256').update(body).digest('base64url') })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('Upstash')
    .setSubject(url)
    .setIssuedAt(iat)
    .setNotBefore(0)
    .setExpirationTime(iat + 300)
    .sign(new TextEncoder().encode(key ?? rig.deps.env.QSTASH_CURRENT_SIGNING_KEY));
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Upstash-Signature': token, ...headers }, body });
}

async function job(): Promise<JobRow> {
  const { deps } = rig;
  const now = deps.clock.now();
  const row = await deps.db.tx((tx) => insertJob(tx, { kind: 'portal_poll', accountId: null, dedupeKey: 'poll:http:1', runAt: now, now }));
  if (row === null) throw new Error('job not inserted');
  await publishJobs(deps, [row]);
  return (await getJob(deps.db, row.id)) ?? row;
}

describe('POST /api/jobs/run', () => {
  it('verifies, reads the QStash headers and runs the job', async () => {
    const seen: { retried: number; messageId: string | null }[] = [];
    registry.register('portal_poll', async (_deps, _job, ctx) => {
      seen.push({ retried: ctx.retried, messageId: ctx.messageId });
      return JobOutcomes.done();
    });
    const row = await job();
    const req = await signed('/api/jobs/run', JSON.stringify({ jobId: row.id }), { 'Upstash-Retried': '2', 'Upstash-Message-Id': 'msg_abc' });
    const res = await handleJobRun(req, rig.deps, { registry });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: 'done' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(seen).toEqual([{ retried: 2, messageId: 'msg_abc' }]);
    expect((await getJob(rig.deps.db, row.id))?.status).toBe('done');
  });

  it('answers 401 and runs nothing for a bad, missing or wrong-route signature', async () => {
    let runs = 0;
    registry.register('portal_poll', async () => {
      runs += 1;
      return JobOutcomes.done();
    });
    const row = await job();
    const body = JSON.stringify({ jobId: row.id });
    const wrongKey = await signed('/api/jobs/run', body, {}, ['sig', 'notTheConfiguredKey'].join('_'));
    const unsigned = new Request(`${rig.deps.env.APP_URL}/api/jobs/run`, { method: 'POST', body });
    const forFailedRoute = await signed('/api/jobs/failed', body);
    const tampered = await signed('/api/jobs/run', body);
    const tamperedReq = new Request(tampered.url, { method: 'POST', headers: tampered.headers, body: JSON.stringify({ jobId: row.id, x: 1 }) });
    for (const req of [wrongKey, unsigned, new Request(`${rig.deps.env.APP_URL}/api/jobs/run`, { method: 'POST', headers: forFailedRoute.headers, body }), tamperedReq]) {
      expect((await handleJobRun(req, rig.deps, { registry })).status).toBe(401);
    }
    expect(runs).toBe(0);
  });

  it('answers 489 non-retryable for a verified but malformed body', async () => {
    const res = await handleJobRun(await signed('/api/jobs/run', '{"jobId":"not-a-uuid"}'), rig.deps, { registry });
    expect(res.status).toBe(489);
    expect(res.headers.get('upstash-nonretryable-error')).toBe('true');
    const notJson = await handleJobRun(await signed('/api/jobs/run', 'nope'), rig.deps, { registry });
    expect(notJson.status).toBe(489);
  });

  it('maps outcomes: transient → 500, permanent → 489, live lease → 503 + Retry-After, final transient → 200', async () => {
    let mode: 'transient' | 'permanent' = 'transient';
    registry.register('portal_poll', async () => {
      if (mode === 'transient') throw new TransientError('hubspot_server_error', { retryAfterMs: 1500 });
      throw new PermanentError('lead_missing');
    });
    const row = await job();
    const body = JSON.stringify({ jobId: row.id });

    const transient = await handleJobRun(await signed('/api/jobs/run', body, { 'Upstash-Retried': '0' }), rig.deps, { registry });
    expect(transient.status).toBe(500);
    expect(transient.headers.get('retry-after')).toBe('2');

    await claimJob(rig.deps.db, row.id, 'other-attempt', rig.deps.clock.now());
    const held = await handleJobRun(await signed('/api/jobs/run', body), rig.deps, { registry });
    expect(held.status).toBe(503);
    expect(Number(held.headers.get('retry-after'))).toBeGreaterThan(0);
    await rig.deps.db.query(`update scheduled_jobs set status = 'scheduled', lease_until = null where id = $1`, [row.id]);

    const final = await handleJobRun(await signed('/api/jobs/run', body, { 'Upstash-Retried': '4' }), rig.deps, { registry });
    expect(final.status).toBe(200);
    expect(await final.json()).toEqual({ ok: true, outcome: 'failed' });

    mode = 'permanent';
    await rig.deps.db.query(`update scheduled_jobs set status = 'scheduled' where id = $1`, [row.id]);
    const permanent = await handleJobRun(await signed('/api/jobs/run', body), rig.deps, { registry });
    expect(permanent.status).toBe(489);
    expect(permanent.headers.get('upstash-nonretryable-error')).toBe('true');
  });
});

describe('POST /api/jobs/failed', () => {
  function callbackBody(row: JobRow, options: { withSourceBody?: boolean; messageId?: string } = {}): string {
    return JSON.stringify({
      status: 500,
      retried: 4,
      maxRetries: 4,
      dlqId: '1725323658779-0',
      sourceMessageId: options.messageId ?? row.externalId,
      url: `${rig.deps.env.APP_URL}/api/jobs/run`,
      method: 'POST',
      ...(options.withSourceBody === false ? {} : { sourceBody: Buffer.from(JSON.stringify({ jobId: row.id })).toString('base64') }),
    });
  }

  it('fails the job through the compare-and-set and runs the failure path once', async () => {
    const reasons: string[] = [];
    registry.registerFailurePath('portal_poll', async (_deps, _job, info) => {
      reasons.push(info.reason);
    });
    const row = await job();
    const first = await handleJobFailed(await signed('/api/jobs/failed', callbackBody(row)), rig.deps, { registry });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, outcome: 'won' });
    const second = await handleJobFailed(await signed('/api/jobs/failed', callbackBody(row)), rig.deps, { registry });
    expect(await second.json()).toEqual({ ok: true, outcome: 'lost' });
    expect(reasons).toEqual(['failure_callback']);
    expect((await getJob(rig.deps.db, row.id))?.status).toBe('failed');
  });

  it('finds the job by message id when the source body is missing', async () => {
    const row = await job();
    const res = await handleJobFailed(await signed('/api/jobs/failed', callbackBody(row, { withSourceBody: false })), rig.deps, { registry });
    expect(await res.json()).toEqual({ ok: true, outcome: 'won' });
  });

  it('leaves a job that a live attempt holds', async () => {
    const row = await job();
    await claimJob(rig.deps.db, row.id, 'live-attempt', rig.deps.clock.now());
    const res = await handleJobFailed(await signed('/api/jobs/failed', callbackBody(row)), rig.deps, { registry });
    expect(await res.json()).toEqual({ ok: true, outcome: 'lost' });
    expect((await getJob(rig.deps.db, row.id))?.status).toBe('running');
  });

  it('answers 401 when the signature is for the run route, and 489 for a malformed callback', async () => {
    const row = await job();
    const forRun = await signed('/api/jobs/run', callbackBody(row));
    const misrouted = new Request(`${rig.deps.env.APP_URL}/api/jobs/failed`, { method: 'POST', headers: forRun.headers, body: callbackBody(row) });
    expect((await handleJobFailed(misrouted, rig.deps, { registry })).status).toBe(401);
    const malformed = await handleJobFailed(await signed('/api/jobs/failed', '{"status":500}'), rig.deps, { registry });
    expect(malformed.status).toBe(489);
    expect((await getJob(rig.deps.db, row.id))?.status).toBe('scheduled');
  });
});

describe('route files', () => {
  it('give the run route maxDuration 300 and stay thin', async () => {
    const run = await import('@/app/api/jobs/run/route');
    const failed = await import('@/app/api/jobs/failed/route');
    expect(run.maxDuration).toBe(300);
    expect(typeof run.POST).toBe('function');
    expect(typeof failed.POST).toBe('function');
  });
});
