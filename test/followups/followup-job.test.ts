import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_SEND_UNCONFIRMED_NOTE, REPLIES_NOT_LOGGED_NOTE, REPLIES_UNKNOWN_NOTE } from '@/emails/components/HonestNotes';
import { followUpOpening } from '@/emails/FollowUp';
import type { LoggingMode } from '@/server/domain/types';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { runSweeper } from '@/server/jobs/sweeper';
import { verifyActionToken } from '@/server/security/action-tokens';
import { useTestDb as setUpTestDb } from '../db/harness';
import { actionLinks, tokenOf } from '../leads/support';
import {
  at,
  createFollowUpRig,
  DAY,
  deliver,
  deliverWhenDue,
  followUpJob,
  followUpJobs,
  HOUR,
  INITIAL_BODY,
  INITIAL_SUBJECT,
  jobById,
  LEAD_EMAIL,
  leadRow,
  MINUTE,
  notifications,
  NOTIFY_EMAIL,
  onlyEmail,
  OWNER_EMAIL,
  seedFollowUpLead,
  sent,
  targetOf,
  type FollowUpRig,
} from './support';

// The follow-up job end to end on PGlite with every fake (brief §5.6, PLAN §8.3, §8.4, §8.5, §9.5,
// D-33, D-34): the email (draft quoting the first email, Reply-To the owner, three buttons,
// fu{n}_notified_at), the honest notes, quiet hours and weekends at fire time, the HubSpot daily
// limit, follow-up 2 never before follow-up 1, and exactly one email across crashes, retries and
// duplicate deliveries. T0 is Tuesday 2026-10-06 10:00 in New York: follow-up 1 is Thursday 10:00,
// follow-up 2 (Sunday) is shifted to Monday 08:00 plus the account's offset.

