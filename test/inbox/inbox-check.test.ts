import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onAlert, type RaisedAlert } from '@/server/jobs';
import type { Deps, HubSpotClient } from '@/server/ports';
import { NotificationKeys, NotificationPredicates, reserveAndSend, sendReserved } from '@/server/services/notifications';
import {
  closeAbandonedInboxChecks,
  inboxTestKey,
  readEmailHistory,
  runInboxCheckRetention,
  skipInboxCheck,
  startInboxCheck,
} from '@/server/services/inbox-check';
import { forAccount } from '@/server/services/hubspot';
import { emailHmac } from '@/server/services/intake';
import { loadInboxCheckPage } from '@/server/views/inbox';
import { useTestDb as setUpTestDb } from '../db/harness';
import {
  at,
  checkIdOf,
  checkOf,
  createInboxRig,
  HOUR,
  inboxJobs,
  loggingModeOf,
  MINUTE,
  OWNER_EMAIL,
  runUntil,
  SECOND,
  start,
  TEST_ADDRESS,
  type InboxRig,
} from './support';

// The onboarding inbox-logging check end to end (PLAN §8.2, §8.4, §9.7, D-14) on PGlite and the
// fake portal: history counts, the test lead and inbox_test email, the inbox_check job's legs and
// 60-second cadence, the logging mode, skip, the 24-hour abandon rule and the test-lead exclusions.

const getDb = setUpTestDb();

let rig: InboxRig;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(() => {
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
});

const ALL_SCOPES = ['oauth', 'crm.objects.contacts.read', 'forms', 'sales-email-read'];
const WITHOUT_EMAIL_SCOPE = ALL_SCOPES.filter((scope) => scope !== 'sales-email-read');

describe('history counts', () => {
  it('stores the 30-day outbound and inbound counts when the test starts and shows them', async () => {
    rig = await createInboxRig(getDb());
    const result = await start(rig);
    expect(result.type).toBe('started');
    const check = await checkOf(getDb(), checkIdOf(result));
    // Fixture: 4 logged EMAILs and 1 INCOMING_EMAIL between 2026-09-10 and 09-25 (all within 30 days of 10-06).
    expect(check).toMatchObject({ history_outbound_30d: 4, history_inbound_30d: 1 });
    const view = await loadInboxCheckPage(rig.scope, rig.deps);
    expect(view.check?.history).toEqual({ status: 'ok', outbound: 4, inbound: 1 });
  });

  it('counts only emails of the last 30 days', async () => {
    rig = await createInboxRig(getDb());
    rig.clock.set(new Date('2026-10-12T15:00:00.000Z'));
    const client = forAccount(rig.deps, rig.accountId, { sleep: rig.sleep });
    // Since 2026-09-12 15:00: 60003, 60004, 60005 outbound; the one inbound (09-10) is older.
    expect(await readEmailHistory(client, { scopes: ALL_SCOPES, now: rig.clock.now() })).toEqual({ status: 'ok', outbound: 3, inbound: 0 });
  });

  it('is unavailable without the email scope, and HubSpot is not asked', async () => {
    rig = await createInboxRig(getDb(), { grantedScopes: WITHOUT_EMAIL_SCOPE });
    const result = await start(rig);
    expect(result.type).toBe('started');
    const check = await checkOf(getDb(), checkIdOf(result));
    expect(check).toMatchObject({ history_outbound_30d: null, history_inbound_30d: null });
    expect((await loadInboxCheckPage(rig.scope, rig.deps)).check?.history).toEqual({ status: 'unavailable' });
  });

  it('is unavailable when HubSpot answers 403 MISSING_SCOPES', async () => {
    rig = await createInboxRig(getDb());
    rig.hubspot.setGrantedScopes(WITHOUT_EMAIL_SCOPE);
    const client = forAccount(rig.deps, rig.accountId, { sleep: rig.sleep });
    expect(await readEmailHistory(client, { scopes: ALL_SCOPES, now: rig.clock.now() })).toEqual({ status: 'unavailable' });
  });
});

