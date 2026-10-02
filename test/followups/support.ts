import { expect } from 'vitest';
import type { FakeSentMail } from '@/server/adapters/fake/mailer/fake-mailer';
import type { Db } from '@/server/db';
import { runJob, type RunJobResult } from '@/server/jobs/dispatcher';
import { publishJobs } from '@/server/jobs/outbox';
import { getJob } from '@/server/jobs/rows';
import type { JobRow } from '@/server/jobs/types';
import type { Deps } from '@/server/ports';
import { seedBrief } from '@/server/services/drafting/testing';
import { registerFollowUpJob } from '@/server/services/followups/job';
import { followUpDedupeKey, scheduleFollowUpsInTx } from '@/server/services/followups/schedule';
import { createSignalsRig, seedNotifiedLead as seedSignalsLead, type SignalsRig } from '../signals/support';

// Shared set-up for the follow-up job tests (PGlite + every fake, PLAN §9.5, §12): the signals rig
// (an active New York account installed on the fake HubSpot portal with real encrypted tokens, a
// bound owner, settings with owner@example.com verified, logging_mode log_all) plus a saved brief
// and the form `form-1`, with the `followup` handler and its failure path registered next to
// lead_process and every lead-email resumer. A notified lead has its first email's draft stored and
// the two follow-up jobs of the "notified" transaction (real shifted targets), published.

export { DAY, HOUR, MINUTE, SECOND, at, LEAD_EMAIL, OWNER_EMAIL } from '../signals/support';
export type { SignalsRig };

export const NOTIFY_EMAIL = 'owner@example.com';
export const INITIAL_SUBJECT = 'Your leaking kitchen sink';
export const INITIAL_BODY = 'Hi Maya,\n\nThanks for getting in touch about the sink. We can come and look at it this week.\n\nThanks,\nDana Whitfield';

export type FollowUpRig = SignalsRig;

export async function createFollowUpRig(db: Db): Promise<FollowUpRig> {
  const rig = await createSignalsRig(db);
  registerFollowUpJob({ jobs: rig.registry, notifications: rig.notifications, limiterSleep: rig.sleep });
  await seedBrief(db, rig.accountId);
  await db.query(
    `insert into selected_forms (account_id, form_id, form_name, form_type, intake_floor_at, cursor_submitted_at) values ($1, 'form-1', 'Contact us', 'hubspot', $2, $2)`,
    [rig.accountId, rig.clock.now()],
  );
  return rig;
}

export interface SeedLeadOptions {
  readonly contactId?: string | undefined;
  readonly email?: string | undefined;
  readonly firstName?: string | undefined;
  readonly submittedAt?: Date | undefined;
  /** Default true: the two follow-up jobs of the "notified" transaction. */
  readonly followUps?: boolean | undefined;
}

export interface FollowUpLeadSeed {
  readonly leadId: string;
  readonly contactId: string;
  readonly t0: Date;
  /** fu1, fu2 (when scheduled). */
  readonly jobs: readonly JobRow[];
}

/** A lead whose first email went out now (T0): notified, its initial draft stored, its follow-ups scheduled. */
export async function seedFollowUpLead(rig: FollowUpRig, options: SeedLeadOptions = {}): Promise<FollowUpLeadSeed> {
  const db = rig.deps.db;
  const t0 = rig.clock.now();
  const seeded = await seedSignalsLead(rig, {
    contactId: options.contactId,
    email: options.email,
    firstName: options.firstName,
    submittedAt: options.submittedAt,
    firstNotifiedAt: t0,
    followUps: false,
  });
  await db.query(
    `insert into drafts (lead_id, account_id, kind, subject, body, validation_ok, attempts, model, purge_at)
     select $1, $2, 'initial', $3, $4, true, 1, 'claude-sonnet-5-5', purge_at from lead_messages where lead_id = $1`,
    [seeded.leadId, rig.accountId, INITIAL_SUBJECT, INITIAL_BODY],
  );
  const jobs: JobRow[] = [];
  if (options.followUps ?? true) {
    const result = await db.tx((tx) => scheduleFollowUpsInTx(tx, { accountId: rig.accountId, leadId: seeded.leadId, firstNotifiedAt: t0, now: t0 }));
    if (result.type !== 'scheduled') throw new Error(`follow-ups not scheduled: ${result.type}`);
    await publishJobs(rig.deps, result.jobs);
    for (const job of result.jobs) {
      if (job === null) throw new Error('follow-up job not inserted');
      jobs.push(await jobById(db, job.id));
    }
  }
  return { leadId: seeded.leadId, contactId: seeded.contactId, t0, jobs };
}

