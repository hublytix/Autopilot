import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeSentMail } from '@/server/adapters/fake/mailer/fake-mailer';
import type { Db } from '@/server/db';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, TEST_START, type JobTestRig } from '@/server/jobs/testing';
import { createNotificationRegistry } from '@/server/services/notifications/renderers';
import { getNotification } from '@/server/services/notifications/reserve';
import { sendReserved } from '@/server/services/notifications/send';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { applyDailyCap, countDraftedLeads, localDay, registerDraftingNotifications } from './cap';
import { seedDraftableLead, seedDraftingAccount } from './testing';

// The daily cap (D-36, PLAN §9.3 step 4): leads drafted on the portal's local date, counted after
// classification; at or over MAX_DRAFTED_LEADS_PER_DAY the lead is deferred with no draft call, and
// the account gets exactly one lead_cap email per local day.

const getDb = setUpTestDb();
const ZONE = 'America/New_York';
// TEST_START is 2026-10-06T14:00Z = 10:00 on Tuesday 6 October in New York.
const LOCAL_DATE = '2026-10-06';

let rig: JobTestRig;

beforeEach(() => {
  // PLAN §12: nothing here may read the wall clock, so the system time is far from the test's Clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createJobTestRig(getDb(), createJobRegistry());
});

afterEach(() => {
  vi.useRealTimers();
});

/** `count` leads already notified at `at` (no draft call needed for the count). */
async function seedNotifiedLeads(db: Db, accountId: string, count: number, at: Date): Promise<void> {
  await db.query(
    `insert into leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, received_at, classified_at,
                        first_notified_at, processing_state, classification)
     select $1, 'contact-' || g || '-' || extract(epoch from $2::timestamptz), 'form-1', $2, 'webhook', $2, $2, $2, 'notified', 'lead'
       from generate_series(1, $3::int) g`,
    [accountId, at, count],
  );
}

async function leadState(db: Db, leadId: string): Promise<string> {
  return (await db.one<{ processing_state: string }>(`select processing_state from leads where id = $1`, [leadId])).processing_state;
}

function capEmails(): FakeSentMail[] {
  return rig.fakes.mailer.sent.filter((mail) => mail.kind === 'lead_cap');
}

