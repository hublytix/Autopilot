import { describe, expect, it } from 'vitest';
import { IdempotencyConflictError, PermanentError, TransientError } from '@/server/domain/errors';
import type { OutgoingMail } from '@/server/ports';
import { classifyResendError, ResendMailer, type ResendEmailsClient } from './resend-mailer';

type SendArgs = Parameters<ResendEmailsClient['emails']['send']>;
type SendResult = Awaited<ReturnType<ResendEmailsClient['emails']['send']>>;

function stub(result: SendResult | (() => Promise<SendResult>)): { client: ResendEmailsClient; calls: SendArgs[] } {
  const calls: SendArgs[] = [];
  const client: ResendEmailsClient = {
    emails: {
      send: async (...args) => {
        calls.push(args);
        return typeof result === 'function' ? result() : result;
      },
    },
  };
  return { client, calls };
}

const MAIL: OutgoingMail = {
  to: ['owner@example.com'],
  replyTo: 'owner@example.com',
  subject: 'New lead: Asha — your reply is ready',
  html: '<p>Asha asked about a water heater.</p>',
  text: 'Asha asked about a water heater.',
  tags: [
    { name: 'kind', value: 'new_lead' },
    { name: 'lead', value: 'L1' },
  ],
  idempotencyKey: 'prod:notify:L1:initial:r0',
};

function errorResult(name: string, statusCode: number | null, headers: Record<string, string> | null = null): SendResult {
  return { data: null, error: { name, statusCode, message: 'Cannot send to owner@example.com: Asha asked about a water heater' }, headers };
}

async function sendError(result: SendResult): Promise<unknown> {
  const { client } = stub(result);
  return new ResendMailer({ apiKey: 're_test', from: 'Autopilot <noreply@example.com>', client }).send(MAIL).catch((e: unknown) => e);
}

describe('ResendMailer', () => {
  it('sends html and text with Reply-To, tags and the Idempotency-Key, and returns the provider id', async () => {
    const { client, calls } = stub({ data: { id: 'email_123' }, error: null, headers: {} });
    const mailer = new ResendMailer({ apiKey: 're_test', from: 'Autopilot <noreply@example.com>', client });
    expect(await mailer.send(MAIL)).toEqual({ providerMessageId: 'email_123' });
    expect(calls).toEqual([
      [
        {
          from: 'Autopilot <noreply@example.com>',
          to: ['owner@example.com'],
          subject: MAIL.subject,
          html: MAIL.html,
          text: MAIL.text,
          replyTo: 'owner@example.com',
          tags: [
            { name: 'kind', value: 'new_lead' },
            { name: 'lead', value: 'L1' },
          ],
        },
        { idempotencyKey: 'prod:notify:L1:initial:r0' },
      ],
    ]);
  });

  it.each([
    ['rate_limit_exceeded', 429],
    ['concurrent_idempotent_requests', 409],
    ['application_error', null],
    ['internal_server_error', 500],
    ['daily_quota_exceeded', 429],
    ['monthly_quota_exceeded', 429],
  ] as const)('classifies %s as transient with its own code', async (name, status) => {
    const error = await sendError(errorResult(name, status));
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ code: name, message: name });
  });

  it('treats any 5xx and a null status (network) as transient', () => {
    expect(classifyResendError({ name: 'validation_error', statusCode: 502 })).toMatchObject({ kind: 'transient', code: 'resend_server_error' });
    expect(classifyResendError({ name: 'something_new', statusCode: null })).toMatchObject({ kind: 'transient', code: 'application_error' });
  });

  it('reads Retry-After into retryAfterMs', () => {
    expect(classifyResendError({ name: 'rate_limit_exceeded', statusCode: 429 }, { 'retry-after': '2' })).toMatchObject({ retryAfterMs: 2000 });
  });

  it('maps 409 invalid_idempotent_request to IdempotencyConflictError', async () => {
    expect(await sendError(errorResult('invalid_idempotent_request', 409))).toBeInstanceOf(IdempotencyConflictError);
  });

  it.each([
    ['validation_error', 422],
    ['invalid_from_address', 422],
    ['invalid_api_key', 403],
    ['restricted_api_key', 401],
    ['missing_required_field', null],
    ['invalid_idempotency_key', 400],
  ] as const)('classifies %s as permanent', async (name, status) => {
    const error = await sendError(errorResult(name, status));
    expect(error).toBeInstanceOf(PermanentError);
    expect(error).toMatchObject({ code: name });
  });

  it('gives an unknown 4xx error a known code', async () => {
    expect(await sendError(errorResult('brand_new_error', 418))).toMatchObject({ kind: 'permanent', code: 'resend_unknown_error' });
  });

  it('never carries recipients or content in the error', async () => {
    const error = await sendError(errorResult('validation_error', 422));
    const serialised = JSON.stringify(error) + String(error) + (error instanceof Error ? (error.stack ?? '') : '');
    expect(serialised).not.toContain('owner@example.com');
    expect(serialised).not.toContain('water heater');
  });

  it('maps a thrown SDK error to a transient error', async () => {
    const { client } = stub(() => Promise.reject(new Error('socket hang up for owner@example.com')));
    const error: unknown = await new ResendMailer({ apiKey: 're_test', from: 'a@example.com', client }).send(MAIL).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'transient', code: 'application_error' });
    expect(String(error)).not.toContain('owner@example.com');
  });

  it('omits replyTo and tags when there are none', async () => {
    const { client, calls } = stub({ data: { id: 'email_1' }, error: null });
    const { replyTo: _r, tags: _t, ...bare } = MAIL;
    await new ResendMailer({ apiKey: 're_test', from: 'a@example.com', client }).send(bare);
    expect(calls[0]?.[0]).not.toHaveProperty('replyTo');
    expect(calls[0]?.[0]).not.toHaveProperty('tags');
  });
});
