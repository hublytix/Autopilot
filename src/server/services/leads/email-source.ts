import 'server-only';
import { z } from 'zod';
import { defangLeadText } from '@/server/domain/defang';
import { safeFirstName } from '@/server/domain/subject';
import { DRAFT_FLAGS, LOGGING_MODES, type DraftFlag, type DraftKind, type LoggingMode } from '@/server/domain/types';
import type { Db } from '@/server/db';

// Everything a lead email (new lead, needs touch, follow-up, reply detected) is rendered from, read
// in one statement so the first send and a resumed send (the sweeper, a later job) build the same
// email from the stored rows: the lead's stored content (D-31: name, company, address, message),
// the draft of the requested kind, how HubSpot logs the owner's mail (`logging_mode`, D-14), and the
// addresses (PLAN §8.4, D-27, D-46):
// - to: the account's verified notify addresses (an unconfirmed address receives nothing, D-46);
//   the owner's sign-in address when none is verified (it always is; never silent, D-24);
// - Reply-To: the owner's own sign-in address (D-27), never the lead's or a support inbox.
// Content: never log anything read here.

export interface LeadEmailDraft {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
  /** The draft is the minimal safe template. */
  readonly needsTouch: boolean;
  /** The model's flags (closed list, de-duplicated; none on the template). */
  readonly flags: readonly DraftFlag[];
}

export interface LeadEmailSource {
  readonly accountId: string;
  readonly leadId: string;
  readonly processRev: number;
  readonly followupStream: number;
  readonly processingState: string;
  readonly hubspotContactId: string | null;
  readonly portalId: string;
  readonly uiDomain: string | null;
  /** The account's IANA zone (or fixed-offset name); null when unknown. */
  readonly timezone: string | null;
  readonly loggingMode: LoggingMode;
  readonly sendConfirmedAt: Date | null;
  readonly repliedAt: Date | null;
  /** False once the lead's content is purged or deleted. */
  readonly hasContent: boolean;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly company: string | null;
  readonly email: string | null;
  readonly message: string | null;
  /** The draft of the requested kind while its content exists; null otherwise. */
  readonly draft: LeadEmailDraft | null;
  readonly to: readonly string[];
  readonly replyTo: string | null;
  /** The brief in force allows prices in drafts (`allow_pricing`); false when unknown. */
  readonly allowPricing: boolean;
}

