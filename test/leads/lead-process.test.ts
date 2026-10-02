import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeSentMail } from '@/server/adapters/fake/mailer/fake-mailer';
import type { Db, DbRow } from '@/server/db';
import { TransientError } from '@/server/domain/errors';
import { followUpTargets } from '@/server/domain/followup-schedule';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { cancelJobsInTx } from '@/server/jobs/cancel';
import { handleFailureCallback } from '@/server/jobs/failure';
import { getJob } from '@/server/jobs/rows';
import { runSweeper } from '@/server/jobs/sweeper';
import type { LLM } from '@/server/ports/llm';
import { verifyActionToken } from '@/server/security/action-tokens';
import { resolveSendLink } from '@/server/services/action-links/send';
import { useTestDb as setUpTestDb } from '../db/harness';
import {
  actionLinks,
  createLeadsRig,
  deliver,
  followUpJobs,
  LEAD_EMAIL,
  leadRow,
  notifications,
  NOTIFY_EMAIL,
  OWNER_EMAIL,
  scheduleLeadProcess,
  seedLeadAccount,
  seedNewLead,
  tokenOf,
  ZONE,
  type LeadsRig,
} from './support';

// lead_process end to end on PGlite with every fake (PLAN §9.3, §8.3, §8.4, §12): classify → daily
// cap → breaker → draft → the new_lead / needs_touch email (exactly once, tokens committed before
// the send, Reply-To the owner) → notified with two follow-up job rows; and the failure path that
// is never silent (D-24).

const getDb = setUpTestDb();

let rig: LeadsRig;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(() => {
  // PLAN §12: nothing here may read the wall clock, so the system time is far from the test's Clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createLeadsRig(getDb());
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
  vi.useRealTimers();
});

function sent(kind?: string): FakeSentMail[] {
  return rig.fakes.mailer.sent.filter((mail) => kind === undefined || mail.kind === kind);
}

function onlyEmail(kind: string): FakeSentMail {
  const all = sent();
  expect(all.map((mail) => mail.kind)).toEqual([kind]);
  const [mail] = all;
  if (mail === undefined) throw new Error('no email');
  return mail;
}

interface ProcessableLeadOptions {
  followupsEnabled?: boolean | undefined;
  loggingMode?: 'unknown' | 'log_all' | 'sends_only' | 'none' | undefined;
  mailClient?: 'gmail' | 'other' | undefined;
  message?: string | null | undefined;
}

async function seedProcessableLead(options: ProcessableLeadOptions = {}) {
  const db = getDb();
  const { message, ...account } = options;
  const accountId = await seedLeadAccount(db, { now: rig.clock.now(), ...account });
  const leadId = await seedNewLead(db, { accountId, now: rig.clock.now(), message });
  const job = await scheduleLeadProcess(rig, { accountId, leadId });
  return { accountId, leadId, job };
}

async function draftRow(leadId: string) {
  return getDb().maybeOne<{ id: string; subject: string | null; body: string | null; needs_touch: boolean; attempts: number }>(
    `select id, subject, body, needs_touch, attempts from drafts where lead_id = $1 and kind = 'initial'`,
    [leadId],
  );
}

/** `db` whose transactions throw (a transient error) on a `followup` job insert while `fault.active`. */
function failingFollowUpInserts(db: Db, fault: { active: boolean }): Db {
  const check = (sql: string, params: readonly unknown[] | undefined): void => {
    if (fault.active && /insert into scheduled_jobs/.test(sql) && params?.[2] === 'followup') throw new TransientError('test_followup_insert_fault');
  };
  const wrap = (handle: Db): Db => ({
    query<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row[]> {
      check(sql, params);
      return handle.query<Row>(sql, params);
    },
    one<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row> {
      check(sql, params);
      return handle.one<Row>(sql, params);
    },
    maybeOne<Row extends object = DbRow>(sql: string, params?: readonly unknown[]): Promise<Row | null> {
      check(sql, params);
      return handle.maybeOne<Row>(sql, params);
    },
    exec: (sql) => handle.exec(sql),
    tx: (fn) => handle.tx((tx) => fn(wrap(tx))),
    close: () => handle.close(),
  });
  return wrap(db);
}