const getDb = setUpTestDb();
let rig: FollowUpRig;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(async () => {
  // PLAN §12: nothing here may read the wall clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createFollowUpRig(getDb());
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('followup job: the email', () => {
  it('sends follow-up 1 once on day 2: a short draft quoting the first email, to the notify address, Reply-To the owner, three working buttons', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const [fu1, fu2] = lead.jobs;
    if (fu1 === undefined || fu2 === undefined) throw new Error('no jobs');
    expect(targetOf(fu1)).toEqual(at(lead.t0, 2 * DAY));

    expect(await deliverWhenDue(rig, fu1)).toEqual({ status: 200, outcome: 'done' });

    const mail = onlyEmail(rig, 'follow_up');
    expect(mail.subject).toBe('Follow-up 1 for Maya — your draft is ready');
    expect(mail.to).toEqual([NOTIFY_EMAIL]);
    expect(mail.replyTo).toBe(OWNER_EMAIL);
    expect(mail.tags).toEqual([
      { name: 'kind', value: 'follow_up' },
      { name: 'lead', value: lead.leadId },
    ]);
    const calls = rig.fakes.llm.callsFor('followup');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.followUpNumber).toBe(1);
    expect(calls[0]?.input).toMatchObject({ original: { subject: INITIAL_SUBJECT, body: INITIAL_BODY } });
    const draft = await db.one<{ subject: string; body: string; validation_ok: boolean; needs_touch: boolean }>(
      `select subject, body, validation_ok, needs_touch from drafts where lead_id = $1 and kind = 'fu1'`,
      [lead.leadId],
    );
    expect(draft).toMatchObject({ subject: `Re: ${INITIAL_SUBJECT}`, validation_ok: true, needs_touch: false });
    expect(draft.body.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(70);
    expect(mail.text).toContain(draft.subject);

    // Send, the same send link for the default mail app (?via=mailto), edit and dismiss.
    const links = actionLinks(mail.html);
    expect(links).toHaveLength(4);
    for (const action of ['send', 'edit', 'dismiss'] as const) {
      const url = links.find((link) => new RegExp(`/a/[^/]+/${action}(?:\\?|$)`).test(link)) ?? '';
      expect(await verifyActionToken(db, tokenOf(url, action), action, rig.clock.now())).toMatchObject({ ok: true });
    }

    expect(await leadRow(db, lead.leadId)).toMatchObject({ fu1_notified_at: rig.clock.now(), fu2_notified_at: null, stop_reason: null });
    expect(await notifications(db, lead.leadId)).toEqual([{ dedupe_key: `notify:${lead.leadId}:fu1:s0`, kind: 'follow_up', status: 'sent' }]);
    expect((await jobById(db, fu2.id)).status).toBe('scheduled');
    // Never the lead: the owner sends it from their own mailbox (law 1).
    expect(sent(rig).flatMap((m) => m.to)).not.toContain(LEAD_EMAIL);
  });

  it('sends follow-up 2 after follow-up 1, the last one; the lead then reads "No reply from lead" without a stop reason', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const [fu1, fu2] = lead.jobs;
    if (fu1 === undefined || fu2 === undefined) throw new Error('no jobs');

    expect(await deliverWhenDue(rig, fu1)).toMatchObject({ outcome: 'done' });
    expect(await deliverWhenDue(rig, fu2)).toMatchObject({ outcome: 'done' });

    expect(sent(rig).map((m) => m.subject)).toEqual(['Follow-up 1 for Maya — your draft is ready', 'Follow-up 2 for Maya — your draft is ready']);
    expect(rig.fakes.llm.callsFor('followup').map((c) => c.request.followUpNumber)).toEqual([1, 2]);
    const row = await leadRow(db, lead.leadId);
    expect(row.fu2_notified_at).toEqual(rig.clock.now());
    expect(row.stop_reason).toBeNull();
    expect(await followUpJobs(db, lead.leadId)).toMatchObject([{ status: 'done' }, { status: 'done' }]);
  });

  it('a follow-up draft the model declines becomes a needs-touch email on the same key, saying why', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    rig.fakes.llm.injectFault('refusal', { purpose: 'followup' });

    expect(await deliverWhenDue(rig, lead.jobs[0] ?? { id: '' })).toMatchObject({ outcome: 'done' });

    const mail = onlyEmail(rig, 'needs_touch');
    expect(mail.subject).toBe('Follow-up 1 for Maya — your draft needs your touch');
    expect(await notifications(db, lead.leadId)).toEqual([{ dedupe_key: `notify:${lead.leadId}:fu1:s0`, kind: 'needs_touch', status: 'sent' }]);
    expect(await leadRow(db, lead.leadId)).toMatchObject({ fu1_notified_at: rig.clock.now() });
  });

  it('once the first email is purged, the follow-up is still drafted without quoting it', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    await db.query(`update drafts set subject = null, body = null, purged_at = $2 where lead_id = $1 and kind = 'initial'`, [lead.leadId, rig.clock.now()]);

    expect(await deliverWhenDue(rig, lead.jobs[0] ?? { id: '' })).toMatchObject({ outcome: 'done' });

    expect(rig.fakes.llm.callsFor('followup')[0]?.input).toMatchObject({ original: null });
    expect(onlyEmail(rig, 'follow_up').subject).toBe('Follow-up 1 for Maya — your draft is ready');
  });
});

describe('followup job: honest notes (D-34)', () => {
  const cases: { name: string; logged: boolean; mode: LoggingMode; present: string[]; absent: string[] }[] = [
    {
      name: 'send confirmed in HubSpot, replies logged: no note',
      logged: true,
      mode: 'log_all',
      present: [],
      absent: [FIRST_SEND_UNCONFIRMED_NOTE, REPLIES_NOT_LOGGED_NOTE, REPLIES_UNKNOWN_NOTE],
    },
    {
      name: 'send not confirmed: the unconfirmed-send note',
      logged: false,
      mode: 'log_all',
      present: [FIRST_SEND_UNCONFIRMED_NOTE],
      absent: [REPLIES_NOT_LOGGED_NOTE, REPLIES_UNKNOWN_NOTE],
    },
    {
      name: 'sends only (BCC): the replies-not-logged note',
      logged: true,
      mode: 'sends_only',
      present: [REPLIES_NOT_LOGGED_NOTE],
      absent: [FIRST_SEND_UNCONFIRMED_NOTE, REPLIES_UNKNOWN_NOTE],
    },
    {
      name: 'nothing logged: both notes',
      logged: false,
      mode: 'none',
      present: [FIRST_SEND_UNCONFIRMED_NOTE, REPLIES_NOT_LOGGED_NOTE],
      absent: [REPLIES_UNKNOWN_NOTE],
    },
    {
      name: 'logging not checked: the cautious reply note',
      logged: true,
      mode: 'unknown',
      present: [REPLIES_UNKNOWN_NOTE],
      absent: [FIRST_SEND_UNCONFIRMED_NOTE, REPLIES_NOT_LOGGED_NOTE],
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const db = getDb();
      await db.query(`update accounts set logging_mode = $2 where id = $1`, [rig.accountId, c.mode]);
      const lead = await seedFollowUpLead(rig);
      // The owner's send of the first reply, logged in HubSpot 12 minutes after T0: the job's own read confirms it.
      if (c.logged) rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(lead.t0, 12 * MINUTE) });

      expect(await deliverWhenDue(rig, lead.jobs[0] ?? { id: '' })).toMatchObject({ outcome: 'done' });

      const mail = onlyEmail(rig, 'follow_up');
      for (const note of c.present) {
        expect(mail.text).toContain(note);
        expect(mail.html).toContain(note.replaceAll("'", '&#x27;'));
      }
      for (const note of c.absent) expect(mail.text).not.toContain(note);
      expect((await leadRow(db, lead.leadId)).send_confirmed_at).toEqual(c.logged ? at(lead.t0, 12 * MINUTE) : null);
    });
  }
});

