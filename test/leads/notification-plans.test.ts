import { beforeEach, describe, expect, it } from 'vitest';
import type { FakeSentMail } from '@/server/adapters/fake/mailer/fake-mailer';
import type { Db } from '@/server/db';
import { createJobHandlerRegistries } from '@/server/jobs/handlers';
import { verifyActionToken } from '@/server/security/action-tokens';
import { followUpNotificationPlan } from '@/server/services/leads/follow-up-notification';
import { initialNotificationPlan } from '@/server/services/leads/initial-notification';
import { parseLeadNotificationKey, registerLeadNotifications } from '@/server/services/leads/notifications';
import { replyDetectedKey, replyDetectedNotificationPlan } from '@/server/services/leads/reply-detected-notification';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import { createNotificationRegistry } from '@/server/services/notifications/renderers';
import { getNotification, reserveInTx } from '@/server/services/notifications/reserve';
import { reserveAndSend, sendReserved } from '@/server/services/notifications/send';
import { useTestDb as setUpTestDb } from '../db/harness';
import { actionLinks, createLeadsRig, NOTIFY_EMAIL, OWNER_EMAIL, PORTAL_ID, seedLeadAccount, seedNewLead, tokenOf, type LeadsRig } from './support';

// The follow-up and reply-detected emails' send plans (built now, used by M5's follow-up job and
// markReplied) and the resumers of every lead email (PLAN §8.3 step 7, §8.4, D-34, D-45).

const getDb = setUpTestDb();

let rig: LeadsRig;

beforeEach(() => {
  rig = createLeadsRig(getDb());
});

const CONTACT_ID = '9001';

async function notifiedLead(db: Db, options: { loggingMode?: 'log_all' | 'sends_only' | 'none' | 'unknown'; sendConfirmed?: boolean } = {}) {
  const now = rig.clock.now();
  const accountId = await seedLeadAccount(db, { now, loggingMode: options.loggingMode });
  const leadId = await seedNewLead(db, { accountId, now, contactId: CONTACT_ID });
  await db.query(
    `update leads set processing_state = 'notified', classification = 'lead', classified_at = $2, first_notified_at = $2, send_confirmed_at = $3 where id = $1`,
    [leadId, now, options.sendConfirmed === true ? now : null],
  );
  return { accountId, leadId };
}

