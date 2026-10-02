import type { FakeSentMail } from '@/server/adapters/fake/mailer/fake-mailer';
import type { Db } from '@/server/db';
import type { Classification } from '@/server/domain/types';
import { runJob, type RunJobResult } from '@/server/jobs/dispatcher';
import { getJob } from '@/server/jobs/rows';
import type { JobRow } from '@/server/jobs/types';
import type { Deps } from '@/server/ports';
import { insertBaseline } from '@/server/services/baseline/repository';
import { registerWeeklyReportJob } from '@/server/services/reports/job';
import { scheduleWeeklyReports } from '@/server/services/reports/schedule';
import { createSignalsRig, DAY, HOUR, MINUTE, seedNotifiedLead, type SignalsRig } from '../signals/support';

// Shared set-up for the Monday report tests (PGlite + every fake, PLAN §9.8, §13): the signals rig
// (an active America/New_York account installed on the fake HubSpot portal, whose installer mailbox
// logs everything; a bound owner; owner@example.com verified; logging_mode log_all) with the
// weekly_report job, its failure path, resumer and failure hook registered next to lead_process.
// `seedSimulationWeek` builds the PLAN §13 week: leads in the database as the earlier jobs left
// them, and the owner's sends and #6's reply logged in HubSpot only, so the report's refresh is
// what finds them.

export { DAY, HOUR, MINUTE };
export const NOTIFY_EMAIL = 'owner@example.com';
export const WEEK_START = '2026-10-12';
/** Mon 2026-10-12 08:00 America/New_York: the report's period end and the due-check's first hit. */
export const MONDAY_8AM = new Date('2026-10-12T12:00:00.000Z');
export const PERIOD_START = new Date('2026-10-05T12:00:00.000Z');

export type ReportRig = SignalsRig;

export async function createReportRig(db: Db): Promise<ReportRig> {
  const rig = await createSignalsRig(db);
  registerWeeklyReportJob({ jobs: rig.registry, notifications: rig.notifications, limiterSleep: rig.sleep });
  return rig;
}

/** America/New_York (EDT, UTC−4) local time on October `day`, 2026. */
export function local(day: number, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, (h ?? 0) + 4, m ?? 0));
}

export async function seedBaseline(db: Db, accountId: string, now: Date): Promise<void> {
  await insertBaseline(db, {
    accountId,
    status: 'ok',
    submissionsRead: 5,
    leadsCounted: 5,
    medianSecondsToFirstOutbound: 3.5 * 3600,
    withoutOutboundCount: 1,
    percentAvailable: true,
    now,
    notBefore: now,
  });
}

/** A lead the classifier filtered: never emailed to the owner. */
export async function seedFilteredLead(rig: ReportRig, input: { email: string; submittedAt: Date; classification: Classification }): Promise<string> {
  const contactId = rig.hubspot.createContact({ email: input.email, firstName: 'Filtered', at: input.submittedAt });
  const row = await rig.deps.db.one<{ id: string }>(
    `insert into leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, is_test, received_at,
                        classification, classified_at, processing_state)
     values ($1, $2, 'form-1', $3, 'webhook', false, $3, $4, $3, 'filtered') returning id`,
    [rig.accountId, contactId, input.submittedAt, input.classification],
  );
  return row.id;
}

export interface SimulationWeek {
  readonly ids: Readonly<Record<'#1' | '#2' | '#3' | '#4' | '#5' | '#6' | 'test', string>>;
  readonly contacts: Readonly<Record<'#2', string>>;
}

/**
 * PLAN §13: Day 0 Tue 10-06 submissions #1 #2 #3 (spam) #4 (vendor pitch) #6 and #5 (10:31, cron),
 * the owner's taps and logged sends, Day 1 #5's send, Day 2 fu1 ×4, Day 3 #6's reply (Fri 14:00),
 * Day 5 fu2 ×3; the onboarding test lead. The database holds no send or reply yet.
 */