describe('lead_process: a genuine lead', () => {
  it('sends exactly one new_lead email with three working links and the mailto link, Reply-To the owner, then notifies with two follow-up jobs', async () => {
    const db = getDb();
    const { accountId, leadId, job } = await seedProcessableLead({ mailClient: 'gmail' });
    const t0 = rig.clock.now();

    expect(await deliver(rig, job)).toEqual({ status: 200, outcome: 'done' });

    const mail = onlyEmail('new_lead');
    expect(mail.to).toEqual([NOTIFY_EMAIL]);
    expect(mail.replyTo).toBe(OWNER_EMAIL);
    expect(mail.subject).toBe('New lead: Maya — your reply is ready');
    expect(mail.idempotencyKey).toBe(`fake-local:notify:${leadId}:initial:r0`);
    expect(mail.tags).toEqual([
      { name: 'kind', value: 'new_lead' },
      { name: 'lead', value: leadId },
    ]);

    // The opening line (D-27), the lead card and the defanged, unverified message (D-47), the draft.
    expect(mail.text.trimStart().startsWith('Hublytix Autopilot')).toBe(true);
    expect(mail.text).toContain("This email isn't monitored. To answer the lead, tap 'Send from my email'.");
    // The plain-text part upper-cases headings.
    expect(mail.text.indexOf("This email isn't monitored")).toBeLessThan(mail.text.indexOf('NEW LEAD: MAYA'));
    expect(mail.text).toContain('Maya Okafor');
    expect(mail.text).toContain('Okafor Bakery');
    expect(mail.text).toContain('maya[@]okafor-bakery[.]example');
    expect(mail.text).toContain('Message from the lead (unverified)');
    expect(mail.text).toContain('hxxps://okafor-bakery[.]example/sink');
    expect(mail.html).not.toContain('https://okafor-bakery.example');
    expect(mail.html).not.toContain(LEAD_EMAIL);
    const draft = await draftRow(leadId);
    expect(draft?.needs_touch).toBe(false);
    expect(mail.text).toContain(draft?.subject);
    for (const line of (draft?.body ?? '').split('\n').filter((l) => l.trim() !== '')) expect(mail.text).toContain(line.trim());
    // No tracking (D-26): no images, no pixels.
    expect(mail.html).not.toMatch(/<img/i);

    // Three buttons and the "Open in default mail app" link, each a committed token of its purpose.
    const links = actionLinks(mail.html);
    expect(links).toHaveLength(4);
    const [sendUrl, editUrl, dismissUrl, mailtoUrl] = links;
    expect(sendUrl).toMatch(/^http:\/\/localhost:3000\/a\/apt_[A-Za-z0-9_-]{43}\/send$/);
    expect(editUrl).toMatch(/\/a\/apt_[A-Za-z0-9_-]{43}\/edit$/);
    expect(dismissUrl).toMatch(/\/a\/apt_[A-Za-z0-9_-]{43}\/dismiss$/);
    expect(mailtoUrl).toBe(`${sendUrl}?via=mailto`);
    expect(mail.text).toContain('Send from my email');
    expect(mail.text).toContain('Edit first');
    expect(mail.text).toContain('Not a real lead');
    expect(mail.text).toContain('Open in default mail app');
    for (const [url, purpose] of [
      [sendUrl, 'send'],
      [editUrl, 'edit'],
      [dismissUrl, 'dismiss'],
    ] as const) {
      const verified = await verifyActionToken(db, tokenOf(url ?? '', purpose), purpose, rig.clock.now());
      expect(verified).toMatchObject({ ok: true, token: { accountId, leadId, draftId: draft?.id, notificationKey: `notify:${leadId}:initial:r0`, purpose } });
    }
    const send = tokenOf(sendUrl ?? '', 'send');
    const desktop = { ip: '203.0.113.9', method: 'GET', chUaMobile: null, prefetch: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
    const opened = await resolveSendLink(rig.deps, { ...desktop, token: send, viaMailto: false });
    expect(opened).toMatchObject({ type: 'redirect', client: 'gmail' });
    if (opened.type === 'redirect') expect(decodeURIComponent(opened.url)).toContain(`to=${LEAD_EMAIL}`);
    expect(await resolveSendLink(rig.deps, { ...desktop, token: send, viaMailto: true })).toMatchObject({ type: 'interstitial', view: { recipient: LEAD_EMAIL, subject: draft?.subject } });

    // The `sent` transaction: notified, first_notified_at, and the two follow-up jobs.
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'notified', first_notified_at: t0, needs_touch: false, stop_reason: null });
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'sent' }]);
    const targets = followUpTargets(t0, { quietStartHour: 19, quietEndHour: 8, skipWeekends: true }, ZONE, accountId);
    const jobs = await followUpJobs(db, leadId);
    expect(jobs.map((row) => [row.dedupe_key, row.seq, row.status, row.payload])).toEqual([
      [`lead:${leadId}:fu:1:s0`, 1, 'scheduled', { leadId, n: 1, followupStream: 0, targetAt: targets[0].runAt.toISOString() }],
      [`lead:${leadId}:fu:2:s0`, 2, 'scheduled', { leadId, n: 2, followupStream: 0, targetAt: targets[1].runAt.toISOString() }],
    ]);
    // Tuesday 10:00 New York: day 2 is Thursday 10:00 (allowed); day 5 is a Sunday, shifted to Monday 08:00 + the account's offset.
    expect(targets[0]).toMatchObject({ shifted: false, runAt: new Date('2026-10-08T14:00:00.000Z') });
    expect(targets[1].shifted).toBe(true);
    expect(targets[1].runAt.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-10-12T12:00:00.000Z'));
    expect(targets[1].runAt.getTime()).toBeLessThanOrEqual(Date.parse('2026-10-12T12:10:00.000Z'));
    expect((await getJob(db, job.id))?.status).toBe('done');
  });

  it('names no lead in the subject when the first name is unsafe, and says so when HubSpot cannot confirm the send', async () => {
    const db = getDb();
    const accountId = await seedLeadAccount(db, { now: rig.clock.now(), loggingMode: 'none' });
    const leadId = await seedNewLead(db, { accountId, now: rig.clock.now(), firstName: 'Win big at evil.example' });
    await deliver(rig, await scheduleLeadProcess(rig, { accountId, leadId }));

    const mail = onlyEmail('new_lead');
    expect(mail.subject).toBe('New lead — your reply is ready');
    expect(mail.text).toContain("HubSpot isn't logging your emails, so we can't confirm that you sent this reply or see the lead's answer.");
    expect(mail.text).toContain('evil[.]example');
    expect(mail.html).not.toContain('evil.example');
  });

  it('files a filtered lead without a draft or an email', async () => {
    const db = getDb();
    const { leadId, job } = await seedProcessableLead({ message: 'Buy crypto now and click here for casino backlinks' });
    expect(await deliver(rig, job)).toEqual({ status: 200, outcome: 'done' });
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'filtered', first_notified_at: null });
    expect(sent()).toEqual([]);
    expect(await draftRow(leadId)).toBeNull();
    expect(rig.fakes.llm.callsFor('draft')).toHaveLength(0);
    expect(await followUpJobs(db, leadId)).toEqual([]);
  });
});