describe('followup job: "no reply is logged" only when HubSpot was read in full (law 3, D-73)', () => {
  const CHECKED = followUpOpening(1, false);
  const UNCHECKED = followUpOpening(1, true);

  it('a complete read: "No reply from this lead is logged in HubSpot since we first emailed you about them."', async () => {
    const lead = await seedFollowUpLead(rig);
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(lead.t0, 12 * MINUTE) });

    expect(await deliverWhenDue(rig, lead.jobs[0] ?? { id: '' })).toMatchObject({ outcome: 'done' });

    const mail = onlyEmail(rig, 'follow_up');
    expect(mail.text).toContain('No reply from this lead is logged in HubSpot since we first emailed you about them.');
    expect(mail.text).not.toContain(UNCHECKED);
  });

  it('HubSpot answers the email read with 403 MISSING_SCOPES: the follow-up says it could not tell, never "no reply is logged"', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(lead.t0, 12 * MINUTE) });
    rig.hubspot.setGrantedScopes(['oauth', 'crm.objects.contacts.read', 'forms']);

    expect(await deliverWhenDue(rig, lead.jobs[0] ?? { id: '' })).toMatchObject({ outcome: 'done' });

    const mail = onlyEmail(rig, 'follow_up');
    expect(mail.text).toContain(UNCHECKED);
    expect(mail.text).not.toContain(CHECKED);
    expect(mail.text).not.toMatch(/no reply from this lead is logged/i);
    // Nothing was confirmed from engagements, and the read is not recorded as a check.
    expect(await leadRow(db, lead.leadId)).toMatchObject({ send_confirmed_at: null });
    expect((await db.one<{ signals_checked_at: Date | null }>(`select signals_checked_at from leads where id = $1`, [lead.leadId])).signals_checked_at).toBeNull();
  });

  it('a stored grant without the email scope: the same cautious opening', async () => {
    const db = getDb();
    await db.query(`update hubspot_connections set scopes = $2 where account_id = $1`, [rig.accountId, ['oauth', 'crm.objects.contacts.read', 'forms']]);
    const lead = await seedFollowUpLead(rig);

    expect(await deliverWhenDue(rig, lead.jobs[0] ?? { id: '' })).toMatchObject({ outcome: 'done' });

    expect(onlyEmail(rig, 'follow_up').text).toContain(UNCHECKED);
  });

  it('the sweeper\'s resume renders the same opening as the job would have (complete read, then blind read)', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    expect(await deliverWhenDue(rig, lead.jobs[0] ?? { id: '' }, { retried: 4 })).toEqual({ status: 200, outcome: 'done' });
    rig.clock.advance({ minutes: 11 });
    await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });
    expect(onlyEmail(rig, 'follow_up').text).toContain(CHECKED);

    // Follow-up 2's read is blind (the portal dropped the scope) and its send is resumed too.
    rig.hubspot.logOwnerSend({ to: LEAD_EMAIL, at: at(lead.t0, 12 * MINUTE) });
    rig.hubspot.setGrantedScopes(['oauth', 'crm.objects.contacts.read', 'forms']);
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    expect(await deliverWhenDue(rig, lead.jobs[1] ?? { id: '' }, { retried: 4 })).toEqual({ status: 200, outcome: 'done' });
    rig.clock.advance({ minutes: 11 });
    await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });
    const fu2 = sent(rig, 'follow_up')[1];
    expect(fu2?.text).toContain(followUpOpening(2, true));
    expect((await leadRow(db, lead.leadId)).fu2_notified_at).not.toBeNull();
  });
});