async function seedDraft(db: Db, input: { accountId: string; leadId: string; kind: 'initial' | 'fu1' | 'fu2'; needsTouch?: boolean }): Promise<string> {
  const row = await db.one<{ id: string }>(
    `insert into drafts (lead_id, account_id, kind, subject, body, validation_ok, needs_touch, purge_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      input.leadId,
      input.accountId,
      input.kind,
      input.kind === 'initial' ? 'Your leaking sink' : 'Re: Your leaking sink',
      input.kind === 'initial' ? 'Hi Maya,\n\nThanks for getting in touch.\n\nDana' : 'Hi Maya,\n\nJust following up on my earlier email.\n\nDana',
      input.needsTouch !== true,
      input.needsTouch === true,
      new Date(rig.clock.now().getTime() + 30 * 86_400_000),
    ],
  );
  return row.id;
}

function only(kind: string): FakeSentMail {
  const mails = rig.fakes.mailer.sent;
  expect(mails.map((mail) => mail.kind)).toEqual([kind]);
  const [mail] = mails;
  if (mail === undefined) throw new Error('no email');
  return mail;
}

describe('follow-up plan (for M5)', () => {
  it('sends follow-up 1 with D-34’s notes, the draft and three working links; the sent transaction stamps fu1_notified_at', async () => {
    const db = getDb();
    const { accountId, leadId } = await notifiedLead(db, { loggingMode: 'sends_only' });
    const draftId = await seedDraft(db, { accountId, leadId, kind: 'fu1' });

    const built = await followUpNotificationPlan(rig.deps, { accountId, leadId, n: 1, followupStream: 0 });
    expect(built).toMatchObject({ kind: 'follow_up', dedupeKey: `notify:${leadId}:fu1:s0` });
    if (built === null) throw new Error('no plan');
    expect(await reserveAndSend(rig.deps, { kind: built.kind, dedupeKey: built.dedupeKey, accountId, leadId, ...built.plan })).toMatchObject({ status: 'sent' });

    const mail = only('follow_up');
    expect(mail.subject).toBe('Follow-up 1 for Maya — your draft is ready');
    expect(mail.to).toEqual([NOTIFY_EMAIL]);
    expect(mail.replyTo).toBe(OWNER_EMAIL);
    expect(mail.text).toContain("This email isn't monitored. To answer the lead, tap 'Send from my email'.");
    expect(mail.text).toContain("We couldn't confirm in HubSpot that your first reply was sent.");
    expect(mail.text).toContain("HubSpot isn't logging replies for you, so check your inbox before sending.");
    expect(mail.text).toContain('Just following up on my earlier email.');
    const links = actionLinks(mail.html);
    expect(links).toHaveLength(4);
    for (const [url, purpose] of [
      [links[0], 'send'],
      [links[1], 'edit'],
      [links[2], 'dismiss'],
    ] as const) {
      expect(await verifyActionToken(db, tokenOf(url ?? '', purpose), purpose, rig.clock.now())).toMatchObject({ ok: true, token: { draftId, leadId, purpose } });
    }
    const lead = await db.one<{ fu1_notified_at: Date | null; fu2_notified_at: Date | null }>(`select fu1_notified_at, fu2_notified_at from leads where id = $1`, [leadId]);
    expect(lead).toEqual({ fu1_notified_at: rig.clock.now(), fu2_notified_at: null });
  });

  it('a starter follow-up draft is a needs_touch email under the same key', async () => {
    const db = getDb();
    const { accountId, leadId } = await notifiedLead(db, { sendConfirmed: true });
    await seedDraft(db, { accountId, leadId, kind: 'fu2', needsTouch: true });
    const built = await followUpNotificationPlan(rig.deps, { accountId, leadId, n: 2, followupStream: 0, why: 'declined' });
    expect(built).toMatchObject({ kind: 'needs_touch', dedupeKey: `notify:${leadId}:fu2:s0` });
    if (built === null) throw new Error('no plan');
    await reserveAndSend(rig.deps, { kind: built.kind, dedupeKey: built.dedupeKey, accountId, leadId, ...built.plan });
    const mail = only('needs_touch');
    expect(mail.subject).toBe('Follow-up 2 for Maya — your draft needs your touch');
    expect(mail.text).toContain('The AI model that writes your drafts declined to write your reply to this message.');
    expect(mail.text).not.toContain("We couldn't confirm in HubSpot");
  });

  it('respects the follow-up predicates: a replied lead gets nothing', async () => {
    const db = getDb();
    const { accountId, leadId } = await notifiedLead(db);
    await seedDraft(db, { accountId, leadId, kind: 'fu1' });
    await db.query(`update leads set replied_at = $2 where id = $1`, [leadId, rig.clock.now()]);
    const built = await followUpNotificationPlan(rig.deps, { accountId, leadId, n: 1, followupStream: 0 });
    if (built === null) throw new Error('no plan');
    expect(await reserveAndSend(rig.deps, { kind: built.kind, dedupeKey: built.dedupeKey, accountId, leadId, ...built.plan })).toEqual({
      status: 'skipped',
      reason: 'predicates',
    });
    expect(rig.fakes.mailer.sent).toEqual([]);
  });

  it('has no plan without the follow-up draft', async () => {
    const db = getDb();
    const { accountId, leadId } = await notifiedLead(db);
    expect(await followUpNotificationPlan(rig.deps, { accountId, leadId, n: 1, followupStream: 0 })).toBeNull();
  });
});

describe('reply-detected plan (for M5)', () => {
  it('reserved in markReplied’s transaction, sent after commit through the resumer, with the HubSpot record link', async () => {
    const db = getDb();
    const { accountId, leadId } = await notifiedLead(db);
    const key = replyDetectedKey(leadId, 0);
    await db.tx(async (tx) => {
      await tx.query(`update leads set replied_at = $2 where id = $1`, [leadId, new Date('2026-10-07T13:05:00.000Z')]);
      await reserveInTx(tx, {
        kind: 'reply_detected',
        dedupeKey: key,
        accountId,
        leadId,
        predicates: NotificationPredicates.replyDetected({ accountId, leadId }),
        now: rig.clock.now(),
      });
    });

    expect(await sendReserved(rig.deps, key, rig.notifications)).toMatchObject({ status: 'sent' });

    const mail = only('reply_detected');
    expect(mail.subject).toBe('Maya replied — follow-ups stopped');
    expect(mail.replyTo).toBe(OWNER_EMAIL);
    expect(mail.text).toContain('HubSpot logged a reply from Maya on Wed 7 Oct, 09:05.');
    expect(mail.html).toContain(`href="https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-1/${CONTACT_ID}"`);
    expect(actionLinks(mail.html)).toEqual([]);
    expect(mail.text).not.toMatch(/okafor-bakery|sink/i);
  });

  it('is not sent for a lead without a logged reply (predicates)', async () => {
    const db = getDb();
    const { accountId, leadId } = await notifiedLead(db);
    const plan = await replyDetectedNotificationPlan(rig.deps, { accountId, leadId });
    if (plan === null) throw new Error('no plan');
    expect(await reserveAndSend(rig.deps, { kind: 'reply_detected', dedupeKey: replyDetectedKey(leadId, 0), accountId, leadId, ...plan })).toEqual({
      status: 'skipped',
      reason: 'predicates',
    });
  });
});

describe('lead email resumers', () => {
  it('rebuild a lost new_lead send from the stored rows', async () => {
    const db = getDb();
    const { accountId, leadId } = await notifiedLead(db);
    await db.query(`update leads set processing_state = 'processing', first_notified_at = null where id = $1`, [leadId]);
    await seedDraft(db, { accountId, leadId, kind: 'initial' });
    const key = NotificationKeys.initial(leadId, 0);
    await reserveInTx(db, { kind: 'new_lead', dedupeKey: key, accountId, leadId, predicates: NotificationPredicates.initial({ accountId, leadId }), now: rig.clock.now() });

    expect(await sendReserved(rig.deps, key, rig.notifications)).toMatchObject({ status: 'sent' });

    expect(only('new_lead').subject).toBe('New lead: Maya — your reply is ready');
    const lead = await db.one<{ processing_state: string; first_notified_at: Date | null }>(`select processing_state, first_notified_at from leads where id = $1`, [leadId]);
    expect(lead).toEqual({ processing_state: 'notified', first_notified_at: rig.clock.now() });
    expect(await db.query(`select dedupe_key from scheduled_jobs where lead_id = $1 and kind = 'followup' order by seq`, [leadId])).toHaveLength(2);
  });

  it('mark a reservation failed when the content it needs is gone', async () => {
    const db = getDb();
    const { accountId, leadId } = await notifiedLead(db);
    await seedDraft(db, { accountId, leadId, kind: 'initial' });
    const key = NotificationKeys.initial(leadId, 0);
    await db.query(`update leads set processing_state = 'processing', first_notified_at = null where id = $1`, [leadId]);
    await reserveInTx(db, { kind: 'needs_touch', dedupeKey: key, accountId, leadId, predicates: NotificationPredicates.initial({ accountId, leadId }), now: rig.clock.now() });
    await db.query(`delete from lead_messages where lead_id = $1`, [leadId]);

    expect(await sendReserved(rig.deps, key, rig.notifications)).toEqual({ status: 'failed', code: 'notification_not_resumable' });
    expect((await getNotification(db, key))?.status).toBe('failed');
    expect(rig.fakes.mailer.sent).toEqual([]);
  });

  it('the initial plan reports why it cannot be built', async () => {
    const db = getDb();
    const { accountId, leadId } = await notifiedLead(db);
    expect(await initialNotificationPlan(rig.deps, { accountId, leadId, processRev: 0, kind: 'new_lead' })).toEqual({ ok: false, problem: 'draft_missing' });
    await db.query(`update settings set notify_emails_verified = '{}' where account_id = $1`, [accountId]);
    await db.query(`delete from users where account_id = $1`, [accountId]);
    await seedDraft(db, { accountId, leadId, kind: 'initial' });
    expect(await initialNotificationPlan(rig.deps, { accountId, leadId, processRev: 0, kind: 'new_lead' })).toEqual({ ok: false, problem: 'no_recipients' });
  });

  it('send to the owner’s sign-in address when no notify address is confirmed', async () => {
    const db = getDb();
    const { accountId, leadId } = await notifiedLead(db);
    await db.query(`update settings set notify_emails = array['someone@example.net'], notify_emails_verified = '{}' where account_id = $1`, [accountId]);
    await seedDraft(db, { accountId, leadId, kind: 'initial' });
    const built = await initialNotificationPlan(rig.deps, { accountId, leadId, processRev: 0, kind: 'new_lead' });
    if (!built.ok) throw new Error(built.problem);
    await db.query(`update leads set processing_state = 'processing', first_notified_at = null where id = $1`, [leadId]);
    await reserveAndSend(rig.deps, { kind: 'new_lead', dedupeKey: NotificationKeys.initial(leadId, 0), accountId, leadId, ...built.plan });
    expect(only('new_lead').to).toEqual([OWNER_EMAIL]);
  });

  it('parse every lead email key and nothing else', () => {
    const id = '0b1c2d3e-4f50-4a61-8b72-9c0d1e2f3a4b';
    expect(parseLeadNotificationKey(`notify:${id}:initial:r2`)).toEqual({ type: 'initial', leadId: id, processRev: 2 });
    expect(parseLeadNotificationKey(`notify:${id}:fu2:s1`)).toEqual({ type: 'follow_up', leadId: id, n: 2, followupStream: 1 });
    expect(parseLeadNotificationKey(`reply:${id}:s0`)).toEqual({ type: 'reply', leadId: id, followupStream: 0 });
    expect(parseLeadNotificationKey(`notify:${id}:fu3:s0`)).toBeNull();
    expect(parseLeadNotificationKey(`cap:${id}:2026-10-06`)).toBeNull();
    expect(parseLeadNotificationKey(`notify:not-a-uuid:initial:r0`)).toBeNull();
  });

  it('are registered with lead_process, once, in the app registries', () => {
    const registries = createJobHandlerRegistries();
    for (const kind of ['new_lead', 'needs_touch', 'follow_up', 'reply_detected'] as const) expect(registries.notifications.resumer(kind)).toBeTypeOf('function');
    const notifications = createNotificationRegistry();
    registerLeadNotifications({ notifications });
    expect(() => registerLeadNotifications({ notifications })).not.toThrow();
  });
});
