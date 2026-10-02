import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermanentError, TransientError } from '@/server/domain/errors';
import type { Deps, PublishRequest } from '@/server/ports';
import { NotificationKeys, NotificationPredicates, reserveAndSend } from '@/server/services/notifications';
import { useTestDb as setUpTestDb } from '../../../test/db/harness';
import { onAlert, type RaisedAlert } from './alert';
import { claimJob, finishJob, releaseJob } from './claim';
import { runJob } from './dispatcher';
import { failJobIfUnchanged, handleFailureCallback } from './failure';
import { dedupeIdFor, insertJob, publishJobs, RepublishDeduplicatedError } from './outbox';
import { createJobRegistry, type JobRegistry } from './registry';
import { republishJob } from './republish';
import { getJob } from './rows';
import { createJobTestRig, seedActiveAccount, seedLead, type JobTestRig } from './testing';
import { JobOutcomes, type JobHandler, type JobOutcome, type JobRow } from './types';

const getDb = setUpTestDb();

const MINUTE = 60_000;

let registry: JobRegistry;
let rig: JobTestRig;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(() => {
  registry = createJobRegistry();
  rig = createJobTestRig(getDb(), registry);
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
});

async function scheduleJob(deps: Deps, options: { key?: string; runAt?: Date; accountId?: string | null; leadId?: string | null } = {}): Promise<JobRow> {
  const now = deps.clock.now();
  const job = await deps.db.tx((tx) =>
    insertJob(tx, {
      kind: 'portal_poll',
      accountId: options.accountId ?? null,
      leadId: options.leadId ?? null,
      dedupeKey: options.key ?? 'poll:test:1',
      runAt: options.runAt ?? now,
      now,
    }),
  );
  if (job === null) throw new Error('job not inserted');
  await publishJobs(deps, [job]);
  const published = await getJob(deps.db, job.id);
  if (published === null) throw new Error('job vanished');
  return published;
}

function handlerReturning(outcome: JobOutcome | (() => JobOutcome | Promise<JobOutcome>)): { handler: JobHandler; calls: number[] } {
  const calls: number[] = [];
  const handler: JobHandler = async (_deps, _job, ctx) => {
    calls.push(ctx.retried);
    return typeof outcome === 'function' ? outcome() : outcome;
  };
  return { handler, calls };
}

describe('outbox', () => {
  it('inserts a scheduled row and publishes it with the namespaced dedupe id', async () => {
    const { deps, fakes } = rig;
    const job = await scheduleJob(deps);
    expect(job.status).toBe('scheduled');
    expect(job.hops).toBe(0);
    expect(job.externalId).not.toBeNull();
    expect(job.publishedAt).toEqual(deps.clock.now());
    expect(fakes.scheduler.pending()).toEqual([
      expect.objectContaining({ jobId: job.id, dedupeId: 'fake-local:poll:test:1', retries: 4, messageId: job.externalId }),
    ]);
  });

  it('returns null for a second insert with the same dedupe key', async () => {
    const { deps } = rig;
    await scheduleJob(deps);
    const again = await deps.db.tx((tx) =>
      insertJob(tx, { kind: 'portal_poll', accountId: null, dedupeKey: 'poll:test:1', runAt: deps.clock.now(), now: deps.clock.now() }),
    );
    expect(again).toBeNull();
  });

  it('leaves the row unpublished when the publish fails', async () => {
    const { deps } = rig;
    const failing: Deps = { ...deps, scheduler: { publish: () => Promise.reject(new TransientError('qstash_server_error')), cancel: () => Promise.resolve() } };
    const job = await deps.db.tx((tx) =>
      insertJob(tx, { kind: 'portal_poll', accountId: null, dedupeKey: 'poll:test:2', runAt: deps.clock.now(), now: deps.clock.now() }),
    );
    const summary = await publishJobs(failing, [job, null]);
    expect(summary.failed).toEqual([job?.id]);
    expect((await getJob(deps.db, job?.id ?? ''))?.externalId).toBeNull();
  });

  it('publishes a target beyond the QStash maximum delay at the maximum, recording the real target', async () => {
    const { deps } = rig;
    const target = new Date(deps.clock.now().getTime() + 10 * 86_400_000);
    const job = await scheduleJob(deps, { runAt: target });
    expect(job.payload.targetAt).toBe(target.toISOString());
    expect(job.runAt).toEqual(new Date(deps.clock.now().getTime() + 601_200_000));
  });
});

