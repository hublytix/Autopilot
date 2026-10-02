import 'server-only';
import type { Db } from '@/server/db';
import { seedAccount, seedConnection, seedLead, seedSettings } from '@/server/jobs/testing';
import type { BriefDraft } from '@/server/ports/llm';

// Test support (Vitest only; nothing in the app imports this): an active account with a saved brief
// (booking link confirmed) and a classified lead in `processing` with its content, the minimum
// generateDraft and applyDailyCap read. M4's lead_process tests can build on it.

export const SAMPLE_BOOKING_LINK = 'https://cal.example.com/brightside/visit';
export const SAMPLE_SITE_URL = 'https://brightside-plumbing.example/';

export const SAMPLE_BRIEF: BriefDraft = {
  company_name: 'Brightside Plumbing',
  one_line: 'Family-run plumbers in Riverton.',
  services: ['Emergency repairs', 'Boiler servicing', 'Drain cleaning'],
  who_we_serve: 'Homeowners and landlords in Riverton',
  booking_link: SAMPLE_BOOKING_LINK,
  tone: { style: 'friendly', note: 'Warm and plain.' },
  sign_off_name: 'Dana Whitfield',
  allow_pricing: false,
  never_promise: ['same-day service'],
  faqs: [{ q: 'Do you work weekends?', a: 'Saturdays from 9 to 1.' }],
};

export const SAMPLE_MESSAGE = 'Hi, our kitchen sink has been leaking under the cabinet since Monday. Could someone come and look at it this week?';

export interface SeedBriefInput {
  brief?: BriefDraft | undefined;
  choice?: 'unset' | 'link' | 'none' | undefined;
  confirmed?: boolean | undefined;
  sourceUrl?: string | null | undefined;
}

/** The brief in force (`briefs` row) for `accountId`. */
export async function seedBrief(db: Db, accountId: string, input: SeedBriefInput = {}): Promise<void> {
  const choice = input.choice ?? 'link';
  await db.query(
    `insert into briefs (account_id, brief, source_url, booking_link_choice, booking_link_confirmed, version)
     values ($1, $2::jsonb, $3, $4, $5, 1)
     on conflict (account_id) do update set brief = excluded.brief, source_url = excluded.source_url,
       booking_link_choice = excluded.booking_link_choice, booking_link_confirmed = excluded.booking_link_confirmed`,
    [accountId, input.brief ?? SAMPLE_BRIEF, input.sourceUrl === undefined ? SAMPLE_SITE_URL : input.sourceUrl, choice, input.confirmed ?? choice === 'link'],
  );
}

/** An active account with a connection, settings (owner@example.com verified), a selected form and a brief. */
export async function seedDraftingAccount(db: Db, input: { now: Date; timezone?: string | undefined; brief?: SeedBriefInput | undefined }): Promise<string> {
  const accountId = await seedAccount(db, { now: input.now, timezone: input.timezone });
  await seedConnection(db, { accountId, now: input.now });
  await seedSettings(db, { accountId, now: input.now });
  await db.query(
    `insert into selected_forms (account_id, form_id, form_name, form_type, intake_floor_at, cursor_submitted_at) values ($1, 'form-1', 'Contact us', 'hubspot', $2, $2)`,
    [accountId, input.now],
  );
  await seedBrief(db, accountId, input.brief);
  return accountId;
}

export interface SeedDraftableLeadInput {
  accountId: string;
  now: Date;
  firstName?: string | null | undefined;
  message?: string | null | undefined;
  company?: string | null | undefined;
}

export interface DraftableLead {
  leadId: string;
  purgeAt: Date;
}

/** A classified lead in `processing` with its content (purge_at = now + 30 d). */
export async function seedDraftableLead(db: Db, input: SeedDraftableLeadInput): Promise<DraftableLead> {
  const leadId = await seedLead(db, { accountId: input.accountId, now: input.now });
  await db.query(`update leads set processing_state = 'processing', classification = 'lead', classified_at = $2 where id = $1`, [leadId, input.now]);
  const purgeAt = new Date(input.now.getTime() + 30 * 86_400_000);
  await db.query(
    `insert into lead_messages (lead_id, account_id, message, first_name, company, email, purge_at) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      leadId,
      input.accountId,
      input.message === undefined ? SAMPLE_MESSAGE : input.message,
      input.firstName === undefined ? 'Maya' : input.firstName,
      input.company === undefined ? 'Okafor Bakery' : input.company,
      'maya@example.org',
      purgeAt,
    ],
  );
  return { leadId, purgeAt };
}
