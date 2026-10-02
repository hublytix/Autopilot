import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { WeeklyReport, WEEKLY_REPORT_HONESTY_LINE } from '@/emails/WeeklyReport';
import { PermanentError, TransientError } from '@/server/domain/errors';
import { parseWeeklyMetrics, type WeeklyMetrics } from '@/server/domain/weekly-metrics';
import { renderEmail } from '@/server/email/render';
import { runJob } from '@/server/jobs/dispatcher';
import { createJobRegistry } from '@/server/jobs/registry';
import { getJob } from '@/server/jobs/rows';
import { runSweeper } from '@/server/jobs/sweeper';
import { createWeeklyReportHandler } from '@/server/services/reports/job';
import { weeklyReportProps } from '@/server/services/reports/present';
import { listRefreshLeads, REPLY_LOOKBACK_MS } from '@/server/services/reports/repository';
import { useTestDb as setUpTestDb } from '../db/harness';
import { forbidNetworkInTransactions, interceptBefore } from '../db/intercept';
import { seedLeadIn } from '../dashboard/support';
import { seedOtherAccount } from '../owner-controls/support';
import { OWNER_EMAIL, seedNotifiedLead } from '../signals/support';
import {
  createReportRig,
  deliverReport,
  HOUR,
  local,
  MINUTE,
  MONDAY_8AM,
  NOTIFY_EMAIL,
  PERIOD_START,
  reportReservation,
  reportRow,
  scheduleReport,
  seedBaseline,
  seedFilteredLead,
  seedSimulationWeek,
  sent,
  type ReportRig,
  type SimulationWeek,
} from './support';

// The `weekly_report` job (PLAN §8.2, §8.3, §9.8, D-17, D-37): re-check the account, refresh the
// signals, compute and store the metrics before the email is reserved, send it once to the verified
// addresses (Reply-To the owner), mark the report sent; the failure path, the sweeper's re-enqueue
// and resume, and the honesty rules end to end on the fake portal.

const getDb = setUpTestDb();
let rig: ReportRig;
let week: SimulationWeek;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createReportRig(getDb());
  week = await seedSimulationWeek(rig);
  await seedBaseline(getDb(), rig.accountId, rig.clock.now());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function recordUrl(contactId: string): string {
  return `https://app.hubspot.com/contacts/${rig.portalId}/record/0-1/${contactId}`;
}

function sweep() {
  return runSweeper(rig.deps, { jobRegistry: rig.registry, notificationRegistry: rig.notifications });
}

/** PLAN §13's Monday metrics for the seeded week, exactly. */
function planMetrics(): WeeklyMetrics {
  return {
    version: 1,
    period: { start: '2026-10-05T12:00:00.000Z', end: '2026-10-12T12:00:00.000Z' },
    basis: { loggingMode: 'log_all', emailScope: true, sendsLogged: true, repliesLogged: true },
    cohort: {
      leadsIn: 6,
      filtered: 2,
      draftsEmailed: 4,
      sendsConfirmed: 3,
      sendLinkOpenedNotConfirmed: 1,
      medianTimeToFirstReply: { seconds: 21 * 60, samples: 3 },
      waiting: { count: 1, leads: [{ leadId: week.ids['#2'], submittedAt: '2026-10-06T14:05:00.000Z', recordUrl: recordUrl(week.contacts['#2']) }], more: 0 },
      unchecked: 0,
    },
    events: { repliesFromLeads: 1, followUpsDrafted: 7 },
    comparison: {
      baseline: 'ok',
      baselineMedianSeconds: 3.5 * 3600,
      baselinePercentWithoutReply: 20,
      medianSeconds: 21 * 60,
      percentWithoutReply: 25,
      population: 4,
      withoutReply: 1,
    },
  };
}

/** Lead #2's contact read fails as `error` whenever it asks for the emails (the other leads read normally). */
function failContactRead(contactId: string, error: Error): void {
  const original = rig.hubspot.getContact.bind(rig.hubspot);
  vi.spyOn(rig.hubspot, 'getContact').mockImplementation(async (token, id, options) => {
    if (id === contactId && options.associations !== undefined) throw error;
    return original(token, id, options);
  });
}

