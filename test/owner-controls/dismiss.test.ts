import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationPredicates } from '@/server/services/notifications/predicates';
import { dismissLead, dismissLeadForOwner } from '@/server/services/owner-controls';
import { useTestDb as setUpTestDb } from '../db/harness';
import { scheduleLeadProcess } from '../leads/support';
import {
  createLeadsRig,
  insertPrivacyJob,
  leadJobs,
  predicateHolds,
  seedNotifiedLead,
  seedOtherAccount,
  seedOwnedAccount,
  type LeadsRig,
} from './support';

// "Not a real lead" (PLAN §6.2 "dismiss → dismissed_at, jobs cancelled"), shared by the action link
// and the dashboard: idempotent, keeps an earlier stop reason, never cancels a privacy deletion, and
// a follow-up that is already past its stop check is caught by its reservation predicate.

const getDb = setUpTestDb();
let rig: LeadsRig;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createLeadsRig(getDb());
});

afterEach(() => {
  vi.useRealTimers();
});

async function leadState(leadId: string) {
  return getDb().one<{ dismissed_at: Date | null; stop_reason: string | null }>(`select dismissed_at, stop_reason from leads where id = $1`, [leadId]);
}

describe('dismissLead', () => {
  it("sets dismissed_at and stop_reason, cancels the lead's follow-ups (QStash after commit), never its privacy deletion", async () => {
    const db = getDb();
    const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
    const lead = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    const privacy = await insertPrivacyJob(rig, { accountId: owned.accountId, leadId: lead.leadId });
    rig.clock.advance({ hours: 1 });

    expect(await dismissLeadForOwner(rig.deps, owned.scope, lead.leadId)).toEqual({ type: 'dismissed', cancelledJobs: 2 });

    expect(await leadState(lead.leadId)).toEqual({ dismissed_at: rig.clock.now(), stop_reason: 'dismissed' });
    const jobs = await leadJobs(db, lead.leadId);
    expect(jobs.map((job) => [job.kind, job.status, job.cancel_reason])).toEqual([
      ['followup', 'cancelled', 'dismissed'],
      ['followup', 'cancelled', 'dismissed'],
      ['privacy_delete', 'scheduled', null],
    ]);
    expect(rig.fakes.scheduler.cancelled).toEqual(lead.jobs.map((job) => job.externalId));
    expect(rig.fakes.scheduler.cancelled).not.toContain(privacy.externalId);
  });

  it('is idempotent: a second dismiss keeps the first time and changes nothing', async () => {
    const owned = await seedOwnedAccount(getDb(), { now: rig.clock.now() });
    const lead = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    const first = rig.clock.now();
    await dismissLead(rig.deps, { accountId: owned.accountId, leadId: lead.leadId }, { via: 'action_link' });
    rig.clock.advance({ hours: 2 });

    expect(await dismissLead(rig.deps, { accountId: owned.accountId, leadId: lead.leadId }, { via: 'dashboard' })).toEqual({
      type: 'already_dismissed',
      cancelledJobs: 0,
    });
    expect(await leadState(lead.leadId)).toEqual({ dismissed_at: first, stop_reason: 'dismissed' });
  });

  it('keeps the first stop reason (a replied lead stays replied)', async () => {
    const db = getDb();
    const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
    const lead = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    await db.query(`update leads set replied_at = $2, stop_reason = 'replied' where id = $1`, [lead.leadId, rig.clock.now()]);

    expect(await dismissLeadForOwner(rig.deps, owned.scope, lead.leadId)).toMatchObject({ type: 'dismissed' });
    expect(await leadState(lead.leadId)).toEqual({ dismissed_at: rig.clock.now(), stop_reason: 'replied' });
  });

  it("cancels a lead's lead_process job too (a dismiss before it ran)", async () => {
    const db = getDb();
    const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
    const lead = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    await db.query(`update leads set processing_state = 'new' where id = $1`, [lead.leadId]);
    const job = await scheduleLeadProcess(rig, { accountId: owned.accountId, leadId: lead.leadId });

    expect(await dismissLeadForOwner(rig.deps, owned.scope, lead.leadId)).toEqual({ type: 'dismissed', cancelledJobs: 3 });
    expect(rig.fakes.scheduler.cancelled).toContain(job.externalId);
  });

  it('makes a follow-up already past its stop check fail its reservation predicate (dismiss during drafting)', async () => {
    const db = getDb();
    const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
    const lead = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    const scope = { accountId: owned.accountId, leadId: lead.leadId };
    expect(await predicateHolds(db, NotificationPredicates.followUp(scope, 1))).toBe(true);

    await dismissLeadForOwner(rig.deps, owned.scope, lead.leadId);

    expect(await predicateHolds(db, NotificationPredicates.followUp(scope, 1))).toBe(false);
  });

  it('changes nothing when the guard says no (the action link token was used meanwhile)', async () => {
    const owned = await seedOwnedAccount(getDb(), { now: rig.clock.now() });
    const lead = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });

    const outcome = await dismissLead(rig.deps, { accountId: owned.accountId, leadId: lead.leadId }, { via: 'action_link', guard: () => Promise.resolve(false) });

    expect(outcome).toEqual({ type: 'refused' });
    expect(await leadState(lead.leadId)).toEqual({ dismissed_at: null, stop_reason: null });
    expect((await leadJobs(getDb(), lead.leadId)).map((job) => job.status)).toEqual(['scheduled', 'scheduled']);
  });

  it("never touches another account's lead", async () => {
    const db = getDb();
    const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
    const lead = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    const other = await seedOtherAccount(db, rig.clock.now());

    expect(await dismissLeadForOwner(rig.deps, other.scope, lead.leadId)).toEqual({ type: 'not_found' });
    expect(await leadState(lead.leadId)).toEqual({ dismissed_at: null, stop_reason: null });
    expect((await leadJobs(db, lead.leadId)).map((job) => job.status)).toEqual(['scheduled', 'scheduled']);
  });
});