describe('followup job: timing at fire time (D-33, D-11)', () => {
  it('a time the current quiet hours forbid is re-targeted to the next allowed hour, with nothing read or sent; it goes out then', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const fu1 = lead.jobs[0];
    if (fu1 === undefined) throw new Error('no job');
    // The owner moved quiet hours to 09:00–12:00 after the follow-up was scheduled (Thursday 10:00 New York).
    await db.query(`update settings set quiet_start_hour = 9, quiet_end_hour = 12 where account_id = $1`, [rig.accountId]);
    const getContact = vi.spyOn(rig.hubspot, 'getContact');

    expect(await deliverWhenDue(rig, fu1)).toEqual({ status: 200, outcome: 'retargeted' });

    const moved = await jobById(db, fu1.id);
    expect(moved.status).toBe('scheduled');
    expect(moved.hops).toBe(1);
    const target = targetOf(moved);
    // Thursday 12:00 New York (16:00Z) plus the account's 0–10 minute offset.
    expect(target.getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 8, 16, 0));
    expect(target.getTime()).toBeLessThanOrEqual(Date.UTC(2026, 9, 8, 16, 10));
    expect(moved.runAt).toEqual(target);
    expect(getContact).not.toHaveBeenCalled();
    expect(sent(rig)).toEqual([]);
    expect(rig.fakes.llm.callsFor('followup')).toEqual([]);

    expect(await deliverWhenDue(rig, fu1)).toEqual({ status: 200, outcome: 'done' });
    expect(onlyEmail(rig, 'follow_up').sentAt).toEqual(target);
  });

  it('weekends switched on after scheduling: a Sunday follow-up waits for Monday 08:00', async () => {
    const db = getDb();
    await db.query(`update settings set skip_weekends = false where account_id = $1`, [rig.accountId]);
    const lead = await seedFollowUpLead(rig);
    const fu2 = lead.jobs[1];
    if (fu2 === undefined) throw new Error('no job');
    // Scheduled for Sunday 10:00 New York; then the owner turned "skip weekends" on.
    expect(targetOf(fu2)).toEqual(at(lead.t0, 5 * DAY));
    await db.query(`update settings set skip_weekends = true where account_id = $1`, [rig.accountId]);
    await db.query(`update leads set fu1_notified_at = $2 where id = $1`, [lead.leadId, at(lead.t0, 2 * DAY)]);
    await db.query(`update scheduled_jobs set status = 'done' where id = $1`, [lead.jobs[0]?.id]);

    expect(await deliverWhenDue(rig, fu2)).toMatchObject({ outcome: 'retargeted' });

    const target = targetOf(await jobById(db, fu2.id));
    // Monday 2026-10-12 08:00 New York = 12:00Z, plus the offset.
    expect(target.getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 12, 12, 0));
    expect(target.getTime()).toBeLessThanOrEqual(Date.UTC(2026, 9, 12, 12, 10));
    expect(sent(rig)).toEqual([]);
  });

  it('the HubSpot daily limit re-targets the job past the next local midnight, then quiet hours move it to the morning', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const fu1 = lead.jobs[0];
    if (fu1 === undefined) throw new Error('no job');
    rig.hubspot.injectFailure('getContact', { kind: 'daily_limit' });

    expect(await deliverWhenDue(rig, fu1)).toEqual({ status: 200, outcome: 'retargeted' });
    // Friday 00:10 New York (04:10Z): the next local midnight plus the 10-minute margin (D-11).
    expect(targetOf(await jobById(db, fu1.id))).toEqual(new Date(Date.UTC(2026, 9, 9, 4, 10)));
    expect(sent(rig)).toEqual([]);

    expect(await deliverWhenDue(rig, fu1)).toEqual({ status: 200, outcome: 'retargeted' });
    const morning = targetOf(await jobById(db, fu1.id));
    expect(morning.getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 9, 12, 0));
    expect(morning.getTime()).toBeLessThanOrEqual(Date.UTC(2026, 9, 9, 12, 10));

    expect(await deliverWhenDue(rig, fu1)).toEqual({ status: 200, outcome: 'done' });
    expect(onlyEmail(rig, 'follow_up').sentAt).toEqual(morning);
  });

  it('a follow-up beyond the QStash maximum delay hops (nothing claimed, read or sent) and goes out at its target', async () => {
    const db = getDb();
    // T0 Sunday 2026-10-11 22:00 New York: follow-up 2 (Friday 22:00, quiet, then the weekend) lands
    // on Monday 10-19 08:00 plus the offset, more than QSTASH_MAX_DELAY_SECONDS (6.96 days) out.
    rig.clock.set(new Date(Date.UTC(2026, 9, 12, 2, 0)));
    const lead = await seedFollowUpLead(rig);
    const [fu1, fu2] = lead.jobs;
    if (fu1 === undefined || fu2 === undefined) throw new Error('no jobs');
    const target = targetOf(fu2);
    const maxDelayMs = Number(rig.deps.env.QSTASH_MAX_DELAY_SECONDS) * 1000;
    expect(target.getTime() - lead.t0.getTime()).toBeGreaterThan(maxDelayMs);
    expect(await deliverWhenDue(rig, fu1)).toMatchObject({ outcome: 'done' });
    const getContact = vi.spyOn(rig.hubspot, 'getContact');

    // QStash delivers the clamped message at the maximum delay: re-published for the rest of the way.
    rig.clock.set(new Date(lead.t0.getTime() + maxDelayMs));
    expect(await deliver(rig, fu2)).toEqual({ status: 200, outcome: 'hopped' });
    const hopped = await jobById(db, fu2.id);
    expect(hopped).toMatchObject({ status: 'scheduled', hops: 1, attempts: 0 });
    expect(targetOf(hopped)).toEqual(target);
    expect(hopped.externalId).not.toBe(fu2.externalId);
    expect(getContact).not.toHaveBeenCalled();
    expect(sent(rig, 'follow_up')).toHaveLength(1);

    expect(await deliverWhenDue(rig, fu2)).toMatchObject({ outcome: 'done' });
    expect(sent(rig, 'follow_up').map((mail) => [mail.subject, mail.sentAt])).toEqual([
      ['Follow-up 1 for Maya — your draft is ready', expect.any(Date)],
      ['Follow-up 2 for Maya — your draft is ready', target],
    ]);
  });

  it('follow-up 2 never overtakes follow-up 1 of its stream: it waits while follow-up 1 has not run', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const [fu1, fu2] = lead.jobs;
    if (fu1 === undefined || fu2 === undefined) throw new Error('no jobs');
    // Follow-up 1 is held back (here: never delivered) past follow-up 2's time.
    rig.clock.set(targetOf(fu2));

    expect(await deliver(rig, fu2)).toEqual({ status: 200, outcome: 'retargeted' });
    // fu1's target + 3 days is Sunday (a weekend) → the floor of now + 1 h, an allowed Monday hour.
    expect(targetOf(await jobById(db, fu2.id))).toEqual(at(rig.clock.now(), HOUR));
    expect(sent(rig)).toEqual([]);

    expect(await deliver(rig, fu1)).toMatchObject({ outcome: 'done' });
    expect(await deliverWhenDue(rig, fu2)).toMatchObject({ outcome: 'done' });
    expect(sent(rig).map((m) => m.subject)).toEqual(['Follow-up 1 for Maya — your draft is ready', 'Follow-up 2 for Maya — your draft is ready']);
  });
});

