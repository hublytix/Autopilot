import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordFollowUpFailedNote } from '@/server/services/followups/notes';
import { pauseAll, resumeFollowUps } from '@/server/services/owner-controls';
import { leadDetailView, type LeadDetailView } from '@/server/views/dashboard';
import { useTestDb as setUpTestDb } from '../db/harness';
import {
  at,
  createLeadsRig,
  DAY,
  HOUR,
  markRepliedLikeTheJob,
  MINUTE,
  purgeContent,
  seedDraft,
  seedFilteredLead,
  seedLeadIn,
  seedNotifiedLead,
  seedOtherAccount,
  seedOwnedAccount,
  type LeadsRig,
  type OwnedAccount,
} from './support';

// /dashboard/leads/[id]'s read model (PLAN §7.5, D-31, D-32, D-42, D-47): the timeline in order with
// HubSpot's times, the drafts until purged, the lead's message defanged until purged, the controls
// that apply, and nothing for another account's lead or a malformed id.

const getDb = setUpTestDb();
let rig: LeadsRig;
let owned: OwnedAccount;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createLeadsRig(getDb());
  owned = await seedOwnedAccount(getDb(), { now: rig.clock.now() });
});

afterEach(() => {
  vi.useRealTimers();
});

async function detail(leadId: string): Promise<LeadDetailView> {
  const view = await leadDetailView(owned.scope, rig.deps, leadId);
  if (view === null) throw new Error('lead not found');
  return view;
}

