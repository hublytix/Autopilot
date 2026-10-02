import 'server-only';
import { Resend } from 'resend';
import { IdempotencyConflictError, PermanentError, TransientError } from '@/server/domain/errors';
import type { Mailer, OutgoingMail, SentMail } from '@/server/ports/mailer';

// The live Mailer (PLAN §4, §8.4, D-27, D-36, RS-SEND-API, RS-IDEMPOTENCY-LIMITS): Resend with
// EMAIL_FROM, html AND text (rendered by us), Reply-To, ASCII tags and the `Idempotency-Key` header.
// The SDK returns `{data, error}` instead of throwing. Errors are classified per D-36:
// - transient (retry later; `retryAfterMs` from Retry-After): rate_limit_exceeded,
//   concurrent_idempotent_requests, application_error, internal_server_error, daily_quota_exceeded,
//   monthly_quota_exceeded, any status ≥ 500 and a null status (network);
// - 409 invalid_idempotent_request → IdempotencyConflictError (an earlier attempt sent this key);
// - everything else → PermanentError with a known code.
// Error messages (which can quote addresses) are dropped; recipients and content are never logged.

/** The part of the Resend SDK this adapter uses (tests pass a stub). */
export interface ResendEmailsClient {
  emails: {
    send(
      payload: {
        from: string;
        to: string[];
        subject: string;
        html: string;
        text: string;
        replyTo?: string;
        tags?: { name: string; value: string }[];
      },
      options: { idempotencyKey: string },
    ): Promise<{
      data: { id: string } | null;
      error: { name: string; statusCode: number | null; message: string } | null;
      headers?: Record<string, string> | null;
    }>;
  };
}

export interface ResendMailerOptions {
  apiKey: string;
  /** EMAIL_FROM. */
  from: string;
  /** For tests; default `new Resend(apiKey)`. */
  client?: ResendEmailsClient | undefined;
}

const TRANSIENT_CODES = [
  'rate_limit_exceeded',
  'concurrent_idempotent_requests',
  'application_error',
  'internal_server_error',
  'daily_quota_exceeded',
  'monthly_quota_exceeded',
] as const;
type ResendTransientCode = (typeof TRANSIENT_CODES)[number];

const PERMANENT_CODES = [
  'invalid_idempotency_key',
  'validation_error',
  'missing_api_key',
  'restricted_api_key',
  'invalid_api_key',
  'not_found',
  'method_not_allowed',
  'invalid_attachment',
  'invalid_from_address',
  'invalid_access',
  'invalid_parameter',
  'invalid_region',
  'missing_required_field',
  'security_error',
] as const;
type ResendPermanentCode = (typeof PERMANENT_CODES)[number];

function oneOf<T extends string>(values: readonly T[], value: string): T | undefined {
  return (values as readonly string[]).includes(value) ? (value as T) : undefined;
}

function retryAfterMs(headers: Record<string, string> | null | undefined): number | undefined {
  const value = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (value === undefined || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

/** Maps a Resend error response to our typed errors (D-36). */
export function classifyResendError(
  error: { name: string; statusCode: number | null },
  headers?: Record<string, string> | null,
): TransientError | PermanentError | IdempotencyConflictError {
  const status = error.statusCode ?? undefined;
  if (error.name === 'invalid_idempotent_request') return new IdempotencyConflictError();
  const transient = oneOf<ResendTransientCode>(TRANSIENT_CODES, error.name);
  if (transient !== undefined) return new TransientError<ResendTransientCode>(transient, { httpStatus: status, retryAfterMs: retryAfterMs(headers) });
  if (status !== undefined && status >= 500) return new TransientError('resend_server_error', { httpStatus: status, retryAfterMs: retryAfterMs(headers) });
  // Named errors with a null status are the SDK's own checks (e.g. missing_required_field), not the network.
  const permanent = oneOf<ResendPermanentCode>(PERMANENT_CODES, error.name);
  if (permanent !== undefined) return new PermanentError<ResendPermanentCode>(permanent, { httpStatus: status });
  if (status === undefined) return new TransientError('application_error', { retryAfterMs: retryAfterMs(headers) });
  return new PermanentError('resend_unknown_error', { httpStatus: status });
}

export class ResendMailer implements Mailer {
  readonly #client: ResendEmailsClient;
  readonly #from: string;

  constructor(options: ResendMailerOptions) {
    this.#client = options.client ?? (new Resend(options.apiKey) as unknown as ResendEmailsClient);
    this.#from = options.from;
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    let response: Awaited<ReturnType<ResendEmailsClient['emails']['send']>>;
    try {
      response = await this.#client.emails.send(
        {
          from: this.#from,
          to: [...mail.to],
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          ...(mail.replyTo === undefined ? {} : { replyTo: mail.replyTo }),
          ...(mail.tags === undefined || mail.tags.length === 0 ? {} : { tags: mail.tags.map((tag) => ({ name: tag.name, value: tag.value })) }),
        },
        { idempotencyKey: mail.idempotencyKey },
      );
    } catch {
      // The SDK reports API errors in `error`; a throw is a network or runtime failure.
      throw new TransientError('application_error');
    }
    if (response.error !== null) throw classifyResendError(response.error, response.headers);
    if (response.data === null || typeof response.data.id !== 'string' || response.data.id.length === 0) {
      throw new TransientError('application_error');
    }
    return { providerMessageId: response.data.id };
  }
}
