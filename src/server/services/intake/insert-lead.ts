import 'server-only';
import type { IntakeTrigger } from '@/server/domain/types';
import { insertJob, type JobRow } from '@/server/jobs';
import { leadProcessDedupeKey } from '@/server/services/leads/process';
import type { Db } from '@/server/db';
import type { LeadContent } from './submission';

// One new lead, in ONE transaction (PLAN §9.2 step 2, §6.2, §8.3 step 1):
// 1. the lead row, ON CONFLICT DO NOTHING on both unique keys ((account, contact, submittedAt) and
//    (account, form, submission_key)), only while the account is still `active`, and never for a
//    contact HubSpot has sent a privacy deletion for (D-06): the poll may have resolved the contact
//    just before the deletion arrived and its `privacy_delete` job ran (finding no lead yet). The
//    insert takes `FOR SHARE` on the account row and privacy_delete takes `FOR NO KEY UPDATE` on it
//    before reading the contact's leads, so a concurrent insert is either seen by the deletion or
//    refused here (docs/ARCHITECTURE.md, row lock order). The webhook's dedupe key is
//    `portalId:subscriptionType:objectId:eventId:occurredAt`, so its third part is the contact id;
// 2. its content in `lead_messages`, through a CTE on the lead insert's RETURNING, so content can
//    never exist without its lead (D-31); purged at submittedAt + 30 d;
// 3. the `lead_process` job (dedupe `lead:{id}:process:r0`).
// The caller publishes the job after commit.

/** Lead content lives for 30 days after the submission (D-31, D-49). */
export const LEAD_CONTENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface NewLead {
  accountId: string;
  /** The resolved contact id (after any merge). */
  contactId: string;
  formId: string;
  submittedAt: Date;
  conversionId: string | null;
  submissionKey: string;
  trigger: Exclude<IntakeTrigger, 'inbox_check'>;
  content: LeadContent;
  /** `$now`: `received_at` and the job's `created_at`/`run_at`. */
  now: Date;
}

export interface InsertedLead {
  readonly leadId: string;
  /** The lead_process job to publish after commit. */
  readonly job: JobRow | null;
}

/** Inside the caller's transaction. Null when the lead already exists, the account stopped being active, or the contact was privacy-deleted. */
export async function insertLeadInTx(tx: Db, lead: NewLead): Promise<InsertedLead | null> {
  const purgeAt = new Date(lead.submittedAt.getTime() + LEAD_CONTENT_RETENTION_MS);
  const row = await tx.maybeOne<{ id: string }>(
    `with lead as (
       insert into leads (account_id, hubspot_contact_id, form_id, submitted_at, conversion_id, submission_key,
                          intake_trigger, is_test, processing_state, received_at)
       select $1, $2, $3, $4, $5, $6, $7, false, 'new', $8
        where exists (select 1 from accounts where id = $1 and processing_state = 'active' for share)
          and not exists (
            select 1 from webhook_events w
             where w.provider = 'hubspot'
               and w.portal_id = (select a.hubspot_portal_id from accounts a where a.id = $1)
               and w.event_type = 'contact.privacyDeletion'
               and split_part(w.dedupe_key, ':', 3) = $2)
       on conflict do nothing
       returning id, account_id
     ), content as (
       insert into lead_messages (lead_id, account_id, message, first_name, last_name, company, email, purge_at)
       select lead.id, lead.account_id, $9, $10, $11, $12, $13, $14 from lead
       returning lead_id
     )
     select lead.id from lead join content on content.lead_id = lead.id`,
    [
      lead.accountId,
      lead.contactId,
      lead.formId,
      lead.submittedAt,
      lead.conversionId,
      lead.submissionKey,
      lead.trigger,
      lead.now,
      lead.content.message,
      lead.content.firstName,
      lead.content.lastName,
      lead.content.company,
      lead.content.email,
      purgeAt,
    ],
  );
  if (row === null) return null;
  const job = await insertJob(tx, {
    kind: 'lead_process',
    accountId: lead.accountId,
    leadId: row.id,
    dedupeKey: leadProcessDedupeKey(row.id, 0),
    runAt: lead.now,
    now: lead.now,
  });
  return { leadId: row.id, job };
}

/** insertLeadInTx in its own transaction. */
export async function insertLead(db: Db, lead: NewLead): Promise<InsertedLead | null> {
  return db.tx((tx) => insertLeadInTx(tx, lead));
}
