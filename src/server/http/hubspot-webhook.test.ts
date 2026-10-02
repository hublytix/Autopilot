import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb as setUpTestDb } from '../../../test/db/harness';
import {
  createIntakeRig,
  deliverWebhook,
  jobsOf,
  leadsOf,
  MINUTE,
  runCron,
  signedRawRequest,
  webhookRequest,
  type IntakeRig,
} from '../../../test/intake/support';
import { handleHubSpotWebhook } from './hubspot-webhook';

// PLAN §12 "Idempotent webhook replay": same body twice, attemptNumber 0/1, webhook + poller → one
// lead, appId mismatch; plus the signature, debounce, unknown-portal and privacy-deletion rules
// (§7.3, D-05, D-06). Real Request objects, signed by the fake portal as HubSpot signs them.

const getDb = setUpTestDb();

let rig: IntakeRig;

beforeEach(async () => {
  rig = await createIntakeRig(getDb());
});

async function webhookEvents(): Promise<{ dedupe_key: string; outcome: string | null; account_id: string | null; body_sha256: string | null }[]> {
  return getDb().query(`select dedupe_key, outcome, account_id, body_sha256 from webhook_events order by id`);
}

describe('POST /api/hubspot/webhooks', () => {
  it('records the same body delivered twice once, and queues one pair of polls', async () => {
    const request = webhookRequest(rig, [{ subscriptionType: 'object.creation', objectId: '101' }]);
    const again = request.clone();
    expect((await handleHubSpotWebhook(request, rig.deps)).status).toBe(200);
    const second = await handleHubSpotWebhook(again, rig.deps);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, duplicates: 1, pollsQueued: 0 });

    const events = await webhookEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'poll_queued', account_id: rig.accountId });
    expect(events[0]?.dedupe_key).toMatch(/^1234567:object\.creation:101:\d+:\d{13}$/);
    expect(events[0]?.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await jobsOf(getDb(), 'portal_poll')).toHaveLength(2);
  });

  it('treats a retry with a higher attemptNumber as the same event', async () => {
    const occurredAt = rig.clock.now();
    const event = { subscriptionType: 'object.creation', objectId: '101', eventId: 77, occurredAt } as const;
    expect((await deliverWebhook(rig, [{ ...event, attemptNumber: 0 }])).status).toBe(200);
    rig.clock.advance(30_000);
    const retry = await deliverWebhook(rig, [{ ...event, attemptNumber: 1 }]);
    expect(await retry.json()).toMatchObject({ duplicates: 1 });
    expect(await webhookEvents()).toHaveLength(1);
    expect(await jobsOf(getDb(), 'portal_poll')).toHaveLength(2);
  });

  it('turns a webhook and the poller into one lead', async () => {
    const at = rig.clock.now();
    const { contactId } = rig.hubspot.submitForm({
      formId: rig.contactUs,
      email: 'nina.patel@example.com',
      firstName: 'Nina',
      message: 'Our kitchen sink drains slowly. Can you quote a fix?',
      at,
      newContact: true,
    });
    if (contactId === null) throw new Error('contact not created');
    expect((await deliverWebhook(rig, [{ subscriptionType: 'object.creation', objectId: contactId }])).status).toBe(200);

    await rig.fakes.scheduler.runDue(rig.clock.now());
    await runCron(rig);
    rig.clock.advance(2 * MINUTE);
    await rig.fakes.scheduler.runDue(rig.clock.now());
    await runCron(rig);

    const leads = await leadsOf(getDb(), rig.accountId);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ hubspot_contact_id: contactId, intake_trigger: 'webhook', processing_state: 'new' });
    const polls = await jobsOf(getDb(), 'portal_poll');
    expect(polls.map((job) => job.status)).toEqual(['done', 'done']);
  });

  it('drops events of another app before recording anything', async () => {
    const response = await deliverWebhook(rig, [{ subscriptionType: 'object.creation', objectId: '101', appId: '9999999' }]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, otherApp: 1 });
    expect(await webhookEvents()).toHaveLength(0);
    expect(await jobsOf(getDb(), 'portal_poll')).toHaveLength(0);
  });

  it('refuses a bad signature with 401 and records nothing', async () => {
    const forged = await deliverWebhook(rig, [{ subscriptionType: 'object.creation', objectId: '101' }], { clientSecret: 'not-the-client-secret' });
    expect(forged.status).toBe(401);
    const stale = await deliverWebhook(rig, [{ subscriptionType: 'object.creation', objectId: '101' }], {
      timestampMs: rig.clock.now().getTime() - 300_001,
    });
    expect(stale.status).toBe(401);
    expect(await webhookEvents()).toHaveLength(0);
  });

  it('answers 200 for an unknown portal and records the event without an account', async () => {
    const response = await deliverWebhook(rig, [{ subscriptionType: 'contact.privacyDeletion', objectId: '101', portalId: '7654321' }]);
    expect(response.status).toBe(200);
    expect(await webhookEvents()).toEqual([expect.objectContaining({ outcome: 'unknown_portal', account_id: null })]);
    expect(await jobsOf(getDb(), 'privacy_delete')).toHaveLength(0);
  });

  it('debounces creation events to one pair of polls a minute, now and 90 s later', async () => {
    rig.clock.set(new Date('2026-10-06T14:05:10.000Z'));
    await deliverWebhook(rig, [{ subscriptionType: 'object.creation', objectId: '101' }]);
    rig.clock.advance(20_000);
    const debounced = await deliverWebhook(rig, [
      { subscriptionType: 'contact.creation', objectId: '102' },
      { subscriptionType: 'object.creation', objectId: '103' },
    ]);
    expect(await debounced.json()).toMatchObject({ pollsQueued: 0, pollsDebounced: 2 });
    rig.clock.advance(MINUTE);
    await deliverWebhook(rig, [{ subscriptionType: 'object.creation', objectId: '104' }]);

    const polls = await jobsOf(getDb(), 'portal_poll');
    expect(polls.map((job) => job.dedupe_key)).toEqual([
      `poll:${rig.accountId}:2026-10-06T14:05:a`,
      `poll:${rig.accountId}:2026-10-06T14:06:a`,
      `poll:${rig.accountId}:2026-10-06T14:05:b`,
      `poll:${rig.accountId}:2026-10-06T14:06:b`,
    ]);
    const first = polls.filter((job) => job.dedupe_key.includes('14:05'));
    expect(first.map((job) => job.run_at.toISOString())).toEqual(['2026-10-06T14:05:10.000Z', '2026-10-06T14:06:40.000Z']);
    const connection = await getDb().one<{ poll_requested_at: Date; last_webhook_at: Date }>(
      `select poll_requested_at, last_webhook_at from hubspot_connections where id = $1`,
      [rig.connectionId],
    );
    expect(connection.poll_requested_at.toISOString()).toBe('2026-10-06T14:06:30.000Z');
    expect(connection.last_webhook_at.toISOString()).toBe('2026-10-06T14:06:30.000Z');
  });

  it('queues no polls for a portal that is not active, but still queues its privacy deletions', async () => {
    await getDb().query(`update accounts set paused_at = $2, processing_state = 'paused' where id = $1`, [rig.accountId, rig.clock.now()]);
    const response = await deliverWebhook(rig, [
      { subscriptionType: 'object.creation', objectId: '101' },
      { subscriptionType: 'contact.privacyDeletion', objectId: '101' },
    ]);
    expect(await response.json()).toMatchObject({ notActive: 1, privacyDeletesQueued: 1 });
    expect(await jobsOf(getDb(), 'portal_poll')).toHaveLength(0);
    const [job] = await jobsOf(getDb(), 'privacy_delete');
    expect(job?.dedupe_key).toMatch(/^privacy:1234567:101:\d{13}$/);
    expect(job?.payload).toMatchObject({ portalId: '1234567', contactId: '101' });
  });

  it('records and ignores event types it does not handle, and answers 200 to a body it cannot read', async () => {
    const event = {
      eventId: 9,
      subscriptionId: 1,
      portalId: 1234567,
      appId: Number(rig.deps.env.HUBSPOT_APP_ID),
      occurredAt: rig.clock.now().getTime(),
      subscriptionType: 'contact.propertyChange',
      attemptNumber: 0,
      objectId: 101,
      propertyName: 'message',
      propertyValue: 'not stored',
    };
    const other = await handleHubSpotWebhook(signedRawRequest(rig, JSON.stringify([event, { eventId: 'x' }])), rig.deps);
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ ok: true, ignored: 1, malformed: 1 });
    expect(await webhookEvents()).toEqual([expect.objectContaining({ outcome: 'ignored' })]);

    const unreadable = await handleHubSpotWebhook(signedRawRequest(rig, '{"not":"an array"}'), rig.deps);
    expect(unreadable.status).toBe(200);
    expect(await unreadable.json()).toMatchObject({ ok: true, code: 'webhook_body_ignored' });
    const tooMany = JSON.stringify(Array.from({ length: 101 }, () => event));
    expect(await (await handleHubSpotWebhook(signedRawRequest(rig, tooMany), rig.deps)).json()).toMatchObject({ code: 'webhook_body_ignored' });
  });

  it('a poll job that finds the contact not yet visible leaves it to the +90 s poll', async () => {
    const at = rig.clock.now();
    const { contactId } = rig.hubspot.submitForm({
      formId: rig.quote,
      email: 'omar.haddad@example.com',
      message: 'Quote for a new water softener please.',
      at,
      newContact: true,
      visibilityDelayMs: MINUTE,
    });
    if (contactId === null) throw new Error('contact not created');
    await deliverWebhook(rig, [{ subscriptionType: 'object.creation', objectId: contactId }]);
    await rig.fakes.scheduler.runDue(rig.clock.now());
    expect(await leadsOf(getDb(), rig.accountId)).toHaveLength(0);
    rig.clock.advance(90_000);
    await rig.fakes.scheduler.runDue(rig.clock.now());
    expect(await leadsOf(getDb(), rig.accountId)).toEqual([expect.objectContaining({ hubspot_contact_id: contactId, intake_trigger: 'webhook' })]);
  });
});
