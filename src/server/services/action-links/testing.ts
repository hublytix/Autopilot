import 'server-only';
import type { MailClient } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { seedAccount, seedConnection, seedLead, seedSettings } from '@/server/jobs/testing';
import { mintActionTokens } from '@/server/security/action-tokens';
import { NotificationKeys } from '@/server/services/notifications/predicates';

// Test support (Vitest only; nothing in the app imports this): an active account with a lead, its
// content, an initial draft, the sent new-lead email and that email's action tokens, the minimum the
// action-link pages read. M4's edit and dismiss tests can build on it.

export const SAMPLE_REPLY = {
  recipient: 'jane@example.com',
  subject: 'Re: Your enquiry',
  body: 'Hi Jane,\n\nThanks for reaching out.\n\nBest,\nSam',
} as const;

export interface SeedSendableLeadInput {
  now: Date;
  mailClient?: MailClient | undefined;
  gmailAccount?: string | null | undefined;
  bcc?: string | null | undefined;
  recipient?: string | null | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  /** When the new-lead email went out; null leaves it `sending` with no sent_at. Default `now`. */
  sentAt?: Date | null | undefined;
  isTest?: boolean | undefined;
}

export interface SendableLead {
  accountId: string;
  leadId: string;
  draftId: string;
  notificationKey: string;
  sendToken: string;
  editToken: string;
  dismissToken: string;
}

export async function seedSendableLead(db: Db, input: SeedSendableLeadInput): Promise<SendableLead> {
  const { now } = input;
  const accountId = await seedAccount(db, { now });
  await seedConnection(db, { accountId, now });
  await seedSettings(db, { accountId, now });
  await db.query(`update settings set mail_client = $2, gmail_account_email = $3, bcc_address = $4 where account_id = $1`, [
    accountId,
    input.mailClient ?? 'gmail',
    input.gmailAccount ?? null,
    input.bcc ?? null,
  ]);
  const leadId = await seedLead(db, { accountId, now, firstNotifiedAt: now, isTest: input.isTest });
  const purgeAt = new Date(now.getTime() + 30 * 86_400_000);
  await db.query(
    `insert into lead_messages (lead_id, account_id, message, first_name, email, purge_at) values ($1, $2, $3, $4, $5, $6)`,
    [leadId, accountId, 'Could you quote for a kitchen remodel?', 'Jane', input.recipient === undefined ? SAMPLE_REPLY.recipient : input.recipient, purgeAt],
  );
  const draft = await db.one<{ id: string }>(
    `insert into drafts (lead_id, account_id, kind, subject, body, validation_ok, purge_at) values ($1, $2, 'initial', $3, $4, true, $5) returning id`,
    [leadId, accountId, input.subject ?? SAMPLE_REPLY.subject, input.body ?? SAMPLE_REPLY.body, purgeAt],
  );
  const notificationKey = NotificationKeys.initial(leadId, 0);
  const sentAt = input.sentAt === undefined ? now : input.sentAt;
  await db.query(
    `insert into notifications_sent (dedupe_key, account_id, lead_id, kind, status, recipients_count, first_reserved_at, reserved_at, send_attempts, sent_at)
     values ($1, $2, $3, 'new_lead', $4, 1, $5, $5, 1, $6)`,
    [notificationKey, accountId, leadId, sentAt === null ? 'sending' : 'sent', now, sentAt],
  );
  const tokens = await mintActionTokens(db, { accountId, leadId, draftId: draft.id, notificationKey, purposes: ['send', 'edit', 'dismiss'], now });
  const { send, edit, dismiss } = tokens;
  if (send === undefined || edit === undefined || dismiss === undefined) throw new Error('seedSendableLead: tokens not minted');
  return { accountId, leadId, draftId: draft.id, notificationKey, sendToken: send, editToken: edit, dismissToken: dismiss };
}

export interface ClickState {
  firstSendClickedAt: Date | null;
  useCount: number;
  firstUsedAt: Date | null;
}

/** The lead's first click and the send token's use counters. */
export async function clickStateOf(db: Db, lead: Pick<SendableLead, 'leadId' | 'notificationKey'>): Promise<ClickState> {
  const row = await db.one<{ first_send_clicked_at: Date | null; use_count: number; first_used_at: Date | null }>(
    `select l.first_send_clicked_at, t.use_count, t.first_used_at
       from leads l join action_tokens t on t.lead_id = l.id and t.purpose = 'send' and t.notification_key = $2
      where l.id = $1`,
    [lead.leadId, lead.notificationKey],
  );
  return { firstSendClickedAt: row.first_send_clicked_at, useCount: row.use_count, firstUsedAt: row.first_used_at };
}
