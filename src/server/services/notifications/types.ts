import 'server-only';
import { z } from 'zod';
import { NOTIFICATION_KINDS, NOTIFICATION_STATUSES, type ActionTokenPurpose, type NotificationKind, type NotificationStatus } from '@/server/domain/types';
import type { Db } from '@/server/db';
import type { JobRow } from '@/server/jobs/types';
import type { MailTag } from '@/server/ports';
import type { MintedTokens } from '@/server/security/action-tokens';
import type { NotificationPredicate } from './predicates';

/** One `notifications_sent` row: ids, statuses and times only. */
export interface NotificationRow {
  readonly id: string;
  readonly dedupeKey: string;
  readonly accountId: string | null;
  readonly leadId: string | null;
  readonly kind: NotificationKind;
  readonly status: NotificationStatus;
  readonly providerMessageId: string | null;
  readonly recipientsCount: number;
  /** Never reset: bounds resumes to Resend's 24 h idempotency window. */
  readonly firstReservedAt: Date;
  readonly reservedAt: Date;
  readonly sendAttempts: number;
  readonly sweeperResumes: number;
  readonly sentAt: Date | null;
}

export const NOTIFICATION_COLUMNS =
  'id, dedupe_key, account_id, lead_id, kind, status, provider_message_id, recipients_count, first_reserved_at, reserved_at, ' +
  'send_attempts, sweeper_resumes, sent_at';

const rowSchema = z.object({
  id: z.string(),
  dedupe_key: z.string(),
  account_id: z.string().nullable(),
  lead_id: z.string().nullable(),
  kind: z.enum(NOTIFICATION_KINDS),
  status: z.enum(NOTIFICATION_STATUSES),
  provider_message_id: z.string().nullable(),
  recipients_count: z.number(),
  first_reserved_at: z.date(),
  reserved_at: z.date(),
  send_attempts: z.number(),
  sweeper_resumes: z.number(),
  sent_at: z.date().nullable(),
});

export function toNotificationRow(raw: unknown): NotificationRow {
  const r = rowSchema.parse(raw);
  return {
    id: r.id,
    dedupeKey: r.dedupe_key,
    accountId: r.account_id,
    leadId: r.lead_id,
    kind: r.kind,
    status: r.status,
    providerMessageId: r.provider_message_id,
    recipientsCount: r.recipients_count,
    firstReservedAt: r.first_reserved_at,
    reservedAt: r.reserved_at,
    sendAttempts: r.send_attempts,
    sweeperResumes: r.sweeper_resumes,
    sentAt: r.sent_at,
  };
}

/** The email for one send. Built after the tokens are committed; never logged. */
export interface RenderedMail {
  to: readonly string[];
  replyTo?: string | undefined;
  subject: string;
  html: string;
  text: string;
  /** ASCII kinds and ids only. A `kind` tag with the notification kind is added when missing. */
  tags?: readonly MailTag[] | undefined;
}

/**
 * Runs inside the transaction that marks the notification sent (PLAN §8.4 step 5): the lead
 * timestamp, and for the first notification the follow-up job rows. Job rows it returns are
 * published after commit. `providerMessageId` is null when Resend's 409 showed an earlier attempt
 * already sent the email.
 */
export type OnSent = (tx: Db, providerMessageId: string | null) => Promise<void | readonly (JobRow | null)[]>;

/** How to (re)send one reservation. */
export interface NotificationSendPlan {
  /** This kind's predicates from `NotificationPredicates`, checked at reservation and at every takeover. */
  predicates: NotificationPredicate;
  /** Button purposes: one fresh token each, committed before the send. */
  buttons?: readonly ActionTokenPurpose[] | undefined;
  /** The draft the tokens act on. */
  draftId?: string | null | undefined;
  render(tokens: MintedTokens): RenderedMail | Promise<RenderedMail>;
  onSent?: OnSent | undefined;
}

export interface ReserveAndSendInput extends NotificationSendPlan {
  kind: NotificationKind;
  /** From `NotificationKeys`, without the `{ENV_NAMESPACE}:` prefix. */
  dedupeKey: string;
  accountId: string | null;
  leadId?: string | null | undefined;
  /**
   * The caller's ownership check (a job's `ctx.assertOwned`): the reservation, or the takeover of an
   * earlier attempt's, runs in one transaction after it, so a job cancelled meanwhile never reserves.
   */
  guard?: ((tx: Db) => Promise<void>) | undefined;
}

export type NotificationSkipReason =
  /** No row and the reservation predicates failed (or the takeover found them failing). */
  | 'predicates'
  /** The reservation is `failed`. */
  | 'failed_earlier'
  /** Another attempt changed the reservation first; it is responsible for the send. */
  | 'busy'
  /** The existing reservation belongs to a kind that may not take it over. */
  | 'kind_mismatch'
  /** sendReserved found no reservation. */
  | 'not_reserved'
  /** No renderer is registered for the kind (the sweeper leaves the row). */
  | 'no_renderer';

export type SendResult =
  | { readonly status: 'sent'; readonly providerMessageId: string | null; readonly viaIdempotencyConflict: boolean }
  | { readonly status: 'already_sent' }
  | { readonly status: 'skipped'; readonly reason: NotificationSkipReason }
  | { readonly status: 'failed'; readonly code: string };

export type { MintedTokens };
