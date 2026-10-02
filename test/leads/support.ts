import type { Db } from '@/server/db';
import type { LoggingMode } from '@/server/domain/types';
import { runJob } from '@/server/jobs/dispatcher';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import { createJobRegistry, type JobRegistry } from '@/server/jobs/registry';
import { getJob } from '@/server/jobs/rows';
import { createJobTestRig, TEST_START, type JobTestRig, type JobTestRigOptions } from '@/server/jobs/testing';
import type { JobRow } from '@/server/jobs/types';
import type { Deps } from '@/server/ports';
import { seedOwner } from '@/server/services/accounts/testing';
import { registerDraftingNotifications } from '@/server/services/drafting/cap';
import { seedDraftingAccount } from '@/server/services/drafting/testing';
import { leadProcessDedupeKey, registerLeadProcessJob } from '@/server/services/leads/process';
import { createNotificationRegistry, type NotificationRegistry } from '@/server/services/notifications/renderers';

// Test support for the lead email tests: a job rig whose registries hold lead_process, its failure
// path and every lead-email resumer; an active account with a bound owner, a saved brief and a
// selected form; a new lead with its content, as intake stores it.

export const ZONE = 'America/New_York';
/** settings.notify_emails_verified from seedSettings. */
export const NOTIFY_EMAIL = 'owner@example.com';
/** The owner's sign-in address (users.email): the Reply-To of every lead email (D-27). */
export const OWNER_EMAIL = 'dana@brightside-plumbing.example';
export const PORTAL_ID = '24681357';
export const LEAD_EMAIL = 'maya@okafor-bakery.example';
export const LEAD_MESSAGE = 'Hi, our kitchen sink has been leaking since Monday. Photos are at https://okafor-bakery.example/sink. Could someone come this week?';

export interface LeadsRig extends JobTestRig {
  readonly registry: JobRegistry;
  readonly notifications: NotificationRegistry;
}

export function createLeadsRig(db: Db, options: JobTestRigOptions = {}): LeadsRig {
  const registry = createJobRegistry();
  const notifications = createNotificationRegistry();
  registerLeadProcessJob({ jobs: registry, notifications });
  registerDraftingNotifications({ notifications });
  return { ...createJobTestRig(db, registry, { start: TEST_START, ...options }), registry, notifications };
}

export interface SeedLeadAccountInput {
  now: Date;
  followupsEnabled?: boolean | undefined;
  loggingMode?: LoggingMode | undefined;
  mailClient?: 'gmail' | 'other' | undefined;
}

/** An active account (New York) with a bound owner, a saved brief (booking link confirmed) and the form `form-1`. */
export async function seedLeadAccount(db: Db, input: SeedLeadAccountInput): Promise<string> {
  const accountId = await seedDraftingAccount(db, { now: input.now, timezone: ZONE });
  await seedOwner(db, accountId, OWNER_EMAIL);
  await db.query(`update accounts set hubspot_portal_id = $2, logging_mode = $3 where id = $1`, [accountId, PORTAL_ID, input.loggingMode ?? 'log_all']);
  await db.query(`update hubspot_connections set ui_domain = 'app.hubspot.com' where account_id = $1`, [accountId]);
  await db.query(`update settings set followups_enabled = $2, mail_client = $3 where account_id = $1`, [
    accountId,
    input.followupsEnabled ?? true,
    input.mailClient ?? 'other',
  ]);
  return accountId;
}

export interface SeedNewLeadInput {
  accountId: string;
  now: Date;
  message?: string | null | undefined;
  firstName?: string | null | undefined;
  isTest?: boolean | undefined;
  contactId?: string | undefined;
}

let nextContactId = 100_001;