describe('runJob', () => {
  it('claims, runs the handler and finishes the job done', async () => {
    const { deps, fakes } = rig;
    const { handler, calls } = handlerReturning(JobOutcomes.done());
    registry.register('portal_poll', handler);
    const job = await scheduleJob(deps);
    await fakes.scheduler.runDue();
    expect(calls).toEqual([0]);
    const after = await getJob(deps.db, job.id);
    expect(after).toMatchObject({ status: 'done', attempts: 1, leaseUntil: null });
    expect(after?.finishedAt).toEqual(deps.clock.now());
  });

  it('answers 200 without running anything for a finished job (duplicate delivery)', async () => {
    const { deps, fakes } = rig;
    const { handler, calls } = handlerReturning(JobOutcomes.done());
    registry.register('portal_poll', handler);
    await scheduleJob(deps);
    fakes.scheduler.simulate('duplicate');
    await fakes.scheduler.runDue();
    expect(calls).toHaveLength(1);
    expect(fakes.scheduler.events.filter((e) => e.type === 'delivery').map((e) => e.type === 'delivery' && e.status)).toEqual([200, 200]);
  });

  it('answers 503 with Retry-After while another attempt holds a live lease', async () => {
    const { deps } = rig;
    registry.register('portal_poll', handlerReturning(JobOutcomes.done()).handler);
    const job = await scheduleJob(deps);
    await claimJob(deps.db, job.id, 'crashed-attempt', deps.clock.now());
    rig.clock.advance({ minutes: 2 });
    const result = await runJob(deps, { jobId: job.id, messageId: job.externalId, retried: 0 }, registry);
    expect(result).toEqual({ status: 503, outcome: 'lease_held', retryAfterSeconds: 60 });
  });

  it('recovers a crashed attempt: the redelivery claims the job once the lease expires', async () => {
    const { deps, fakes } = rig;
    const { handler, calls } = handlerReturning(JobOutcomes.done());
    registry.register('portal_poll', handler);
    const job = await scheduleJob(deps);
    // The first attempt claimed the job and died before writing an outcome; QStash redelivers later.
    await claimJob(deps.db, job.id, 'crashed-attempt', deps.clock.now());
    rig.clock.advance({ minutes: 7 });
    await fakes.scheduler.runDue();
    expect(calls).toHaveLength(1);
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('puts a transient failure back to scheduled and answers 500 so QStash backs off', async () => {
    const { deps } = rig;
    registry.register('portal_poll', async () => {
      throw new TransientError('hubspot_server_error', { httpStatus: 502 });
    });
    const job = await scheduleJob(deps);
    const result = await runJob(deps, { jobId: job.id, messageId: job.externalId, retried: 0 }, registry);
    expect(result).toMatchObject({ status: 500, outcome: 'transient', code: 'hubspot_server_error' });
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'scheduled', leaseUntil: null, lastErrorCode: 'hubspot_server_error' });
  });

  it('re-schedules a transient error that asks to wait more than 60 s (D-11 long wait) instead of spending retries', async () => {
    const { deps, fakes } = rig;
    let runs = 0;
    registry.register('portal_poll', async () => {
      runs += 1;
      if (runs === 1) throw new TransientError('hubspot_migration_in_progress', { httpStatus: 477, retryAfterMs: 10 * MINUTE });
      return JobOutcomes.done();
    });
    const job = await scheduleJob(deps);
    await fakes.scheduler.runDue();
    const later = new Date(deps.clock.now().getTime() + 10 * MINUTE);
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'scheduled', hops: 1, runAt: later });
    expect(fakes.scheduler.events.filter((e) => e.type === 'delivery').map((e) => e.type === 'delivery' && e.status)).toEqual([200]);
    rig.clock.set(later);
    await fakes.scheduler.runDue();
    expect(runs).toBe(2);
    expect((await getJob(deps.db, job.id))?.status).toBe('done');
  });

  it('stops re-scheduling long waits once the job has been claimed 6 times', async () => {
    const { deps } = rig;
    registry.register('portal_poll', async () => {
      throw new TransientError('hubspot_rate_limited', { retryAfterMs: 5 * MINUTE });
    });
    const job = await scheduleJob(deps);
    await deps.db.query(`update scheduled_jobs set attempts = 5 where id = $1`, [job.id]);
    const result = await runJob(deps, { jobId: job.id, messageId: job.externalId, retried: 0 }, registry);
    expect(result).toMatchObject({ status: 500, outcome: 'transient', retryAfterSeconds: 300 });
  });

  it('runs the failure path inline on the final delivery of a transient failure, then fails with 200', async () => {
    const { deps, fakes } = rig;
    const { handler, calls } = handlerReturning(() => {
      throw new TransientError('hubspot_server_error');
    });
    const failures: string[] = [];
    registry.register('portal_poll', handler);
    registry.registerFailurePath('portal_poll', async (_deps, _job, info) => {
      failures.push(`${info.reason}:${info.code}`);
    });
    const job = await scheduleJob(deps);
    for (let i = 0; i < 10; i += 1) {
      await fakes.scheduler.runDue();
      rig.clock.advance({ seconds: 90 });
    }
    expect(calls).toEqual([0, 1, 2, 3, 4]);
    expect(failures).toEqual(['final_delivery:hubspot_server_error']);
    expect(alerts.filter((a) => a.code === 'job_failed')).toHaveLength(1);
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'failed', attempts: 5 });
    // The last delivery answered 200, so QStash never calls the failure callback.
    expect(fakes.scheduler.failures).toEqual([]);
  });

  it('runs the failure path inline on a permanent error and answers 489 non-retryable', async () => {
    const { deps, fakes } = rig;
    const failures: string[] = [];
    registry.register('portal_poll', async () => {
      throw new PermanentError('lead_missing');
    });
    registry.registerFailurePath('portal_poll', async (_deps, _job, info) => {
      failures.push(info.reason);
    });
    const job = await scheduleJob(deps);
    const direct = await runJob(deps, { jobId: job.id, messageId: job.externalId, retried: 0 }, registry);
    expect(direct).toEqual({ status: 489, outcome: 'permanent', code: 'lead_missing' });
    expect(failures).toEqual(['permanent']);
    // QStash may still call the failure callback for a 489: it loses the compare-and-set.
    await fakes.scheduler.runDue();
    expect(await handleFailureCallback(deps, { jobId: job.id, sourceMessageId: job.externalId ?? '' }, registry)).toBe('lost');
    expect(failures).toEqual(['permanent']);
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'failed', lastErrorCode: 'lead_missing' });
  });

  it('treats a kind without a handler as a permanent failure', async () => {
    const { deps } = rig;
    const job = await scheduleJob(deps);
    const result = await runJob(deps, { jobId: job.id, messageId: null, retried: 0 }, registry);
    expect(result).toMatchObject({ status: 489, code: 'job_handler_missing' });
  });

  it('answers 200 for an unknown or malformed job id', async () => {
    const { deps } = rig;
    expect(await runJob(deps, { jobId: 'not-a-uuid', messageId: null, retried: 0 }, registry)).toEqual({ status: 200, outcome: 'not_found' });
    expect(await runJob(deps, { jobId: '00000000-0000-4000-8000-000000000000', messageId: null, retried: 0 }, registry)).toEqual({
      status: 200,
      outcome: 'not_found',
    });
  });

  it('lets a handler check its claim inside its own transaction', async () => {
    const { deps } = rig;
    registry.register('portal_poll', async (d, job, ctx) => {
      // The job is cancelled while the handler works; its write must not commit.
      await d.db.query(`update scheduled_jobs set status = 'cancelled' where id = $1`, [job.id]);
      await d.db.tx(async (tx) => {
        await ctx.assertOwned(tx);
      });
      return JobOutcomes.done();
    });
    const job = await scheduleJob(deps);
    expect(await runJob(deps, { jobId: job.id, messageId: null, retried: 0 }, registry)).toEqual({ status: 200, outcome: 'lease_lost' });
    expect((await getJob(deps.db, job.id))?.status).toBe('cancelled');
  });
});

