import type { Db } from '@/server/db';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth/owner-scope';
import { seedNewLead } from '../leads/support';

// Test support for the dashboard (PLAN §7.5): small row writers on top of the leads and
// owner-controls support (an owned active account in New York, leads in each state).

export { createLeadsRig, LEAD_EMAIL, LEAD_MESSAGE, PORTAL_ID, ZONE, type LeadsRig } from '../leads/support';
export { markFollowUpSent, markRepliedLikeTheJob, seedFilteredLead, seedNotifiedLead, seedOtherAccount, seedOwnedAccount, type OwnedAccount } from '../owner-controls/support';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function at(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

/** A lead with its content, in `state`, received at `receivedAt`; extra columns set as given. */
export async function seedLeadIn(
  db: Db,
  input: { accountId: string; receivedAt: Date; state?: string | undefined; set?: Record<string, unknown> | undefined; firstName?: string | null | undefined; contactId?: string | undefined; isTest?: boolean | undefined },
): Promise<string> {
  const leadId = await seedNewLead(db, { accountId: input.accountId, now: input.receivedAt, firstName: input.firstName, contactId: input.contactId, isTest: input.isTest });
  const set: Record<string, unknown> = { processing_state: input.state ?? 'new', ...input.set };
  const columns = Object.keys(set);
  if (columns.some((column) => !/^[a-z0-9_]+$/.test(column))) throw new Error('bad column');
  await db.query(`update leads set ${columns.map((column, index) => `${column} = $${index + 2}`).join(', ')} where id = $1`, [leadId, ...columns.map((c) => set[c])]);
  return leadId;
}

/** The lead's content purged as retention does (PLAN §9.10 steps 1-3). */
export async function purgeContent(db: Db, leadId: string, now: Date): Promise<void> {
  await db.query(`delete from lead_messages where lead_id = $1`, [leadId]);
  await db.query(`update drafts set subject = null, body = null, flags = '{}', purged_at = $2 where lead_id = $1`, [leadId, now]);
  await db.query(`update leads set submission_key = null where id = $1`, [leadId]);
}

/** A checked draft row (kind initial/fu1/fu2) for the lead. */
export async function seedDraft(
  db: Db,
  input: { accountId: string; leadId: string; kind?: 'initial' | 'fu1' | 'fu2' | undefined; subject?: string | undefined; body?: string | undefined; needsTouch?: boolean | undefined; purgeAt: Date },
): Promise<void> {
  await db.query(
    `insert into drafts (lead_id, account_id, kind, subject, body, validation_ok, needs_touch, purge_at) values ($1, $2, $3, $4, $5, true, $6, $7)`,
    [input.leadId, input.accountId, input.kind ?? 'initial', input.subject ?? 'Your leaking sink', input.body ?? 'Hi Maya,\n\nThanks for getting in touch.\n\nDana', input.needsTouch ?? false, input.purgeAt],
  );
}

/** A second scope on the same account (another session of the owner is not possible, but tests use it for clarity). */
export function scopeFor(accountId: string, userId: string): OwnerScope {
  return createOwnerScopeForTest(accountId, userId);
}

/** Everything a cross-tenant call could change for `accountId`, as one comparable snapshot. */
export async function accountSnapshot(db: Db, accountId: string): Promise<unknown> {
  const tables = {
    accounts: `select * from accounts where id = $1`,
    leads: `select * from leads where account_id = $1 order by id`,
    lead_messages: `select * from lead_messages where account_id = $1 order by lead_id`,
    drafts: `select * from drafts where account_id = $1 order by id`,
    scheduled_jobs: `select * from scheduled_jobs where account_id = $1 order by id`,
    notifications_sent: `select * from notifications_sent where account_id = $1 order by id`,
    audit_log: `select id, actor, action, meta from audit_log where account_id = $1 order by id`,
    settings: `select * from settings where account_id = $1`,
    selected_forms: `select * from selected_forms where account_id = $1 order by form_id`,
    briefs: `select * from briefs where account_id = $1`,
    brief_versions: `select * from brief_versions where account_id = $1 order by version`,
    brief_jobs: `select * from brief_jobs where account_id = $1 order by id`,
    inbox_checks: `select * from inbox_checks where account_id = $1 order by id`,
    hubspot_connections: `select * from hubspot_connections where account_id = $1`,
    users: `select * from users where account_id = $1 order by id`,
    weekly_reports: `select * from weekly_reports where account_id = $1 order by id`,
    subscriptions: `select * from subscriptions where account_id = $1 order by id`,
    baselines: `select * from baselines where account_id = $1 order by id`,
    action_tokens: `select * from action_tokens where account_id = $1 order by id`,
    ai_calls: `select * from ai_calls where account_id = $1 order by id`,
    login_intents: `select * from login_intents where account_id = $1 order by token_hash_sha256`,
  } as const;
  const out: Record<string, unknown> = {};
  for (const [name, sql] of Object.entries(tables)) out[name] = await db.query(sql, [accountId]);
  return out;
}