/** A lead as intake stores it: `new`, with its content (purge_at = +30 d). */
export async function seedNewLead(db: Db, input: SeedNewLeadInput): Promise<string> {
  const isTest = input.isTest ?? false;
  const lead = await db.one<{ id: string }>(
    `insert into leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, is_test, received_at, stop_reason)
     values ($1, $2, $3, $4, $5, $6, $4, $7) returning id`,
    [
      input.accountId,
      isTest ? null : (input.contactId ?? String(nextContactId++)),
      isTest ? null : 'form-1',
      input.now,
      isTest ? 'inbox_check' : 'webhook',
      isTest,
      isTest ? 'test_lead' : null,
    ],
  );
  await db.query(
    `insert into lead_messages (lead_id, account_id, message, first_name, last_name, company, email, purge_at)
     values ($1, $2, $3, $4, 'Okafor', 'Okafor Bakery', $5, $6)`,
    [
      lead.id,
      input.accountId,
      input.message === undefined ? LEAD_MESSAGE : input.message,
      input.firstName === undefined ? 'Maya' : input.firstName,
      LEAD_EMAIL,
      new Date(input.now.getTime() + 30 * 86_400_000),
    ],
  );
  return lead.id;
}

/** Inserts and publishes the lead's lead_process job, as intake does. */
export async function scheduleLeadProcess(rig: LeadsRig, input: { accountId: string; leadId: string; rev?: number | undefined }): Promise<JobRow> {
  const db = rig.deps.db;
  const now = rig.clock.now();
  const rev = input.rev ?? 0;
  const job = await db.tx((tx) =>
    insertJob(tx, { kind: 'lead_process', accountId: input.accountId, leadId: input.leadId, dedupeKey: leadProcessDedupeKey(input.leadId, rev), runAt: now, now }),
  );
  if (job === null) throw new Error('job not inserted');
  await publishJobs(rig.deps, [job]);
  const published = await getJob(db, job.id);
  if (published === null) throw new Error('job vanished');
  return published;
}

/** One QStash delivery of `job` (`retried` = Upstash-Retried; 4 is the final delivery). */
export async function deliver(rig: LeadsRig, job: JobRow, options: { retried?: number | undefined; deps?: Deps | undefined } = {}) {
  const current = await getJob(rig.deps.db, job.id);
  return runJob(options.deps ?? rig.deps, { jobId: job.id, messageId: current?.externalId ?? job.externalId, retried: options.retried ?? 0 }, rig.registry);
}

export interface LeadRow {
  processing_state: string;
  needs_touch: boolean;
  first_notified_at: Date | null;
  stop_reason: string | null;
  dismissed_at: Date | null;
}

export async function leadRow(db: Db, leadId: string): Promise<LeadRow> {
  return db.one<LeadRow>(`select processing_state, needs_touch, first_notified_at, stop_reason, dismissed_at from leads where id = $1`, [leadId]);
}

export interface FollowUpJobRow {
  dedupe_key: string;
  seq: number;
  run_at: Date;
  payload: Record<string, unknown>;
  status: string;
}

export async function followUpJobs(db: Db, leadId: string): Promise<FollowUpJobRow[]> {
  return db.query<FollowUpJobRow>(`select dedupe_key, seq, run_at, payload, status from scheduled_jobs where lead_id = $1 and kind = 'followup' order by seq`, [
    leadId,
  ]);
}

export interface NotificationRowLite {
  dedupe_key: string;
  kind: string;
  status: string;
}

export async function notifications(db: Db, leadId: string): Promise<NotificationRowLite[]> {
  return db.query<NotificationRowLite>(`select dedupe_key, kind, status from notifications_sent where lead_id = $1 order by id`, [leadId]);
}

/** The action-link URLs in an email's HTML, in order. */
export function actionLinks(html: string): string[] {
  return [...html.matchAll(/href="([^"]*\/a\/[^"]+)"/g)].map((match) => (match[1] ?? '').replaceAll('&amp;', '&'));
}

/** The token of `/a/{token}/{action}` in `url`. */
export function tokenOf(url: string, action: 'send' | 'edit' | 'dismiss'): string {
  const match = new RegExp(`/a/([^/]+)/${action}(?:\\?|$)`).exec(url);
  if (match?.[1] === undefined) throw new Error(`no ${action} link`);
  return decodeURIComponent(match[1]);
}