describe('weekly_report: the PLAN §13 Monday report', () => {
  it('refreshes the signals, stores the metrics and emails the verified address with Reply-To the owner', async () => {
    const job = await scheduleReport(rig);
    expect(await deliverReport(rig, job)).toMatchObject({ status: 200, outcome: 'done' });

    // The refresh found the logged sends and #6's reply (the database had neither).
    const leads = await getDb().query<{ id: string; send_confirmed_at: Date | null; replied_at: Date | null }>(
      `select id, send_confirmed_at, replied_at from leads where account_id = $1`,
      [rig.accountId],
    );
    const byId = new Map(leads.map((lead) => [lead.id, lead]));
    expect(byId.get(week.ids['#1'])?.send_confirmed_at).toEqual(new Date('2026-10-06T14:13:00.000Z'));
    expect(byId.get(week.ids['#5'])?.send_confirmed_at).toEqual(new Date('2026-10-07T14:01:00.000Z'));
    expect(byId.get(week.ids['#6'])).toMatchObject({ send_confirmed_at: new Date('2026-10-06T14:41:00.000Z'), replied_at: new Date('2026-10-09T18:00:00.000Z') });
    expect(byId.get(week.ids['#2'])?.send_confirmed_at).toBeNull();
    // The test lead is never read or counted.
    expect(byId.get(week.ids.test)?.send_confirmed_at).toBeNull();

    const report = await reportRow(getDb(), rig.accountId);
    expect(report.status).toBe('sent');
    expect(report.attempts).toBe(0);
    expect(report.metrics).toEqual(planMetrics());

    const mails = sent(rig);
    expect(mails.map((mail) => mail.kind)).toEqual(['weekly_report']);
    const [mail] = mails;
    expect(mail?.to).toEqual([NOTIFY_EMAIL]);
    expect(mail?.replyTo).toBe(OWNER_EMAIL);
    expect(mail?.subject).toBe(`${rig.deps.env.PRODUCT_NAME} weekly report: Mon 5 Oct – Mon 12 Oct`);
    expect(mail?.idempotencyKey).toBe(`${rig.deps.env.ENV_NAMESPACE}:report:${rig.accountId}:2026-10-12`);
    const text = mail?.text ?? '';
    for (const line of [
      'From Mon 5 Oct, 08:00 to Mon 12 Oct, 08:00 (America/New_York).',
      'Leads in: 6',
      'Filtered (spam etc.): 2',
      'Drafts emailed to you: 4',
      'Your sends confirmed in HubSpot: 3',
      'Send link opened, not confirmed: 1',
      'Median time to your first reply (logged in HubSpot): 21 min',
      'Leads still waiting for your reply (nothing logged in HubSpot): 1',
      'Lead submitted Tue 6 Oct, 10:05',
      recordUrl(week.contacts['#2']),
      'Replies from leads: 1',
      'Follow-ups drafted: 7',
      'Baseline: 3 h 30 min · This week: 21 min',
      'Baseline: 20% · This week: 25%',
      WEEKLY_REPORT_HONESTY_LINE,
      `${rig.deps.env.APP_URL}/dashboard`,
    ]) {
      expect(text).toContain(line);
    }
    // Plain text upper-cases the headings.
    expect(text).toMatch(/Compared with your baseline/i);
    expect(mail?.html).toContain(`href="${recordUrl(week.contacts['#2'])}"`);
    // Law 4: ids, times and numbers only, never a lead's name or address.
    for (const content of ['Ana', 'Ben', 'Fay', 'Eli', 'example.org', 'Okafor']) expect(text).not.toContain(content);
    expect(JSON.stringify(report.metrics)).not.toMatch(/example\.org|Okafor|Ana|Ben/);

    expect(await reportReservation(getDb(), rig.accountId)).toEqual({ kind: 'weekly_report', status: 'sent' });
    expect((await getJob(getDb(), job.id))?.status).toBe('done');
  });

  it('holds no database transaction across a HubSpot, Resend or QStash call', async () => {
    const job = await scheduleReport(rig);
    const guarded = forbidNetworkInTransactions(rig.deps);
    expect(await deliverReport(rig, job, { deps: guarded.deps })).toMatchObject({ outcome: 'done' });
    expect(guarded.calls).toEqual(expect.arrayContaining(['hubspot.getContact', 'hubspot.batchReadEmails', 'mailer.send']));
  });

  it('stores the metrics before the email is reserved', async () => {
    const job = await scheduleReport(rig);
    let storedAtReservation: unknown = 'not reached';
    const watched = interceptBefore(getDb(), /insert into notifications_sent/, async (handle) => {
      storedAtReservation = (await handle.one<{ metrics: unknown }>(`select metrics from weekly_reports where account_id = $1`, [rig.accountId])).metrics;
    });
    expect(await deliverReport(rig, job, { deps: { ...rig.deps, db: watched.db } })).toMatchObject({ outcome: 'done' });
    expect(watched.fired()).toBe(1);
    expect(parseWeeklyMetrics(storedAtReservation)).not.toBeNull();
  });

  it('sends nothing more on a redelivery', async () => {
    const job = await scheduleReport(rig);
    await deliverReport(rig, job);
    await getDb().query(`update scheduled_jobs set status = 'scheduled' where id = $1`, [job.id]);
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'done' });
    expect(sent(rig)).toHaveLength(1);
  });

  it('runs 15 minutes after Monday 08:00 local plus the portal\'s stagger', async () => {
    const job = await scheduleReport(rig);
    // The fake portal's stagger (FNV of its id) — whatever it is, after the 15-minute intake grace.
    expect(job.runAt.getTime()).toBeGreaterThanOrEqual(MONDAY_8AM.getTime() + 15 * MINUTE);
    expect(job.runAt.getTime()).toBeLessThanOrEqual(MONDAY_8AM.getTime() + 25 * MINUTE);
  });
});

