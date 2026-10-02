import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNAL_CONTACT_PROPERTIES } from '@/server/domain/signals';
import { EMAIL_METADATA_PROPERTIES } from '@/server/domain/types';
import { isSuperseded } from '@/server/services/followups';
import { MAX_ASSOCIATION_PAGES, readContactSignals } from '@/server/services/signals';
import { useTestDb as setUpTestDb } from '../db/harness';
import { apply, at, createSignalsRig, DAY, HOUR, LEAD_EMAIL, MINUTE, OWNER_EMAIL, seedNotifiedLead, signalRow, type SignalsRig } from './support';

// The contact read behind the follow-up stops (PLAN §9.5 step 3, D-08, D-09, HS-EMAIL-BY-CONTACT,
// HS-CONTACT-DELETED-MERGED) against the fake portal: the property and metadata allow-lists, the
// association paging past the first page, batch reads of at most 100, a deleted contact, a merged
// contact (re-mapped, and read on), opt-out and bounce, and a grant without the email scope.

const getDb = setUpTestDb();
let rig: SignalsRig;

beforeEach(async () => {
  // PLAN §12: nothing here may read the wall clock, so the system time is far from the test's Clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createSignalsRig(getDb());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('readContactSignals', () => {
  it('asks only for the allow-listed contact properties and email metadata', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, 10 * MINUTE) });
    const getContact = vi.spyOn(rig.hubspot, 'getContact');
    const batchRead = vi.spyOn(rig.hubspot, 'batchReadEmails');

    const read = await readContactSignals(rig.deps, rig.accountId, { id: lead.leadId, hubspotContactId: lead.contactId }, { sleep: rig.sleep });

    expect(read).toMatchObject({ type: 'found', contactId: lead.contactId, mergedFrom: null, emailsAvailable: true });
    expect(getContact).toHaveBeenCalledTimes(1);
    expect(getContact.mock.calls[0]?.[1]).toBe(lead.contactId);
    expect(getContact.mock.calls[0]?.[2]).toMatchObject({ properties: SIGNAL_CONTACT_PROPERTIES, associations: ['emails'] });
    expect(batchRead.mock.calls.map((call) => call[2])).toEqual([EMAIL_METADATA_PROPERTIES]);
    if (read.type !== 'found') throw new Error('not found');
    expect(read.emails).toHaveLength(1);
    expect(Object.keys(read.properties).sort()).toEqual([...SIGNAL_CONTACT_PROPERTIES].sort());
  });

  it('follows the association pages past the first 100 and batch-reads in chunks of at most 100', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    // 249 older emails on the contact (before the notification), then the lead's reply: the 250th.
    for (let i = 0; i < 249; i++) {
      rig.hubspot.logEmail({ direction: 'EMAIL', from: OWNER_EMAIL, to: [LEAD_EMAIL], contactIds: [lead.contactId], at: at(t0, -DAY - i * MINUTE) });
    }
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(t0, 30 * HOUR) });
    const pages = vi.spyOn(rig.hubspot, 'listContactEmailIds');
    const batchRead = vi.spyOn(rig.hubspot, 'batchReadEmails');

    const read = await readContactSignals(rig.deps, rig.accountId, { id: lead.leadId, hubspotContactId: lead.contactId }, { sleep: rig.sleep });

    if (read.type !== 'found') throw new Error('not found');
    expect(read.emails).toHaveLength(250);
    expect(pages).toHaveBeenCalledTimes(2);
    expect(batchRead.mock.calls.map((call) => call[1].length)).toEqual([100, 100, 50]);
    expect(new Set(batchRead.mock.calls.flatMap((call) => call[1])).size).toBe(250);

    // …and the reply on the last page stops follow-ups.
    const result = await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] });
    expect(result).toMatchObject({ stop: 'replied', replied: true, markedReplied: true, confirmedSendAt: null });
    expect((await signalRow(getDb(), lead.leadId)).replied_at).toEqual(at(t0, 30 * HOUR));
  });

  it('reports a deleted contact (404) without reading emails, and stores nothing but the check time', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(t0, HOUR) });
    rig.hubspot.deleteContact(lead.contactId);
    const batchRead = vi.spyOn(rig.hubspot, 'batchReadEmails');

    const read = await readContactSignals(rig.deps, rig.accountId, { id: lead.leadId, hubspotContactId: lead.contactId }, { sleep: rig.sleep });
    expect(read).toEqual({ type: 'deleted', contactId: lead.contactId });

    const result = await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] });
    expect(result).toMatchObject({ outcome: 'checked', stop: 'contact_deleted', replied: false, markedReplied: false, replyEmail: 'none' });
    expect(batchRead).not.toHaveBeenCalled();
    const row = await signalRow(getDb(), lead.leadId);
    expect(row).toMatchObject({ replied_at: null, stop_reason: null, send_confirmed_at: null, signals_checked_at: rig.clock.now() });
  });

  it('re-maps a merged contact (every lead of the account on the old id) and reads on with the new id', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const older = await seedNotifiedLead(rig, { firstNotifiedAt: at(t0, -10 * DAY), followUps: false });
    const lead = await seedNotifiedLead(rig, { contactId: older.contactId });
    const other = rig.hubspot.createContact({ email: 'maya.o@work.example', at: at(t0, -20 * DAY) });
    rig.clock.set(at(t0, 2 * DAY));
    const mergedId = rig.hubspot.mergeContact(older.contactId, other);
    expect(mergedId).not.toBe(older.contactId);
    // The lead replies from the secondary record's address, now one of the merged record's additional emails.
    rig.hubspot.logLeadReply({ from: 'Maya.O@work.example', at: at(t0, 40 * HOUR) });

    const result = await apply(rig, lead.leadId, { caller: 'followup_job', jobId: lead.jobIds[0] });

    expect(result).toMatchObject({ contactId: mergedId, stop: 'replied', markedReplied: true });
    expect((await signalRow(db, lead.leadId)).hubspot_contact_id).toBe(mergedId);
    expect((await signalRow(db, older.leadId)).hubspot_contact_id).toBe(mergedId);
    expect((await signalRow(db, lead.leadId)).replied_at).toEqual(at(t0, 40 * HOUR));
  });

  it('returns opt-out and bounce as stops without storing them', async () => {
    const t0 = rig.clock.now();
    const optedOut = await seedNotifiedLead(rig);
    const bounced = await seedNotifiedLead(rig, { email: 'sam@riverton-dental.example', firstName: 'Sam' });
    const badAddress = await seedNotifiedLead(rig, { email: 'kim@typo.example', firstName: 'Kim' });
    rig.hubspot.optOut(optedOut.contactId);
    rig.hubspot.hardBounce(bounced.contactId, 'UNKNOWN_USER');
    rig.hubspot.updateContact(badAddress.contactId, { hs_email_bad_address: 'true' });
    rig.clock.set(at(t0, 2 * DAY));

    expect(await apply(rig, optedOut.leadId, { caller: 'followup_job' })).toMatchObject({ outcome: 'checked', stop: 'opted_out', replied: false });
    expect(await apply(rig, bounced.leadId, { caller: 'followup_job' })).toMatchObject({ outcome: 'checked', stop: 'bounced', replied: false });
    expect(await apply(rig, badAddress.leadId, { caller: 'followup_job' })).toMatchObject({ outcome: 'checked', stop: 'bounced' });
    for (const lead of [optedOut, bounced, badAddress]) {
      expect((await signalRow(getDb(), lead.leadId)).stop_reason).toBeNull();
    }
  });

  it('without the email scope reads no email: nothing is confirmed from engagements, the fallback property still counts', async () => {
    // A grant without `sales-email-read` (D-03 path b), as stored by the OAuth callback.
    rig.hubspot.setGrantedScopes(['oauth', 'crm.objects.contacts.read', 'forms']);
    await getDb().query(`update hubspot_connections set scopes = $2 where account_id = $1`, [rig.accountId, ['oauth', 'crm.objects.contacts.read', 'forms']]);
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, 10 * MINUTE) });
    const batchRead = vi.spyOn(rig.hubspot, 'batchReadEmails');
    const getContact = vi.spyOn(rig.hubspot, 'getContact');

    const read = await readContactSignals(rig.deps, rig.accountId, { id: lead.leadId, hubspotContactId: lead.contactId }, { sleep: rig.sleep });
    expect(read).toMatchObject({ type: 'found', emails: [], emailsAvailable: false });
    expect(getContact.mock.calls[0]?.[2]?.associations).toBeUndefined();
    expect(batchRead).not.toHaveBeenCalled();
    expect(await apply(rig, lead.leadId, { caller: 'refresh' })).toMatchObject({ confirmedSendAt: null, replied: false });

    rig.hubspot.updateContact(lead.contactId, { hs_sales_email_last_replied: at(t0, 26 * HOUR).toISOString() });
    expect(await apply(rig, lead.leadId, { caller: 'refresh' })).toMatchObject({ replied: true, markedReplied: true, stop: 'replied' });
  });

  it('treats HubSpot\'s 403 MISSING_SCOPES on the email read like a missing scope', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, 10 * MINUTE) });
    // The stored grant still lists the scope, but the portal no longer grants it.
    rig.hubspot.setGrantedScopes(['oauth', 'crm.objects.contacts.read', 'forms']);

    const read = await readContactSignals(rig.deps, rig.accountId, { id: lead.leadId, hubspotContactId: lead.contactId }, { sleep: rig.sleep });
    expect(read).toMatchObject({ type: 'found', emails: [], emailsAvailable: false });
  });

  it('a 403 MISSING_SCOPES on a later association page reads no email instead of failing the job (D-69, D-73)', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    for (let i = 0; i < 150; i++) {
      rig.hubspot.logEmail({ direction: 'EMAIL', from: OWNER_EMAIL, to: [LEAD_EMAIL], contactIds: [lead.contactId], at: at(t0, -DAY - i * MINUTE) });
    }
    rig.hubspot.injectFailure('listContactEmailIds', { kind: 'missing_scopes' });
    const batchRead = vi.spyOn(rig.hubspot, 'batchReadEmails');

    const read = await readContactSignals(rig.deps, rig.accountId, { id: lead.leadId, hubspotContactId: lead.contactId }, { sleep: rig.sleep });

    expect(read).toMatchObject({ type: 'found', emails: [], emailsAvailable: false, emailsComplete: false });
    expect(batchRead).not.toHaveBeenCalled();
  });

  it('a 403 MISSING_SCOPES on the contact GET with associations is retried once without them; no email is read', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.injectFailure('getContact', { kind: 'missing_scopes' });
    const getContact = vi.spyOn(rig.hubspot, 'getContact');

    const read = await readContactSignals(rig.deps, rig.accountId, { id: lead.leadId, hubspotContactId: lead.contactId }, { sleep: rig.sleep });

    expect(read).toMatchObject({ type: 'found', contactId: lead.contactId, emails: [], emailsAvailable: false });
    expect(getContact.mock.calls.map((call) => call[2].associations)).toEqual([['emails'], undefined]);
    // A second 403 (the contacts scope itself) is not swallowed.
    rig.hubspot.injectFailure('getContact', { kind: 'missing_scopes', times: 2 });
    await expect(readContactSignals(rig.deps, rig.accountId, { id: lead.leadId, hubspotContactId: lead.contactId }, { sleep: rig.sleep })).rejects.toMatchObject({
      code: 'hubspot_missing_scopes',
    });
  });

  it('association paging cut short (the page cap, or a cursor HubSpot repeats) is not a complete read', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    for (let i = 0; i < 150; i++) {
      rig.hubspot.logEmail({ direction: 'EMAIL', from: OWNER_EMAIL, to: [LEAD_EMAIL], contactIds: [lead.contactId], at: at(t0, -DAY - i * MINUTE) });
    }
    // HubSpot keeps answering with the same cursor: one more call, then the loop ends.
    const pages = vi.spyOn(rig.hubspot, 'listContactEmailIds').mockResolvedValue({ ids: ['999001'], nextAfter: 'same-cursor' });

    const read = await readContactSignals(rig.deps, rig.accountId, { id: lead.leadId, hubspotContactId: lead.contactId }, { sleep: rig.sleep });

    expect(pages).toHaveBeenCalledTimes(2);
    expect(read).toMatchObject({ type: 'found', emailsAvailable: true, emailsComplete: false });
    const result = await apply(rig, lead.leadId, { caller: 'refresh' });
    expect(result).toMatchObject({ outcome: 'checked', emailsAvailable: false });
    expect((await signalRow(getDb(), lead.leadId)).signals_checked_at).toBeNull();

    // Pages that never end stop at MAX_ASSOCIATION_PAGES.
    let n = 0;
    pages.mockImplementation(async () => ({ ids: [], nextAfter: `cursor-${(n += 1)}` }));
    const capped = await readContactSignals(rig.deps, rig.accountId, { id: lead.leadId, hubspotContactId: lead.contactId }, { sleep: rig.sleep });
    expect(capped).toMatchObject({ emailsComplete: false });
    expect(n).toBe(MAX_ASSOCIATION_PAGES);
  });

  it('a merge of two contacts that each have a lead re-maps both leads, so D-44 sees one contact (hs_merged_object_ids)', async () => {
    const db = getDb();
    const t0 = rig.clock.now();
    const leadA = await seedNotifiedLead(rig, { firstNotifiedAt: at(t0, -3 * DAY), submittedAt: at(t0, -3 * DAY - MINUTE), followUps: false });
    const leadB = await seedNotifiedLead(rig, { email: 'maya.o@work.example', followUps: false });
    rig.clock.set(at(t0, 2 * DAY));
    const mergedId = rig.hubspot.mergeContact(leadA.contactId, leadB.contactId);

    const read = await readContactSignals(rig.deps, rig.accountId, { id: leadA.leadId, hubspotContactId: leadA.contactId }, { sleep: rig.sleep });

    expect(read).toMatchObject({ type: 'found', contactId: mergedId, mergedFrom: leadA.contactId });
    expect((await signalRow(db, leadA.leadId)).hubspot_contact_id).toBe(mergedId);
    expect((await signalRow(db, leadB.leadId)).hubspot_contact_id).toBe(mergedId);
    // The older lead is now superseded by the newer one, which was notified.
    expect(await isSuperseded(db, leadA.leadId)).toBe(true);
  });

  it('lets other HubSpot errors through (the follow-up job retries)', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, 2 * DAY));
    rig.hubspot.injectFailure('batchReadEmails', { kind: 'server_error' });
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(t0, 10 * MINUTE) });

    await expect(apply(rig, lead.leadId, { caller: 'followup_job' })).rejects.toMatchObject({ kind: 'transient' });
    expect((await signalRow(getDb(), lead.leadId)).signals_checked_at).toBeNull();
  });
});
