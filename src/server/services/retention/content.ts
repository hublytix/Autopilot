import 'server-only';
import type { Db } from '@/server/db';
import type { Deps } from '@/server/ports';
import { INBOX_CHECK_ABANDON_MS, runInboxCheckRetention } from '@/server/services/inbox-check';

// The content steps of retention (PLAN §9.10 steps 1-4, D-31, D-49). Every statement binds `$now`
// from the Clock. Content is gone once its `purge_at` is reached: the views already hide it from
// that instant (D-77), so these statements use `purge_at <= $now` (a superset of PLAN's `<`).
//
// 1-3 run as ONE statement, so a lead's message, its drafts and its submission key go together:
//   1. `delete from lead_messages where purge_at <= $now` (30 d; test leads 24 h, D-49);
//   2. drafts: subject and body null, flags '{}', `purged_at = $now`, for drafts past their own
//      `purge_at` and for the drafts of every lead whose message this statement deleted;
//   3. `leads.submission_key = null` for the leads whose message it deleted (the key is an HMAC of
//      the email when HubSpot gave no conversion id, D-31).
// 4. `inbox_checks.test_address` cleared 24 h after the check was created and checks still without
//    deadlines closed (services/inbox-check), and login intents deleted a day after they expired.
// The 5-minute guard (guard.ts) runs these whenever anything is due; the daily cron runs them too,
// plus a catch-all (catchUpOrphanedContent) and the prunes (prune.ts).

export const LOGIN_INTENT_KEEP_MS = 24 * 60 * 60 * 1000;

export interface ContentPurgeSummary {
  readonly leadMessagesDeleted: number;
  readonly draftsPurged: number;
  readonly submissionKeysCleared: number;
}

/** Steps 1-3 in one statement. */
export async function purgeExpiredContent(db: Db, now: Date): Promise<ContentPurgeSummary> {
  const row = await db.one<{ messages: number; drafts: number; keys: number }>(
    `with purged as (
       delete from lead_messages where purge_at <= $1 returning lead_id
     ), keys as (
       update leads set submission_key = null
        where id in (select lead_id from purged) and submission_key is not null
       returning id
     ), cleared as (
       update drafts set subject = null, body = null, flags = '{}', purged_at = $1
        where purged_at is null and (purge_at <= $1 or lead_id in (select lead_id from purged))
       returning id
     )
     select (select count(*) from purged)::int as messages,
            (select count(*) from cleared)::int as drafts,
            (select count(*) from keys)::int as keys`,
    [now],
  );
  return { leadMessagesDeleted: row.messages, draftsPurged: row.drafts, submissionKeysCleared: row.keys };
}

/**
 * The daily catch-all: drafts and submission keys of leads whose message is already gone (a purge
 * that ran before these statements existed, or any other path). Privacy-deleted leads keep the
 * random key their deletion wrote (services/privacy); their drafts were purged by it.
 */
export async function catchUpOrphanedContent(db: Db, now: Date): Promise<{ draftsPurged: number; submissionKeysCleared: number }> {
  const drafts = await db.query(
    `update drafts d set subject = null, body = null, flags = '{}', purged_at = $1
      where d.purged_at is null and not exists (select 1 from lead_messages m where m.lead_id = d.lead_id)
     returning d.id`,
    [now],
  );
  const keys = await db.query(
    `update leads l set submission_key = null
      where l.submission_key is not null and l.stop_reason is distinct from 'privacy_deletion'
        and not exists (select 1 from lead_messages m where m.lead_id = l.id)
     returning l.id`,
  );
  return { draftsPurged: drafts.length, submissionKeysCleared: keys.length };
}

/** Step 4's login-intent expiry: intents are kept one day past `expires_at`, then deleted. */
export async function deleteExpiredLoginIntents(db: Db, now: Date): Promise<number> {
  const rows = await db.query(`delete from login_intents where expires_at < $1 returning token_hash_sha256`, [
    new Date(now.getTime() - LOGIN_INTENT_KEEP_MS),
  ]);
  return rows.length;
}

export interface ContentRetentionSummary extends ContentPurgeSummary {
  readonly inboxChecksClosed: number;
  readonly testAddressesCleared: number;
  readonly loginIntentsDeleted: number;
}

/** Steps 1-4. */
export async function runContentRetention(deps: Pick<Deps, 'db' | 'clock'>): Promise<ContentRetentionSummary> {
  const now = deps.clock.now();
  const content = await purgeExpiredContent(deps.db, now);
  const inbox = await runInboxCheckRetention(deps);
  const loginIntentsDeleted = await deleteExpiredLoginIntents(deps.db, now);
  return { ...content, ...inbox, loginIntentsDeleted };
}

/** Whether any step 1-4 has something to do: index-backed existence checks only, so the 5-minute guard stays cheap. */
export async function contentRetentionDue(db: Db, now: Date): Promise<boolean> {
  const row = await db.one<{ due: boolean }>(
    `select exists (select 1 from lead_messages where purge_at <= $1)
         or exists (select 1 from drafts where purged_at is null and purge_at <= $1)
         or exists (select 1 from inbox_checks where test_address is not null and created_at <= $2)
         or exists (select 1 from inbox_checks where status = 'open' and send_deadline_at is null and created_at <= $2)
         or exists (select 1 from login_intents where expires_at < $3) as due`,
    [now, new Date(now.getTime() - INBOX_CHECK_ABANDON_MS), new Date(now.getTime() - LOGIN_INTENT_KEEP_MS)],
  );
  return row.due;
}