describe('weekly_report: which leads it reads and counts (the SQL)', () => {
  it('counts a lead submitted at the period start, not one at the period end, and an earlier lead\'s reply and follow-up in the period', async () => {
    const db = getDb();
    const atStart = await seedFilteredLead(rig, { email: 'start@example.net', submittedAt: PERIOD_START, classification: 'spam' });
    const atEnd = await seedFilteredLead(rig, { email: 'end@example.net', submittedAt: MONDAY_8AM, classification: 'spam' });
    // Submitted the week before; its follow-up 2 went out on Mon 5 Oct 10:01 (in the period), and the
    // contact replied on Thu 8 Oct — logged in HubSpot only, so only the report's refresh can find it.
    const old = await seedNotifiedLead(rig, {
      email: 'olga@example.org',
      firstName: 'Olga',
      submittedAt: new Date('2026-09-30T14:00:00.000Z'),
      firstNotifiedAt: new Date('2026-09-30T14:01:00.000Z'),
      followUps: false,
    });
    await db.query(`update leads set fu1_notified_at = $2, fu2_notified_at = $3 where id = $1`, [old.leadId, new Date('2026-10-02T14:01:00.000Z'), local(5, '10:01')]);
    rig.hubspot.logLeadReply({ from: 'olga@example.org', at: local(8, '09:00') });
    // Two earlier leads only a follow-up email puts in the week (dismissed afterwards, so no reply lookback reads them).
    const pia = await seedNotifiedLead(rig, { email: 'pia@example.org', firstName: 'Pia', submittedAt: new Date('2026-10-03T14:00:00.000Z'), firstNotifiedAt: new Date('2026-10-03T14:01:00.000Z'), followUps: false });
    await db.query(`update leads set fu1_notified_at = $2, dismissed_at = $3 where id = $1`, [pia.leadId, local(5, '10:01'), local(6, '09:00')]);
    const quin = await seedNotifiedLead(rig, { email: 'quin@example.org', firstName: 'Quin', submittedAt: new Date('2026-09-30T15:00:00.000Z'), firstNotifiedAt: new Date('2026-09-30T15:01:00.000Z'), followUps: false });
    await db.query(`update leads set fu1_notified_at = $2, fu2_notified_at = $3, dismissed_at = $4 where id = $1`, [quin.leadId, new Date('2026-10-02T15:01:00.000Z'), local(5, '11:01'), local(6, '09:00')]);

    const job = await scheduleReport(rig);
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'done' });

    const metrics = (await reportRow(db, rig.accountId)).metrics as WeeklyMetrics;
    const expected = planMetrics();
    // The PERIOD_START lead is in the cohort (a filtered one), the MONDAY_8AM one is not; the old lead is not in the cohort.
    expect(metrics.cohort).toEqual({ ...expected.cohort, leadsIn: 7, filtered: 3 });
    // The old lead's reply (found by the refresh) and its follow-up 2, Pia's follow-up 1 and Quin's follow-up 2 are this week's events.
    expect(metrics.events).toEqual({ repliesFromLeads: 2, followUpsDrafted: 10 });
    expect(metrics.comparison).toEqual(expected.comparison);
    const oldRow = await db.one<{ replied_at: Date | null; signals_checked_at: Date | null }>(`select replied_at, signals_checked_at from leads where id = $1`, [old.leadId]);
    expect(oldRow.replied_at).toEqual(local(8, '09:00'));
    expect(oldRow.signals_checked_at).not.toBeNull();
    expect(JSON.stringify(metrics)).not.toContain(old.leadId);
    expect(JSON.stringify(metrics)).not.toContain(atStart);
    expect(JSON.stringify(metrics)).not.toContain(atEnd);
    // No other email: the refresh's reply cancelled no scheduled follow-up.
    expect(sent(rig).map((mail) => mail.kind)).toEqual(['weekly_report']);
  });

  it('also looks for replies on leads emailed in the 30 days before the period end, after the period\'s own leads', async () => {
    const db = getDb();
    const notified = (name: string, email: string, submitted: string) =>
      seedNotifiedLead(rig, { email, firstName: name, submittedAt: new Date(submitted), firstNotifiedAt: new Date(new Date(submitted).getTime() + MINUTE), followUps: false });
    // Lou: emailed Tue 29 Sep, both follow-ups before the period, replied Fri 9 Oct (HubSpot only).
    const lou = await notified('Lou', 'lou@example.org', '2026-09-29T14:00:00.000Z');
    await db.query(`update leads set fu1_notified_at = $2, fu2_notified_at = $3, stop_reason = 'max_followups' where id = $1`, [
      lou.leadId,
      new Date('2026-10-01T14:01:00.000Z'),
      new Date('2026-10-04T14:01:00.000Z'),
    ]);
    // Dot: dismissed before the period; Abe: emailed more than 30 days before the period end.
    const dot = await notified('Dot', 'dot@example.org', '2026-09-29T15:00:00.000Z');
    await db.query(`update leads set dismissed_at = $2 where id = $1`, [dot.leadId, new Date('2026-10-01T15:00:00.000Z')]);
    const abe = await notified('Abe', 'abe@example.org', '2026-09-10T14:00:00.000Z');
    for (const email of ['lou@example.org', 'dot@example.org', 'abe@example.org']) rig.hubspot.logLeadReply({ from: email, at: local(9, '11:00') });

    const period = { start: PERIOD_START, end: MONDAY_8AM };
    const listed = await listRefreshLeads(db, rig.accountId, period);
    // The period's own leads first (by submission), then the earlier ones; never the test lead, Dot or Abe.
    expect(listed).toEqual([week.ids['#1'], week.ids['#2'], week.ids['#6'], week.ids['#5'], lou.leadId]);
    expect(MONDAY_8AM.getTime() - REPLY_LOOKBACK_MS).toBe(new Date('2026-09-12T12:00:00.000Z').getTime());

    const job = await scheduleReport(rig);
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'done' });
    expect((await reportRow(db, rig.accountId)).metrics).toMatchObject({ events: { repliesFromLeads: 2, followUpsDrafted: 7 }, cohort: { leadsIn: 6 } });
    const replied = await db.query<{ id: string; replied_at: Date | null }>(`select id, replied_at from leads where id = any($1::uuid[]) order by submitted_at`, [[lou.leadId, dot.leadId, abe.leadId]]);
    expect(Object.fromEntries(replied.map((row) => [row.id, row.replied_at]))).toEqual({ [lou.leadId]: local(9, '11:00'), [dot.leadId]: null, [abe.leadId]: null });
  });
});

