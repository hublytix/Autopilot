import { beforeEach, describe, expect, it } from 'vitest';
import type { Deps } from '@/server/ports';
import { useTestDb as setUpTestDb } from '../../../test/db/harness';
import { CancelFilterRequiredError, cancelJobs, cancelJobsInTx, cancelScheduledMessages } from './cancel';
import { claimJob } from './claim';
import { runJob } from './dispatcher';
import { insertJob, publishJobs } from './outbox';
import { createJobRegistry, type JobRegistry } from './registry';
import { getJob } from './rows';
import { createJobTestRig, seedActiveAccount, seedLead, type JobTestRig } from './testing';
import { JobOutcomes, type JobRow } from './types';

const getDb = setUpTestDb();

let registry: JobRegistry;
let rig: JobTestRig;
let runs: string[];

beforeEach(() => {
  registry = createJobRegistry();
  rig = createJobTestRig(getDb(), registry);
  runs = [];
  registry.register('followup', async (_deps, job) => {
    runs.push(job.id);
    return JobOutcomes.done();
  });
});

async function followUp(deps: Deps, accountId: string, leadId: string, n: number): Promise<JobRow> {
  const now = deps.clock.now();
  const job = await deps.db.tx((tx) =>
    insertJob(tx, { kind: 'followup', accountId, leadId, dedupeKey: `lead:${leadId}:fu:${n}:s0`, runAt: new Date(now.getTime() + n * 86_400_000), now, seq: n }),
  );
  if (job === null) throw new Error('job not inserted');
  await publishJobs(deps, [job]);
  return (await getJob(deps.db, job.id)) ?? job;
}

describe('cancelJobs', () => {
  it('marks the lead’s jobs cancelled, cancels each message by id, and a late delivery does nothing', async () => {
    const { deps, fakes, clock } = rig;
    const { accountId } = await seedActiveAccount(getDb(), deps.clock.now());
    const leadId = await seedLead(getDb(), { accountId, now: deps.clock.now() });
    const otherLead = await seedLead(getDb(), { accountId, now: deps.clock.now() });
    const fu1 = await followUp(deps, accountId, leadId, 1);
    const fu2 = await followUp(deps, accountId, leadId, 2);
    const other = await followUp(deps, accountId, otherLead, 1);

    const cancelled = await cancelJobs(deps, { leadId, reason: 'dismissed' });
    expect(new Set(cancelled.jobIds)).toEqual(new Set([fu1.id, fu2.id]));
    expect(new Set(fakes.scheduler.cancelled)).toEqual(new Set([fu1.externalId, fu2.externalId]));
    expect(await getJob(deps.db, fu1.id)).toMatchObject({ status: 'cancelled', cancelReason: 'dismissed', finishedAt: deps.clock.now() });
    expect((await getJob(deps.db, other.id))?.status).toBe('scheduled');

    // A message that slipped through (cancel lost the race) answers 200 without running.
    expect(await runJob(deps, { jobId: fu1.id, messageId: fu1.externalId, retried: 0 }, registry)).toEqual({ status: 200, outcome: 'already_finished' });
    clock.advance({ days: 3 });
    await fakes.scheduler.runDue();
    expect(runs).toEqual([other.id]);
  });

  it('cancels a running job, so its attempt’s guarded writes change nothing', async () => {
    const { deps } = rig;
    const { accountId } = await seedActiveAccount(getDb(), deps.clock.now());
    const leadId = await seedLead(getDb(), { accountId, now: deps.clock.now() });
    const fu1 = await followUp(deps, accountId, leadId, 1);
    await claimJob(deps.db, fu1.id, 'attempt-a', deps.clock.now());
    await cancelJobs(deps, { leadId, reason: 'replied' });
    expect(await deps.db.query(`update scheduled_jobs set status = 'done' where id = $1 and attempt_id = 'attempt-a' and status = 'running' returning id`, [fu1.id])).toEqual([]);
    expect((await getJob(deps.db, fu1.id))?.status).toBe('cancelled');
  });

  it('filters by kind and leaves out the calling job', async () => {
    const { deps } = rig;
    const { accountId } = await seedActiveAccount(getDb(), deps.clock.now());
    const leadId = await seedLead(getDb(), { accountId, now: deps.clock.now() });
    const fu1 = await followUp(deps, accountId, leadId, 1);
    const fu2 = await followUp(deps, accountId, leadId, 2);
    const now = deps.clock.now();
    const process = await deps.db.tx((tx) =>
      insertJob(tx, { kind: 'lead_process', accountId, leadId, dedupeKey: `lead:${leadId}:process:r0`, runAt: now, now }),
    );
    const result = await deps.db.tx((tx) =>
      cancelJobsInTx(tx, { leadId, kinds: ['followup'], exceptJobId: fu2.id, reason: 'replied', now: deps.clock.now() }),
    );
    expect(result.jobIds).toEqual([fu1.id]);
    await cancelScheduledMessages(deps, result);
    expect((await getJob(deps.db, fu2.id))?.status).toBe('scheduled');
    expect((await getJob(deps.db, process?.id ?? ''))?.status).toBe('scheduled');
  });

  it('cancels by account', async () => {
    const { deps } = rig;
    const { accountId } = await seedActiveAccount(getDb(), deps.clock.now());
    const leadId = await seedLead(getDb(), { accountId, now: deps.clock.now() });
    await followUp(deps, accountId, leadId, 1);
    expect((await cancelJobs(deps, { accountId, reason: 'revoked' })).jobIds).toHaveLength(1);
  });

  it('refuses a cancel without a lead or account (never a bulk cancel)', async () => {
    const { deps } = rig;
    await expect(cancelJobs(deps, { reason: 'dismissed' })).rejects.toBeInstanceOf(CancelFilterRequiredError);
  });

  it('keeps going when a message cancel fails', async () => {
    const { deps } = rig;
    let attempted = 0;
    const failing: Deps = {
      ...deps,
      scheduler: {
        publish: deps.scheduler.publish.bind(deps.scheduler),
        cancel: async () => {
          attempted += 1;
          throw new Error('network');
        },
      },
    };
    await cancelScheduledMessages(failing, { jobIds: ['a', 'b'], messageIds: ['msg_a', 'msg_b'] });
    expect(attempted).toBe(2);
  });
});
