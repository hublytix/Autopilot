import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveLeadStatus } from '@/server/domain/lead-status';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import type { LLM } from '@/server/ports/llm';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth/owner-scope';
import { followUpDedupeKey } from '@/server/services/followups/schedule';
import { revokeConnection } from '@/server/services/hubspot';
import { dismissLeadForOwner, pauseAll, resumeAll } from '@/server/services/owner-controls';
import { applySignals } from '@/server/services/signals';
import { useTestDb as setUpTestDb } from '../db/harness';
import {
  at,
  createFollowUpRig,
  DAY,
  deliverWhenDue,
  followUpJobs,
  HOUR,
  jobById,
  LEAD_EMAIL,
  leadRow,
  MINUTE,
  notifications,
  seedFollowUpLead,
  sent,
  type FollowUpLeadSeed,
  type FollowUpRig,
} from './support';

// The follow-up hard stops through the job (PLAN §6.2 stop table, §9.5 steps 2-3, D-08, D-09, D-14,
// D-44): each stop ends the job `skipped` with no draft call and no email; lead stops (contact
// deleted, opted out, bounced, superseded) are stored and cancel the remaining follow-up; stops that
// arrive between the claim and the send are caught by the reservation predicates (or the lost
// claim); and a stream that ends without its email records why, so the lead's status moves on
// (D-66 open point (2)).

const getDb = setUpTestDb();
let rig: FollowUpRig;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createFollowUpRig(getDb());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function ownerScope(): Promise<OwnerScope> {
  const row = await getDb().one<{ owner_user_id: string }>(`select owner_user_id from accounts where id = $1`, [rig.accountId]);
  return createOwnerScopeForTest(rig.accountId, row.owner_user_id);
}

function fu(lead: FollowUpLeadSeed, n: 1 | 2): { id: string } {
  const job = lead.jobs[n - 1];
  if (job === undefined) throw new Error(`no fu${n} job`);
  return job;
}

interface StopCase {
  readonly name: string;
  readonly arrange: (lead: FollowUpLeadSeed) => Promise<void>;
  /** `leads.stop_reason` after follow-up 1's job. */
  readonly storedReason: string | null;
  /** Follow-up 2's job after it. */
  readonly fu2: { status: string; cancel_reason: string | null };
  /** Whether the job read HubSpot first (the contact stops). */
  readonly readsHubSpot: boolean;
}

const SCHEDULED = { status: 'scheduled', cancel_reason: null };

