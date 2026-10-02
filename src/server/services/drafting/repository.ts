import 'server-only';
import { z } from 'zod';
import { DRAFT_FLAGS, DRAFT_KINDS, VALIDATION_ERROR_CODES, type DraftFlag, type DraftKind, type ValidationErrorCode } from '@/server/domain/types';
import { PermanentError } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import type { BriefDraft, DraftLeadInput } from '@/server/ports/llm';
import { safeFirstName } from '@/server/domain/subject';
import { StoredBriefSchema } from '@/server/services/brief/schema';

// What drafting reads and writes (PLAN §5 `drafts`, D-31, D-49). One `drafts` row per (lead, kind):
// the row may first exist as an empty slot (subject and body null) claimed by the daily cap, and is
// completed once, by the first attempt that stores a draft (compare-and-set on `subject is null`), so
// a redelivered job reuses the stored draft instead of paying for another one. Content (subject,
// body, flags) is purged with the lead's content: `purge_at` is the lead_messages row's.

const INT32_MAX = 2_147_483_647;

/** One stored draft (content included: never log it). */
export interface DraftRecord {
  readonly id: string;
  readonly leadId: string;
  readonly accountId: string;
  readonly kind: DraftKind;
  readonly subject: string;
  readonly body: string;
  readonly flags: readonly DraftFlag[];
  readonly usedBookingLink: boolean;
  /** The model's draft passed the validator (false for a needs-touch template). */
  readonly validationOk: boolean;
  /** The codes the model's last draft failed with. */
  readonly validationErrors: readonly ValidationErrorCode[];
  /** LLM attempts made (0 when no model was called). */
  readonly attempts: number;
  /** The body is the minimal safe template; the owner should look at it first. */
  readonly needsTouch: boolean;
  readonly model: string | null;
}

export const DRAFT_COLUMNS =
  'id, lead_id, account_id, kind, subject, body, flags, used_booking_link, validation_ok, validation_errors, attempts, needs_touch, model';

const draftRow = z.object({
  id: z.string(),
  lead_id: z.string(),
  account_id: z.string(),
  kind: z.enum(DRAFT_KINDS),
  subject: z.string(),
  body: z.string(),
  flags: z.array(z.enum(DRAFT_FLAGS)),
  used_booking_link: z.boolean(),
  validation_ok: z.boolean(),
  validation_errors: z.array(z.enum(VALIDATION_ERROR_CODES)),
  attempts: z.number(),
  needs_touch: z.boolean(),
  model: z.string().nullable(),
});

export function toDraftRecord(raw: unknown): DraftRecord {
  const row = draftRow.parse(raw);
  return {
    id: row.id,
    leadId: row.lead_id,
    accountId: row.account_id,
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    flags: row.flags,
    usedBookingLink: row.used_booking_link,
    validationOk: row.validation_ok,
    validationErrors: row.validation_errors,
    attempts: row.attempts,
    needsTouch: row.needs_touch,
    model: row.model,
  };
}

/** The lead's completed draft of `kind` while its content exists, or null (none yet, an empty slot, or purged). */
export async function findCompletedDraft(db: Db, leadId: string, kind: DraftKind): Promise<DraftRecord | null> {
  const raw = await db.maybeOne(
    `select ${DRAFT_COLUMNS} from drafts
      where lead_id = $1 and kind = $2 and subject is not null and body is not null and purged_at is null`,
    [leadId, kind],
  );
  return raw === null ? null : toDraftRecord(raw);
}

export interface DraftToStore {
  subject: string;
  body: string;
  flags: readonly DraftFlag[];
  usedBookingLink: boolean;
  validationOk: boolean;
  validationErrors: readonly ValidationErrorCode[];
  attempts: number;
  needsTouch: boolean;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

function int(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), INT32_MAX) : 0;
}

/**
 * Stores the draft unless one is already stored (first writer wins), and returns whichever is
 * stored. `guard` runs first inside the transaction (lead_process passes `ctx.assertOwned`). A
 * needs-touch initial draft also sets `leads.needs_touch`.
 */
