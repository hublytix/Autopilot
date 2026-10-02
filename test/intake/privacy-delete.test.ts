import { beforeEach, describe, expect, it } from 'vitest';
import { insertJob, publishJobs } from '@/server/jobs';
import type { HubSpotClient } from '@/server/ports';
import { mintActionTokens, verifyActionToken } from '@/server/security/action-tokens';
import { pollPortal } from '@/server/services/intake';
import { revokeConnection } from '@/server/services/hubspot';
import { privacyDelete } from '@/server/services/privacy';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createIntakeRig, deliverWebhook, HOUR, jobsOf, leadsOf, MINUTE, type IntakeRig } from './support';

// The privacy_delete job (D-06, PLAN §12 "Intake"): removes content, revokes tokens, cancels jobs and
// sets stop_reason='privacy_deletion', for every lead of the contact, whatever the account's state.

const getDb = setUpTestDb();

let rig: IntakeRig;

beforeEach(async () => {
  rig = await createIntakeRig(getDb());
});

interface Seeded {
  tomLeads: string[];
  mayaLead: string;
  tokens: string[];
  followupJobId: string;
  oldKeys: Map<string, string | null>;
}

/** Two leads for Tom (contact 102), one for Maya (101), a draft, buttons and a pending follow-up for Tom's first. */
async function seedLeads(): Promise<Seeded> {
  const db = getDb();
  rig.hubspot.submitForm({ formId: rig.contactUs, email: 'tom.reyes@example.org', message: 'Faucets, please.', at: rig.clock.now() });
  rig.hubspot.submitForm({ formId: rig.quote, email: 'maya.okafor@example.com', message: 'Water heater.', at: rig.clock.now() });
  rig.clock.advance(MINUTE);
  rig.hubspot.submitForm({ formId: rig.quote, email: 'tom.reyes@example.org', message: 'And the shower valve.', at: rig.clock.now() });
  await pollPortal(rig.deps, rig.accountId, 'webhook', { sleep: rig.sleep });
  const leads = await leadsOf(db, rig.accountId);
  const tomLeads = leads.filter((lead) => lead.hubspot_contact_id === '102').map((lead) => lead.id);
  const mayaLead = leads.find((lead) => lead.hubspot_contact_id === '101')?.id;
  const first = tomLeads[0];
  if (tomLeads.length !== 2 || mayaLead === undefined || first === undefined) throw new Error('leads not seeded');

  const now = rig.clock.now();
  const purgeAt = new Date(now.getTime() + 30 * 24 * HOUR);
  for (const leadId of [first, mayaLead]) {
    await db.query(
      `insert into drafts (lead_id, account_id, kind, subject, body, flags, purge_at) values ($1, $2, 'initial', $3, $4, $5, $6)`,
      [leadId, rig.accountId, 'Your faucet quote', 'Hi, thanks for reaching out.', ['urgent'], purgeAt],
    );
  }
  const minted = await mintActionTokens(db, {
    accountId: rig.accountId,
    leadId: first,
    notificationKey: `notify:${first}:initial:r0`,
    purposes: ['send', 'edit', 'dismiss'],
    now,
  });
  const followup = await db.tx((tx) =>
    insertJob(tx, { kind: 'followup', accountId: rig.accountId, leadId: first, dedupeKey: `lead:${first}:fu:1:s0`, runAt: new Date(now.getTime() + 48 * HOUR), now, seq: 1 }),
  );
  if (followup === null) throw new Error('follow-up not inserted');
  await publishJobs(rig.deps, [followup]);
  // The lead_process jobs run (stand-in handler) before the deletion arrives.
  await rig.fakes.scheduler.runDue(now);
  const oldKeys = new Map(leads.map((lead) => [lead.id, lead.submission_key]));
  return { tomLeads, mayaLead, tokens: Object.values(minted), followupJobId: followup.id, oldKeys };
}

async function contentCount(leadIds: readonly string[]): Promise<number> {
  const row = await getDb().one<{ n: string }>(`select count(*) as n from lead_messages where lead_id = any($1::uuid[])`, [leadIds]);
  return Number(row.n);
}