const STOP_MATRIX: readonly StopCase[] = [
  {
    name: 'dismissed',
    arrange: async (lead) => {
      await getDb().query(`update leads set dismissed_at = $2, stop_reason = 'dismissed' where id = $1`, [lead.leadId, rig.clock.now()]);
    },
    storedReason: 'dismissed',
    fu2: SCHEDULED,
    readsHubSpot: false,
  },
  {
    name: 'replied (recorded earlier)',
    arrange: async (lead) => {
      await getDb().query(`update leads set replied_at = $2, stop_reason = 'replied' where id = $1`, [lead.leadId, at(lead.t0, DAY)]);
    },
    storedReason: 'replied',
    fu2: SCHEDULED,
    readsHubSpot: false,
  },
  {
    // D-06: the deletion cancels the lead's jobs; this is a job that still runs (its cancel lost).
    name: 'privacy deletion (stored stop reason, content deleted)',
    arrange: async (lead) => {
      await getDb().query(`update leads set stop_reason = 'privacy_deletion' where id = $1`, [lead.leadId]);
      await getDb().query(`delete from lead_messages where lead_id = $1`, [lead.leadId]);
    },
    storedReason: 'privacy_deletion',
    fu2: SCHEDULED,
    readsHubSpot: false,
  },
  {
    name: 'a stored test_lead stop reason (D-14, defensive)',
    arrange: async (lead) => {
      await getDb().query(`update leads set stop_reason = 'test_lead' where id = $1`, [lead.leadId]);
    },
    storedReason: 'test_lead',
    fu2: SCHEDULED,
    readsHubSpot: false,
  },
  {
    name: 'a stored stop reason (opted out at an earlier read)',
    arrange: async (lead) => {
      await getDb().query(`update leads set stop_reason = 'opted_out' where id = $1`, [lead.leadId]);
    },
    storedReason: 'opted_out',
    // A lead stop never clears on its own: the rest of the stream goes too.
    fu2: { status: 'cancelled', cancel_reason: 'opted_out' },
    readsHubSpot: false,
  },
  {
    name: 'account paused',
    arrange: async () => {
      await pauseAll(rig.deps, await ownerScope());
    },
    // Follow-up 2 may still go after a resume: the stream stays open.
    storedReason: null,
    fu2: SCHEDULED,
    readsHubSpot: false,
  },
  {
    name: 'account inactive (trial over, not entitled)',
    arrange: async () => {
      await getDb().query(`update accounts set processing_state = 'inactive' where id = $1`, [rig.accountId]);
    },
    storedReason: null,
    fu2: SCHEDULED,
    readsHubSpot: false,
  },
  {
    name: 'connection not active',
    arrange: async () => {
      await getDb().query(`update hubspot_connections set status = 'disconnected' where account_id = $1`, [rig.accountId]);
    },
    storedReason: null,
    fu2: SCHEDULED,
    readsHubSpot: false,
  },
  {
    name: 'follow-ups switched off',
    arrange: async () => {
      await getDb().query(`update settings set followups_enabled = false where account_id = $1`, [rig.accountId]);
    },
    storedReason: null,
    fu2: SCHEDULED,
    readsHubSpot: false,
  },
  {
    name: 'superseded by a newer notified lead of the same contact (D-44)',
    arrange: async (lead) => {
      rig.clock.advance({ hours: 1 });
      await seedFollowUpLead(rig, { contactId: lead.contactId, submittedAt: at(lead.t0, 30 * MINUTE), followUps: false });
    },
    storedReason: 'superseded',
    fu2: { status: 'cancelled', cancel_reason: 'superseded' },
    readsHubSpot: false,
  },
  {
    name: 'contact deleted in HubSpot (404)',
    arrange: async (lead) => {
      rig.hubspot.deleteContact(lead.contactId);
    },
    storedReason: 'contact_deleted',
    fu2: { status: 'cancelled', cancel_reason: 'contact_deleted' },
    readsHubSpot: true,
  },
  {
    name: 'opted out of email in HubSpot',
    arrange: async (lead) => {
      rig.hubspot.optOut(lead.contactId);
    },
    storedReason: 'opted_out',
    fu2: { status: 'cancelled', cancel_reason: 'opted_out' },
    readsHubSpot: true,
  },
  {
    name: 'hard bounce',
    arrange: async (lead) => {
      rig.hubspot.hardBounce(lead.contactId);
    },
    storedReason: 'bounced',
    fu2: { status: 'cancelled', cancel_reason: 'bounced' },
    readsHubSpot: true,
  },
  {
    // D-09 extended (D-73): the owner's send to the lead bounced, logged in HubSpot.
    name: 'a send to the lead that bounced (EMAIL status BOUNCED)',
    arrange: async (lead) => {
      rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(lead.t0, HOUR), status: 'BOUNCED' });
    },
    storedReason: 'bounced',
    fu2: { status: 'cancelled', cancel_reason: 'bounced' },
    readsHubSpot: true,
  },
  {
    name: 'bad address',
    arrange: async (lead) => {
      rig.hubspot.updateContact(lead.contactId, { hs_email_bad_address: 'true' });
    },
    storedReason: 'bounced',
    fu2: { status: 'cancelled', cancel_reason: 'bounced' },
    readsHubSpot: true,
  },
];