describe('weekly_report: leads HubSpot did not let the refresh read in full (law 3)', () => {
  it('never lists a lead whose emails could not be read as waiting, and says it could not be checked', async () => {
    failContactRead(week.contacts['#2'], new PermanentError('hubspot_missing_scopes', { httpStatus: 403 }));
    const job = await scheduleReport(rig);
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'done' });
    const expected = planMetrics();
    expect((await reportRow(getDb(), rig.accountId)).metrics).toEqual({
      ...expected,
      cohort: { ...expected.cohort, waiting: { count: 0, leads: [], more: 0 }, unchecked: 1 },
      comparison: { ...expected.comparison, withoutReply: 0, percentWithoutReply: null },
    });
    const text = sent(rig)[0]?.text ?? '';
    expect(text).toContain('Leads still waiting for your reply (nothing logged in HubSpot): 0');
    expect(text).toContain("1 lead couldn't be checked in HubSpot this time.");
    expect(text).toContain('Baseline: 20% · This week: Not enough data');
    expect(text).not.toContain('Lead submitted');
  });

  it('logs and skips a lead whose read fails with a non-retryable error; the other leads are refreshed', async () => {
    failContactRead(week.contacts['#2'], new PermanentError('hubspot_bad_request', { httpStatus: 400 }));
    const job = await scheduleReport(rig);
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'done' });
    const metrics = (await reportRow(getDb(), rig.accountId)).metrics as WeeklyMetrics;
    expect(metrics.cohort).toMatchObject({ sendsConfirmed: 3, waiting: { count: 0, leads: [] }, unchecked: 1 });
    expect(metrics.events.repliesFromLeads).toBe(1);
    const checked = await getDb().query<{ id: string; signals_checked_at: Date | null }>(`select id, signals_checked_at from leads where id = any($1::uuid[])`, [
      [week.ids['#1'], week.ids['#2'], week.ids['#5'], week.ids['#6']],
    ]);
    expect(checked.filter((row) => row.signals_checked_at !== null).map((row) => row.id).sort()).toEqual([week.ids['#1'], week.ids['#5'], week.ids['#6']].sort());
    expect(sent(rig)).toHaveLength(1);
  });

  it('once the refresh budget is spent, counts only what is stored (never more) and still sends', async () => {
    const registry = createJobRegistry();
    registry.register('weekly_report', createWeeklyReportHandler({ sleep: rig.sleep, notifications: rig.notifications, refreshBudgetMs: 0 }));
    const job = await scheduleReport(rig);
    const getContact = vi.spyOn(rig.hubspot, 'getContact');
    rig.clock.set(job.runAt);
    expect(await runJob(rig.deps, { jobId: job.id, messageId: job.externalId, retried: 0 }, registry)).toMatchObject({ outcome: 'done' });
    expect(getContact).not.toHaveBeenCalled();
    const metrics = (await reportRow(getDb(), rig.accountId)).metrics as WeeklyMetrics;
    // Nothing confirmed is stored yet: no send, no reply, no waiting lead is claimed.
    expect(metrics.cohort).toMatchObject({ leadsIn: 6, draftsEmailed: 4, sendsConfirmed: null, waiting: { count: 0, leads: [], more: 0 }, unchecked: 4 });
    expect(metrics.events.repliesFromLeads).toBeNull();
    expect(metrics.comparison.percentWithoutReply).toBeNull();
    expect(sent(rig, 'weekly_report')).toHaveLength(1);
  });
});