const rowSchema = z.object({
  account_id: z.string(),
  lead_id: z.string(),
  process_rev: z.number(),
  followup_stream: z.number(),
  processing_state: z.string(),
  hubspot_contact_id: z.string().nullable(),
  portal_id: z.string(),
  ui_domain: z.string().nullable(),
  timezone: z.string().nullable(),
  logging_mode: z.enum(LOGGING_MODES),
  send_confirmed_at: z.date().nullable(),
  replied_at: z.date().nullable(),
  has_content: z.boolean(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  company: z.string().nullable(),
  email: z.string().nullable(),
  message: z.string().nullable(),
  draft_id: z.string().nullable(),
  draft_subject: z.string().nullable(),
  draft_body: z.string().nullable(),
  draft_needs_touch: z.boolean().nullable(),
  draft_flags: z.array(z.string()).nullable(),
  allow_pricing: z.boolean().nullable(),
  verified: z.array(z.string()).nullable(),
  owner_email: z.string().nullable(),
});

function uniqueAddresses(addresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of addresses) {
    const address = raw.trim();
    if (address === '' || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    out.push(address);
  }
  return out;
}

/** The lead email's source for `leadId` (and `accountId` when known), with its `draftKind` draft; null when the lead is gone. */
export async function loadLeadEmailSource(
  db: Db,
  input: { accountId?: string | null | undefined; leadId: string; draftKind?: DraftKind | undefined },
): Promise<LeadEmailSource | null> {
  const raw = await db.maybeOne(
    `select l.account_id, l.id as lead_id, l.process_rev, l.followup_stream, l.processing_state, l.hubspot_contact_id,
            a.hubspot_portal_id as portal_id, c.ui_domain, a.timezone, a.logging_mode, l.send_confirmed_at, l.replied_at,
            m.lead_id is not null as has_content, m.first_name, m.last_name, m.company, m.email, m.message,
            d.id as draft_id, d.subject as draft_subject, d.body as draft_body, d.needs_touch as draft_needs_touch,
            d.flags as draft_flags,
            case when jsonb_typeof(b.brief -> 'allow_pricing') = 'boolean' then (b.brief ->> 'allow_pricing')::boolean end as allow_pricing,
            s.notify_emails_verified as verified, u.email as owner_email
       from leads l
       join accounts a on a.id = l.account_id
       left join hubspot_connections c on c.account_id = a.id
       left join lead_messages m on m.lead_id = l.id and m.account_id = l.account_id
       left join drafts d on d.lead_id = l.id and d.account_id = l.account_id and d.kind = $3 and d.purged_at is null
                          and d.subject is not null and d.body is not null
       left join settings s on s.account_id = a.id
       left join briefs b on b.account_id = a.id
       left join users u on u.account_id = a.id and u.auth_user_id = a.owner_user_id
      where l.id = $1 and ($2::uuid is null or l.account_id = $2::uuid)`,
    [input.leadId, input.accountId ?? null, input.draftKind ?? 'initial'],
  );
  if (raw === null) return null;
  const row = rowSchema.parse(raw);
  const ownerEmail = row.owner_email?.trim() ?? '';
  const verified = uniqueAddresses(row.verified ?? []);
  const to = verified.length > 0 ? verified : ownerEmail === '' ? [] : [ownerEmail];
  const draft =
    input.draftKind === undefined || row.draft_id === null || row.draft_subject === null || row.draft_body === null
      ? null
      : {
          id: row.draft_id,
          subject: row.draft_subject,
          body: row.draft_body,
          needsTouch: row.draft_needs_touch === true,
          flags: DRAFT_FLAGS.filter((flag) => (row.draft_flags ?? []).includes(flag)),
        };
  return {
    accountId: row.account_id,
    leadId: row.lead_id,
    processRev: row.process_rev,
    followupStream: row.followup_stream,
    processingState: row.processing_state,
    hubspotContactId: row.hubspot_contact_id,
    portalId: row.portal_id,
    uiDomain: row.ui_domain,
    timezone: row.timezone,
    loggingMode: row.logging_mode,
    sendConfirmedAt: row.send_confirmed_at,
    repliedAt: row.replied_at,
    hasContent: row.has_content,
    firstName: row.first_name,
    lastName: row.last_name,
    company: row.company,
    email: row.email,
    message: row.message,
    draft,
    to,
    replyTo: ownerEmail === '' ? null : ownerEmail,
    allowPricing: row.allow_pricing === true,
  };
}

// ---------------------------------------------------------------------------------------------
// Display (D-47): lead-controlled text is cleaned and defanged before it reaches an email
// ---------------------------------------------------------------------------------------------

const LINE_MAX_CHARS = 200;
const MESSAGE_MAX_CHARS = 4000;

function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join('').trimEnd()}…`;
}

/** One line of lead text (a name, company or address), defanged; null when empty. */
export function displayLine(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const line = defangLeadText(text).replace(/\s+/gu, ' ').trim();
  return line === '' ? null : cut(line, LINE_MAX_CHARS);
}

/** The lead's message for "Message from the lead (unverified)": defanged, line breaks kept; null when empty. */
export function displayMessage(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const message = defangLeadText(text).trim();
  return message === '' ? null : cut(message, MESSAGE_MAX_CHARS);
}

/** The lead card's name, company and address, each defanged (D-47). */
export function leadCardOf(source: Pick<LeadEmailSource, 'firstName' | 'lastName' | 'company' | 'email'>): {
  name: string | null;
  company: string | null;
  email: string | null;
} {
  const name = [source.firstName, source.lastName].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(' ');
  return { name: displayLine(name), company: displayLine(source.company), email: displayLine(source.email) };
}

/** The safe first name for subjects, headings and previews (D-47). */
export function safeNameOf(source: Pick<LeadEmailSource, 'firstName'>): string | null {
  return safeFirstName(source.firstName);
}