describe('lead_process: needs your touch', () => {
  it('a refusal sends one needs-touch email with the starter reply, in plain words', async () => {
    const db = getDb();
    rig.fakes.llm.injectFault('refusal', { purpose: 'draft' });
    const { leadId, job } = await seedProcessableLead();

    expect(await deliver(rig, job)).toEqual({ status: 200, outcome: 'done' });

    const mail = onlyEmail('needs_touch');
    expect(mail.subject).toBe('New lead: Maya — your reply needs your touch');
    expect(mail.replyTo).toBe(OWNER_EMAIL);
    expect(mail.text).toContain("This email isn't monitored. To answer the lead, tap 'Send from my email'.");
    expect(mail.text).toContain('The AI model that writes your drafts declined to write your reply to this message.');
    expect(mail.text).toContain("So we've written a short starter version of your reply instead.");
    expect(mail.text).not.toMatch(/refusal|validation|needs_touch/);
    expect(actionLinks(mail.html)).toHaveLength(4);
    const draft = await draftRow(leadId);
    expect(draft).toMatchObject({ needs_touch: true });
    expect(mail.text).toContain('Hi Maya,');
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'notified', needs_touch: true });
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'needs_touch', status: 'sent' }]);
    expect(await followUpJobs(db, leadId)).toHaveLength(2);
    expect(rig.fakes.llm.callsFor('draft')).toHaveLength(1);
  });

  it('a transient drafting error retries the job, and on the final delivery sends one needs-touch email', async () => {
    const db = getDb();
    rig.fakes.llm.injectFault('transient', { purpose: 'draft', times: 2 });
    const { leadId, job } = await seedProcessableLead();

    expect(await deliver(rig, job)).toMatchObject({ status: 500, outcome: 'transient', code: 'ai_draft_transient' });
    expect(sent()).toEqual([]);
    expect((await leadRow(db, leadId)).processing_state).toBe('processing');

    rig.clock.advance({ minutes: 5 });
    expect(await deliver(rig, job, { retried: 4 })).toEqual({ status: 200, outcome: 'done' });

    const mail = onlyEmail('needs_touch');
    expect(mail.text).toContain('Something went wrong while we were preparing this lead.');
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'notified', needs_touch: true });
    expect(alerts.map((alert) => alert.code)).toEqual([]);
  });

  it('with the AI budget breaker tripped, sends a needs-touch email without any model call and alerts the admin once', async () => {
    const db = getDb();
    rig = createLeadsRig(db, { env: { AI_DAILY_BUDGET_USD: '1' } });
    await db.query(`insert into ai_calls (purpose, attempt, model, cost_micro_usd, outcome, created_at) values ('draft', 1, 'claude-sonnet-5-5', 1000000, 'ok', $1)`, [
      rig.clock.now(),
    ]);
    const { leadId, job } = await seedProcessableLead();

    expect(await deliver(rig, job)).toEqual({ status: 200, outcome: 'done' });

    const mail = onlyEmail('needs_touch');
    expect(mail.text).toContain('Drafting is unavailable right now.');
    expect(rig.fakes.llm.calls).toHaveLength(0);
    expect(alerts.map((alert) => alert.code)).toEqual(['ai_daily_budget_reached']);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'notified', needs_touch: true });
  });
});