describe('weekly_report: tenant isolation (PLAN §10.8)', () => {
  it('reads and reports only its own account\'s leads', async () => {
    const db = getDb();
    const other = await seedOtherAccount(db, rig.clock.now());
    await db.query(`update accounts set logging_mode = 'log_all' where id = $1`, [other.accountId]);
    const contactIds = ['777001', '777002', '777003'];
    const bLeads = [
      await seedLeadIn(db, { accountId: other.accountId, receivedAt: local(6, '11:00'), contactId: contactIds[0], state: 'notified', set: { classification: 'lead', first_notified_at: local(6, '11:01') } }),
      await seedLeadIn(db, {
        accountId: other.accountId,
        receivedAt: local(6, '11:10'),
        contactId: contactIds[1],
        state: 'notified',
        set: { classification: 'lead', first_notified_at: local(6, '11:11'), send_confirmed_at: local(6, '11:20'), replied_at: local(8, '12:00'), stop_reason: 'replied' },
      }),
      await seedLeadIn(db, {
        accountId: other.accountId,
        receivedAt: local(6, '11:20'),
        contactId: contactIds[2],
        state: 'notified',
        set: { classification: 'unclear', first_notified_at: local(6, '11:21'), fu1_notified_at: local(8, '11:21'), fu2_notified_at: local(11, '11:21') },
      }),
    ];
    const bPortal = (await db.one<{ hubspot_portal_id: string }>(`select hubspot_portal_id from accounts where id = $1`, [other.accountId])).hubspot_portal_id;

    const job = await scheduleReport(rig);
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'done' });
    expect((await reportRow(db, rig.accountId)).metrics).toEqual(planMetrics());
    const [mail] = sent(rig, 'weekly_report');
    const everything = `${mail?.text ?? ''}${mail?.html ?? ''}${JSON.stringify((await reportRow(db, rig.accountId)).metrics)}`;
    for (const marker of [...bLeads, ...contactIds, other.accountId, `/contacts/${bPortal}/`]) expect(everything, marker).not.toContain(marker);
    expect(mail?.to).toEqual([NOTIFY_EMAIL]);
    // A's refresh never read B's leads.
    const bChecked = await db.query<{ signals_checked_at: Date | null }>(`select signals_checked_at from leads where account_id = $1`, [other.accountId]);
    expect(bChecked.map((row) => row.signals_checked_at)).toEqual([null, null, null]);
  });
});

describe('weekly_report: exactly once (claim, crash, redelivery, sweeper)', () => {
  it('a crash after Resend accepted the email, before it was marked sent: the redelivery sends nothing new and marks the report sent (409 path)', async () => {
    const job = await scheduleReport(rig);
    // The database goes away right after Resend accepted the email: nothing is marked sent.
    const crash = interceptBefore(getDb(), /update notifications_sent set status = 'sent'/, async () => {
      throw new TransientError('db_connection_lost');
    });
    expect(await deliverReport(rig, job, { deps: { ...rig.deps, db: crash.db } })).toMatchObject({ status: 500 });
    expect(crash.fired()).toBe(1);
    const [first] = sent(rig);
    expect(sent(rig)).toHaveLength(1);
    expect(await reportReservation(getDb(), rig.accountId)).toEqual({ kind: 'weekly_report', status: 'sending' });
    expect((await reportRow(getDb(), rig.accountId)).status).toBe('pending');
    const stored = (await reportRow(getDb(), rig.accountId)).metrics;

    const getContact = vi.spyOn(rig.hubspot, 'getContact');
    rig.clock.advance(20_000);
    expect(await deliverReport(rig, job, { retried: 1 })).toMatchObject({ status: 200, outcome: 'done' });
    expect(sent(rig)).toEqual([first]);
    expect(getContact).not.toHaveBeenCalled();
    expect(await reportRow(getDb(), rig.accountId)).toMatchObject({ status: 'sent', metrics: stored });
    expect(await reportReservation(getDb(), rig.accountId)).toEqual({ kind: 'weekly_report', status: 'sent' });
  });

  it('a crash after the reservation, before the send: the redelivery sends the stored report once, without a second refresh', async () => {
    const job = await scheduleReport(rig);
    vi.spyOn(rig.fakes.mailer, 'send').mockRejectedValueOnce(new Error('process crashed before the send'));
    expect(await deliverReport(rig, job)).toMatchObject({ status: 500 });
    expect(sent(rig)).toHaveLength(0);
    expect(await reportReservation(getDb(), rig.accountId)).toEqual({ kind: 'weekly_report', status: 'sending' });
    const stored = (await reportRow(getDb(), rig.accountId)).metrics;
    expect(stored).toEqual(planMetrics());

    const getContact = vi.spyOn(rig.hubspot, 'getContact');
    expect(await deliverReport(rig, job, { retried: 1 })).toMatchObject({ outcome: 'done' });
    expect(getContact).not.toHaveBeenCalled();
    expect(sent(rig, 'weekly_report')).toHaveLength(1);
    expect(await reportRow(getDb(), rig.accountId)).toMatchObject({ status: 'sent', metrics: stored });
  });

  it('a delivery while another attempt holds the lease is told to come back, reading and sending nothing', async () => {
    const job = await scheduleReport(rig);
    rig.clock.set(job.runAt);
    await getDb().query(`update scheduled_jobs set status = 'running', attempt_id = gen_random_uuid(), lease_until = $2 where id = $1`, [
      job.id,
      new Date(rig.clock.now().getTime() + 5 * MINUTE),
    ]);
    const getContact = vi.spyOn(rig.hubspot, 'getContact');
    expect(await deliverReport(rig, job)).toMatchObject({ status: 503, outcome: 'lease_held' });
    expect(getContact).not.toHaveBeenCalled();
    expect(sent(rig)).toHaveLength(0);
    expect(await reportRow(getDb(), rig.accountId)).toMatchObject({ status: 'pending', metrics: null });
  });

  it('marks the report sent without sending when its email was already sent (the report row lagged)', async () => {
    const job = await scheduleReport(rig);
    await deliverReport(rig, job);
    await getDb().query(`update weekly_reports set status = 'pending' where account_id = $1`, [rig.accountId]);
    await getDb().query(`update scheduled_jobs set status = 'scheduled' where id = $1`, [job.id]);
    const getContact = vi.spyOn(rig.hubspot, 'getContact');
    const mailerSend = vi.spyOn(rig.fakes.mailer, 'send');
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'done' });
    expect(getContact).not.toHaveBeenCalled();
    expect(mailerSend).not.toHaveBeenCalled();
    expect((await reportRow(getDb(), rig.accountId)).status).toBe('sent');
    expect(sent(rig)).toHaveLength(1);
  });
});

