import 'server-only';
import type { Db } from '@/server/db';
import { TEST_LEAD_CONTENT_TTL_MS } from './constants';

// The inbox check's test lead (PLAN §9.7 step 2, D-14, D-31): `is_test`, `intake_trigger =
// 'inbox_check'`, a fixed template draft (no LLM call), its content purged after 24 h. It is the
// "lead" of the test email the owner sends to their own other address. Test leads never get a
// lead_process or follow-up job, never supersede, never count in metrics and are excluded from
// signals (`AND NOT is_test`); `stop_reason = 'test_lead'` keeps every lead-email predicate false
// for it as a second guard (PLAN §6.2's defensive stop).

export const TEST_LEAD_FIRST_NAME = 'Test';

/** The test lead's "message": shown in the test email as the lead's message. */
export function testLeadMessage(productName: string): string {
  return `This is a test lead from your ${productName} inbox check. Send your reply below from your own mailbox, then answer it from this address.`;
}

/** The template draft the owner sends to their other address (plain text, no placeholders). */
export function testDraft(productName: string): { subject: string; body: string } {
  return {
    subject: `${productName} inbox check`,
    body: [
      'Hi,',
      '',
      `This is a test email from my ${productName} inbox check. Please answer it from this address: a short answer is fine.`,
      '',
      'Thanks',
    ].join('\n'),
  };
}

export interface NewTestLead {
  accountId: string;
  checkId: string;
  /** The test contact, when HubSpot already has one for the address. */
  contactId: string | null;
  /** Lower-cased. */
  testAddress: string;
  productName: string;
  /** `$now`. */
  now: Date;
}

export interface InsertedTestLead {
  readonly leadId: string;
  readonly draftId: string;
}

/**
 * Inside the caller's transaction: the lead, its content and its draft in one statement, linked to
 * the check. Null unless the check is still open without a test lead (a repeated start, or a skip,
 * got there first).
 */
export async function insertTestLeadInTx(tx: Db, input: NewTestLead): Promise<InsertedTestLead | null> {
  const purgeAt = new Date(input.now.getTime() + TEST_LEAD_CONTENT_TTL_MS);
  const draft = testDraft(input.productName);
  const row = await tx.maybeOne<{ lead_id: string | null; draft_id: string | null }>(
    `with lead as (
       insert into leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, is_test, processing_state,
                          stop_reason, received_at)
       select $1, $2, null, $3, 'inbox_check', true, 'processing', 'test_lead', $3
        where exists (select 1 from inbox_checks k
                       where k.id = $4 and k.account_id = $1 and k.status = 'open' and k.test_lead_id is null)
       returning id),
     content as (
       insert into lead_messages (lead_id, account_id, message, first_name, last_name, company, email, purge_at)
       select id, $1, $5, $6, null, null, $7, $8 from lead
       returning lead_id),
     draft as (
       insert into drafts (lead_id, account_id, kind, subject, body, flags, validation_ok, purge_at)
       select id, $1, 'initial', $9, $10, '{}', true, $8 from lead
       returning id),
     linked as (
       update inbox_checks set test_lead_id = (select id from lead)
        where id = $4 and exists (select 1 from lead)
       returning id)
     select (select id from lead) as lead_id, (select id from draft) as draft_id,
            (select count(*) from content) as contents, (select count(*) from linked) as links`,
    [
      input.accountId,
      input.contactId,
      input.now,
      input.checkId,
      testLeadMessage(input.productName),
      TEST_LEAD_FIRST_NAME,
      input.testAddress,
      purgeAt,
      draft.subject,
      draft.body,
    ],
  );
  if (row === null || row.lead_id === null || row.draft_id === null) return null;
  return { leadId: row.lead_id, draftId: row.draft_id };
}