describe('lead_process: exactly once', () => {
  it('a crash after the email went out does not send it twice; the first email’s links stay valid', async () => {
    const db = getDb();
    // Resend accepted the email but the response was lost (or the process died right after).
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', afterSend: true });
    const { leadId, job } = await seedProcessableLead();

    expect(await deliver(rig, job)).toMatchObject({ status: 500, outcome: 'transient' });
    const first = onlyEmail('new_lead');
    expect((await leadRow(db, leadId)).processing_state).toBe('processing');
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'sending' }]);

    rig.clock.advance({ seconds: 20 });
    expect(await deliver(rig, job, { retried: 1 })).toEqual({ status: 200, outcome: 'done' });

    // Same idempotency key, new tokens → Resend's 409: the reservation is marked sent, nothing is resent.
    expect(sent()).toEqual([first]);
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'sent' }]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'notified' });
    expect(await followUpJobs(db, leadId)).toHaveLength(2);
    expect(rig.fakes.llm.callsFor('draft')).toHaveLength(1);
    const [sendUrl] = actionLinks(first.html);
    expect(await verifyActionToken(db, tokenOf(sendUrl ?? '', 'send'), 'send', rig.clock.now())).toMatchObject({ ok: true });
    const tokens = await db.query<{ revoked: number; live: number }>(
      `select count(*) filter (where revoked_at is not null)::int as revoked, count(*) filter (where revoked_at is null)::int as live
         from action_tokens where lead_id = $1`,
      [leadId],
    );
    expect(tokens).toEqual([{ revoked: 3, live: 3 }]);
  });

  it('a redelivery after the email was sent changes nothing', async () => {
    const db = getDb();
    const { leadId, job } = await seedProcessableLead();
    await deliver(rig, job);
    await db.query(`update scheduled_jobs set status = 'scheduled' where id = $1`, [job.id]);
    rig.clock.advance({ minutes: 1 });
    expect(await deliver(rig, job, { retried: 1 })).toEqual({ status: 200, outcome: 'done' });
    expect(sent()).toHaveLength(1);
    expect(await followUpJobs(db, leadId)).toHaveLength(2);
  });

  it('a dismissal during drafting stops the email (reservation predicates)', async () => {
    const db = getDb();
    const { leadId, job } = await seedProcessableLead();
    const llm: LLM = {
      classify: (input, options) => rig.deps.llm.classify(input, options),
      generateBrief: (input, options) => rig.deps.llm.generateBrief(input, options),
      draftFollowUp: (input, options) => rig.deps.llm.draftFollowUp(input, options),
      draft: async (input, options) => {
        // The owner taps "Not a real lead" on another device while the draft is being written.
        await db.query(`update leads set dismissed_at = $2, stop_reason = 'dismissed' where id = $1`, [leadId, rig.clock.now()]);
        return rig.deps.llm.draft(input, options);
      },
    };

    expect(await deliver(rig, job, { deps: { ...rig.deps, llm } })).toEqual({ status: 200, outcome: 'skipped' });

    expect(sent()).toEqual([]);
    expect(await notifications(db, leadId)).toEqual([]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'skipped', first_notified_at: null, stop_reason: 'dismissed' });
    expect(await followUpJobs(db, leadId)).toEqual([]);
  });
});