describe('weekly_report: who gets one (D-17)', () => {
  it('is skipped, with no report and no HubSpot read, when the account stopped being active', async () => {
    const job = await scheduleReport(rig);
    await getDb().query(`update accounts set processing_state = 'paused', paused_at = $2 where id = $1`, [rig.accountId, MONDAY_8AM]);
    const getContact = vi.spyOn(rig.hubspot, 'getContact');
    expect(await deliverReport(rig, job)).toMatchObject({ status: 200, outcome: 'skipped' });
    expect(getContact).not.toHaveBeenCalled();
    expect(sent(rig)).toHaveLength(0);
    expect(await reportRow(getDb(), rig.accountId)).toMatchObject({ status: 'pending', metrics: null });
    expect(await reportReservation(getDb(), rig.accountId)).toBeNull();
  });

  it('is skipped when the connection turns out revoked during the refresh, with no email', async () => {
    const job = await scheduleReport(rig);
    rig.hubspot.setRefreshMode({ kind: 'revoked' });
    await getDb().query(`update hubspot_connections set access_expires_at = $2 where account_id = $1`, [rig.accountId, new Date(MONDAY_8AM.getTime() - HOUR)]);
    // The revoke transition cancels the account's jobs, this one included: it ends without a report.
    expect(await deliverReport(rig, job)).toMatchObject({ status: 200 });
    expect((await getJob(getDb(), job.id))?.status).toMatch(/^(skipped|cancelled)$/);
    expect((await getDb().one<{ status: string }>(`select status from hubspot_connections where account_id = $1`, [rig.accountId])).status).toBe('revoked');
    expect(sent(rig, 'weekly_report')).toHaveLength(0);
    expect(await reportRow(getDb(), rig.accountId)).toMatchObject({ status: 'pending', metrics: null });
    expect(await reportReservation(getDb(), rig.accountId)).toBeNull();
  });

  it('is skipped, unsent, when the account is paused between the numbers and the email (the predicates)', async () => {
    const job = await scheduleReport(rig);
    const pause = interceptBefore(getDb(), /insert into notifications_sent/, async (handle) => {
      await handle.query(`update accounts set processing_state = 'paused', paused_at = $2 where id = $1`, [rig.accountId, rig.clock.now()]);
    });
    expect(await deliverReport(rig, job, { deps: { ...rig.deps, db: pause.db } })).toMatchObject({ status: 200, outcome: 'skipped' });
    expect(pause.fired()).toBe(1);
    expect(sent(rig)).toHaveLength(0);
    const report = await reportRow(getDb(), rig.accountId);
    expect(report.status).toBe('pending');
    expect(report.metrics).toEqual(planMetrics());
    expect(await reportReservation(getDb(), rig.accountId)).toBeNull();
  });

  it('fails permanently when there is nobody to email', async () => {
    await getDb().query(`update settings set notify_emails_verified = '{}' where account_id = $1`, [rig.accountId]);
    await getDb().query(`update users set email = '' where account_id = $1`, [rig.accountId]);
    const job = await scheduleReport(rig);
    expect(await deliverReport(rig, job)).toMatchObject({ status: 489, code: 'weekly_report_no_recipients' });
    expect(sent(rig)).toHaveLength(0);
    expect((await reportRow(getDb(), rig.accountId)).status).toBe('failed');
  });

  it('is skipped when the connection is no longer active', async () => {
    const job = await scheduleReport(rig);
    await getDb().query(`update hubspot_connections set status = 'revoked' where account_id = $1`, [rig.accountId]);
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'skipped' });
    expect(sent(rig)).toHaveLength(0);
  });

  it('refuses a job whose payload does not match its key', async () => {
    const job = await scheduleReport(rig);
    await getDb().query(`update scheduled_jobs set payload = jsonb_set(payload, '{weekStart}', '"2026-10-05"') where id = $1`, [job.id]);
    expect(await deliverReport(rig, job)).toMatchObject({ status: 489, code: 'weekly_report_payload_invalid' });
    expect(sent(rig)).toHaveLength(0);
  });
});

