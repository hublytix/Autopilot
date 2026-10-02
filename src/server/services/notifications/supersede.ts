import 'server-only';
import type { Db } from '@/server/db';

// D-44: a newer lead supersedes an older one for the same contact. Supersede is a dynamic stop,
// checked before every follow-up send (PLAN §6.2 stop table, §9.5 step 2): a lead is superseded when
// a newer (later `submitted_at`), non-test lead of the same HubSpot contact in the same account has
// already been notified (`first_notified_at` set). A filtered or deferred newer lead is never
// notified, so it never stops a real older one; a newer lead whose first email went out stops the
// older lead's follow-ups whatever happened to it afterwards (dismissed, replied, failed with a
// needs-touch email): the owner has already been emailed about the contact's newer enquiry.
//
// The condition is the same SQL as the `follow_up` reservation predicate (./predicates.ts,
// NOT_SUPERSEDED), so the job's stop check (services/signals/stop-state.ts) and the send-time re-check
// agree; a test replays both over the same rows. It lives here, below both, so services/notifications
// never imports services/followups (which imports it back) or services/signals; services/followups
// re-exports it for its callers. "Newer" compares `submitted_at`: two leads of one contact never
// share it (unique (account_id, hubspot_contact_id, submitted_at)). A test lead has no contact (or is
// excluded as the newer one), and a lead without a contact id is never superseded.

/**
 * The boolean SQL "lead `alias` is superseded" (D-44), for a statement that has `alias` in scope
 * (e.g. `leads l`). The newer lead is aliased `newer_lead`.
 */
export function supersededSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error('supersede_bad_alias');
  return `exists (
      select 1 from leads newer_lead
       where newer_lead.account_id = ${alias}.account_id
         and newer_lead.hubspot_contact_id = ${alias}.hubspot_contact_id
         and newer_lead.id <> ${alias}.id
         and not newer_lead.is_test
         and newer_lead.submitted_at > ${alias}.submitted_at
         and newer_lead.first_notified_at is not null)`;
}

/** D-44 for one lead; false when the lead does not exist. Runs on `db` (a transaction handle or the pool). */
export async function isSuperseded(db: Db, leadId: string): Promise<boolean> {
  const row = await db.maybeOne<{ superseded: boolean }>(`select ${supersededSql('l')} as superseded from leads l where l.id = $1`, [leadId]);
  return row?.superseded ?? false;
}