describe('failure callback', () => {
  it('wins when no attempt holds the job and runs the failure path once', async () => {
    const { deps, fakes } = rig;
    const failures: string[] = [];
    const { handler, calls } = handlerReturning(JobOutcomes.done());
    registry.register('portal_poll', handler);
    registry.registerFailurePath('portal_poll', async (_deps, _job, info) => {
      failures.push(`${info.reason}:${info.code}`);
    });
    const job = await scheduleJob(deps);
    // Every delivery dies before the handler runs (the endpoint is down).
    fakes.scheduler.simulate('crash_before_dispatch', { jobId: job.id }, 5);
    for (let i = 0; i < 8; i += 1) {
      await fakes.scheduler.runDue();
      rig.clock.advance({ seconds: 90 });
    }
    expect(calls).toEqual([]);
    expect(fakes.scheduler.failures).toHaveLength(1);
    expect(failures).toEqual(['failure_callback:qstash_retries_exhausted']);
    expect((await getJob(deps.db, job.id))?.status).toBe('failed');
    // A repeated callback loses.
    expect(await handleFailureCallback(deps, { jobId: job.id, sourceMessageId: job.externalId ?? '' }, registry)).toBe('lost');
    expect(failures).toHaveLength(1);
  });

  it('ignores a callback for a message the job no longer uses', async () => {
    const { deps } = rig;
    const job = await scheduleJob(deps);
    expect(await handleFailureCallback(deps, { jobId: job.id, sourceMessageId: 'msg_old' }, registry)).toBe('lost');
    expect((await getJob(deps.db, job.id))?.status).toBe('scheduled');
  });

  it('loses to a live lease: a duplicate delivery exhausting its retries leaves exactly one owner email', async () => {
    const { deps, fakes } = rig;
    const db = getDb();
    const { accountId } = await seedActiveAccount(db, deps.clock.now());
    const leadId = await seedLead(db, { accountId, now: deps.clock.now() });
    const key = NotificationKeys.initial(leadId, 0);
    const send = (kind: 'new_lead' | 'needs_touch') =>
      reserveAndSend(deps, {
        kind,
        dedupeKey: key,
        accountId,
        leadId,
        predicates: NotificationPredicates.initial({ accountId, leadId }),
        render: () => ({ to: ['owner@example.com'], subject: kind === 'new_lead' ? 'New lead' : 'Needs your touch', html: '<p>x</p>', text: 'x' }),
      });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const claimed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registry.register('lead_process', async () => {
      entered();
      await gate;
      await send('new_lead');
      return JobOutcomes.done();
    });
    registry.registerFailurePath('lead_process', async () => {
      await send('needs_touch');
    });
    const now = deps.clock.now();
    const job = await deps.db.tx((tx) => insertJob(tx, { kind: 'lead_process', accountId, leadId, dedupeKey: `lead:${leadId}:process:r0`, runAt: now, now }));
    if (job === null) throw new Error('job not inserted');
    await publishJobs(deps, [job]);
    const published = await getJob(deps.db, job.id);

    // Attempt A: the first delivery, still working (slow model call).
    const attemptA = runJob(deps, { jobId: job.id, messageId: published?.externalId ?? null, retried: 0 }, registry);
    await claimed;
    // A duplicate of the same message keeps meeting the live lease until QStash gives up.
    for (let i = 0; i < 5; i += 1) {
      await fakes.scheduler.runDue();
      rig.clock.advance({ seconds: 61 });
    }
    expect(fakes.scheduler.failures).toHaveLength(1);
    expect((await getJob(deps.db, job.id))?.status).toBe('running');

    release();
    expect(await attemptA).toEqual({ status: 200, outcome: 'done' });
    expect(fakes.mailer.sent.map((mail) => mail.subject)).toEqual(['New lead']);
    expect(alerts.filter((a) => a.code === 'job_failed')).toEqual([]);
    expect((await getJob(deps.db, job.id))?.status).toBe('done');
  });
});