describe('lead_process: a dismissal that cancels the job', () => {
  it('during drafting, the attempt loses its claim and writes and sends nothing', async () => {
    const db = getDb();
    const { leadId, job } = await seedProcessableLead();
    const llm: LLM = {
      classify: (input, options) => rig.deps.llm.classify(input, options),
      generateBrief: (input, options) => rig.deps.llm.generateBrief(input, options),
      draftFollowUp: (input, options) => rig.deps.llm.draftFollowUp(input, options),
      draft: async (input, options) => {
        // The dismiss POST: dismissed_at, stop_reason and the lead's jobs cancelled, in one transaction.
        await db.tx(async (tx) => {
          await tx.query(`update leads set dismissed_at = $2, stop_reason = 'dismissed' where id = $1`, [leadId, rig.clock.now()]);
          await cancelJobsInTx(tx, { leadId, reason: 'dismissed', now: rig.clock.now() });
        });
        return rig.deps.llm.draft(input, options);
      },
    };

    expect(await deliver(rig, job, { deps: { ...rig.deps, llm } })).toEqual({ status: 200, outcome: 'lease_lost' });

    expect(sent()).toEqual([]);
    expect(await notifications(db, leadId)).toEqual([]);
    expect(await draftRow(leadId)).toMatchObject({ subject: null });
    expect((await getJob(db, job.id))?.status).toBe('cancelled');
    expect(await followUpJobs(db, leadId)).toEqual([]);
  });
});