export async function seedSimulationWeek(rig: ReportRig): Promise<SimulationWeek> {
  const db = rig.deps.db;
  const notified = async (name: string, email: string, submitted: Date, emailed: Date) =>
    seedNotifiedLead(rig, { email, firstName: name, submittedAt: submitted, firstNotifiedAt: emailed, followUps: false });

  const one = await notified('Ana', 'ana@example.org', local(6, '10:00'), local(6, '10:01'));
  const two = await notified('Ben', 'ben@example.org', local(6, '10:05'), local(6, '10:06'));
  const three = await seedFilteredLead(rig, { email: 'spam@example.net', submittedAt: local(6, '10:10'), classification: 'spam' });
  const four = await seedFilteredLead(rig, { email: 'vendor@example.net', submittedAt: local(6, '10:15'), classification: 'vendor_pitch' });
  const six = await notified('Fay', 'fay@example.org', local(6, '10:20'), local(6, '10:21'));
  const five = await notified('Eli', 'eli@example.org', local(6, '10:31'), local(6, '10:36'));
  const test = await seedNotifiedLead(rig, { isTest: true, email: 'test+abc@example.com', submittedAt: local(6, '09:03'), firstNotifiedAt: local(6, '09:03'), followUps: false });
  await db.query(`update leads set intake_trigger = 'cron' where id = $1`, [five.leadId]);

  // The owner's taps (our own records) and the follow-up emails (Thu fu1 ×4, Sun fu2 ×3).
  for (const [lead, tap] of [
    [one, local(6, '10:12')],
    [two, local(6, '10:30')],
    [six, local(6, '10:40')],
  ] as const) {
    await db.query(`update leads set first_send_clicked_at = $2 where id = $1`, [lead.leadId, tap]);
  }
  for (const lead of [one, two, six, five]) {
    await db.query(`update leads set fu1_notified_at = first_notified_at + interval '2 days' where id = $1`, [lead.leadId]);
  }
  for (const lead of [one, two, five]) {
    await db.query(`update leads set fu2_notified_at = first_notified_at + interval '5 days' where id = $1`, [lead.leadId]);
  }

  // What HubSpot logged: #1 at 10:13, #6 at 10:41, #5 on Wed at 10:01; #6's reply on Fri at 14:00.
  rig.hubspot.logOwnerSend({ to: 'ana@example.org', at: local(6, '10:13') });
  rig.hubspot.logOwnerSend({ to: 'fay@example.org', at: local(6, '10:41') });
  rig.hubspot.logOwnerSend({ to: 'eli@example.org', at: local(7, '10:01') });
  rig.hubspot.logLeadReply({ from: 'fay@example.org', at: local(9, '14:00') });

  return {
    ids: { '#1': one.leadId, '#2': two.leadId, '#3': three, '#4': four, '#5': five.leadId, '#6': six.leadId, test: test.leadId },
    contacts: { '#2': two.contactId },
  };
}

/** Runs the hourly due-check at `at` (default Monday 08:00 local) and returns the report's job. */
export async function scheduleReport(rig: ReportRig, at: Date = MONDAY_8AM): Promise<JobRow> {
  rig.clock.set(at);
  await scheduleWeeklyReports(rig.deps);
  const row = await rig.deps.db.one<{ id: string }>(`select id from scheduled_jobs where kind = 'weekly_report' and account_id = $1`, [rig.accountId]);
  const job = await getJob(rig.deps.db, row.id);
  if (job === null) throw new Error('no report job');
  return job;
}

/** One QStash delivery of the report job's current message, at its target (`retried` 4 is the final one). */
export async function deliverReport(rig: ReportRig, job: Pick<JobRow, 'id'>, options: { retried?: number | undefined; deps?: Deps | undefined } = {}): Promise<RunJobResult> {
  const current = await getJob(rig.deps.db, job.id);
  if (current === null) throw new Error('job vanished');
  if (current.runAt.getTime() > rig.clock.now().getTime()) rig.clock.set(current.runAt);
  return runJob(options.deps ?? rig.deps, { jobId: job.id, messageId: current.externalId, retried: options.retried ?? 0 }, rig.registry);
}

export interface ReportRowLite {
  id: string;
  status: string;
  attempts: number;
  metrics: Record<string, unknown> | null;
}

export async function reportRow(db: Db, accountId: string, weekStart = WEEK_START): Promise<ReportRowLite> {
  return db.one<ReportRowLite>(`select id, status, attempts, metrics from weekly_reports where account_id = $1 and week_start = $2::date`, [accountId, weekStart]);
}

export function sent(rig: ReportRig, kind?: string): FakeSentMail[] {
  return rig.fakes.mailer.sent.filter((mail) => kind === undefined || mail.kind === kind);
}

export async function reportReservation(db: Db, accountId: string, weekStart = WEEK_START): Promise<{ kind: string; status: string } | null> {
  return db.maybeOne(`select kind, status from notifications_sent where dedupe_key = $1`, [`report:${accountId}:${weekStart}`]);
}