describe('re-publish', () => {
  it('re-targets with hops + 1 and the :h{hops} dedupe id, then runs at the new time', async () => {
    const { deps, fakes } = rig;
    const later = new Date(deps.clock.now().getTime() + 3 * 60 * MINUTE);
    let runs = 0;
    registry.register('portal_poll', async () => {
      runs += 1;
      return runs === 1 ? JobOutcomes.retarget(later) : JobOutcomes.done();
    });
    const job = await scheduleJob(deps);
    await fakes.scheduler.runDue();
    const moved = await getJob(deps.db, job.id);
    expect(moved).toMatchObject({ status: 'scheduled', hops: 1, runAt: later, leaseUntil: null });
    expect(moved?.payload.targetAt).toBe(later.toISOString());
    expect(fakes.scheduler.pending()).toEqual([expect.objectContaining({ jobId: job.id, dedupeId: 'fake-local:poll:test:1:h1', runAt: later })]);
    rig.clock.set(later);
    await fakes.scheduler.runDue();
    expect(runs).toBe(2);
    expect((await getJob(deps.db, job.id))?.status).toBe('done');
  });

  it('treats deduplicated:true on a re-publish as an error', async () => {
    const { deps } = rig;
    const job = await scheduleJob(deps);
    const requests: PublishRequest[] = [];
    const deduplicating: Deps = {
      ...deps,
      scheduler: {
        publish: async (request) => {
          requests.push(request);
          return { messageId: 'msg_existing', deduplicated: true };
        },
        cancel: () => Promise.resolve(),
      },
    };
    await expect(republishJob(deduplicating, job, deps.clock.now(), { type: 'hops', hops: 0 })).rejects.toBeInstanceOf(RepublishDeduplicatedError);
    expect(requests.map((r) => r.dedupeId)).toEqual([dedupeIdFor('fake-local', 'poll:test:1', 1)]);
    expect(alerts.map((a) => a.code)).toContain('job_republish_deduplicated');
    // The row waits for the sweeper, unpublished.
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'scheduled', hops: 1, externalId: null });
  });

  it('accepts deduplicated:true on a first publish (an earlier publish whose id was not stored)', async () => {
    const { deps } = rig;
    const now = deps.clock.now();
    const job = await deps.db.tx((tx) => insertJob(tx, { kind: 'portal_poll', accountId: null, dedupeKey: 'poll:test:3', runAt: now, now }));
    const deduplicating: Deps = {
      ...deps,
      scheduler: { publish: async () => ({ messageId: 'msg_existing', deduplicated: true }), cancel: () => Promise.resolve() },
    };
    const summary = await publishJobs(deduplicating, [job]);
    expect(summary.failed).toEqual([]);
    expect((await getJob(deps.db, job?.id ?? ''))?.externalId).toBe('msg_existing');
  });

  it('hops a delivery that arrives well before its target, without claiming', async () => {
    const { deps, fakes } = rig;
    const { handler, calls } = handlerReturning(JobOutcomes.done());
    registry.register('portal_poll', handler);
    const target = new Date(deps.clock.now().getTime() + 10 * 86_400_000);
    const job = await scheduleJob(deps, { runAt: target });
    const firstDelivery = new Date(deps.clock.now().getTime() + 601_200_000);
    rig.clock.set(firstDelivery);
    await fakes.scheduler.runDue();
    expect(calls).toEqual([]);
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'scheduled', hops: 1, attempts: 0, runAt: target });
    expect(fakes.scheduler.pending()).toEqual([expect.objectContaining({ dedupeId: 'fake-local:poll:test:1:h1', runAt: target })]);
    rig.clock.set(target);
    await fakes.scheduler.runDue();
    expect(calls).toEqual([0]);
    expect((await getJob(deps.db, job.id))?.status).toBe('done');
  });

  it('does not hop again for a stale copy of an earlier message', async () => {
    const { deps, fakes } = rig;
    registry.register('portal_poll', handlerReturning(JobOutcomes.done()).handler);
    const target = new Date(deps.clock.now().getTime() + 10 * 86_400_000);
    const job = await scheduleJob(deps, { runAt: target });
    rig.clock.set(new Date(deps.clock.now().getTime() + 601_200_000));
    await fakes.scheduler.runDue();
    const hopped = await getJob(deps.db, job.id);
    expect(hopped?.hops).toBe(1);
    // QStash delivers the first message once more (at-least-once).
    expect(await runJob(deps, { jobId: job.id, messageId: job.externalId, retried: 0 }, registry)).toEqual({ status: 200, outcome: 'hopped' });
    expect(await getJob(deps.db, job.id)).toMatchObject({ hops: 1, externalId: hopped?.externalId });
    expect(fakes.scheduler.pending()).toHaveLength(1);
  });
});