export async function jobById(db: Db, id: string): Promise<JobRow> {
  const job = await getJob(db, id);
  if (job === null) throw new Error('job vanished');
  return job;
}

/** The job of follow-up n in `stream`. */
export async function followUpJob(db: Db, leadId: string, n: 1 | 2, stream = 0): Promise<JobRow> {
  const row = await db.one<{ id: string }>(`select id from scheduled_jobs where dedupe_key = $1`, [followUpDedupeKey(leadId, n, stream)]);
  return jobById(db, row.id);
}

/** The job's target (`payload.targetAt`, else `run_at`). */
export function targetOf(job: JobRow): Date {
  const value = job.payload.targetAt;
  return typeof value === 'string' ? new Date(value) : job.runAt;
}

/** One QStash delivery of the job's current message (`retried` = Upstash-Retried; 4 is the final one). */
export async function deliver(rig: FollowUpRig, job: Pick<JobRow, 'id'>, options: { retried?: number | undefined; deps?: Deps | undefined } = {}): Promise<RunJobResult> {
  const current = await getJob(rig.deps.db, job.id);
  return runJob(options.deps ?? rig.deps, { jobId: job.id, messageId: current?.externalId ?? null, retried: options.retried ?? 0 }, rig.registry);
}

/** Moves the clock to the job's target and delivers it. */
export async function deliverWhenDue(rig: FollowUpRig, job: Pick<JobRow, 'id'>, options: { retried?: number | undefined; deps?: Deps | undefined } = {}): Promise<RunJobResult> {
  const current = await jobById(rig.deps.db, job.id);
  const target = targetOf(current);
  if (target.getTime() > rig.clock.now().getTime()) rig.clock.set(target);
  return deliver(rig, job, options);
}

export function sent(rig: FollowUpRig, kind?: string): FakeSentMail[] {
  return rig.fakes.mailer.sent.filter((mail) => kind === undefined || mail.kind === kind);
}

export function onlyEmail(rig: FollowUpRig, kind: string): FakeSentMail {
  const all = sent(rig);
  expect(all.map((mail) => mail.kind)).toEqual([kind]);
  const [mail] = all;
  if (mail === undefined) throw new Error('no email');
  return mail;
}

export interface FollowUpLeadRow {
  stop_reason: string | null;
  replied_at: Date | null;
  dismissed_at: Date | null;
  fu1_notified_at: Date | null;
  fu2_notified_at: Date | null;
  followup_stream: number;
  send_confirmed_at: Date | null;
}

export async function leadRow(db: Db, leadId: string): Promise<FollowUpLeadRow> {
  return db.one<FollowUpLeadRow>(
    `select stop_reason, replied_at, dismissed_at, fu1_notified_at, fu2_notified_at, followup_stream, send_confirmed_at from leads where id = $1`,
    [leadId],
  );
}

export interface JobLite {
  dedupe_key: string;
  status: string;
  cancel_reason: string | null;
}

export async function followUpJobs(db: Db, leadId: string): Promise<JobLite[]> {
  return db.query<JobLite>(`select dedupe_key, status, cancel_reason from scheduled_jobs where lead_id = $1 and kind = 'followup' order by created_at, seq`, [leadId]);
}

export async function notifications(db: Db, leadId: string): Promise<{ dedupe_key: string; kind: string; status: string }[]> {
  return db.query(`select dedupe_key, kind, status from notifications_sent where lead_id = $1 order by first_reserved_at, dedupe_key`, [leadId]);
}

export async function auditActions(db: Db, accountId: string): Promise<{ action: string; meta: Record<string, unknown> }[]> {
  return db.query(`select action, meta from audit_log where account_id = $1 order by id`, [accountId]);
}