describe('live test', () => {
  it('sends the inbox_test email (send button + mail-app link only until M4) to the owner, sets the deadlines and inserts the first job', async () => {
    rig = await createInboxRig(getDb());
    const t0 = rig.clock.now();
    const result = await start(rig);
    expect(result.type).toBe('started');
    const checkId = checkIdOf(result);

    const mails = rig.fakes.mailer.sent;
    expect(mails).toHaveLength(1);
    const [mail] = mails;
    expect(mail).toMatchObject({ kind: 'inbox_test', to: [OWNER_EMAIL], replyTo: OWNER_EMAIL, idempotencyKey: `${rig.deps.env.ENV_NAMESPACE}:inbox-test:${checkId}` });
    expect(mail?.text).toContain("This email isn't monitored");
    expect(mail?.text).toContain(TEST_ADDRESS);
    expect(mail?.html).toMatch(/\/a\/apt_[A-Za-z0-9_-]{43}\/send"/);
    expect(mail?.html).toMatch(/\/a\/apt_[A-Za-z0-9_-]{43}\/send\?via=mailto"/);
    // /a/{t}/edit and /dismiss are M4: no button may lead to a page that does not exist (law 5).
    expect(mail?.html).not.toMatch(/\/(edit|dismiss)"/);
    expect(mail?.text).not.toContain('Edit first');
    expect(mail?.text).not.toContain('Not a real lead');
    expect(mail?.text).not.toContain('work like the ones on real lead emails');

    const check = await checkOf(getDb(), checkId);
    expect(check.status).toBe('open');
    expect(check.test_address).toBe(TEST_ADDRESS);
    expect(check.test_address_hmac).toBe(emailHmac(rig.deps.env, TEST_ADDRESS));
    expect(check.send_deadline_at).toEqual(at(t0, 10 * MINUTE));
    expect(check.reply_deadline_at).toEqual(at(t0, 20 * MINUTE));

    const tokens = await getDb().query<{ purpose: string }>(`select purpose from action_tokens where lead_id = $1 order by purpose`, [check.test_lead_id]);
    expect(tokens.map((t) => t.purpose)).toEqual(['send']);
    expect(await inboxJobs(getDb())).toEqual([
      { dedupe_key: `inbox:${rig.accountId}:${checkId}:1`, status: 'scheduled', seq: 1, run_at: at(t0, MINUTE) },
    ]);
  });

  it('passes both legs and sets log_all when the send and the reply are logged', async () => {
    rig = await createInboxRig(getDb());
    const t0 = rig.clock.now();
    const checkId = checkIdOf(await start(rig));
    rig.hubspot.logOwnerSend({ to: TEST_ADDRESS, at: at(t0, 45 * SECOND) });
    rig.hubspot.logLeadReply({ from: TEST_ADDRESS, at: at(t0, 100 * SECOND) });

    await runUntil(rig, at(t0, 30 * MINUTE));

    const check = await checkOf(getDb(), checkId);
    expect(check).toMatchObject({ status: 'closed', send_leg: 'passed', reply_leg: 'passed' });
    expect(await loggingModeOf(getDb(), rig.accountId)).toBe('log_all');
    // Run 1 (t0+60 s) saw the send; run 2 (t0+120 s) saw the reply and closed the check.
    expect(await inboxJobs(getDb())).toEqual([
      { dedupe_key: `inbox:${rig.accountId}:${checkId}:1`, status: 'done', seq: 1, run_at: at(t0, MINUTE) },
      { dedupe_key: `inbox:${rig.accountId}:${checkId}:2`, status: 'done', seq: 2, run_at: at(t0, 2 * MINUTE) },
    ]);
    expect(check.closed_at).toEqual(at(t0, 2 * MINUTE));
    const view = await loadInboxCheckPage(rig.scope, rig.deps);
    expect(view.check).toMatchObject({ phase: 'finished', result: 'log_all', send: { status: 'passed' }, reply: { status: 'passed' } });
  });

  it('sets sends_only when the send is logged but the reply is not, 10 minutes after the send was seen', async () => {
    rig = await createInboxRig(getDb());
    rig.hubspot.setLoggingMode('sends_only');
    const t0 = rig.clock.now();
    const checkId = checkIdOf(await start(rig));
    rig.hubspot.logOwnerSend({ to: TEST_ADDRESS, at: at(t0, 30 * SECOND) });
    expect(rig.hubspot.logLeadReply({ from: TEST_ADDRESS, at: at(t0, 90 * SECOND) })).toBeNull();

    await runUntil(rig, at(t0, 5 * MINUTE));
    let check = await checkOf(getDb(), checkId);
    expect(check).toMatchObject({ status: 'open', send_leg: 'passed', reply_leg: 'pending' });
    // The reply window starts when the send was seen (run 1, t0 + 60 s).
    expect(check.reply_deadline_at).toEqual(at(t0, 11 * MINUTE));
    expect(await loggingModeOf(getDb(), rig.accountId)).toBe('unknown');

    await runUntil(rig, at(t0, 30 * MINUTE));
    check = await checkOf(getDb(), checkId);
    expect(check).toMatchObject({ status: 'closed', send_leg: 'passed', reply_leg: 'failed' });
    expect(check.closed_at).toEqual(at(t0, 11 * MINUTE));
    expect(await loggingModeOf(getDb(), rig.accountId)).toBe('sends_only');
    const jobs = await inboxJobs(getDb());
    expect(jobs).toHaveLength(11);
    expect(jobs.every((job) => job.status === 'done')).toBe(true);
  });

  it('sets none when neither leg is seen by both deadlines', async () => {
    rig = await createInboxRig(getDb());
    rig.hubspot.setLoggingMode('none');
    const t0 = rig.clock.now();
    const checkId = checkIdOf(await start(rig));
    expect(rig.hubspot.logOwnerSend({ to: TEST_ADDRESS, at: at(t0, 30 * SECOND) })).toBeNull();

    await runUntil(rig, at(t0, 15 * MINUTE));
    let check = await checkOf(getDb(), checkId);
    expect(check).toMatchObject({ status: 'open', send_leg: 'failed', reply_leg: 'pending' });
    expect(await loggingModeOf(getDb(), rig.accountId)).toBe('unknown');

    await runUntil(rig, at(t0, 40 * MINUTE));
    check = await checkOf(getDb(), checkId);
    expect(check).toMatchObject({ status: 'closed', send_leg: 'failed', reply_leg: 'failed' });
    expect(check.closed_at).toEqual(at(t0, 20 * MINUTE));
    expect(await loggingModeOf(getDb(), rig.accountId)).toBe('none');
    expect(rig.fakes.scheduler.pending()).toEqual([]);
    expect((await inboxJobs(getDb())).every((job) => job.status === 'done')).toBe(true);
    const view = await loadInboxCheckPage(rig.scope, rig.deps);
    expect(view.check).toMatchObject({ phase: 'finished', result: 'none', send: { status: 'failed' }, reply: { status: 'failed' } });
  });

  it('ignores a logged email to the test address from before the check started', async () => {
    rig = await createInboxRig(getDb());
    const t0 = rig.clock.now();
    const contactId = rig.hubspot.createContact({ email: TEST_ADDRESS, at: at(t0, -2 * HOUR) });
    rig.hubspot.logEmail({ direction: 'EMAIL', from: OWNER_EMAIL, to: [TEST_ADDRESS], contactIds: [contactId], at: at(t0, -HOUR) });
    rig.hubspot.logEmail({ direction: 'INCOMING_EMAIL', from: TEST_ADDRESS, to: [OWNER_EMAIL], contactIds: [contactId], at: at(t0, -HOUR) });
    const checkId = checkIdOf(await start(rig));
    await runUntil(rig, at(t0, 5 * MINUTE));
    expect(await checkOf(getDb(), checkId)).toMatchObject({ status: 'open', send_leg: 'pending', reply_leg: 'pending' });
  });

  it('runs whatever the processing state, and writes only inbox_checks and logging_mode', async () => {
    rig = await createInboxRig(getDb());
    const t0 = rig.clock.now();
    const checkId = checkIdOf(await start(rig));
    // The owner pauses (or billing lapses) right after the start: the check still finishes.
    await getDb().query(`update accounts set paused_at = $2, processing_state = 'paused' where id = $1`, [rig.accountId, t0]);
    rig.hubspot.logOwnerSend({ to: TEST_ADDRESS, at: at(t0, 20 * SECOND) });
    rig.hubspot.logLeadReply({ from: TEST_ADDRESS, at: at(t0, 40 * SECOND) });
    const before = await getDb().one(`select * from leads where id = (select test_lead_id from inbox_checks where id = $1)`, [checkId]);

    await runUntil(rig, at(t0, 3 * MINUTE));

    expect(await checkOf(getDb(), checkId)).toMatchObject({ status: 'closed', send_leg: 'passed', reply_leg: 'passed' });
    expect(await loggingModeOf(getDb(), rig.accountId)).toBe('log_all');
    const after = await getDb().one(`select * from leads where id = (select test_lead_id from inbox_checks where id = $1)`, [checkId]);
    expect(after).toEqual(before);
  });

  it('fails the open legs through the failure path when HubSpot keeps failing', async () => {
    rig = await createInboxRig(getDb());
    const t0 = rig.clock.now();
    const checkId = checkIdOf(await start(rig));
    rig.hubspot.injectFailure('getContact', { kind: 'server_error', times: 20 });

    await runUntil(rig, at(t0, 10 * MINUTE));

    expect(await checkOf(getDb(), checkId)).toMatchObject({ status: 'closed', send_leg: 'failed', reply_leg: 'failed' });
    expect(await loggingModeOf(getDb(), rig.accountId)).toBe('none');
    // The final delivery ran the failure path inline (PLAN §8.3 step 4) and raised the job_failed alert.
    expect(alerts.map((alert) => alert.code)).toContain('job_failed');
    expect(await inboxJobs(getDb())).toMatchObject([{ seq: 1, status: 'failed' }]);
  });

  it('skips the open legs and keeps the logging mode when the connection is revoked', async () => {
    rig = await createInboxRig(getDb());
    const t0 = rig.clock.now();
    const checkId = checkIdOf(await start(rig));
    await getDb().query(
      `update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null where id = $1`,
      [rig.connectionId],
    );
    await runUntil(rig, at(t0, 5 * MINUTE));
    expect(await checkOf(getDb(), checkId)).toMatchObject({ status: 'closed', send_leg: 'skipped', reply_leg: 'skipped' });
    expect(await loggingModeOf(getDb(), rig.accountId)).toBe('unknown');
    expect(await inboxJobs(getDb())).toMatchObject([{ status: 'skipped' }]);
  });

  it('finishes the check when a transient send failure is resumed later', async () => {
    rig = await createInboxRig(getDb());
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    const t0 = rig.clock.now();
    const result = await start(rig);
    expect(result.type).toBe('send_failed');
    const checkId = checkIdOf(result);
    expect(await checkOf(getDb(), checkId)).toMatchObject({ status: 'open', send_deadline_at: null });
    expect((await loadInboxCheckPage(rig.scope, rig.deps)).check?.phase).toBe('sending');

    rig.clock.set(at(t0, 12 * MINUTE));
    expect(await sendReserved(rig.deps, inboxTestKey(checkId), rig.notifications)).toMatchObject({ status: 'sent' });
    const check = await checkOf(getDb(), checkId);
    expect(check.send_deadline_at).toEqual(at(t0, 22 * MINUTE));
    expect(await inboxJobs(getDb())).toMatchObject([{ seq: 1, status: 'scheduled', run_at: at(t0, 13 * MINUTE) }]);
    expect(rig.fakes.mailer.sent.map((mail) => mail.kind)).toEqual(['inbox_test']);
  });
});

describe('starting', () => {
  it('creates the check before the contact lookup, so intake skips the address from then on', async () => {
    rig = await createInboxRig(getDb());
    const db = getDb();
    const seen: number[] = [];
    const hubspot = rig.deps.hubspot;
    const spy: HubSpotClient = new Proxy(hubspot, {
      get(target, property, receiver) {
        if (property === 'getContact') {
          return async (...args: Parameters<HubSpotClient['getContact']>) => {
            const rows = await db.query(`select id from inbox_checks where account_id = $1 and test_address_hmac = $2`, [
              rig.accountId,
              emailHmac(rig.deps.env, TEST_ADDRESS),
            ]);
            seen.push(rows.length);
            return target.getContact(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const deps: Deps = { ...rig.deps, hubspot: spy };
    const result = await startInboxCheck(rig.scope, deps, { testAddress: ' Owner.Personal@Example.NET ' }, { sleep: rig.sleep });
    expect(result.type).toBe('started');
    expect(seen).toEqual([1]);
  });

  it('asks for the BCC address or a form submission when HubSpot has no test contact and no BCC is saved', async () => {
    rig = await createInboxRig(getDb(), { bcc: false });
    const result = await start(rig);
    expect(result.type).toBe('test_contact_missing');
    const check = await checkOf(getDb(), checkIdOf(result));
    expect(check).toMatchObject({ status: 'open', test_lead_id: null, send_deadline_at: null });
    expect(rig.fakes.mailer.sent).toEqual([]);
    expect(await inboxJobs(getDb())).toEqual([]);
    expect((await loadInboxCheckPage(rig.scope, rig.deps)).check?.phase).toBe('needs_contact');
  });

  it('starts without a BCC address when the test contact exists', async () => {
    rig = await createInboxRig(getDb(), { bcc: false });
    const contactId = rig.hubspot.createContact({ email: TEST_ADDRESS });
    const result = await start(rig);
    expect(result.type).toBe('started');
    const lead = await getDb().one<{ hubspot_contact_id: string | null }>(
      `select hubspot_contact_id from leads where id = (select test_lead_id from inbox_checks where id = $1)`,
      [checkIdOf(result)],
    );
    expect(lead.hubspot_contact_id).toBe(contactId);
  });

  it('refuses an invalid address and the owner’s own sign-in address without creating a check', async () => {
    rig = await createInboxRig(getDb());
    expect((await start(rig, 'not an address')).type).toBe('invalid_address');
    expect((await start(rig, 'OWNER@brightside-plumbing.example')).type).toBe('same_as_owner');
    expect(await getDb().query(`select id from inbox_checks`)).toEqual([]);
  });

  it('refuses when the connection is not active', async () => {
    rig = await createInboxRig(getDb());
    await getDb().query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null where id = $1`, [
      rig.connectionId,
    ]);
    expect((await start(rig)).type).toBe('not_connected');
    expect(await getDb().query(`select id from inbox_checks`)).toEqual([]);
  });

  it('supersedes an earlier open check and allows 5 starts per 24 hours', async () => {
    rig = await createInboxRig(getDb());
    const first = checkIdOf(await start(rig));
    rig.clock.advance(MINUTE);
    const second = checkIdOf(await start(rig, 'owner.other@example.org'));
    expect(await checkOf(getDb(), first)).toMatchObject({ status: 'closed', send_leg: 'skipped', reply_leg: 'skipped' });
    expect(await checkOf(getDb(), second)).toMatchObject({ status: 'open' });
    for (let i = 0; i < 3; i++) {
      rig.clock.advance(MINUTE);
      expect((await start(rig)).type).toBe('started');
    }
    rig.clock.advance(MINUTE);
    expect((await start(rig)).type).toBe('rate_limited');
    rig.clock.advance(24 * HOUR);
    expect((await start(rig)).type).toBe('started');
  });
});

describe('skip', () => {
  it('sets logging_mode unknown, closes the check with its open legs skipped, and the next run does nothing', async () => {
    rig = await createInboxRig(getDb());
    const t0 = rig.clock.now();
    const checkId = checkIdOf(await start(rig));
    await getDb().query(`update accounts set logging_mode = 'sends_only' where id = $1`, [rig.accountId]);
    rig.clock.advance(20 * SECOND);
    const result = await skipInboxCheck(rig.scope, rig.deps);
    expect(result).toEqual({ closed: 1, onboardingComplete: false });
    expect(await loggingModeOf(getDb(), rig.accountId)).toBe('unknown');
    expect(await checkOf(getDb(), checkId)).toMatchObject({ status: 'closed', send_leg: 'skipped', reply_leg: 'skipped' });

    rig.hubspot.logOwnerSend({ to: TEST_ADDRESS, at: at(t0, 30 * SECOND) });
    rig.hubspot.injectFailure('getContact', { kind: 'server_error', times: 1 });
    await runUntil(rig, at(t0, 5 * MINUTE));
    // The run found the check closed and never reached HubSpot (the injected failure is unused).
    expect(await inboxJobs(getDb())).toMatchObject([{ seq: 1, status: 'done' }]);
    expect(await checkOf(getDb(), checkId)).toMatchObject({ send_leg: 'skipped', reply_leg: 'skipped' });
    expect(await loggingModeOf(getDb(), rig.accountId)).toBe('unknown');
    expect((await loadInboxCheckPage(rig.scope, rig.deps)).check?.phase).toBe('closed_early');
  });

  it('keeps the measured mode when the check finished before the tap (a stale page’s Skip)', async () => {
    rig = await createInboxRig(getDb());
    const t0 = rig.clock.now();
    const checkId = checkIdOf(await start(rig));
    rig.hubspot.logOwnerSend({ to: TEST_ADDRESS, at: at(t0, 45 * SECOND) });
    rig.hubspot.logLeadReply({ from: TEST_ADDRESS, at: at(t0, 100 * SECOND) });
    await runUntil(rig, at(t0, 30 * MINUTE));
    expect(await loggingModeOf(getDb(), rig.accountId)).toBe('log_all');

    const result = await skipInboxCheck(rig.scope, rig.deps);
    expect(result).toEqual({ closed: 0, onboardingComplete: false });
    expect(await loggingModeOf(getDb(), rig.accountId)).toBe('log_all');
    expect(await checkOf(getDb(), checkId)).toMatchObject({ status: 'closed', send_leg: 'passed', reply_leg: 'passed' });
    const view = await loadInboxCheckPage(rig.scope, rig.deps);
    expect(view.check).toMatchObject({ phase: 'finished', result: 'log_all' });
  });

  it('keeps a skipped check’s unsent test email from going out later', async () => {
    rig = await createInboxRig(getDb());
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    const checkId = checkIdOf(await start(rig));
    await skipInboxCheck(rig.scope, rig.deps);
    expect(await sendReserved(rig.deps, inboxTestKey(checkId), rig.notifications)).toEqual({ status: 'skipped', reason: 'predicates' });
    expect(rig.fakes.mailer.sent).toEqual([]);
    expect(await inboxJobs(getDb())).toEqual([]);
  });
});

describe('abandoned checks', () => {
  it('closes a check still without deadlines 24 h after creation, legs skipped, and clears its address', async () => {
    rig = await createInboxRig(getDb(), { bcc: false });
    const t0 = rig.clock.now();
    const checkId = checkIdOf(await start(rig));
    rig.clock.set(at(t0, 24 * HOUR - SECOND));
    expect(await closeAbandonedInboxChecks(getDb(), rig.clock.now())).toBe(0);
    expect((await loadInboxCheckPage(rig.scope, rig.deps)).check?.phase).toBe('needs_contact');

    rig.clock.set(at(t0, 24 * HOUR));
    expect(await runInboxCheckRetention(rig.deps)).toEqual({ inboxChecksClosed: 1, testAddressesCleared: 1 });
    const check = await checkOf(getDb(), checkId);
    expect(check).toMatchObject({ status: 'closed', send_leg: 'skipped', reply_leg: 'skipped', test_address: null });
    expect(check.test_address_hmac).toBe(emailHmac(rig.deps.env, TEST_ADDRESS));
  });

  it('leaves a check that got its deadlines alone', async () => {
    rig = await createInboxRig(getDb());
    const t0 = rig.clock.now();
    const checkId = checkIdOf(await start(rig));
    rig.clock.set(at(t0, 25 * HOUR));
    expect(await closeAbandonedInboxChecks(getDb(), rig.clock.now())).toBe(0);
    expect(await checkOf(getDb(), checkId)).toMatchObject({ status: 'open' });
  });
});

describe('the test lead', () => {
  async function finishedLogAllCheck(): Promise<{ checkId: string; leadId: string; t0: Date }> {
    rig = await createInboxRig(getDb());
    const t0 = rig.clock.now();
    const checkId = checkIdOf(await start(rig));
    rig.hubspot.logOwnerSend({ to: TEST_ADDRESS, at: at(t0, 45 * SECOND) });
    rig.hubspot.logLeadReply({ from: TEST_ADDRESS, at: at(t0, 100 * SECOND) });
    await runUntil(rig, at(t0, 30 * MINUTE));
    const check = await checkOf(getDb(), checkId);
    if (check.test_lead_id === null) throw new Error('no test lead');
    return { checkId, leadId: check.test_lead_id, t0 };
  }

  it('is a test lead with a template draft and content kept for 24 h', async () => {
    const { leadId, t0 } = await finishedLogAllCheck();
    const lead = await getDb().one(
      `select is_test, intake_trigger, hubspot_contact_id, form_id, processing_state, stop_reason, first_notified_at, classification
         from leads where id = $1`,
      [leadId],
    );
    expect(lead).toEqual({
      is_test: true,
      intake_trigger: 'inbox_check',
      hubspot_contact_id: null,
      form_id: null,
      processing_state: 'notified',
      stop_reason: 'test_lead',
      first_notified_at: t0,
      classification: null,
    });
    const content = await getDb().one<{ email: string; purge_at: Date }>(`select email, purge_at from lead_messages where lead_id = $1`, [leadId]);
    expect(content).toEqual({ email: TEST_ADDRESS, purge_at: at(t0, 24 * HOUR) });
    const draft = await getDb().one(`select kind, validation_ok, model, attempts, purge_at from drafts where lead_id = $1`, [leadId]);
    expect(draft).toEqual({ kind: 'initial', validation_ok: true, model: null, attempts: 0, purge_at: at(t0, 24 * HOUR) });
    expect(await getDb().query(`select id from ai_calls`)).toEqual([]);
  });

  it('never gets a lead_process or follow-up job, and the follow-up email predicates refuse it', async () => {
    const { leadId } = await finishedLogAllCheck();
    expect(await getDb().query(`select kind from scheduled_jobs where lead_id = $1`, [leadId])).toEqual([]);
    expect(await getDb().query(`select distinct kind from scheduled_jobs`)).toEqual([{ kind: 'inbox_check' }]);
    const scope = { accountId: rig.accountId, leadId };
    const followUp = await reserveAndSend(rig.deps, {
      kind: 'follow_up',
      dedupeKey: NotificationKeys.followUp(leadId, 1, 0),
      accountId: rig.accountId,
      leadId,
      predicates: NotificationPredicates.followUp(scope),
      render: () => {
        throw new Error('must not render');
      },
    });
    expect(followUp).toEqual({ status: 'skipped', reason: 'predicates' });
  });

  it('is excluded from signals: the check never records a send or reply on it', async () => {
    const { leadId } = await finishedLogAllCheck();
    const lead = await getDb().one(`select send_confirmed_at, replied_at, signals_checked_at, first_send_clicked_at from leads where id = $1`, [leadId]);
    expect(lead).toEqual({ send_confirmed_at: null, replied_at: null, signals_checked_at: null, first_send_clicked_at: null });
  });

  it('never gets a reply_detected email: the only email is the inbox test', async () => {
    const { leadId } = await finishedLogAllCheck();
    expect(await getDb().query(`select kind, status from notifications_sent`)).toEqual([{ kind: 'inbox_test', status: 'sent' }]);
    expect(await getDb().query(`select id from notifications_sent where dedupe_key = $1`, [NotificationKeys.replyDetected(leadId, 0)])).toEqual([]);
    expect(rig.fakes.mailer.sent.map((mail) => mail.kind)).toEqual(['inbox_test']);
  });
});