export async function storeDraft(
  db: Db,
  target: { accountId: string; leadId: string; kind: DraftKind; purgeAt: Date },
  draft: DraftToStore,
  guard?: (tx: Db) => Promise<void>,
): Promise<DraftRecord> {
  return db.tx(async (tx) => {
    if (guard !== undefined) await guard(tx);
    const raw = await tx.maybeOne(
      `insert into drafts (lead_id, account_id, kind, subject, body, flags, used_booking_link, validation_ok, validation_errors,
                           attempts, needs_touch, model, input_tokens, output_tokens, cost_micro_usd, purge_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       on conflict (lead_id, kind) do update
         set subject = excluded.subject, body = excluded.body, flags = excluded.flags, used_booking_link = excluded.used_booking_link,
             validation_ok = excluded.validation_ok, validation_errors = excluded.validation_errors, attempts = excluded.attempts,
             needs_touch = excluded.needs_touch, model = excluded.model, input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens, cost_micro_usd = excluded.cost_micro_usd
         where drafts.subject is null and drafts.purged_at is null
       returning ${DRAFT_COLUMNS}`,
      [
        target.leadId,
        target.accountId,
        target.kind,
        draft.subject,
        draft.body,
        [...draft.flags],
        draft.usedBookingLink,
        draft.validationOk,
        [...draft.validationErrors],
        int(draft.attempts),
        draft.needsTouch,
        draft.model,
        int(draft.inputTokens),
        int(draft.outputTokens),
        int(draft.costMicroUsd),
        target.purgeAt,
      ],
    );
    if (raw === null) {
      // Another delivery stored its draft first (or the content was purged meanwhile).
      const existing = await tx.maybeOne(
        `select ${DRAFT_COLUMNS} from drafts where lead_id = $1 and kind = $2 and subject is not null and body is not null and purged_at is null`,
        [target.leadId, target.kind],
      );
      if (existing === null) throw new PermanentError('draft_content_missing');
      return toDraftRecord(existing);
    }
    const stored = toDraftRecord(raw);
    if (stored.needsTouch && stored.kind === 'initial') {
      await tx.query(`update leads set needs_touch = true where id = $1 and account_id = $2`, [target.leadId, target.accountId]);
    }
    return stored;
  });
}

/** Everything one draft needs, read in one statement. Content: never log it. */
export interface DraftContext {
  readonly accountId: string;
  readonly leadId: string;
  readonly kind: DraftKind;
  /** The lead fields the model may use (brief §5.4); the first name is already `safeFirstName`d. */
  readonly lead: DraftLeadInput;
  /** The brief in force with the booking link in force (null unless the owner chose and confirmed a link); null before the owner saved one. */
  readonly brief: BriefDraft | null;
  readonly bookingLink: string | null;
  /** The brief's website (`briefs.source_url`): the URL rule allows links on its host, within its path. */
  readonly siteUrl: string | null;
  /** The initial draft, for follow-ups, while its content exists. */
  readonly original: { subject: string; body: string } | null;
  /** = lead_messages.purge_at. */
  readonly purgeAt: Date;
}

interface ContextRow {
  has_content: boolean;
  message: string | null;
  first_name: string | null;
  company: string | null;
  purge_at: Date | null;
  form_name: string | null;
  brief: unknown;
  booking_link_choice: string | null;
  booking_link_confirmed: boolean | null;
  source_url: string | null;
  original_subject: string | null;
  original_body: string | null;
}

function bookingLinkInForce(brief: BriefDraft, choice: string | null, confirmed: boolean | null): string | null {
  if (choice !== 'link' || confirmed !== true) return null;
  const link = brief.booking_link?.trim() ?? '';
  try {
    return link !== '' && new URL(link).protocol === 'https:' ? link : null;
  } catch {
    return null;
  }
}

/** Throws PermanentError('draft_lead_not_found' | 'draft_content_missing') when there is nothing to draft from. */
export async function loadDraftContext(db: Db, input: { accountId: string; leadId: string; kind: DraftKind }): Promise<DraftContext> {
  const row = await db.maybeOne<ContextRow>(
    `select m.lead_id is not null as has_content, m.message, m.first_name, m.company, m.purge_at, f.form_name,
            b.brief, b.booking_link_choice, b.booking_link_confirmed, b.source_url,
            o.subject as original_subject, o.body as original_body
       from leads l
       left join lead_messages m on m.lead_id = l.id
       left join selected_forms f on f.account_id = l.account_id and f.form_id = l.form_id
       left join briefs b on b.account_id = l.account_id
       left join drafts o on o.lead_id = l.id and o.kind = 'initial' and o.purged_at is null
      where l.id = $1 and l.account_id = $2`,
    [input.leadId, input.accountId],
  );
  if (row === null) throw new PermanentError('draft_lead_not_found');
  if (!row.has_content || row.purge_at === null) throw new PermanentError('draft_content_missing');

  const parsed = row.booking_link_choice === null || row.booking_link_choice === 'unset' ? null : StoredBriefSchema.safeParse(row.brief);
  const stored = parsed?.success === true ? parsed.data : null;
  const bookingLink = stored === null ? null : bookingLinkInForce(stored, row.booking_link_choice, row.booking_link_confirmed);
  const brief: BriefDraft | null = stored === null ? null : { ...stored, booking_link: bookingLink };
  const original =
    input.kind !== 'initial' && row.original_subject !== null && row.original_body !== null
      ? { subject: row.original_subject, body: row.original_body }
      : null;
  return {
    accountId: input.accountId,
    leadId: input.leadId,
    kind: input.kind,
    lead: { firstName: safeFirstName(row.first_name), company: row.company, message: row.message, formName: row.form_name ?? '' },
    brief,
    bookingLink,
    siteUrl: row.source_url,
    original,
    purgeAt: row.purge_at,
  };
}