describe('lead_process: the failure path is never silent', () => {
  it('the failure callback winner sends one needs-touch email with the minimal safe template (no model call)', async () => {
    const db = getDb();
    const { leadId, job } = await seedProcessableLead();

    expect(await handleFailureCallback(rig.deps, { jobId: job.id, sourceMessageId: job.externalId ?? '' }, rig.registry)).toBe('won');

    const mail = onlyEmail('needs_touch');
    expect(mail.subject).toBe('New lead: Maya — your reply needs your touch');
    expect(mail.text).toContain('Something went wrong while we were preparing this lead.');
    expect(mail.text).toContain("So we've written a short starter version of your reply instead.");
    expect(actionLinks(mail.html)).toHaveLength(4);
    expect(await draftRow(leadId)).toMatchObject({ needs_touch: true, attempts: 0 });
    expect(rig.fakes.llm.callsFor('draft')).toHaveLength(0);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'failed', first_notified_at: rig.clock.now() });
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'needs_touch', status: 'sent' }]);
    // A failed lead is "not processed" (D-32): no follow-ups.
    expect(await followUpJobs(db, leadId)).toEqual([]);
    expect(alerts.map((alert) => alert.code)).toEqual(['job_failed']);

    // The failure path again (the sweeper, a second callback): still one email.
    const failurePath = rig.registry.failurePath('lead_process');
    await failurePath?.(rig.deps, job, { reason: 'sweeper', code: 'job_too_many_attempts' });
    expect(sent()).toHaveLength(1);
  });

  it('a Resend outage on every delivery is not a failure: the new_lead email waits for the sweeper, then notifies with two follow-ups', async () => {
    const db = getDb();
    // Every one of the job's five deliveries hits a Resend 500; Resend recovers before the sweeper runs.
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', times: 5 });
    const { leadId, job } = await seedProcessableLead();

    for (let retried = 0; retried < 4; retried += 1) {
      expect(await deliver(rig, job, { retried })).toMatchObject({ status: 500, outcome: 'transient' });
      rig.clock.advance({ minutes: 1 });
    }
    // The final delivery: the reservation stays `sending` as new_lead and the job ends done, not failed.
    expect(await deliver(rig, job, { retried: 4 })).toEqual({ status: 200, outcome: 'done' });
    expect(sent()).toEqual([]);
    expect((await getJob(db, job.id))?.status).toBe('done');
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'processing', first_notified_at: null });
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'sending' }]);
    expect(alerts.map((alert) => alert.code)).toEqual([]);

    rig.clock.advance({ minutes: 11 });
    const summary = await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });
    expect(summary.notificationsResumed).toBe(1);

    const mail = onlyEmail('new_lead');
    expect(mail.subject).toBe('New lead: Maya — your reply is ready');
    expect(mail.text).not.toContain('Something went wrong');
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'sent' }]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'notified', needs_touch: false, first_notified_at: rig.clock.now() });
    expect(await followUpJobs(db, leadId)).toHaveLength(2);
    expect(rig.fakes.llm.callsFor('draft')).toHaveLength(1);
  });

  it('a new_lead email Resend never accepts within 23 h expires and the lead becomes failed ("Not processed"), not processing forever', async () => {
    const db = getDb();
    // Resend refuses every attempt: five deliveries, then every sweeper resume for 23 h.
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', times: 1000 });
    const { leadId, job } = await seedProcessableLead();
    for (let retried = 0; retried <= 4; retried += 1) await deliver(rig, job, { retried });
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'processing' });

    for (let hour = 0; hour < 23; hour += 1) {
      rig.clock.advance({ hours: 1 });
      await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });
    }

    expect(sent()).toEqual([]);
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'failed' }]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'failed', first_notified_at: null });
    expect(await followUpJobs(db, leadId)).toEqual([]);
    expect(alerts.map((alert) => alert.code)).toContain('notification_expired');
  });

  it('an expired initial email of an older revision leaves the re-processed lead alone', async () => {
    const db = getDb();
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', times: 1000 });
    const { leadId, job } = await seedProcessableLead();
    for (let retried = 0; retried <= 4; retried += 1) await deliver(rig, job, { retried });
    // The owner's override moved the lead to a new revision meanwhile.
    await db.query(`update leads set process_rev = 1 where id = $1`, [leadId]);

    rig.clock.advance({ hours: 23 });
    await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });

    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'failed' }]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'processing' });
  });

  it('Resend down on the final delivery, then the owner pauses: the sweeper\'s takeover fails its predicates and the lead becomes skipped, not processing forever', async () => {
    const db = getDb();
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', times: 5 });
    const { leadId, accountId, job } = await seedProcessableLead();
    for (let retried = 0; retried <= 4; retried += 1) await deliver(rig, job, { retried });
    expect((await getJob(db, job.id))?.status).toBe('done');
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'processing' });
    await db.query(`update accounts set paused_at = $2, processing_state = 'paused' where id = $1`, [accountId, rig.clock.now()]);

    rig.clock.advance({ minutes: 11 });
    const summary = await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });

    expect(summary).toMatchObject({ notificationsResumed: 0, errors: 0 });
    expect(sent()).toEqual([]);
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'failed' }]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'skipped', first_notified_at: null });
    expect(await followUpJobs(db, leadId)).toEqual([]);
  });

  it('a permanent Resend error on the sweeper\'s resume: the lead becomes failed ("Not processed") with no second email', async () => {
    const db = getDb();
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', times: 5 });
    const { leadId, job } = await seedProcessableLead();
    for (let retried = 0; retried <= 4; retried += 1) await deliver(rig, job, { retried });
    rig.fakes.mailer.injectFailure({ kind: 'permanent', code: 'validation_error' });

    rig.clock.advance({ minutes: 11 });
    await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });

    expect(sent()).toEqual([]);
    expect(alerts.map((alert) => alert.code)).toContain('notification_send_failed');
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'failed' }]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'failed', first_notified_at: null });
    expect(await followUpJobs(db, leadId)).toEqual([]);
  });

  it('an email that went out on the final delivery but whose answer was lost is notified once, with its follow-ups', async () => {
    const db = getDb();
    // Resend accepted the final delivery's email, but the response was lost.
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', afterSend: true });
    const { leadId, job } = await seedProcessableLead();

    expect(await deliver(rig, job, { retried: 4 })).toEqual({ status: 200, outcome: 'done' });
    const first = onlyEmail('new_lead');
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'processing' });

    rig.clock.advance({ minutes: 11 });
    await runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });

    // Resend's 409 on the same key: marked sent, nothing resent, and the owner's email is a normal new_lead.
    expect(sent()).toEqual([first]);
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'sent' }]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'notified', needs_touch: false });
    expect(await followUpJobs(db, leadId)).toHaveLength(2);
    const [sendUrl] = actionLinks(first.html);
    expect(await verifyActionToken(db, tokenOf(sendUrl ?? '', 'send'), 'send', rig.clock.now())).toMatchObject({ ok: true });
  });

  it('the failure callback after a crash past the send resumes the pending new_lead email instead of downgrading it', async () => {
    const db = getDb();
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', afterSend: true });
    const { leadId, job } = await seedProcessableLead();
    // A non-final delivery sends, loses the answer, and the process dies; QStash later gives up.
    expect(await deliver(rig, job)).toMatchObject({ status: 500, outcome: 'transient' });
    const first = onlyEmail('new_lead');
    rig.clock.advance({ minutes: 1 });

    expect(await handleFailureCallback(rig.deps, { jobId: job.id, sourceMessageId: job.externalId ?? '' }, rig.registry)).toBe('won');

    expect(sent()).toEqual([first]);
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'sent' }]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'notified', needs_touch: false });
    expect(await followUpJobs(db, leadId)).toHaveLength(2);
  });

  it('a send that fails permanently is alerted, and the failure path marks the lead failed without a second email', async () => {
    const db = getDb();
    rig.fakes.mailer.injectFailure({ kind: 'permanent', code: 'validation_error' });
    const { leadId, job } = await seedProcessableLead();

    expect(await deliver(rig, job)).toMatchObject({ status: 489, outcome: 'permanent', code: 'lead_notification_failed' });
    expect(sent()).toEqual([]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'failed', first_notified_at: null });
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'failed' }]);
    expect(alerts.map((alert) => alert.code)).toContain('notification_send_failed');
    expect(await followUpJobs(db, leadId)).toEqual([]);
  });
});