describe('weekly_report: honesty end to end (D-37)', () => {
  it('says "Not enough data" and "We can\'t confirm your sends …" without the email scope', async () => {
    await getDb().query(`update hubspot_connections set scopes = array_remove(scopes, 'sales-email-read') where account_id = $1`, [rig.accountId]);
    // The owner's sends are in HubSpot, but no logged email can be read: none is confirmed. #6's reply
    // is still confirmed by the contact's last-replied property (D-08's fallback): a count over 0 shows.
    const job = await scheduleReport(rig);
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'done' });
    const report = await reportRow(getDb(), rig.accountId);
    expect(report.metrics).toMatchObject({
      basis: { emailScope: false, sendsLogged: false, repliesLogged: false },
      cohort: { leadsIn: 6, sendsConfirmed: null, medianTimeToFirstReply: { seconds: null, samples: 0 }, waiting: null },
      events: { repliesFromLeads: 1, followUpsDrafted: 7 },
      comparison: { percentWithoutReply: null },
    });
    const text = sent(rig, 'weekly_report')[0]?.text ?? '';
    expect(text).toContain('Your sends confirmed in HubSpot: Not enough data');
    expect(text).toContain("Leads still waiting for your reply (nothing logged in HubSpot): We can't confirm your sends in HubSpot for your account.");
    expect(text).toContain('Replies from leads: 1');
    expect(text).toContain('Baseline: 3 h 30 min · This week: Not enough data');
    expect(text).not.toContain('Lead submitted');
  });

  it('compares with "Not enough logged history" when the baseline could not be measured', async () => {
    await getDb().query(`update baselines set status = 'unavailable', median_seconds_to_first_outbound = null where account_id = $1`, [rig.accountId]);
    const job = await scheduleReport(rig);
    await deliverReport(rig, job);
    expect((await reportRow(getDb(), rig.accountId)).metrics).toMatchObject({ comparison: { baseline: 'not_readable' } });
    expect(sent(rig)[0]?.text).toMatch(/Compared with your baseline\s+Not enough logged history/i);
  });
});