describe('the lead page model', () => {
  it('is null for another account\'s lead and for an id that is not a uuid', async () => {
    const other = await seedOtherAccount(getDb(), rig.clock.now());
    const theirs = await seedFilteredLead(getDb(), { accountId: other.accountId, now: rig.clock.now() });
    expect(await leadDetailView(owned.scope, rig.deps, theirs)).toBeNull();
    expect(await leadDetailView(owned.scope, rig.deps, 'not-a-uuid')).toBeNull();
    expect(await leadDetailView(owned.scope, rig.deps, "' or 1=1 --")).toBeNull();
    expect(await leadDetailView(other.scope, rig.deps, theirs)).not.toBeNull();
  });

  it('a lead the owner sent and the lead answered: the timeline in order, HubSpot\'s times, Resume follow-ups offered', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const { leadId } = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: t0, submittedAt: at(t0, -5 * MINUTE) });
    await db.query(`update leads set first_send_clicked_at = $2, send_confirmed_at = $3 where id = $1`, [leadId, at(t0, 12 * MINUTE), at(t0, 13 * MINUTE)]);
    await markRepliedLikeTheJob(db, leadId, at(t0, 2 * HOUR), at(t0, 3 * HOUR));
    await seedDraft(db, { accountId: owned.accountId, leadId, purgeAt: at(t0, 30 * DAY) });
    rig.clock.advance({ hours: 4 });

    const view = await detail(leadId);
    expect(view.status).toBe('replied');
    expect(view.statusLabel).toBe('Replied');
    expect(view.timeline).toEqual([
      { kind: 'received', at: 'Tue 6 Oct, 09:55' },
      { kind: 'classified', at: 'Tue 6 Oct, 10:00', classification: 'lead', overridden: false },
      { kind: 'emailed', at: 'Tue 6 Oct, 10:00', needsTouch: false },
      { kind: 'send_link_opened', at: 'Tue 6 Oct, 10:12' },
      { kind: 'send_confirmed', at: 'Tue 6 Oct, 10:13' },
      { kind: 'lead_replied', at: 'Tue 6 Oct, 12:00', resumed: false },
    ]);
    expect(view.stopReason).toBe('replied');
    expect(view.upcomingFollowUps).toEqual([]);
    expect(view.controls).toEqual({ realLead: null, resumeFollowUps: 'available', dismiss: true });
    expect(view.drafts).toEqual([
      { kind: 'initial', state: 'available', subject: 'Your leaking sink', body: 'Hi Maya,\n\nThanks for getting in touch.\n\nDana', flags: [], needsTouch: false },
    ]);
  });

  it('after "Resume follow-ups": the set-aside reply and the resume are on the timeline, and the new follow-ups are due', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const { leadId } = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: t0 });
    await markRepliedLikeTheJob(db, leadId, at(t0, HOUR), at(t0, HOUR));
    rig.clock.advance({ hours: 2 });
    expect(await resumeFollowUps(rig.deps, owned.scope, leadId)).toMatchObject({ type: 'resumed' });

    const view = await detail(leadId);
    expect(view.timeline.slice(-2)).toEqual([
      { kind: 'lead_replied', at: 'Tue 6 Oct, 11:00', resumed: true },
      { kind: 'followups_resumed', at: 'Tue 6 Oct, 12:00' },
    ]);
    // Day 2 and day 5 from T0; Sunday is skipped (weekends off by default), to Monday morning plus the account's offset (D-66).
    expect(view.upcomingFollowUps).toEqual([
      { n: 1, at: 'Thu 8 Oct, 10:00' },
      { n: 2, at: expect.stringMatching(/^Mon 12 Oct, 08:(?:0\d|10)$/) },
    ]);
    expect(view.controls.resumeFollowUps).toBeNull();
    expect(view.status).toBe('drafted');
  });

  it('Resume follow-ups is explained, not offered, while paused or with follow-ups off; hidden for another stop reason', async () => {
    const db = getDb();
    const { leadId } = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    await markRepliedLikeTheJob(db, leadId, at(rig.clock.now(), HOUR), at(rig.clock.now(), HOUR));
    await db.query(`update settings set followups_enabled = false where account_id = $1`, [owned.accountId]);
    expect((await detail(leadId)).controls.resumeFollowUps).toBe('followups_off');
    await pauseAll(rig.deps, owned.scope);
    expect((await detail(leadId)).controls.resumeFollowUps).toBe('account_not_active');
    await db.query(`update leads set replied_at = null, stop_reason = 'opted_out' where id = $1`, [leadId]);
    expect((await detail(leadId)).controls.resumeFollowUps).toBeNull();
  });

  it('a filtered lead offers "This is a real lead" (or says why not) and shows its class', async () => {
    const leadId = await seedFilteredLead(getDb(), { accountId: owned.accountId, now: rig.clock.now() });
    const view = await detail(leadId);
    expect(view.statusLabel).toBe('Filtered');
    expect(view.timeline[1]).toMatchObject({ kind: 'classified', classification: 'spam', overridden: false });
    expect(view.controls).toEqual({ realLead: 'available', resumeFollowUps: null, dismiss: true });
    await purgeContent(getDb(), leadId, rig.clock.now());
    expect((await detail(leadId)).controls.realLead).toBe('content_gone');
  });

  it('shows the lead\'s message defanged as unverified text, and the company as a one-liner', async () => {
    const db = getDb();
    const leadId = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: rig.clock.now(), state: 'notified' });
    await db.query(`update lead_messages set message = $2, company = $3 where lead_id = $1`, [
      leadId,
      'Call me‮ at https://evil.example/x or mail jane@evil.example',
      'Okafor\nBakery www.okafor.example',
    ]);
    const view = await detail(leadId);
    expect(view.message).toEqual({ state: 'available', text: 'Call me at hxxps://evil[.]example/x or mail jane[@]evil[.]example', truncated: false });
    expect(view.company).toBe('Okafor Bakery www[.]okafor[.]example');
  });

  it('after the purge: "Contact #id", the draft expired and the message removed', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const leadId = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -31 * DAY), state: 'notified', contactId: '7001', set: { first_notified_at: at(now, -31 * DAY) } });
    await seedDraft(db, { accountId: owned.accountId, leadId, purgeAt: at(now, -HOUR) });
    await purgeContent(db, leadId, now);
    const view = await detail(leadId);
    expect(view.name).toEqual({ kind: 'contact', contactId: '7001', removed: 'purged' });
    expect(view.drafts).toEqual([{ kind: 'initial', state: 'expired' }]);
    expect(view.message).toEqual({ state: 'expired', reason: 'purged' });
    expect(view.company).toBeNull();
  });

  it('shows a draft as expired once the lead\'s message is gone, even if the drafts row still holds text (a purge cut short)', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const leadId = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -2 * DAY), state: 'notified', contactId: '7002', set: { first_notified_at: at(now, -2 * DAY) } });
    await seedDraft(db, { accountId: owned.accountId, leadId, subject: 'b-secret-subject', body: 'b-secret-body', purgeAt: at(now, 28 * DAY) });
    // Retention step 1 committed (the message deleted), step 2 (null the drafts) did not.
    await db.query(`delete from lead_messages where lead_id = $1`, [leadId]);
    const view = await detail(leadId);
    expect(view.drafts).toEqual([{ kind: 'initial', state: 'expired' }]);
    expect(view.message).toEqual({ state: 'expired', reason: 'purged' });
    expect(JSON.stringify(view)).not.toMatch(/b-secret/);
  });

  it('treats content past its purge_at as gone before the hourly purge deletes it', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const leadId = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: at(now, -31 * DAY), state: 'notified', contactId: '7003', set: { first_notified_at: at(now, -31 * DAY) } });
    await seedDraft(db, { accountId: owned.accountId, leadId, subject: 'stale-subject', body: 'stale-body', purgeAt: at(now, -MINUTE) });
    await db.query(`update lead_messages set purge_at = $2, message = 'stale-message' where lead_id = $1`, [leadId, at(now, -MINUTE)]);
    const view = await detail(leadId);
    expect(view.name).toEqual({ kind: 'contact', contactId: '7003', removed: 'purged' });
    expect(view.drafts).toEqual([{ kind: 'initial', state: 'expired' }]);
    expect(view.message).toEqual({ state: 'expired', reason: 'purged' });
    expect(view.company).toBeNull();
    expect(view.controls.realLead).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/stale-|Maya|Okafor/);
    // One minute earlier, the same rows were still shown.
    rig.clock.set(at(now, -2 * MINUTE));
    expect(await detail(leadId)).toMatchObject({ name: { kind: 'name', name: 'Maya' }, message: { state: 'available' }, drafts: [{ kind: 'initial', state: 'available', subject: 'stale-subject' }] });
  });

  it('separates a disconnected account from a missing email scope (the true reason is shown)', async () => {
    const db = getDb();
    const { leadId } = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    await db.query(`update hubspot_connections set scopes = $2 where account_id = $1`, [owned.accountId, ['oauth', 'crm.objects.contacts.read', 'forms', 'sales-email-read']]);
    expect((await detail(leadId)).signals).toMatchObject({ connectionActive: true, emailScope: true });
    await db.query(`update hubspot_connections set status = 'revoked' where account_id = $1`, [owned.accountId]);
    expect((await detail(leadId)).signals).toMatchObject({ connectionActive: false, emailScope: true });
    await db.query(`update hubspot_connections set status = 'active', scopes = $2 where account_id = $1`, [owned.accountId, ['oauth', 'crm.objects.contacts.read', 'forms']]);
    expect((await detail(leadId)).signals).toMatchObject({ connectionActive: true, emailScope: false });
  });

  it('a deferred lead says why it was not processed; a failed follow-up leaves a note; a dismissed one offers nothing', async () => {
    const db = getDb();
    const deferred = await seedLeadIn(db, { accountId: owned.accountId, receivedAt: rig.clock.now(), state: 'deferred', set: { classification: 'lead' } });
    expect(await detail(deferred)).toMatchObject({ statusLabel: 'Not processed', notProcessed: 'daily_cap', drafts: [] });

    const { leadId } = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    await recordFollowUpFailedNote(db, { accountId: owned.accountId, leadId, n: 1, followupStream: 0 });
    expect((await detail(leadId)).failedFollowUps).toEqual([1]);

    await db.query(`update leads set dismissed_at = $2, stop_reason = 'dismissed' where id = $1`, [leadId, rig.clock.now()]);
    const dismissed = await detail(leadId);
    expect(dismissed.controls).toEqual({ realLead: null, resumeFollowUps: null, dismiss: false });
    expect(dismissed.timeline.at(-1)).toMatchObject({ kind: 'dismissed' });
  });

  it('a test lead is shown as such, without a HubSpot link or controls beyond "Not a real lead"', async () => {
    const leadId = await seedLeadIn(getDb(), { accountId: owned.accountId, receivedAt: rig.clock.now(), isTest: true, state: 'notified' });
    const view = await detail(leadId);
    expect(view).toMatchObject({ isTest: true, recordUrl: null, controls: { realLead: null, resumeFollowUps: null, dismiss: true } });
  });
});