describe('followup job: the stop matrix (PLAN §6.2)', () => {
  for (const c of STOP_MATRIX) {
    it(`${c.name}: skipped, no draft, no email`, async () => {
      const db = getDb();
      const lead = await seedFollowUpLead(rig);
      await c.arrange(lead);
      const getContact = vi.spyOn(rig.hubspot, 'getContact');

      expect(await deliverWhenDue(rig, fu(lead, 1))).toEqual({ status: 200, outcome: 'skipped' });

      expect(sent(rig)).toEqual([]);
      expect(await notifications(db, lead.leadId)).toEqual([]);
      expect(rig.fakes.llm.callsFor('followup')).toEqual([]);
      expect(getContact.mock.calls.length > 0).toBe(c.readsHubSpot);
      const row = await leadRow(db, lead.leadId);
      expect(row.stop_reason).toBe(c.storedReason);
      expect(row.fu1_notified_at).toBeNull();
      expect(await followUpJobs(db, lead.leadId)).toEqual([
        { dedupe_key: followUpDedupeKey(lead.leadId, 1, 0), status: 'skipped', cancel_reason: null },
        { dedupe_key: followUpDedupeKey(lead.leadId, 2, 0), ...c.fu2 },
      ]);
    });
  }

  it('a merged contact is re-mapped and the follow-up goes out', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const other = rig.hubspot.createContact({ email: 'maya.work@okafor-bakery.example', firstName: 'Maya', lastName: 'Okafor', at: lead.t0 });
    const merged = rig.hubspot.mergeContact(lead.contactId, other);

    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ outcome: 'done' });

    expect(sent(rig).map((m) => m.kind)).toEqual(['follow_up']);
    expect(await db.one(`select hubspot_contact_id from leads where id = $1`, [lead.leadId])).toEqual({ hubspot_contact_id: merged });
  });

  it('a test lead never gets a follow-up: nothing read, drafted, sent or written', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig, { followUps: false });
    await db.query(`update leads set is_test = true, stop_reason = 'test_lead', hubspot_contact_id = null, form_id = null, intake_trigger = 'inbox_check' where id = $1`, [
      lead.leadId,
    ]);
    const job = await db.tx((tx) =>
      insertJob(tx, {
        kind: 'followup',
        accountId: rig.accountId,
        leadId: lead.leadId,
        dedupeKey: followUpDedupeKey(lead.leadId, 1, 0),
        payload: { leadId: lead.leadId, n: 1, followupStream: 0 },
        runAt: at(lead.t0, 2 * DAY),
        now: rig.clock.now(),
        seq: 1,
      }),
    );
    if (job === null) throw new Error('no job');
    await publishJobs(rig.deps, [job]);
    const getContact = vi.spyOn(rig.hubspot, 'getContact');

    expect(await deliverWhenDue(rig, job)).toEqual({ status: 200, outcome: 'skipped' });

    expect(getContact).not.toHaveBeenCalled();
    expect(sent(rig)).toEqual([]);
    expect(rig.fakes.llm.callsFor('followup')).toEqual([]);
    expect(await leadRow(db, lead.leadId)).toMatchObject({ stop_reason: 'test_lead', fu1_notified_at: null, send_confirmed_at: null });
    expect(await db.one(`select signals_checked_at from leads where id = $1`, [lead.leadId])).toEqual({ signals_checked_at: null });
  });

  it('a third follow-up is never sent: max_followups ends the stream', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig, { followUps: false });
    const job = await db.tx((tx) =>
      insertJob(tx, {
        kind: 'followup',
        accountId: rig.accountId,
        leadId: lead.leadId,
        dedupeKey: followUpDedupeKey(lead.leadId, 2, 0).replace(':fu:2:', ':fu:3:'),
        payload: { leadId: lead.leadId, n: 3, followupStream: 0 },
        runAt: at(lead.t0, 8 * DAY),
        now: rig.clock.now(),
        seq: 3,
      }),
    );
    if (job === null) throw new Error('no job');

    expect(await deliverWhenDue(rig, job)).toEqual({ status: 200, outcome: 'skipped' });

    expect(sent(rig)).toEqual([]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('max_followups');
  });

  it('a job of an older follow-up stream ("Resume follow-ups" started a new one) is skipped and changes nothing', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    await db.query(`update leads set followup_stream = 1 where id = $1`, [lead.leadId]);
    const getContact = vi.spyOn(rig.hubspot, 'getContact');

    expect(await deliverWhenDue(rig, fu(lead, 1))).toEqual({ status: 200, outcome: 'skipped' });

    expect(getContact).not.toHaveBeenCalled();
    expect(sent(rig)).toEqual([]);
    expect(await leadRow(db, lead.leadId)).toMatchObject({ stop_reason: null, followup_stream: 1 });
    expect((await jobById(db, fu(lead, 2).id)).status).toBe('scheduled');
  });
});

/** An LLM whose follow-up drafting first runs `during` (something the owner or HubSpot does meanwhile). */
function llmWith(during: () => Promise<void>): LLM {
  const llm = rig.deps.llm;
  return {
    classify: (input, options) => llm.classify(input, options),
    generateBrief: (input, options) => llm.generateBrief(input, options),
    draft: (input, options) => llm.draft(input, options),
    draftFollowUp: async (input, options) => {
      await during();
      return llm.draftFollowUp(input, options);
    },
  };
}

