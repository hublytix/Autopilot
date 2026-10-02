import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markReplied } from '@/server/services/signals';
import { useTestDb as setUpTestDb } from '../db/harness';
import { apply, at, createSignalsRig, DAY, HOUR, jobStatuses, LEAD_EMAIL, MINUTE, OWNER_EMAIL, replyReservations, seedNotifiedLead, signalRow, type SignalsRig } from './support';

// applySignals on PGlite with the fake portal (PLAN §9.5 step 4, D-08): what a confirmed send and a
// reply are, end to end; LEAST for the send time; replies before "Resume follow-ups" ignored; the
// positive-only fallback; and test leads never touched (D-14).

const getDb = setUpTestDb();
let rig: SignalsRig;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createSignalsRig(getDb());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('applySignals: confirmed send', () => {
  it('stores the earliest qualifying send (HubSpot time) and when it looked', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    // Not sends to the lead: CC'd only, failed, an inbound email, and one logged before the notification.
    rig.hubspot.logOwnerSend({ to: 'colleague@okafor-bakery.example', cc: [LEAD_EMAIL], at: at(t0, 2 * MINUTE), createContactIfMissing: true });
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, 3 * MINUTE), status: 'FAILED' });
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, -2 * MINUTE) });
    // Sends: 30 s before T0 (clock skew), and later ones.
    rig.hubspot.logOwnerSend({ to: 'Maya@Okafor-Bakery.example', at: at(t0, -30_000), status: null });
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, 20 * MINUTE) });

    const result = await apply(rig, lead.leadId, { caller: 'followup_job' });

    expect(result).toMatchObject({ outcome: 'checked', stop: null, replied: false, markedReplied: false, confirmedSendAt: at(t0, -30_000), replyEmail: 'none' });
    expect(await signalRow(getDb(), lead.leadId)).toMatchObject({
      send_confirmed_at: at(t0, -30_000),
      signals_checked_at: at(t0, 2 * DAY),
      replied_at: null,
      stop_reason: null,
    });
  });

  it('never moves the stored send time later, and keeps it when HubSpot shows nothing now (LEAST)', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    await db.query(`update leads set send_confirmed_at = $2 where id = $1`, [lead.leadId, at(t0, 5 * MINUTE)]);
    rig.clock.set(at(t0, 2 * DAY));
    expect((await apply(rig, lead.leadId, { caller: 'refresh' })).confirmedSendAt).toEqual(at(t0, 5 * MINUTE));

    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, 9 * MINUTE) });
    expect((await apply(rig, lead.leadId, { caller: 'refresh' })).confirmedSendAt).toEqual(at(t0, 5 * MINUTE));

    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, MINUTE) });
    expect((await apply(rig, lead.leadId, { caller: 'refresh' })).confirmedSendAt).toEqual(at(t0, MINUTE));
    expect((await signalRow(db, lead.leadId)).send_confirmed_at).toEqual(at(t0, MINUTE));
  });

  it('counts a send to one of the contact\'s additional emails', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.hubspot.updateContact(lead.contactId, { hs_additional_emails: 'm.okafor@gmail.example' });
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.logEmail({ direction: 'EMAIL', from: OWNER_EMAIL, to: ['M.Okafor@Gmail.example'], contactIds: [lead.contactId], at: at(t0, 7 * MINUTE) });

    expect((await apply(rig, lead.leadId, { caller: 'followup_job' })).confirmedSendAt).toEqual(at(t0, 7 * MINUTE));
  });
});

