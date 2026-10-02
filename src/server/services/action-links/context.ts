import 'server-only';
import { z } from 'zod';
import { checkRecipient } from '@/server/domain/compose';
import { MAIL_CLIENTS, type MailClient } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { VerifiedActionToken } from '@/server/security/action-tokens';

// What a send token's pages need (PLAN §7.4): the draft (subject, body), the lead's address
// (lead_messages.email, D-31), the owner's mail client, Gmail account and BCC address (settings),
// and when the email carrying the link was sent (for D-26's 60 s rule). Read in one statement by the
// token's draft and account, so a token can only ever reach its own account's rows.
//
// A draft whose content is gone (purged at 30 days, D-49; or its lead's content row removed) is
// `expired`; a token whose draft or lead does not match is `invalid`.

export interface SendContext {
  readonly tokenId: string;
  readonly accountId: string;
  readonly leadId: string;
  readonly draftId: string;
  /** The lead's address as stored (trimmed); null when missing. Untrusted: check it before use. */
  readonly recipient: string | null;
  readonly subject: string;
  readonly body: string;
  readonly mailClient: MailClient;
  /** settings.gmail_account_email (the builder ignores it unless it is a bare address). */
  readonly gmailAccount: string | null;
  /** settings.bcc_address when it is one bare address (D-46: shown on the send and copy pages). */
  readonly bcc: string | null;
  /** notifications_sent.sent_at of the email the token went out in; null when unknown. */
  readonly sentAt: Date | null;
}

export type SendContextResult = { readonly type: 'ok'; readonly context: SendContext } | { readonly type: 'expired' } | { readonly type: 'invalid' };

const rowSchema = z.object({
  lead_id: z.string(),
  draft_id: z.string(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  purged_at: z.date().nullable(),
  has_content: z.boolean(),
  email: z.string().nullable(),
  mail_client: z.enum(MAIL_CLIENTS),
  gmail_account_email: z.string().nullable(),
  bcc_address: z.string().nullable(),
  sent_at: z.date().nullable(),
});

function trimmedOrNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/** Loads the send context of a verified `send` (or `edit`) token. */
export async function loadSendContext(db: Db, token: VerifiedActionToken): Promise<SendContextResult> {
  if (token.draftId === null || token.leadId === null) return { type: 'invalid' };
  const raw = await db.maybeOne(
    `select d.lead_id, d.id as draft_id, d.subject, d.body, d.purged_at, (m.lead_id is not null) as has_content, m.email,
            coalesce(s.mail_client, 'other') as mail_client, s.gmail_account_email, s.bcc_address,
            (select n.sent_at from notifications_sent n where n.dedupe_key = $4 and n.account_id = d.account_id) as sent_at
       from drafts d
       join leads l on l.id = d.lead_id and l.account_id = d.account_id
       left join lead_messages m on m.lead_id = l.id and m.account_id = l.account_id
       left join settings s on s.account_id = d.account_id
      where d.id = $1 and d.account_id = $2 and d.lead_id = $3`,
    [token.draftId, token.accountId, token.leadId, token.notificationKey],
  );
  if (raw === null) return { type: 'invalid' };
  const row = rowSchema.parse(raw);
  if (row.purged_at !== null || row.subject === null || row.body === null || !row.has_content) return { type: 'expired' };
  const bccRaw = trimmedOrNull(row.bcc_address);
  const bcc = bccRaw !== null && checkRecipient(bccRaw).ok ? bccRaw : null;
  if (bccRaw !== null && bcc === null) {
    log.warn('saved bcc address is not one bare address', { event: 'action_link.bcc_unusable', accountId: token.accountId });
  }
  return {
    type: 'ok',
    context: {
      tokenId: token.id,
      accountId: token.accountId,
      leadId: row.lead_id,
      draftId: row.draft_id,
      recipient: trimmedOrNull(row.email),
      subject: row.subject,
      body: row.body,
      mailClient: row.mail_client,
      gmailAccount: trimmedOrNull(row.gmail_account_email),
      bcc,
      sentAt: row.sent_at,
    },
  };
}