describe('followup job: exactly once', () => {
  it('a crash after the email went out: the retry resumes the reservation and the owner gets one email (409)', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const fu1 = lead.jobs[0];
    if (fu1 === undefined) throw new Error('no job');
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', afterSend: true });

    expect(await deliverWhenDue(rig, fu1)).toMatchObject({ status: 500, outcome: 'transient' });
    const first = onlyEmail(rig, 'follow_up');
    expect(await notifications(db, lead.leadId)).toEqual([{ dedupe_key: `notify:${lead.leadId}:fu1:s0`, kind: 'follow_up', status: 'sending' }]);
    expect((await leadRow(db, lead.leadId)).fu1_notified_at).toBeNull();

    rig.clock.advance({ seconds: 20 });
    expect(await deliver(rig, fu1, { retried: 1 })).toEqual({ status: 200, outcome: 'done' });

    expect(sent(rig)).toEqual([first]);
    expect(await notifications(db, lead.leadId)).toEqual([{ dedupe_key: `notify:${lead.leadId}:fu1:s0`, kind: 'follow_up', status: 'sent' }]);
    expect((await leadRow(db, lead.leadId)).fu1_notified_at).toEqual(rig.clock.now());
    // The stored draft is reused: one model call.
    expect(rig.fakes.llm.callsFor('followup')).toHaveLength(1);
  });

  it('a send error before the email went out: the retry sends it once', async () => {
    const lead = await seedFollowUpLead(rig);
    const fu1 = lead.jobs[0];
    if (fu1 === undefined) throw new Error('no job');
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'rate_limit_exceeded' });

    expect(await deliverWhenDue(rig, fu1)).toMatchObject({ status: 500 });
    expect(sent(rig)).toEqual([]);
    rig.clock.advance({ seconds: 10 });
    expect(await deliver(rig, fu1, { retried: 1 })).toEqual({ status: 200, outcome: 'done' });
    onlyEmail(rig, 'follow_up');
  });

  it('a duplicate delivery changes nothing: answered 200 once finished, and a replay of the claim finds the email sent', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const fu1 = lead.jobs[0];
    if (fu1 === undefined) throw new Error('no job');
    expect(await deliverWhenDue(rig, fu1)).toMatchObject({ outcome: 'done' });
    const getContact = vi.spyOn(rig.hubspot, 'getContact');

    expect(await deliver(rig, fu1, { retried: 1 })).toEqual({ status: 200, outcome: 'already_finished' });
    // A redelivery racing a lost `done` write (the row is claimable again).
    await db.query(`update scheduled_jobs set status = 'scheduled' where id = $1`, [fu1.id]);
    expect(await deliver(rig, fu1, { retried: 2 })).toEqual({ status: 200, outcome: 'done' });

    expect(sent(rig)).toHaveLength(1);
    expect(getContact).not.toHaveBeenCalled();
  });

  it('a delivery while another attempt holds the lease is told to come back (503)', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const fu1 = lead.jobs[0];
    if (fu1 === undefined) throw new Error('no job');
    rig.clock.set(targetOf(fu1));
    await db.query(`update scheduled_jobs set status = 'running', attempt_id = gen_random_uuid(), lease_until = $2 where id = $1`, [
      fu1.id,
      at(rig.clock.now(), 5 * MINUTE),
    ]);

    expect(await deliver(rig, fu1)).toMatchObject({ status: 503, outcome: 'lease_held' });
    expect(sent(rig)).toEqual([]);
  });

  it('Resend down on the final delivery is not a failed follow-up: the job ends, the sweeper sends it once and stamps it', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    const fu1 = lead.jobs[0];
    if (fu1 === undefined) throw new Error('no job');
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });

    expect(await deliverWhenDue(rig, fu1, { retried: 4 })).toEqual({ status: 200, outcome: 'done' });
    expect(sent(rig)).toEqual([]);
    expect(await notifications(db, lead.leadId)).toMatchObject([{ status: 'sending' }]);
    expect(alerts.map((a) => a.code)).toEqual([]);

    rig.clock.advance({ minutes: 11 });
    await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });

    onlyEmail(rig, 'follow_up');
    expect(await notifications(db, lead.leadId)).toMatchObject([{ status: 'sent' }]);
    expect((await leadRow(db, lead.leadId)).fu1_notified_at).toEqual(rig.clock.now());
    expect(await db.query(`select action from audit_log where account_id = $1 and action like 'lead.followup%'`, [rig.accountId])).toEqual([]);
  });

  it('logs ids and codes only: no address, message, draft or link', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
    }
    const lead = await seedFollowUpLead(rig);
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    await deliverWhenDue(rig, lead.jobs[0] ?? { id: '' });
    rig.clock.advance({ seconds: 20 });
    await deliver(rig, lead.jobs[0] ?? { id: '' }, { retried: 1 });
    const mail = onlyEmail(rig, 'follow_up');
    const logged = lines.join('\n');
    expect(logged).toContain('followup.notification');
    for (const secret of [LEAD_EMAIL, NOTIFY_EMAIL, OWNER_EMAIL, 'okafor-bakery', 'Okafor', 'sink', 'Maya', 'apt_', '/a/', mail.subject]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('followup job: registration', () => {
  it('the follow-up jobs of the fu1 send stay published: the second one keeps its message', async () => {
    const db = getDb();
    const lead = await seedFollowUpLead(rig);
    await deliverWhenDue(rig, lead.jobs[0] ?? { id: '' });
    const fu2 = await followUpJob(db, lead.leadId, 2);
    expect(fu2.externalId).not.toBeNull();
    expect(fu2.status).toBe('scheduled');
  });
});
