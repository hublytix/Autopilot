import { beforeEach, describe, expect, it } from 'vitest';
import { onAlert } from '@/server/jobs';
import { emailHmac, pollPortal, POLL_OVERLAP_MS } from '@/server/services/intake';
import { acquireLease, LeaseNames } from '@/server/services/leases';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createIntakeRig, cursorOf, HOUR, jobsOf, leadsOf, MINUTE, runCron, type IntakeRig } from './support';

// pollPortal (PLAN §9.2, D-07, D-14, D-16, D-31) and the PLAN §12 intake cases, on the fake portal.

const getDb = setUpTestDb();

let rig: IntakeRig;

beforeEach(async () => {
  rig = await createIntakeRig(getDb());
});

async function poll(trigger: 'webhook' | 'cron' = 'cron') {
  return pollPortal(rig.deps, rig.accountId, trigger, { sleep: rig.sleep });
}

async function contentOf(leadId: string) {
  return getDb().maybeOne<{ message: string | null; first_name: string | null; last_name: string | null; company: string | null; email: string | null; purge_at: Date }>(
    `select message, first_name, last_name, company, email, purge_at from lead_messages where lead_id = $1`,
    [leadId],
  );
}

describe('pollPortal', () => {
  it('inserts the lead, its content and its lead_process job together, and publishes the job', async () => {
    const at = rig.clock.now();
    const { contactId, conversionId } = rig.hubspot.submitForm({
      formId: rig.contactUs,
      email: 'Nina.Patel@Example.com',
      firstName: 'Nina',
      lastName: 'Patel',
      company: 'Patel Dental',
      message: 'Two dental chairs need new water lines. Can you quote?',
      at,
      newContact: true,
    });
    const result = await poll('webhook');
    expect(result).toMatchObject({ status: 'polled', counts: { leadsCreated: 1, forms: 2 } });

    const [lead] = await leadsOf(getDb(), rig.accountId);
    expect(lead).toMatchObject({
      hubspot_contact_id: contactId,
      form_id: rig.contactUs,
      conversion_id: conversionId,
      submission_key: conversionId,
      intake_trigger: 'webhook',
      processing_state: 'new',
    });
    expect(lead?.submitted_at.toISOString()).toBe(at.toISOString());
    const content = await contentOf(lead?.id ?? '');
    expect(content).toMatchObject({ first_name: 'Nina', last_name: 'Patel', company: 'Patel Dental', email: 'nina.patel@example.com' });
    expect(content?.purge_at.toISOString()).toBe(new Date(at.getTime() + 30 * 24 * HOUR).toISOString());

    const [job] = await jobsOf(getDb(), 'lead_process');
    expect(job).toMatchObject({ dedupe_key: `lead:${lead?.id}:process:r0`, lead_id: lead?.id, status: 'scheduled' });
    expect(rig.fakes.scheduler.pending().filter((message) => message.kind === 'lead_process')).toHaveLength(1);
    expect(await cursorOf(getDb(), rig.accountId, rig.contactUs)).toEqual(at);
    const connection = await getDb().one<{ last_polled_at: Date | null }>(`select last_polled_at from hubspot_connections where id = $1`, [rig.connectionId]);
    expect(connection.last_polled_at).not.toBeNull();
  });

  it('turns a submission whose contact becomes visible 30 min later into a lead', async () => {
    const at = rig.clock.now();
    const { contactId } = rig.hubspot.submitForm({
      formId: rig.quote,
      email: 'omar.haddad@example.com',
      message: 'Quote for a new water softener please.',
      at,
      newContact: true,
      visibilityDelayMs: 30 * MINUTE,
    });
    for (let minutes = 5; minutes < 30; minutes += 5) {
      rig.clock.set(new Date(at.getTime() + minutes * MINUTE));
      expect(await poll()).toMatchObject({ counts: { contactPending: 1, leadsCreated: 0 } });
    }
    expect(await cursorOf(getDb(), rig.accountId, rig.quote)).not.toEqual(at);
    rig.clock.set(new Date(at.getTime() + 30 * MINUTE));
    expect(await poll()).toMatchObject({ counts: { leadsCreated: 1 } });
    expect(await leadsOf(getDb(), rig.accountId)).toEqual([expect.objectContaining({ hubspot_contact_id: contactId, intake_trigger: 'cron' })]);
    expect(await cursorOf(getDb(), rig.accountId, rig.quote)).toEqual(at);
  });

  it('never ingests historical submissions below the floor', async () => {
    // The fixture portal holds five September submissions; this one is a minute before the floor.
    const floor = new Date(rig.clock.now().getTime() - MINUTE);
    rig.hubspot.submitForm({ formId: rig.contactUs, email: 'early.bird@example.com', message: 'Leaking tap.', at: new Date(floor.getTime() - 1), newContact: true });
    rig.hubspot.submitForm({ formId: rig.contactUs, email: 'exactly.floor@example.com', message: 'Leaking tap.', at: floor, newContact: true });
    const result = await poll();
    expect(result).toMatchObject({ status: 'polled', counts: { considered: 0, leadsCreated: 0 } });
    rig.clock.advance(2 * HOUR);
    await poll();
    expect(await leadsOf(getDb(), rig.accountId)).toHaveLength(0);
  });

  it('never makes a lead of a test-address submission, even re-read 25 h after the check was created', async () => {
    const testAddress = rig.hubspot.testAddress ?? 'owner.personal@example.net';
    const checkCreatedAt = rig.clock.now();
    await getDb().query(
      `insert into inbox_checks (account_id, test_address, test_address_hmac, created_at) values ($1, $2, $3, $4)`,
      [rig.accountId, testAddress, emailHmac(rig.deps.env, testAddress.toUpperCase()), checkCreatedAt],
    );
    rig.clock.advance(10 * MINUTE);
    const submittedAt = rig.clock.now();
    rig.hubspot.submitForm({ formId: rig.contactUs, email: testAddress, firstName: 'Owner', message: 'Testing the inbox check.', at: submittedAt });
    expect(await poll()).toMatchObject({ counts: { testAddressSkipped: 1, leadsCreated: 0 } });
    expect(await cursorOf(getDb(), rig.accountId, rig.contactUs)).toEqual(submittedAt);

    // 24 h later the address itself is cleared; only the HMAC remains. No newer submission arrives.
    await getDb().query(`update inbox_checks set test_address = null where account_id = $1`, [rig.accountId]);
    rig.clock.set(new Date(checkCreatedAt.getTime() + 25 * HOUR));
    expect(await poll()).toMatchObject({ status: 'polled', counts: { testAddressSkipped: 1, leadsCreated: 0 } });
    expect(await leadsOf(getDb(), rig.accountId)).toHaveLength(0);
  });

  it('skips the test address only inside the check window (1 h before to 24 h after its creation)', async () => {
    const testAddress = 'owner.personal@example.net';
    await getDb().query(`insert into inbox_checks (account_id, test_address_hmac, created_at) values ($1, $2, $3)`, [
      rig.accountId,
      emailHmac(rig.deps.env, testAddress),
      new Date(rig.clock.now().getTime() + 2 * HOUR),
    ]);
    rig.hubspot.submitForm({ formId: rig.contactUs, email: testAddress, firstName: 'Owner', message: 'A real question, long before the test.', at: rig.clock.now() });
    expect(await poll()).toMatchObject({ counts: { testAddressSkipped: 0, leadsCreated: 1 } });
  });

  it('fills missing fields from the contact and stores them only with the lead content, which purges with it', async () => {
    const at = rig.clock.now();
    // Maya (contact 101) submits again with only her email and a message (no webhook: existing contact).
    rig.hubspot.submitForm({ formId: rig.quote, email: 'maya.okafor@example.com', message: 'Can you also quote a new dishwasher hookup?', at });
    await poll();
    const [lead] = await leadsOf(getDb(), rig.accountId);
    expect(lead).toMatchObject({ hubspot_contact_id: '101' });
    const content = await contentOf(lead?.id ?? '');
    expect(content).toMatchObject({
      first_name: 'Maya',
      last_name: 'Okafor',
      company: 'Okafor Bakery',
      email: 'maya.okafor@example.com',
      message: 'Can you also quote a new dishwasher hookup?',
    });
    const leadRow = await getDb().one<Record<string, unknown>>(`select * from leads where id = $1`, [lead?.id ?? '']);
    expect(Object.values(leadRow)).not.toContain('Maya');
    expect(Object.values(leadRow)).not.toContain('Okafor Bakery');

    // PLAN §9.10 step 1 at 30 d + 1 h: the contact-filled values go with the rest.
    rig.clock.set(new Date(at.getTime() + 30 * 24 * HOUR + HOUR));
    await getDb().query(`delete from lead_messages where purge_at < $1`, [rig.clock.now()]);
    expect(await contentOf(lead?.id ?? '')).toBeNull();
  });

  it('picks up a repeat submission by an existing contact (no webhook) on the cron poll, as cron', async () => {
    const at = rig.clock.now();
    rig.hubspot.submitForm({ formId: rig.contactUs, email: 'tom.reyes@example.org', message: 'Following up on the faucet quote.', at, newContact: false });
    const summary = await runCron(rig);
    expect(summary).toMatchObject({ ok: true, status: 'ran', polled: 1, leadsCreated: 1 });
    expect(await leadsOf(getDb(), rig.accountId)).toEqual([expect.objectContaining({ hubspot_contact_id: '102', intake_trigger: 'cron' })]);
  });

  it('moves the cursor only forward (GREATEST)', async () => {
    const start = rig.clock.now();
    const older = new Date(start.getTime() + 10 * MINUTE);
    const newer = new Date(start.getTime() + 20 * MINUTE);
    rig.clock.set(older);
    rig.hubspot.submitForm({ formId: rig.contactUs, email: 'slow.contact@example.com', message: 'Burst pipe.', at: older, newContact: true, visibilityDelayMs: 20 * MINUTE });
    rig.clock.set(newer);
    rig.hubspot.submitForm({ formId: rig.contactUs, email: 'fast.contact@example.com', message: 'Blocked drain.', at: newer, newContact: true });
    rig.clock.set(new Date(start.getTime() + 25 * MINUTE));
    expect(await poll()).toMatchObject({ counts: { leadsCreated: 1, contactPending: 1 } });
    expect(await cursorOf(getDb(), rig.accountId, rig.contactUs)).toEqual(newer);

    // Something already moved the cursor further (a processed submission HubSpot no longer lists).
    const further = new Date(start.getTime() + 24 * MINUTE);
    await getDb().query(`update selected_forms set cursor_submitted_at = $3 where account_id = $1 and form_id = $2`, [rig.accountId, rig.contactUs, further]);

    // The older submission's contact appears: it becomes a lead, and the cursor does not move back.
    rig.clock.set(new Date(start.getTime() + 35 * MINUTE));
    expect(await poll()).toMatchObject({ counts: { leadsCreated: 1, alreadyKnown: 1 } });
    expect(await cursorOf(getDb(), rig.accountId, rig.contactUs)).toEqual(further);
    expect(await leadsOf(getDb(), rig.accountId)).toHaveLength(2);
  });

  it('gives up on a contact that never appears after the overlap: one audit entry without content, one alert', async () => {
    const alerts: string[] = [];
    const stop = onAlert((alert) => alerts.push(alert.code));
    try {
      const at = rig.clock.now();
      rig.hubspot.submitForm({ formId: rig.contactUs, email: 'ghost@example.com', firstName: 'Casper', message: 'Secret message', at, newContact: true, visibilityDelayMs: 10 * 24 * HOUR });
      rig.clock.set(new Date(at.getTime() + POLL_OVERLAP_MS));
      expect(await poll()).toMatchObject({ counts: { contactPending: 1 } });
      rig.clock.set(new Date(at.getTime() + POLL_OVERLAP_MS + 5 * MINUTE));
      expect(await poll()).toMatchObject({ counts: { contactMissing: 1 } });
      rig.clock.advance(5 * MINUTE);
      await poll();

      const audit = await getDb().query<{ action: string; level: string; meta: Record<string, unknown> }>(
        `select action, level, meta from audit_log where account_id = $1`,
        [rig.accountId],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'intake.contact_not_found', level: 'warn', meta: { formId: rig.contactUs } });
      const serialized = JSON.stringify(audit);
      for (const content of ['ghost@example.com', 'Casper', 'Secret message']) expect(serialized).not.toContain(content);
      expect(alerts.filter((code) => code === 'intake_contact_not_found')).toHaveLength(1);
      expect(await cursorOf(getDb(), rig.accountId, rig.contactUs)).toEqual(at);
      expect(await leadsOf(getDb(), rig.accountId)).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it('polls active accounts only', async () => {
    await getDb().query(`update accounts set paused_at = $2, processing_state = 'paused' where id = $1`, [rig.accountId, rig.clock.now()]);
    rig.hubspot.submitForm({ formId: rig.contactUs, email: 'tom.reyes@example.org', message: 'While paused.', at: rig.clock.now() });
    expect(await poll()).toEqual({ status: 'not_active' });
    expect(await leadsOf(getDb(), rig.accountId)).toHaveLength(0);
  });

  it('does not poll an account whose lease another poll holds', async () => {
    const lease = await acquireLease(getDb(), { name: LeaseNames.accountPoll(rig.accountId), ttlMs: 60_000, now: rig.clock.now() });
    expect(lease).not.toBeNull();
    expect(await poll()).toEqual({ status: 'busy' });
    rig.clock.advance(61_000);
    expect(await poll()).toMatchObject({ status: 'polled' });
  });

  it('dedupes submissions it has already turned into leads without looking their contacts up again', async () => {
    rig.hubspot.submitForm({ formId: rig.contactUs, email: 'tom.reyes@example.org', message: 'Once.', at: rig.clock.now(), withConversionId: false });
    expect(await poll()).toMatchObject({ counts: { leadsCreated: 1 } });
    rig.clock.advance(5 * MINUTE);
    rig.hubspot.injectFailure('getContact', { kind: 'server_error', times: 5 });
    expect(await poll()).toMatchObject({ counts: { leadsCreated: 0, alreadyKnown: 1 } });
    const [lead] = await leadsOf(getDb(), rig.accountId);
    expect(lead?.conversion_id).toBeNull();
    expect(lead?.submission_key).toMatch(/^[0-9a-f]{64}$/);
  });
});