// Sequential replays (PLAN §12 "Locking and race semantics"): crash and redelivery, concurrent hops,
// a sweeper racing a delivery. Each guarded write must change nothing for the loser.
describe('sequential replays of claims and re-publishes', () => {
  it('a crashed attempt’s late finish or release changes nothing once another attempt has claimed the job', async () => {
    const { deps } = rig;
    const job = await scheduleJob(deps);
    expect(await claimJob(deps.db, job.id, 'attempt-a', deps.clock.now())).toMatchObject({ attemptId: 'attempt-a' });
    rig.clock.advance({ minutes: 7 });
    expect(await claimJob(deps.db, job.id, 'attempt-b', deps.clock.now())).toMatchObject({ attemptId: 'attempt-b', attempts: 2 });

    expect(await finishJob(deps.db, job, 'attempt-a', 'done', deps.clock.now())).toBe(false);
    expect(await finishJob(deps.db, job, 'attempt-a', 'failed', deps.clock.now(), 'late_error')).toBe(false);
    expect(await releaseJob(deps.db, job, 'attempt-a', 'late_error')).toBe(false);
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'running', attemptId: 'attempt-b', lastErrorCode: null });
    expect(await finishJob(deps.db, job, 'attempt-b', 'done', deps.clock.now())).toBe(true);
  });

  it('two re-publishes from the same stale hops: only the first moves the job, and one :h1 message exists', async () => {
    const { deps, fakes } = rig;
    const job = await scheduleJob(deps);
    const later = new Date(deps.clock.now().getTime() + 30 * MINUTE);
    expect(await republishJob(deps, job, later, { type: 'hops', hops: 0 })).not.toBeNull();
    expect(await republishJob(deps, job, later, { type: 'hops', hops: 0 })).toBeNull();
    expect(await getJob(deps.db, job.id)).toMatchObject({ hops: 1, runAt: later });
    expect(fakes.scheduler.pending().map((m) => m.dedupeId).filter((id) => id.includes(':h'))).toEqual(['fake-local:poll:test:1:h1']);
  });

  it('the sweeper’s fail compare-and-set loses to a re-publish that moved the job meanwhile', async () => {
    const { deps } = rig;
    const stale = await scheduleJob(deps);
    expect(await republishJob(deps, stale, deps.clock.now(), { type: 'hops', hops: 0 })).not.toBeNull();
    expect(await failJobIfUnchanged(deps, stale)).toBeNull();
    expect(await getJob(deps.db, stale.id)).toMatchObject({ status: 'scheduled', hops: 1 });
  });

  it('a final transient delivery that lost its lease runs no failure path and fails nothing', async () => {
    const { deps } = rig;
    const failures: string[] = [];
    registry.registerFailurePath('portal_poll', async (_deps, _job, info) => {
      failures.push(info.reason);
    });
    registry.register('portal_poll', async (_deps, job) => {
      // The attempt stalls past its lease; QStash's redelivery claims the job meanwhile.
      rig.clock.advance({ minutes: 7 });
      await claimJob(deps.db, job.id, 'attempt-b', rig.clock.now());
      throw new TransientError('hubspot_server_error');
    });
    const job = await scheduleJob(deps);
    const result = await runJob(deps, { jobId: job.id, messageId: job.externalId, retried: 4 }, registry);
    expect(result).toEqual({ status: 200, outcome: 'lease_lost' });
    expect(failures).toEqual([]);
    expect(alerts.filter((a) => a.code === 'job_failed')).toEqual([]);
    expect(await getJob(deps.db, job.id)).toMatchObject({ status: 'running', attemptId: 'attempt-b' });
  });
});