describe('lead_process: the `sent` transaction is one transaction (PLAN §8.4 step 5)', () => {
  it('when the notified writes fail, `sent` is not committed either; the retry finishes all of it once', async () => {
    const db = getDb();
    const fault = { active: true };
    const faultyDeps = { ...rig.deps, db: failingFollowUpInserts(db, fault) };
    const { leadId, job } = await seedProcessableLead();

    // The follow-up row insert fails inside the sent transaction (a database blip).
    expect(await deliver(rig, job, { deps: faultyDeps })).toMatchObject({ status: 500, outcome: 'transient', code: 'test_followup_insert_fault' });
    const first = onlyEmail('new_lead');
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'sending' }]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'processing', first_notified_at: null });
    expect(await followUpJobs(db, leadId)).toEqual([]);

    fault.active = false;
    rig.clock.advance({ seconds: 30 });
    expect(await deliver(rig, job, { retried: 1, deps: faultyDeps })).toEqual({ status: 200, outcome: 'done' });

    // Resend's 409 on the same key: one email in total; sent, notified and exactly two follow-ups.
    expect(sent()).toEqual([first]);
    expect(await notifications(db, leadId)).toEqual([{ dedupe_key: `notify:${leadId}:initial:r0`, kind: 'new_lead', status: 'sent' }]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'notified', first_notified_at: rig.clock.now() });
    expect(await followUpJobs(db, leadId)).toHaveLength(2);
  });
});