describe('weekly_report: failures, the sweeper', () => {
  it('retries a HubSpot error during the refresh, then sends', async () => {
    const job = await scheduleReport(rig);
    rig.hubspot.injectFailure('getContact', { kind: 'server_error' });
    expect(await deliverReport(rig, job)).toMatchObject({ status: 500, outcome: 'transient' });
    expect(sent(rig)).toHaveLength(0);
    expect(await reportReservation(getDb(), rig.accountId)).toBeNull();
    expect(await deliverReport(rig, job, { retried: 1 })).toMatchObject({ outcome: 'done' });
    expect(sent(rig)).toHaveLength(1);
    expect((await reportRow(getDb(), rig.accountId)).status).toBe('sent');
  });

  it('a HubSpot daily-limit hold re-targets the report past local midnight; it then goes out on Tuesday, once', async () => {
    const job = await scheduleReport(rig);
    rig.hubspot.injectFailure('getContact', { kind: 'daily_limit' });
    expect(await deliverReport(rig, job)).toMatchObject({ status: 200, outcome: 'retargeted' });
    const moved = await getJob(getDb(), job.id);
    // Past Tue 13 Oct 00:00 in New York (04:00 UTC).
    expect(moved?.runAt.getTime()).toBeGreaterThan(new Date('2026-10-13T04:00:00.000Z').getTime());
    expect(sent(rig)).toHaveLength(0);
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'done' });
    const [mail] = sent(rig, 'weekly_report');
    expect(mail?.sentAt.getTime()).toBeGreaterThan(new Date('2026-10-13T04:00:00.000Z').getTime());
    // The same week's numbers: the period does not move with the run.
    expect((await reportRow(getDb(), rig.accountId)).metrics).toEqual(planMetrics());
  });

  it('marks the report failed after the last delivery, and the sweeper re-enqueues it and sends the stored report once', async () => {
    const job = await scheduleReport(rig);
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', times: 1 });
    expect(await deliverReport(rig, job, { retried: 4 })).toMatchObject({ outcome: 'failed' });
    expect(await reportRow(getDb(), rig.accountId)).toMatchObject({ status: 'failed', attempts: 0 });
    expect(await reportReservation(getDb(), rig.accountId)).toEqual({ kind: 'weekly_report', status: 'sending' });
    const stored = (await reportRow(getDb(), rig.accountId)).metrics;

    rig.clock.advance(5 * MINUTE);
    const summary = await sweep();
    expect(summary.weeklyReportsRequeued).toBe(1);
    expect(await reportRow(getDb(), rig.accountId)).toMatchObject({ status: 'pending', attempts: 1 });
    const getContact = vi.spyOn(rig.hubspot, 'getContact');
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'done' });
    // The email in flight is sent as it was computed: no second refresh, the same metrics.
    expect(getContact).not.toHaveBeenCalled();
    expect(await reportRow(getDb(), rig.accountId)).toMatchObject({ status: 'sent', metrics: stored });
    expect(sent(rig)).toHaveLength(1);
  });

  it('one sweep 10+ minutes after the last delivery both re-enqueues the failed report and resumes its email: one email, report sent', async () => {
    const job = await scheduleReport(rig);
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', times: 1 });
    expect(await deliverReport(rig, job, { retried: 4 })).toMatchObject({ outcome: 'failed' });
    expect(await reportRow(getDb(), rig.accountId)).toMatchObject({ status: 'failed' });
    expect(await reportReservation(getDb(), rig.accountId)).toEqual({ kind: 'weekly_report', status: 'sending' });

    rig.clock.advance(11 * MINUTE);
    const summary = await sweep();
    expect(summary.notificationsResumed).toBe(1);
    expect(sent(rig, 'weekly_report')).toHaveLength(1);
    expect((await reportRow(getDb(), rig.accountId)).status).toBe('sent');
    // A re-enqueued job (if the re-enqueue ran first) finds the email sent and sends nothing more.
    const current = await getJob(getDb(), job.id);
    if (current?.status === 'scheduled') expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'done' });
    expect(sent(rig, 'weekly_report')).toHaveLength(1);
    expect((await reportRow(getDb(), rig.accountId)).status).toBe('sent');
  });

  it('lets the sweeper resume a lost send from the stored metrics, rendering the same email', async () => {
    const job = await scheduleReport(rig);
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', times: 1 });
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'transient' });
    const stored = parseWeeklyMetrics((await reportRow(getDb(), rig.accountId)).metrics);
    if (stored === null) throw new Error('no stored metrics');

    rig.clock.advance(11 * MINUTE);
    expect((await sweep()).notificationsResumed).toBe(1);
    expect((await reportRow(getDb(), rig.accountId)).status).toBe('sent');
    const [mail] = sent(rig);
    const expected = await renderEmail(
      createElement(WeeklyReport, weeklyReportProps(stored, { productName: rig.deps.env.PRODUCT_NAME, timezone: 'America/New_York', dashboardUrl: `${rig.deps.env.APP_URL}/dashboard` })),
    );
    expect(mail?.text).toBe(expected.text);
    expect(mail?.replyTo).toBe(OWNER_EMAIL);

    // The job's next delivery finds the email sent.
    expect(await deliverReport(rig, job, { retried: 1 })).toMatchObject({ outcome: 'done' });
    expect(sent(rig)).toHaveLength(1);
  });

  it('fails the report on a permanent send error, and a re-enqueued run never sends it', async () => {
    const job = await scheduleReport(rig);
    rig.fakes.mailer.injectFailure({ kind: 'permanent', code: 'validation_error' });
    expect(await deliverReport(rig, job)).toMatchObject({ status: 489, outcome: 'permanent' });
    expect(await reportRow(getDb(), rig.accountId)).toMatchObject({ status: 'failed' });
    expect(await reportReservation(getDb(), rig.accountId)).toEqual({ kind: 'weekly_report', status: 'failed' });

    rig.clock.advance(5 * MINUTE);
    expect((await sweep()).weeklyReportsRequeued).toBe(1);
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'skipped' });
    expect(await reportRow(getDb(), rig.accountId)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(sent(rig)).toHaveLength(0);
  });

  it('marks the report failed when its email expires unsent (the failure hook)', async () => {
    const job = await scheduleReport(rig);
    rig.fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', times: 1000 });
    expect(await deliverReport(rig, job)).toMatchObject({ outcome: 'transient' });
    // The job gives up quietly (another worker's lease, say); the reservation stays `sending` until it expires.
    await getDb().query(`update scheduled_jobs set status = 'done' where id = $1`, [job.id]);
    rig.clock.advance(23 * HOUR + MINUTE);
    expect((await sweep()).notificationsExpired).toBe(1);
    expect(await reportRow(getDb(), rig.accountId)).toMatchObject({ status: 'failed' });
    expect(sent(rig)).toHaveLength(0);
  });

  it('is not re-enqueued from local Tuesday 00:00', async () => {
    const job = await scheduleReport(rig);
    rig.fakes.mailer.injectFailure({ kind: 'permanent', code: 'validation_error' });
    await deliverReport(rig, job);
    rig.clock.set(new Date('2026-10-13T04:00:00.000Z'));
    expect((await sweep()).weeklyReportsRequeued).toBe(0);
    expect((await getJob(getDb(), job.id))?.status).toBe('failed');
  });
});