describe('applyDailyCap', () => {
  it('lead 51 of the local day is deferred, with exactly one lead_cap email for the day', async () => {
    const db = getDb();
    const accountId = await seedDraftingAccount(db, { now: TEST_START, timezone: ZONE });
    await seedNotifiedLeads(db, accountId, 49, new Date('2026-10-06T13:00:00.000Z'));

    const fiftieth = await seedDraftableLead(db, { accountId, now: TEST_START });
    expect(await applyDailyCap(rig.deps, { accountId, leadId: fiftieth.leadId, processRev: 0 })).toEqual({ type: 'allowed' });
    expect(await leadState(db, fiftieth.leadId)).toBe('processing');
    // The slot is the lead's (empty) initial draft row.
    expect(await db.query(`select subject, purge_at from drafts where lead_id = $1`, [fiftieth.leadId])).toEqual([{ subject: null, purge_at: fiftieth.purgeAt }]);

    const fiftyFirst = await seedDraftableLead(db, { accountId, now: TEST_START });
    const deferred = await applyDailyCap(rig.deps, { accountId, leadId: fiftyFirst.leadId, processRev: 0 });
    expect(deferred).toMatchObject({ type: 'deferred', email: { status: 'sent' } });
    expect(await leadState(db, fiftyFirst.leadId)).toBe('deferred');
    expect(await db.query(`select id from drafts where lead_id = $1`, [fiftyFirst.leadId])).toEqual([]);

    const fiftySecond = await seedDraftableLead(db, { accountId, now: TEST_START });
    expect(await applyDailyCap(rig.deps, { accountId, leadId: fiftySecond.leadId, processRev: 0 })).toMatchObject({
      type: 'deferred',
      email: { status: 'already_sent' },
    });

    const emails = capEmails();
    expect(emails).toHaveLength(1);
    const [email] = emails;
    expect(email?.to).toEqual(['owner@example.com']);
    expect(email?.replyTo).toBeUndefined();
    expect(email?.subject).toBe("Hublytix Autopilot: today's limit of 50 drafted leads reached");
    expect(email?.text).toContain("You've reached today's limit of 50 drafted leads.");
    expect(email?.text).toContain('listed on your dashboard, not drafted');
    expect(email?.idempotencyKey).toBe(`fake-local:cap:${accountId}:${LOCAL_DATE}`);
    expect(email?.text).not.toMatch(/Maya|sink|Okafor/);
    // No LLM call on any path.
    expect(rig.fakes.llm.calls).toEqual([]);
  });

  it('counts by the portal local date, not the UTC date', async () => {
    const db = getDb();
    const accountId = await seedDraftingAccount(db, { now: TEST_START, timezone: ZONE });
    // 03:00Z on 6 Oct is 23:00 on 5 Oct in New York: yesterday locally, the same UTC day.
    await seedNotifiedLeads(db, accountId, 50, new Date('2026-10-06T03:00:00.000Z'));
    const lead = await seedDraftableLead(db, { accountId, now: TEST_START });
    expect(await applyDailyCap(rig.deps, { accountId, leadId: lead.leadId, processRev: 0 })).toEqual({ type: 'allowed' });

    const day = localDay(TEST_START, ZONE);
    expect(day).toEqual({ date: LOCAL_DATE, start: new Date('2026-10-06T04:00:00.000Z'), end: new Date('2026-10-07T04:00:00.000Z') });
    expect(await countDraftedLeads(db, { accountId, exceptLeadId: lead.leadId, day })).toBe(0);
  });

  it('late in the local evening the day, its count and its one lead_cap email are still the local date, not the UTC one', async () => {
    const db = getDb();
    const small = createJobTestRig(db, createJobRegistry(), { env: { MAX_DRAFTED_LEADS_PER_DAY: '1' } });
    const accountId = await seedDraftingAccount(db, { now: TEST_START, timezone: ZONE });
    // Notified at 10:00 New York on 6 October.
    await seedNotifiedLeads(db, accountId, 1, new Date('2026-10-06T14:00:00.000Z'));

    // 02:30Z on 7 October is 22:30 on 6 October in New York: the 10:00 lead counts, so this one is over the cap.
    small.clock.set(new Date('2026-10-07T02:30:00.000Z'));
    expect(localDay(small.clock.now(), ZONE).date).toBe('2026-10-06');
    const evening = await seedDraftableLead(db, { accountId, now: small.clock.now() });
    expect(await applyDailyCap(small.deps, { accountId, leadId: evening.leadId, processRev: 0 })).toMatchObject({ type: 'deferred', email: { status: 'sent' } });
    expect(small.fakes.mailer.sent.map((mail) => mail.idempotencyKey)).toEqual([`fake-local:cap:${accountId}:2026-10-06`]);

    // The next local day has its own count and its own lead_cap email.
    small.clock.set(new Date('2026-10-07T14:00:00.000Z'));
    await seedNotifiedLeads(db, accountId, 1, new Date('2026-10-07T13:00:00.000Z'));
    const next = await seedDraftableLead(db, { accountId, now: small.clock.now() });
    expect(await applyDailyCap(small.deps, { accountId, leadId: next.leadId, processRev: 0 })).toMatchObject({ type: 'deferred', email: { status: 'sent' } });
    expect(small.fakes.mailer.sent.map((mail) => mail.idempotencyKey)).toEqual([
      `fake-local:cap:${accountId}:2026-10-06`,
      `fake-local:cap:${accountId}:2026-10-07`,
    ]);
  });

  it('a local day is 25 hours when the clocks go back and 23 when they go forward', () => {
    const fallBack = localDay(new Date('2026-11-01T12:00:00.000Z'), ZONE);
    expect(fallBack).toEqual({ date: '2026-11-01', start: new Date('2026-11-01T04:00:00.000Z'), end: new Date('2026-11-02T05:00:00.000Z') });
    const springForward = localDay(new Date('2026-03-08T12:00:00.000Z'), ZONE);
    expect(springForward).toEqual({ date: '2026-03-08', start: new Date('2026-03-08T05:00:00.000Z'), end: new Date('2026-03-09T04:00:00.000Z') });
    // An unusable zone falls back to the UTC day.
    expect(localDay(new Date('2026-10-07T02:30:00.000Z'), 'Not/AZone').date).toBe('2026-10-07');
    expect(localDay(new Date('2026-10-07T02:30:00.000Z'), null).date).toBe('2026-10-07');
  });

  it('counts leads holding a draft slot that are not notified yet, and leaves test leads out', async () => {
    const db = getDb();
    const small = createJobTestRig(db, createJobRegistry(), { env: { MAX_DRAFTED_LEADS_PER_DAY: '2' } });
    const accountId = await seedDraftingAccount(db, { now: TEST_START, timezone: ZONE });
    await db.query(
      `insert into leads (account_id, form_id, submitted_at, intake_trigger, is_test, received_at, first_notified_at, processing_state)
       values ($1, null, $2, 'inbox_check', true, $2, $2, 'notified')`,
      [accountId, TEST_START],
    );
    const first = await seedDraftableLead(db, { accountId, now: TEST_START });
    const second = await seedDraftableLead(db, { accountId, now: TEST_START });
    const third = await seedDraftableLead(db, { accountId, now: TEST_START });
    expect((await applyDailyCap(small.deps, { accountId, leadId: first.leadId, processRev: 0 })).type).toBe('allowed');
    expect((await applyDailyCap(small.deps, { accountId, leadId: second.leadId, processRev: 0 })).type).toBe('allowed');
    expect((await applyDailyCap(small.deps, { accountId, leadId: third.leadId, processRev: 0 })).type).toBe('deferred');
    // A redelivery for a lead that holds its slot is still allowed.
    expect((await applyDailyCap(small.deps, { accountId, leadId: first.leadId, processRev: 0 })).type).toBe('allowed');
    expect(small.fakes.mailer.sent.filter((mail) => mail.kind === 'lead_cap')).toHaveLength(1);
  });

  it('changes nothing for a lead that moved on (override, dismissal) or a stale revision', async () => {
    const db = getDb();
    const small = createJobTestRig(db, createJobRegistry(), { env: { MAX_DRAFTED_LEADS_PER_DAY: '1' } });
    const accountId = await seedDraftingAccount(db, { now: TEST_START, timezone: ZONE });
    await seedNotifiedLeads(db, accountId, 1, TEST_START);
    const lead = await seedDraftableLead(db, { accountId, now: TEST_START });
    expect(await applyDailyCap(small.deps, { accountId, leadId: lead.leadId, processRev: 1 })).toEqual({ type: 'lead_changed' });
    expect(await leadState(db, lead.leadId)).toBe('processing');
    expect(small.fakes.mailer.sent).toEqual([]);
  });

  it('runs the guard inside its transaction', async () => {
    const db = getDb();
    const accountId = await seedDraftingAccount(db, { now: TEST_START });
    const lead = await seedDraftableLead(db, { accountId, now: TEST_START });
    const guard = async (): Promise<void> => {
      throw new Error('job_lease_lost');
    };
    await expect(applyDailyCap(rig.deps, { accountId, leadId: lead.leadId, processRev: 0, guard })).rejects.toThrow('job_lease_lost');
    expect(await db.query(`select id from drafts where lead_id = $1`, [lead.leadId])).toEqual([]);
  });

  it('a transient send failure leaves the reservation for the sweeper; the lead_cap resumer sends it later', async () => {
    const db = getDb();
    const small = createJobTestRig(db, createJobRegistry(), { env: { MAX_DRAFTED_LEADS_PER_DAY: '1' } });
    const accountId = await seedDraftingAccount(db, { now: TEST_START, timezone: ZONE });
    await seedNotifiedLeads(db, accountId, 1, TEST_START);
    const lead = await seedDraftableLead(db, { accountId, now: TEST_START });
    small.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    expect(await applyDailyCap(small.deps, { accountId, leadId: lead.leadId, processRev: 0 })).toEqual({ type: 'deferred', email: { status: 'retry_later' } });
    expect(await leadState(db, lead.leadId)).toBe('deferred');
    const key = `cap:${accountId}:${LOCAL_DATE}`;
    expect((await getNotification(db, key))?.status).toBe('sending');

    const registry = createNotificationRegistry();
    registerDraftingNotifications({ notifications: registry });
    registerDraftingNotifications({ notifications: registry }); // idempotent
    expect(await sendReserved(small.deps, key, registry)).toMatchObject({ status: 'sent' });
    expect(small.fakes.mailer.sent.filter((mail) => mail.kind === 'lead_cap')).toHaveLength(1);
  });

  it('emails the owner sign-in address when no notify address is verified, and nobody without one', async () => {
    const db = getDb();
    const small = createJobTestRig(db, createJobRegistry(), { env: { MAX_DRAFTED_LEADS_PER_DAY: '1' } });
    const accountId = await seedDraftingAccount(db, { now: TEST_START, timezone: ZONE });
    await db.query(`update settings set notify_emails_verified = '{}' where account_id = $1`, [accountId]);
    await seedNotifiedLeads(db, accountId, 1, TEST_START);
    const lead = await seedDraftableLead(db, { accountId, now: TEST_START });
    expect(await applyDailyCap(small.deps, { accountId, leadId: lead.leadId, processRev: 0 })).toEqual({ type: 'deferred', email: null });
    expect(small.fakes.mailer.sent).toEqual([]);

    await db.query(`update accounts set owner_user_id = '11111111-1111-4111-8111-111111111111' where id = $1`, [accountId]);
    await db.query(`insert into users (auth_user_id, account_id, email) values ('11111111-1111-4111-8111-111111111111', $1, 'dana@example.org')`, [accountId]);
    const next = await seedDraftableLead(db, { accountId, now: TEST_START });
    expect(await applyDailyCap(small.deps, { accountId, leadId: next.leadId, processRev: 0 })).toMatchObject({ type: 'deferred', email: { status: 'sent' } });
    expect(small.fakes.mailer.sent.map((mail) => mail.to)).toEqual([['dana@example.org']]);
  });
});