describe('followup job: stops that arrive between the claim and the send', () => {
  it('"Not a real lead" during drafting cancels the job: its claim is lost and nothing is sent', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const scope = await ownerScope();
    const llm = llmWith(async () => {
      await dismissLeadForOwner(rig.deps, scope, lead.leadId);
    });

    expect(await deliverWhenDue(rig, fu(lead, 1), { deps: { ...rig.deps, llm } })).toEqual({ status: 200, outcome: 'lease_lost' });

    expect(sent(rig)).toEqual([]);
    expect(await notifications(db, lead.leadId)).toEqual([]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('dismissed');
    expect(await followUpJobs(db, lead.leadId)).toMatchObject([
      { status: 'cancelled', cancel_reason: 'dismissed' },
      { status: 'cancelled', cancel_reason: 'dismissed' },
    ]);
  });

  it('a dismissal that leaves the job running (the reservation predicates refuse the send)', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const llm = llmWith(async () => {
      await db.query(`update leads set dismissed_at = $2, stop_reason = 'dismissed' where id = $1`, [lead.leadId, rig.clock.now()]);
    });

    expect(await deliverWhenDue(rig, fu(lead, 1), { deps: { ...rig.deps, llm } })).toEqual({ status: 200, outcome: 'skipped' });

    expect(sent(rig)).toEqual([]);
    expect(await notifications(db, lead.leadId)).toEqual([]);
    expect((await leadRow(db, lead.leadId)).fu1_notified_at).toBeNull();
  });

  it('Pause all during drafting: no email, and follow-up 2 still runs after Resume', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const scope = await ownerScope();
    const llm = llmWith(async () => {
      await pauseAll(rig.deps, scope);
    });

    expect(await deliverWhenDue(rig, fu(lead, 1), { deps: { ...rig.deps, llm } })).toEqual({ status: 200, outcome: 'skipped' });
    expect(sent(rig)).toEqual([]);
    expect(await notifications(db, lead.leadId)).toEqual([]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBeNull();

    await resumeAll(rig.deps, scope);
    expect(await deliverWhenDue(rig, fu(lead, 2))).toMatchObject({ outcome: 'done' });
    expect(sent(rig).map((m) => m.subject)).toEqual(['Follow-up 2 for Maya — your draft is ready']);
  });

  it('HubSpot access revoked during drafting: the follow-ups are cancelled and nothing is sent', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const llm = llmWith(async () => {
      // The job's own read refreshed the token first: the revoke names the version now stored.
      const { token_version: tokenVersion } = await db.one<{ token_version: number }>(`select token_version from hubspot_connections where id = $1`, [rig.connectionId]);
      expect(await revokeConnection(rig.deps, { accountId: rig.accountId, connectionId: rig.connectionId, tokenVersion, reason: 'refresh_revoked' })).toBe('revoked');
    });

    expect(await deliverWhenDue(rig, fu(lead, 1), { deps: { ...rig.deps, llm } })).toEqual({ status: 200, outcome: 'lease_lost' });

    expect(sent(rig).filter((m) => m.kind === 'follow_up')).toEqual([]);
    expect(await notifications(db, lead.leadId)).toEqual([]);
    expect(await followUpJobs(db, lead.leadId)).toMatchObject([{ status: 'cancelled' }, { status: 'cancelled' }]);
  });

  it('a disconnect that has not cancelled the job yet: the reservation predicates refuse the send', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const llm = llmWith(async () => {
      await db.query(`update hubspot_connections set status = 'disconnected' where account_id = $1`, [rig.accountId]);
    });

    expect(await deliverWhenDue(rig, fu(lead, 1), { deps: { ...rig.deps, llm } })).toEqual({ status: 200, outcome: 'skipped' });

    expect(sent(rig)).toEqual([]);
    expect(await notifications(db, lead.leadId)).toEqual([]);
  });

  it('a newer lead of the contact notified during drafting supersedes this one: stored, follow-up 2 cancelled', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const llm = llmWith(async () => {
      await seedFollowUpLead(rig, { contactId: lead.contactId, submittedAt: at(lead.t0, DAY), followUps: false });
    });

    expect(await deliverWhenDue(rig, fu(lead, 1), { deps: { ...rig.deps, llm } })).toEqual({ status: 200, outcome: 'skipped' });

    expect(sent(rig)).toEqual([]);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('superseded');
    expect(await followUpJobs(db, lead.leadId)).toMatchObject([
      { status: 'skipped' },
      { status: 'cancelled', cancel_reason: 'superseded' },
    ]);
  });
});

