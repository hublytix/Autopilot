import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintActionTokens } from '@/server/security/action-tokens';
import { applyProcessingState } from '@/server/services/accounts/apply-processing-state';
import { revokeConnection } from '@/server/services/hubspot/revoke';
import { NotificationKeys } from '@/server/services/notifications/predicates';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createLeadsRig, insertPrivacyJob, leadJobs, seedNotifiedLead, seedOwnedAccount, type LeadsRig } from './support';

// Revoke and disconnect (PLAN §6.1 "→ revoked / disconnected: cancel jobs; revoke action tokens",
// §9.1, D-48): a notified lead's follow-up jobs are cancelled (their QStash messages after commit) and
// its action-link tokens revoked; a privacy deletion still runs (D-06: every known portal, any state).

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

async function notifiedLeadWithTokens() {
  const db = getDb();
  const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
  const lead = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
  await mintActionTokens(db, {
    accountId: owned.accountId,
    leadId: lead.leadId,
    notificationKey: NotificationKeys.initial(lead.leadId, 0),
    purposes: ['send', 'edit', 'dismiss'],
    now: rig.clock.now(),
  });
  const privacy = await insertPrivacyJob(rig, { accountId: owned.accountId, leadId: lead.leadId });
  const connection = await db.one<{ id: string; token_version: number }>(`select id, token_version from hubspot_connections where account_id = $1`, [
    owned.accountId,
  ]);
  return { ...owned, ...lead, privacy, connection };
}

async function expectLeadShutDown(lead: Awaited<ReturnType<typeof notifiedLeadWithTokens>>, reason: string): Promise<void> {
  const db = getDb();
  const jobs = await leadJobs(db, lead.leadId);
  expect(jobs.map((job) => [job.kind, job.status, job.cancel_reason])).toEqual([
    ['followup', 'cancelled', reason],
    ['followup', 'cancelled', reason],
    ['privacy_delete', 'scheduled', null],
  ]);
  expect(rig.fakes.scheduler.cancelled).toEqual(expect.arrayContaining(lead.jobs.map((job) => job.externalId)));
  expect(rig.fakes.scheduler.cancelled).not.toContain(lead.privacy.externalId);
  const tokens = await db.query<{ revoked_at: Date | null }>(`select revoked_at from action_tokens where lead_id = $1`, [lead.leadId]);
  expect(tokens).toHaveLength(3);
  expect(tokens.every((token) => token.revoked_at !== null)).toBe(true);
  // Its follow-ups will not come back after a reconnect: the stream's end is recorded (D-72), so the
  // lead can read "No reply from lead" instead of "follow-ups pending" forever.
  expect(await db.one(`select stop_reason from leads where id = $1`, [lead.leadId])).toEqual({ stop_reason: 'account_inactive' });
}

describe('revoke and disconnect', () => {
  it('a revoked connection cancels the follow-up jobs and revokes the action tokens, but keeps the privacy deletion', async () => {
    const lead = await notifiedLeadWithTokens();
    rig.clock.advance({ hours: 1 });

    expect(await revokeConnection(rig.deps, { accountId: lead.accountId, connectionId: lead.connection.id, tokenVersion: lead.connection.token_version, reason: 'refresh_revoked' })).toBe(
      'revoked',
    );

    await expectLeadShutDown(lead, 'revoked');
  });

  it('a disconnect does the same', async () => {
    const lead = await notifiedLeadWithTokens();
    rig.clock.advance({ hours: 1 });
    await getDb().query(`update hubspot_connections set status = 'disconnected', access_token_enc = null, refresh_token_enc = null where id = $1`, [lead.connection.id]);

    expect(await applyProcessingState(rig.deps, lead.accountId)).toMatchObject({ next: 'disconnected', transitioned: true });

    await expectLeadShutDown(lead, 'disconnected');
  });

  it('a revoke keeps a stop reason the lead already had, and leaves leads without pending follow-ups alone', async () => {
    const lead = await notifiedLeadWithTokens();
    const other = await seedNotifiedLead(rig, { accountId: lead.accountId, firstNotifiedAt: rig.clock.now(), contactId: '7001' });
    const db = getDb();
    await db.query(`update leads set stop_reason = 'opted_out' where id = $1`, [lead.leadId]);
    await db.query(`update scheduled_jobs set status = 'done' where lead_id = $1 and kind = 'followup'`, [other.leadId]);
    rig.clock.advance({ hours: 1 });

    await revokeConnection(rig.deps, { accountId: lead.accountId, connectionId: lead.connection.id, tokenVersion: lead.connection.token_version, reason: 'refresh_revoked' });

    expect(await db.one(`select stop_reason from leads where id = $1`, [lead.leadId])).toEqual({ stop_reason: 'opted_out' });
    expect(await db.one(`select stop_reason from leads where id = $1`, [other.leadId])).toEqual({ stop_reason: null });
  });

  it('a pause cancels nothing and revokes nothing', async () => {
    const lead = await notifiedLeadWithTokens();
    await getDb().query(`update accounts set paused_at = $2 where id = $1`, [lead.accountId, rig.clock.now()]);

    expect(await applyProcessingState(rig.deps, lead.accountId)).toMatchObject({ next: 'paused', transitioned: true });

    expect((await leadJobs(getDb(), lead.leadId)).map((job) => job.status)).toEqual(['scheduled', 'scheduled', 'scheduled']);
    const tokens = await getDb().query<{ revoked_at: Date | null }>(`select revoked_at from action_tokens where lead_id = $1`, [lead.leadId]);
    expect(tokens.every((token) => token.revoked_at === null)).toBe(true);
  });
});
