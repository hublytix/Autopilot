import 'server-only';

// Live: Resend with `EMAIL_FROM`; click and open tracking off (D-26). Fake: the dev outbox table,
// memory (tests) or ./outbox (simulate), with Resend's idempotency semantics.
//
// Errors (from '@/server/domain/errors'), classified per D-36, `code` = Resend's error name:
// - TransientError: rate_limit_exceeded, concurrent_idempotent_requests, application_error,
//   internal_server_error, any 5xx, network (null status), and daily_quota_exceeded /
//   monthly_quota_exceeded (which also warrant one admin alert). `retryAfterMs` from Retry-After.
// - PermanentError: everything else (validation_error, key or domain errors, …).
// - IdempotencyConflictError: 409 invalid_idempotent_request, i.e. this key already sent a different
//   payload; the reservation is marked sent (PLAN §8.4 step 4).

/** ASCII letters, digits, `_` and `-` only: kinds and ids, never names or addresses. */
export interface MailTag {
  name: string;
  value: string;
}

export interface OutgoingMail {
  to: readonly string[];
  /** The owner's address on lead emails (D-27); `EMAIL_REPLY_TO` on magic-link and billing emails. */
  replyTo?: string | undefined;
  subject: string;
  html: string;
  text: string;
  /** Include `kind` (and `lead` where there is one): the fake outbox names its files from them. */
  tags?: readonly MailTag[] | undefined;
  /** `{ENV_NAMESPACE}:{dedupe_key}` (PLAN §8.4); same key + same payload returns the original send. */
  idempotencyKey: string;
}

export interface SentMail {
  providerMessageId: string;
}

export interface Mailer {
  /** Sends one email from `EMAIL_FROM`; never logs the payload. */
  send(mail: OutgoingMail): Promise<SentMail>;
}