describe('applySignals: reply', () => {
  it('ignores a third party\'s email on the contact and the owner\'s own emails', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.logEmail({ direction: 'INCOMING_EMAIL', from: 'boss@okafor-bakery.example', to: [OWNER_EMAIL], contactIds: [lead.contactId], at: at(t0, HOUR) });
    rig.hubspot.logEmail({ direction: 'EMAIL', from: LEAD_EMAIL, to: [OWNER_EMAIL], contactIds: [lead.contactId], at: at(t0, HOUR) });

    const result = await apply(rig, lead.leadId, { caller: 'followup_job' });
    expect(result).toMatchObject({ stop: null, replied: false, markedReplied: false });
    expect(await jobStatuses(getDb(), lead.leadId)).toMatchObject([{ status: 'scheduled' }, { status: 'scheduled' }]);
  });

  it('counts a reply forwarded to HubSpot from the lead\'s address', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(t0, 3 * HOUR), direction: 'FORWARDED_EMAIL' });

    expect(await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] })).toMatchObject({ stop: 'replied', markedReplied: true });
  });

  it('ignores replies up to "Resume follow-ups" (replies_ignored_before) and records the next real one', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, DAY));
    // An out-of-office auto-reply, then the owner resumed follow-ups at T0 + 1 day (D-42).
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(t0, 10 * MINUTE) });
    await db.query(`update leads set replies_ignored_before = $2, followup_stream = 1 where id = $1`, [lead.leadId, at(t0, DAY)]);
    // The fallback property says the same old reply: ignored too.
    rig.clock.set(at(t0, 2 * DAY));
    expect(await apply(rig, lead.leadId, { caller: 'followup_job' })).toMatchObject({ stop: null, replied: false });

    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(t0, 2 * DAY + HOUR) });
    rig.clock.set(at(t0, 3 * DAY));
    expect(await apply(rig, lead.leadId, { caller: 'followup_job' })).toMatchObject({ stop: 'replied', markedReplied: true });
    expect(await signalRow(db, lead.leadId)).toMatchObject({ replied_at: at(t0, 2 * DAY + HOUR), stop_reason: 'replied' });
    expect(await replyReservations(db, lead.leadId)).toEqual([{ dedupe_key: `reply:${lead.leadId}:s1`, kind: 'reply_detected', status: 'sent' }]);
  });

  it('uses hs_sales_email_last_replied only to confirm a reply, never to clear one', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    // Older than the notification: no reply.
    rig.hubspot.updateContact(lead.contactId, { hs_sales_email_last_replied: at(t0, -HOUR).toISOString() });
    expect(await apply(rig, lead.leadId, { caller: 'refresh' })).toMatchObject({ replied: false });

    rig.hubspot.updateContact(lead.contactId, { hs_sales_email_last_replied: at(t0, 30 * HOUR).toISOString() });
    expect(await apply(rig, lead.leadId, { caller: 'refresh' })).toMatchObject({ replied: true, markedReplied: true });
    expect((await signalRow(db, lead.leadId)).replied_at).toEqual(at(t0, 30 * HOUR));

    // The property is emptied later: the recorded reply stays.
    rig.hubspot.updateContact(lead.contactId, { hs_sales_email_last_replied: null });
    expect(await apply(rig, lead.leadId, { caller: 'refresh' })).toMatchObject({ replied: true, markedReplied: false, stop: 'replied' });
    expect((await signalRow(db, lead.leadId)).replied_at).toEqual(at(t0, 30 * HOUR));
  });

  it('keeps the earliest reply time when a later read finds an earlier reply (LEAST), with no second email', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.updateContact(lead.contactId, { hs_sales_email_last_replied: at(t0, 40 * HOUR).toISOString() });
    expect(await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] })).toMatchObject({ markedReplied: true, replyEmail: 'sent' });

    // The engagement is logged late, with the reply's real (earlier) time.
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(t0, 30 * HOUR) });
    expect(await apply(rig, lead.leadId, { caller: 'refresh' })).toMatchObject({ markedReplied: false, replied: true, replyEmail: 'none' });
    expect((await signalRow(db, lead.leadId)).replied_at).toEqual(at(t0, 30 * HOUR));
    expect(rig.fakes.mailer.sent.filter((mail) => mail.kind === 'reply_detected')).toHaveLength(1);
  });
});