describe('privacy_delete', () => {
  it.each([
    ['paused', `update accounts set paused_at = $2, processing_state = 'paused' where id = $1`],
    [
      'disconnected',
      `with c as (update hubspot_connections set status = 'disconnected', access_token_enc = null, refresh_token_enc = null, status_changed_at = $2
                   where account_id = $1)
       update accounts set processing_state = 'disconnected', disconnected_at = $2 where id = $1`,
    ],
  ])('removes the content, revokes tokens, cancels jobs and sets the stop reason, on a %s account', async (_state, sql) => {
    const seeded = await seedLeads();
    const [first] = seeded.tomLeads;
    await getDb().query(sql, [rig.accountId, rig.clock.now()]);

    const response = await deliverWebhook(rig, [{ subscriptionType: 'contact.privacyDeletion', objectId: '102' }]);
    expect(await response.json()).toMatchObject({ privacyDeletesQueued: 1 });
    await rig.fakes.scheduler.runDue(rig.clock.now());
    const [job] = await jobsOf(getDb(), 'privacy_delete');
    expect(job?.status).toBe('done');

    // Content gone for both of Tom's leads; Maya's untouched.
    expect(await contentCount(seeded.tomLeads)).toBe(0);
    expect(await contentCount([seeded.mayaLead])).toBe(1);
    const drafts = await getDb().query<{ lead_id: string; subject: string | null; body: string | null; flags: string[]; purged_at: Date | null }>(
      `select lead_id, subject, body, flags, purged_at from drafts order by lead_id`,
    );
    const tomDraft = drafts.find((draft) => draft.lead_id === first);
    expect(tomDraft).toMatchObject({ subject: null, body: null, flags: [] });
    expect(tomDraft?.purged_at).not.toBeNull();
    expect(drafts.find((draft) => draft.lead_id === seeded.mayaLead)).toMatchObject({ subject: 'Your faucet quote', flags: ['urgent'], purged_at: null });

    // Buttons revoked.
    for (const token of seeded.tokens) {
      for (const purpose of ['send', 'edit', 'dismiss'] as const) {
        const verified = await verifyActionToken(getDb(), token, purpose, rig.clock.now());
        expect(verified.ok).toBe(false);
      }
    }
    const tokens = await getDb().query<{ revoked_at: Date | null }>(`select revoked_at from action_tokens where lead_id = $1`, [first]);
    expect(tokens.every((token) => token.revoked_at !== null)).toBe(true);

    // The pending follow-up is cancelled, and its QStash message too.
    const followup = await getDb().one<{ status: string; cancel_reason: string | null; external_id: string | null }>(
      `select status, cancel_reason, external_id from scheduled_jobs where id = $1`,
      [seeded.followupJobId],
    );
    expect(followup).toMatchObject({ status: 'cancelled', cancel_reason: 'privacy_deletion' });
    expect(rig.fakes.scheduler.cancelled).toContain(followup.external_id);

    // Stop reason set; the submission key (an HMAC of the email or HubSpot's id) replaced.
    const leads = await leadsOf(getDb(), rig.accountId);
    for (const lead of leads.filter((row) => row.hubspot_contact_id === '102')) {
      expect(lead.stop_reason).toBe('privacy_deletion');
      expect(lead.submission_key).toMatch(/^[0-9a-f]{64}$/);
      expect(lead.submission_key).not.toBe(seeded.oldKeys.get(lead.id));
    }
    expect(leads.find((lead) => lead.id === seeded.mayaLead)).toMatchObject({ stop_reason: null, submission_key: seeded.oldKeys.get(seeded.mayaLead) });
  });

  it('still runs when the connection is revoked after the deletion was queued (D-06: whatever the state)', async () => {
    const seeded = await seedLeads();
    const response = await deliverWebhook(rig, [{ subscriptionType: 'contact.privacyDeletion', objectId: '102' }]);
    expect(await response.json()).toMatchObject({ privacyDeletesQueued: 1 });

    // Before QStash delivers the job, a refresh comes back revoked: the account-wide cancel runs.
    const connection = await getDb().one<{ token_version: number }>(`select token_version from hubspot_connections where id = $1`, [rig.connectionId]);
    const outcome = await revokeConnection(rig.deps, {
      accountId: rig.accountId,
      connectionId: rig.connectionId,
      tokenVersion: connection.token_version,
      reason: 'refresh_revoked',
    });
    expect(outcome).toBe('revoked');
    const followup = await getDb().one<{ status: string }>(`select status from scheduled_jobs where id = $1`, [seeded.followupJobId]);
    expect(followup.status).toBe('cancelled');
    expect((await jobsOf(getDb(), 'privacy_delete')).map((job) => job.status)).toEqual(['scheduled']);

    await rig.fakes.scheduler.runDue(rig.clock.now());
    expect((await jobsOf(getDb(), 'privacy_delete')).map((job) => job.status)).toEqual(['done']);
    expect(await contentCount(seeded.tomLeads)).toBe(0);
    expect(await contentCount([seeded.mayaLead])).toBe(1);
  });

  it('is idempotent: a replay finds nothing left to remove', async () => {
    const seeded = await seedLeads();
    const first = await privacyDelete(rig.deps, { accountId: rig.accountId, contactId: '102' });
    expect(first).toMatchObject({ leads: 2, messagesDeleted: 2, draftsCleared: 1, tokensRevoked: 3, jobsCancelled: 1 });
    const again = await privacyDelete(rig.deps, { accountId: rig.accountId, contactId: '102' });
    expect(again).toMatchObject({ leads: 2, messagesDeleted: 0, tokensRevoked: 0, jobsCancelled: 0 });
    expect(await contentCount([seeded.mayaLead])).toBe(1);
  });

  it('a contact deleted while a poll was resolving it never becomes a lead (the deletion ran first, finding none)', async () => {
    rig.hubspot.submitForm({ formId: rig.contactUs, email: 'tom.reyes@example.org', message: 'Faucets, please.', at: rig.clock.now() });
    rig.clock.advance(MINUTE);
    const real = rig.deps.hubspot;
    let raced = false;
    // Sequential replay of the race: the poll resolves the contact, then the privacy webhook arrives
    // and its job runs (no lead yet), then the poll inserts.
    const hubspot = new Proxy<HubSpotClient>(real, {
      get(target, prop) {
        if (prop === 'getContact') {
          return async (...args: Parameters<HubSpotClient['getContact']>) => {
            const contact = await target.getContact(...args);
            if (!raced) {
              raced = true;
              await deliverWebhook(rig, [{ subscriptionType: 'contact.privacyDeletion', objectId: '102' }]);
              await rig.fakes.scheduler.runDue(rig.clock.now());
            }
            return contact;
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await pollPortal({ ...rig.deps, hubspot }, rig.accountId, 'cron', { sleep: rig.sleep });
    expect(raced).toBe(true);
    expect((await jobsOf(getDb(), 'privacy_delete')).map((job) => job.status)).toEqual(['done']);
    expect(result).toMatchObject({ status: 'polled', counts: { leadsCreated: 0 } });
    expect(await leadsOf(getDb(), rig.accountId)).toEqual([]);
    expect(await getDb().query(`select lead_id from lead_messages`)).toEqual([]);
    expect(await jobsOf(getDb(), 'lead_process')).toEqual([]);

    // Another contact's lead is unaffected.
    rig.hubspot.submitForm({ formId: rig.quote, email: 'maya.okafor@example.com', message: 'Water heater.', at: rig.clock.now() });
    rig.clock.advance(MINUTE);
    await pollPortal(rig.deps, rig.accountId, 'cron', { sleep: rig.sleep });
    expect((await leadsOf(getDb(), rig.accountId)).map((lead) => lead.hubspot_contact_id)).toEqual(['101']);
  });

  it('a deleted contact is not re-ingested by later polls', async () => {
    await seedLeads();
    await privacyDelete(rig.deps, { accountId: rig.accountId, contactId: '102' });
    rig.hubspot.deleteContact('102');
    rig.clock.advance(5 * MINUTE);
    await pollPortal(rig.deps, rig.accountId, 'cron', { sleep: rig.sleep });
    const leads = await leadsOf(getDb(), rig.accountId);
    expect(leads.filter((lead) => lead.hubspot_contact_id === '102')).toHaveLength(2);
    expect(await contentCount(leads.map((lead) => lead.id))).toBe(1);
  });
});
