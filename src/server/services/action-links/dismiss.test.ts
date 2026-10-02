import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../../../../test/db/harness';
import { createJobRegistry, insertJob } from '@/server/jobs';
import { getJob } from '@/server/jobs/rows';
import { createJobTestRig, TEST_START, type JobTestRig } from '@/server/jobs/testing';
import { dismissLead, resolveDismissLink } from './dismiss';
import { seedSendableLead } from './testing';

// The dismiss service (PLAN §6.2 "dismiss POST → dismissed_at, jobs cancelled", D-45 single use).
// Route-level behaviour (origin, pages, rate limits) is in http/action-links/dismiss.test.ts.

describe('dismissLead', () => {
  const getDb = useTestDb();
  let rig: JobTestRig;

  beforeEach(() => {
    rig = createJobTestRig(getDb(), createJobRegistry(), { start: TEST_START });
  });

  it("cancels the lead's running lead_process job too, but never a privacy deletion", async () => {
    const lead = await seedSendableLead(getDb(), { now: TEST_START });
    const now = rig.clock.now();
    const [processJob, privacyJob] = await getDb().tx(async (tx) => [
      await insertJob(tx, { kind: 'lead_process', accountId: lead.accountId, leadId: lead.leadId, dedupeKey: `lead:${lead.leadId}:process:r0`, runAt: now, now }),
      await insertJob(tx, { kind: 'privacy_delete', accountId: lead.accountId, leadId: lead.leadId, dedupeKey: `privacy:1:2:${now.getTime()}`, runAt: now, now }),
    ]);
    if (processJob === null || privacyJob === null) throw new Error('jobs not inserted');
    await getDb().query(`update scheduled_jobs set status = 'running', lease_until = $2 where id = $1`, [processJob.id, new Date(now.getTime() + 60_000)]);

    expect(await dismissLead(rig.deps, { token: lead.dismissToken, ip: '203.0.113.7' })).toEqual({ type: 'dismissed', cancelledJobs: 1 });
    expect(await getJob(getDb(), processJob.id)).toMatchObject({ status: 'cancelled', cancelReason: 'dismissed' });
    expect((await getJob(getDb(), privacyJob.id))?.status).toBe('scheduled');
  });

  it('reads a used token as dismissed, and using it again changes nothing', async () => {
    const lead = await seedSendableLead(getDb(), { now: TEST_START });
    expect(await resolveDismissLink(rig.deps, { token: lead.dismissToken, ip: '203.0.113.7' })).toEqual({ type: 'confirm' });
    expect(await dismissLead(rig.deps, { token: lead.dismissToken, ip: '203.0.113.7' })).toEqual({ type: 'dismissed', cancelledJobs: 0 });
    expect(await resolveDismissLink(rig.deps, { token: lead.dismissToken, ip: '203.0.113.7' })).toEqual({ type: 'dismissed' });
    expect(await dismissLead(rig.deps, { token: lead.dismissToken, ip: '203.0.113.7' })).toEqual({ type: 'unchanged' });
  });
});
