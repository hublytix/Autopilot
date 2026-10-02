import type { Db } from '@/server/db';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import { getJob } from '@/server/jobs/rows';
import type { JobRow } from '@/server/jobs/types';
import { seedOwner } from '@/server/services/accounts/testing';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth/owner-scope';
import { seedDraftingAccount } from '@/server/services/drafting/testing';
import { followUpDedupeKey, scheduleFollowUpsInTx } from '@/server/services/followups/schedule';
import { bindPredicate, type NotificationPredicate } from '@/server/services/notifications/predicates';
import { createLeadsRig, seedLeadAccount, seedNewLead, type LeadsRig } from '../leads/support';

// Test support for the owner controls (PLAN §9.6, D-42): the lead-email rig (lead_process and every
// lead-email resumer registered), an owned active account (New York), its owner scope, and leads in
// the states the controls act on: filtered, notified with both follow-up rows, replied.

export { createLeadsRig, type LeadsRig };

export interface OwnedAccount {
  readonly accountId: string;
  readonly scope: OwnerScope;
}

/** An active account (New York) with a bound owner, a brief and the form `form-1`; one per test (the owner's email is fixed). */
export async function seedOwnedAccount(db: Db, input: { now: Date; followupsEnabled?: boolean | undefined }): Promise<OwnedAccount> {
  const accountId = await seedLeadAccount(db, { now: input.now, followupsEnabled: input.followupsEnabled });
  const owner = await db.one<{ owner_user_id: string }>(`select owner_user_id from accounts where id = $1`, [accountId]);
  return { accountId, scope: createOwnerScopeForTest(accountId, owner.owner_user_id) };
}

/** Another active account (with its own owner) in the same database: cross-tenant checks. */
export async function seedOtherAccount(db: Db, now: Date): Promise<OwnedAccount> {
  const accountId = await seedDraftingAccount(db, { now, timezone: 'America/New_York' });
  const userId = await seedOwner(db, accountId, 'someone.else@other-business.example');
  return { accountId, scope: createOwnerScopeForTest(accountId, userId) };
}

/** A lead lead_process filed as `filtered` (class spam), with its content. */
export async function seedFilteredLead(db: Db, input: { accountId: string; now: Date; contactId?: string | undefined }): Promise<string> {
  const leadId = await seedNewLead(db, { accountId: input.accountId, now: input.now, contactId: input.contactId });
  await db.query(`update leads set classification = 'spam', classified_at = $2, processing_state = 'filtered' where id = $1`, [leadId, input.now]);
  return leadId;
}

export interface NotifiedLead {
  readonly leadId: string;
  readonly jobs: readonly JobRow[];
}

/**
 * A lead whose first email went out at `firstNotifiedAt` (T0): `notified`, with the two follow-up
 * rows the "notified" transaction writes, published.
 */
export async function seedNotifiedLead(
  rig: LeadsRig,
  input: { accountId: string; firstNotifiedAt: Date; contactId?: string | undefined; submittedAt?: Date | undefined },
): Promise<NotifiedLead> {
  const db = rig.deps.db;
  const leadId = await seedNewLead(db, { accountId: input.accountId, now: input.submittedAt ?? input.firstNotifiedAt, contactId: input.contactId });
  await db.query(`update leads set classification = 'lead', classified_at = $2, processing_state = 'notified', first_notified_at = $2 where id = $1`, [
    leadId,
    input.firstNotifiedAt,
  ]);
  const result = await db.tx((tx) => scheduleFollowUpsInTx(tx, { accountId: input.accountId, leadId, firstNotifiedAt: input.firstNotifiedAt, now: rig.clock.now() }));
  if (result.type !== 'scheduled') throw new Error(`follow-ups not scheduled: ${result.type}`);
  await publishJobs(rig.deps, result.jobs);
  const jobs: JobRow[] = [];
  for (const job of result.jobs) {
    if (job === null) throw new Error('follow-up job not inserted');
    const published = await getJob(db, job.id);
    if (published === null) throw new Error('follow-up job vanished');
    jobs.push(published);
  }
  return { leadId, jobs };
}

/** Follow-up n of stream 0 went out at `at` (its job done, `fu{n}_notified_at` set). */
export async function markFollowUpSent(db: Db, leadId: string, n: 1 | 2, at: Date): Promise<void> {
  await db.query(`update leads set ${n === 1 ? 'fu1_notified_at' : 'fu2_notified_at'} = $2 where id = $1`, [leadId, at]);
  await db.query(`update scheduled_jobs set status = 'done', finished_at = $2 where dedupe_key = $1`, [followUpDedupeKey(leadId, n, 0), at]);
}

/** What markReplied leaves (D-08): `replied_at` (HubSpot's time), `stop_reason = 'replied'`, the remaining follow-up jobs cancelled. */
export async function markRepliedLikeTheJob(db: Db, leadId: string, repliedAt: Date, at: Date): Promise<void> {
  await db.query(`update leads set replied_at = $2, stop_reason = coalesce(stop_reason, 'replied') where id = $1`, [leadId, repliedAt]);
  await db.query(
    `update scheduled_jobs set status = 'cancelled', cancel_reason = 'replied', finished_at = $2
      where lead_id = $1 and kind = 'followup' and status in ('scheduled', 'running')`,
    [leadId, at],
  );
}

/** A `privacy_delete` job for the lead's account (never cancelled by a lead or account cancel, D-06). */
export async function insertPrivacyJob(rig: LeadsRig, input: { accountId: string; leadId: string }): Promise<JobRow> {
  const now = rig.clock.now();
  const job = await rig.deps.db.tx((tx) =>
    insertJob(tx, {
      kind: 'privacy_delete',
      accountId: input.accountId,
      leadId: input.leadId,
      dedupeKey: `privacy:24681357:1001:${now.getTime()}`,
      payload: { contactId: '1001' },
      runAt: now,
      now,
    }),
  );
  if (job === null) throw new Error('privacy job not inserted');
  await publishJobs(rig.deps, [job]);
  return job;
}

export interface JobLite {
  dedupe_key: string;
  kind: string;
  status: string;
  cancel_reason: string | null;
  external_id: string | null;
  run_at: Date;
  payload: Record<string, unknown>;
}

export async function leadJobs(db: Db, leadId: string): Promise<JobLite[]> {
  return db.query<JobLite>(
    `select dedupe_key, kind, status, cancel_reason, external_id, run_at, payload from scheduled_jobs where lead_id = $1 order by kind, seq, created_at, dedupe_key`,
    [leadId],
  );
}

/** Whether a notification predicate holds now (the reservation's WHERE, without reserving). */
export async function predicateHolds(db: Db, predicate: NotificationPredicate): Promise<boolean> {
  const params: unknown[] = [];
  const sql = bindPredicate(predicate, params);
  const row = await db.one<{ ok: boolean }>(`select (${sql}) as ok`, params);
  return row.ok;
}

export interface AuditRow {
  actor: string;
  action: string;
  meta: Record<string, unknown>;
}

export async function auditRows(db: Db, accountId: string): Promise<AuditRow[]> {
  return db.query<AuditRow>(`select actor, action, meta from audit_log where account_id = $1 order by id`, [accountId]);
}
