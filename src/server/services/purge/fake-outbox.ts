import 'server-only';
import type { Db } from '@/server/db';

// Fake mode only (D-29, D-82, law 4): `fake.dev_outbox` keeps the full text of every email the fake
// Mailer accepted (drafts, lead names, compose links, addresses) for the /dev outbox view. It stands
// in for the owner's inbox, but it is a table in our database, so it follows the same rules as our
// own content: rows go 30 days after they were written (the daily prune, retention/prune.ts) and
// with the account they were sent for (the purge's last transaction). The table exists only in
// PGlite (fake-shim.sql); callers check APP_MODE first.

export const DEV_OUTBOX_KEEP_DAYS = 30;

/**
 * Inside the purge's transaction, before `delete from accounts`: the account's lead emails (tagged
 * with one of its lead ids) and every email addressed to one of its own addresses (owner, pending
 * owner, alert addresses) that no other account uses.
 */
export async function deleteFakeOutboxForAccountInTx(tx: Db, accountId: string): Promise<number> {
  const rows = await tx.query(
    `with mine as (
       select lower(u.email) as address from public.users u where u.account_id = $1
       union select lower(a.pending_owner_email) from public.accounts a where a.id = $1 and a.pending_owner_email is not null
       union select lower(e) from public.settings s cross join lateral unnest(s.notify_emails) as e where s.account_id = $1
     ),
     shared as (
       select lower(u.email) as address from public.users u where u.account_id <> $1
       union select lower(a.pending_owner_email) from public.accounts a where a.id <> $1 and a.pending_owner_email is not null
       union select lower(e) from public.settings s cross join lateral unnest(s.notify_emails) as e where s.account_id <> $1
     ),
     addresses as (select address from mine except select address from shared)
     delete from fake.dev_outbox o
      where o.meta->>'lead' in (select l.id::text from public.leads l where l.account_id = $1)
         or exists (select 1 from unnest(o."to") as t(address) where lower(t.address) in (select address from addresses))
     returning o.id`,
    [accountId],
  );
  return rows.length;
}

/** The daily prune's fake-mode step: outbox rows older than 30 days (bound from the Clock). */
export async function pruneFakeOutbox(db: Db, cutoff: Date): Promise<number> {
  return (await db.query(`delete from fake.dev_outbox where created_at < $1 returning id`, [cutoff])).length;
}