describe('followup job: a stream that ends without its email (D-66 open point (2))', () => {
  async function statusOf(leadId: string) {
    const db = getDb();
    const row = await db.one<{
      processing_state: 'notified';
      classification: 'lead';
      classification_override: null;
      process_rev: number;
      stop_reason: 'account_inactive' | 'followups_off' | null;
      dismissed_at: Date | null;
      replied_at: Date | null;
      first_notified_at: Date | null;
      fu1_notified_at: Date | null;
      fu2_notified_at: Date | null;
      first_send_clicked_at: Date | null;
      send_confirmed_at: Date | null;
      signals_checked_at: Date | null;
      followups_enabled: boolean;
    }>(
      `select l.processing_state, l.classification, l.classification_override, l.process_rev, l.stop_reason, l.dismissed_at, l.replied_at,
              l.first_notified_at, l.fu1_notified_at, l.fu2_notified_at, l.first_send_clicked_at, l.send_confirmed_at, l.signals_checked_at, s.followups_enabled
         from leads l join settings s on s.account_id = l.account_id where l.id = $1`,
      [leadId],
    );
    return deriveLeadStatus(
      {
        processingState: row.processing_state,
        classification: row.classification,
        classificationOverride: row.classification_override,
        processRev: row.process_rev,
        stopReason: row.stop_reason,
        dismissedAt: row.dismissed_at,
        repliedAt: row.replied_at,
        firstNotifiedAt: row.first_notified_at,
        fu1NotifiedAt: row.fu1_notified_at,
        fu2NotifiedAt: row.fu2_notified_at,
        firstSendClickedAt: row.first_send_clicked_at,
        sendConfirmedAt: row.send_confirmed_at,
        signalsCheckedAt: row.signals_checked_at,
        followupsEnabled: row.followups_enabled,
        // The follow-up rig's account logs everything (log_all) with the email scope.
        repliesLogged: true,
      },
      rig.clock.now(),
    );
  }

  it('paused through both follow-ups: the last one records account_inactive; "No reply from lead" only once HubSpot was read (D-73)', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    await pauseAll(rig.deps, await ownerScope());

    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ outcome: 'skipped' });
    expect((await leadRow(db, lead.leadId)).stop_reason).toBeNull();
    expect(await deliverWhenDue(rig, fu(lead, 2))).toMatchObject({ outcome: 'skipped' });

    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('account_inactive');
    await resumeAll(rig.deps, await ownerScope());
    // Nobody read HubSpot after the first email: no "none logged" claim (law 3).
    expect(await statusOf(lead.leadId)).toBe('drafted');
    // The lead page's refresh reads it in full: now the claim is true.
    expect(await applySignals(rig.deps, lead.leadId, { caller: 'refresh', sleep: rig.sleep, notifications: rig.notifications })).toMatchObject({
      emailsAvailable: true,
      replied: false,
    });
    expect(await statusOf(lead.leadId)).toBe('no_reply');
    expect(sent(rig)).toEqual([]);
  });

  it('paused through both follow-ups with a reply logged during the pause: the read finds it, never "none logged"', async () => {
    const lead = await seedFollowUpLead(rig);
    await pauseAll(rig.deps, await ownerScope());
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(lead.t0, DAY) });
    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ outcome: 'skipped' });
    expect(await deliverWhenDue(rig, fu(lead, 2))).toMatchObject({ outcome: 'skipped' });
    await resumeAll(rig.deps, await ownerScope());

    expect(await statusOf(lead.leadId)).toBe('drafted');
    await applySignals(rig.deps, lead.leadId, { caller: 'refresh', sleep: rig.sleep, notifications: rig.notifications });
    expect(await statusOf(lead.leadId)).toBe('replied');
  });

  it('follow-ups switched off before follow-up 2, then on again: the stream stays ended (followups_off)', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ outcome: 'done' });
    await db.query(`update settings set followups_enabled = false where account_id = $1`, [rig.accountId]);

    expect(await deliverWhenDue(rig, fu(lead, 2))).toMatchObject({ outcome: 'skipped' });

    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('followups_off');
    await db.query(`update settings set followups_enabled = true where account_id = $1`, [rig.accountId]);
    rig.clock.advance({ days: 2 });
    expect(await statusOf(lead.leadId)).toBe('no_reply');
  });

  it('the content purged before follow-up 2: skipped without a draft, and the stream ends', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ outcome: 'done' });
    await db.query(`delete from lead_messages where lead_id = $1`, [lead.leadId]);

    expect(await deliverWhenDue(rig, fu(lead, 2))).toMatchObject({ outcome: 'skipped' });

    expect(sent(rig).map((m) => m.subject)).toEqual(['Follow-up 1 for Maya — your draft is ready']);
    expect((await leadRow(db, lead.leadId)).stop_reason).toBe('max_followups');
  });
});