describe('applySignals: what it may claim (law 3, D-73)', () => {
  it('a read without the logged emails records no check time and says the emails were not read', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, 10 * MINUTE) });
    // The portal no longer grants the email scope: HubSpot answers the email read with 403 MISSING_SCOPES.
    rig.hubspot.setGrantedScopes(['oauth', 'crm.objects.contacts.read', 'forms']);

    expect(await apply(rig, lead.leadId, { caller: 'refresh' })).toMatchObject({ outcome: 'checked', emailsAvailable: false, replied: false, confirmedSendAt: null });
    expect((await signalRow(getDb(), lead.leadId)).signals_checked_at).toBeNull();

    rig.hubspot.setGrantedScopes(['oauth', 'crm.objects.contacts.read', 'forms', 'sales-email-read']);
    expect(await apply(rig, lead.leadId, { caller: 'refresh' })).toMatchObject({ emailsAvailable: true });
    expect((await signalRow(getDb(), lead.leadId)).signals_checked_at).toEqual(rig.clock.now());
  });

  it('a send to the lead that bounced is a bounce stop, returned and not stored (D-09, D-73)', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, HOUR), status: 'BOUNCED' });

    expect(await apply(rig, lead.leadId, { caller: 'followup_job' })).toMatchObject({ stop: 'bounced', confirmedSendAt: null });
    expect((await signalRow(getDb(), lead.leadId)).stop_reason).toBeNull();
  });

  it('two leads of one contact: the send and the reply for the newer lead are never counted for the older one too', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const older = await seedNotifiedLead(rig, { firstNotifiedAt: at(t0, -3 * DAY), submittedAt: at(t0, -3 * DAY - MINUTE), followUps: false });
    const newer = await seedNotifiedLead(rig, { contactId: older.contactId, followUps: false });
    rig.clock.set(at(t0, 2 * DAY));
    // The owner answered only the newer enquiry, and the lead replied to that.
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, 10 * MINUTE) });
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(t0, 5 * HOUR) });

    expect(await apply(rig, older.leadId, { caller: 'refresh' })).toMatchObject({ confirmedSendAt: null, replied: false, emailsAvailable: true });
    expect(await signalRow(db, older.leadId)).toMatchObject({ send_confirmed_at: null, replied_at: null });

    expect(await apply(rig, newer.leadId, { caller: 'refresh' })).toMatchObject({ confirmedSendAt: at(t0, 10 * MINUTE), replied: true });
  });
});

describe('applySignals: test leads (D-14)', () => {
  it('never reads HubSpot for a test lead, nor writes anything to it', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const testLead = await seedNotifiedLead(rig, { isTest: true, email: 'owner.personal@example.net', firstName: 'Dana' });
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.logOwnerSend({ to: 'owner.personal@example.net', at: at(t0, MINUTE) });
    rig.hubspot.logLeadReply({ from: 'owner.personal@example.net', at: at(t0, HOUR) });
    const getContact = vi.spyOn(rig.hubspot, 'getContact');

    const result = await apply(rig, testLead.leadId, { caller: 'followup_job' });

    expect(result).toMatchObject({ outcome: 'skipped', replied: false, markedReplied: false, replyEmail: 'none' });
    expect(getContact).not.toHaveBeenCalled();
    expect(await signalRow(db, testLead.leadId)).toMatchObject({ send_confirmed_at: null, replied_at: null, signals_checked_at: null, stop_reason: 'test_lead' });

    const marked = await markReplied(rig.deps, { accountId: rig.accountId, leadId: testLead.leadId, repliedAt: at(t0, HOUR), followUpStillScheduled: true });
    expect(marked).toEqual({ won: false, repliedAt: null, cancelledJobs: 0, replyEmail: 'none' });
    expect(await signalRow(db, testLead.leadId)).toMatchObject({ replied_at: null, stop_reason: 'test_lead' });
    expect(await replyReservations(db, testLead.leadId)).toEqual([]);
  });

  it('does not read a privacy-deleted lead\'s contact', async () => {
    const db = getDb();
    const lead = await seedNotifiedLead(rig);
    await db.query(`update leads set stop_reason = 'privacy_deletion' where id = $1`, [lead.leadId]);
    const getContact = vi.spyOn(rig.hubspot, 'getContact');

    expect(await apply(rig, lead.leadId, { caller: 'refresh' })).toMatchObject({ outcome: 'skipped', stop: 'privacy_deletion' });
    expect(getContact).not.toHaveBeenCalled();
    const marked = await markReplied(rig.deps, { accountId: rig.accountId, leadId: lead.leadId, repliedAt: rig.clock.now(), followUpStillScheduled: true });
    expect(marked.won).toBe(false);
    expect((await signalRow(db, lead.leadId)).stop_reason).toBe('privacy_deletion');
  });

  it('only reads a lead of the given account (an owner\'s refresh)', async () => {
    const lead = await seedNotifiedLead(rig);
    const getContact = vi.spyOn(rig.hubspot, 'getContact');
    const result = await apply(rig, lead.leadId, { caller: 'refresh', accountId: '00000000-0000-4000-8000-000000000000' });
    expect(result.outcome).toBe('skipped');
    expect(getContact).not.toHaveBeenCalled();
  });
});