describe('lead_process: privacy (law 4)', () => {
  it('logs ids and codes only: no address, message, draft, token or compose link', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
    }
    try {
      rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
      const { leadId, job } = await seedProcessableLead();
      await deliver(rig, job);
      rig.clock.advance({ minutes: 1 });
      await deliver(rig, job, { retried: 1 });
      expect(sent('new_lead')).toHaveLength(1);
      const draft = await draftRow(leadId);
      const logged = lines.join('\n');
      expect(lines.length).toBeGreaterThan(3);
      for (const secret of [LEAD_EMAIL, OWNER_EMAIL, NOTIFY_EMAIL, 'okafor-bakery', 'Okafor', 'sink', 'apt_', '/a/', draft?.subject ?? '-', 'Maya']) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('lead_process: daily cap, test leads, follow-ups off', () => {
  it('over the daily cap the lead is deferred: no draft call, no lead email, one lead_cap email', async () => {
    const db = getDb();
    const accountId = await seedLeadAccount(db, { now: rig.clock.now() });
    await db.query(
      `insert into leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, received_at, classified_at,
                          first_notified_at, processing_state, classification)
       select $1, 'c-' || g, 'form-1', $2, 'webhook', $2, $2, $2, 'notified', 'lead' from generate_series(1, 50) g`,
      [accountId, new Date(rig.clock.now().getTime() - 3_600_000)],
    );
    const leadId = await seedNewLead(db, { accountId, now: rig.clock.now() });

    expect(await deliver(rig, await scheduleLeadProcess(rig, { accountId, leadId }))).toEqual({ status: 200, outcome: 'done' });

    expect(onlyEmail('lead_cap').to).toEqual([NOTIFY_EMAIL]);
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'deferred', first_notified_at: null });
    expect(rig.fakes.llm.callsFor('draft')).toHaveLength(0);
    expect(await draftRow(leadId)).toBeNull();
    expect(await followUpJobs(db, leadId)).toEqual([]);
  });

  it('a test lead is skipped and never gets follow-up rows or an email', async () => {
    const db = getDb();
    const accountId = await seedLeadAccount(db, { now: rig.clock.now() });
    const leadId = await seedNewLead(db, { accountId, now: rig.clock.now(), isTest: true });
    expect(await deliver(rig, await scheduleLeadProcess(rig, { accountId, leadId }))).toEqual({ status: 200, outcome: 'skipped' });
    expect(sent()).toEqual([]);
    expect(await followUpJobs(db, leadId)).toEqual([]);
  });

  it('with follow-ups off the lead is notified without follow-up rows and marked followups_off', async () => {
    const db = getDb();
    const { leadId, job } = await seedProcessableLead({ followupsEnabled: false });
    expect(await deliver(rig, job)).toEqual({ status: 200, outcome: 'done' });
    expect(onlyEmail('new_lead').subject).toBe('New lead: Maya — your reply is ready');
    expect(await leadRow(db, leadId)).toMatchObject({ processing_state: 'notified', stop_reason: 'followups_off' });
    expect(await followUpJobs(db, leadId)).toEqual([]);
  });

  it('a paused account gets nothing: the lead is skipped before any model call', async () => {
    const db = getDb();
    const { accountId, leadId, job } = await seedProcessableLead();
    await db.query(`update accounts set processing_state = 'paused' where id = $1`, [accountId]);
    expect(await deliver(rig, job)).toEqual({ status: 200, outcome: 'skipped' });
    expect(sent()).toEqual([]);
    expect(rig.fakes.llm.calls).toHaveLength(0);
    expect((await leadRow(db, leadId)).processing_state).toBe('skipped');
  });
});
