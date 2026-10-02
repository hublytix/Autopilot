import { FAKE_HUBSPOT_REFRESH_TOKEN } from '../support/fake-secrets';
import { APIError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createLogger, type LogFields } from '@/server/obs/log';
import {
  ACTION_TOKEN,
  HUBSPOT_ACCESS_TOKEN,
  HUBSPOT_REFRESH_TOKEN,
  JWT,
  LEAD_EMAIL,
  LEAD_MESSAGE,
  MAGIC_LINK_HASH,
  OAUTH_CODE,
  OWNER_EMAIL,
  SESSION_COOKIE,
  SHA256_HEX,
  SUPABASE_SECRET,
  findForbidden,
} from './fixtures';

// Proof for the logger (PLAN §11): whatever a caller passes (allow-listed fields carrying
// secrets, content smuggled in through casts, provider errors quoting content), no fixture
// value reaches the output.

function capture(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  return { lines, logger: createLogger({ sink: (line) => lines.push(line), minLevel: 'debug' }) };
}

describe('logger output never contains content, emails or tokens', () => {
  it('redacts secrets inside allow-listed fields', () => {
    const { lines, logger } = capture();
    logger.warn('request rejected', {
      event: 'http.rejected',
      route: `/a/${ACTION_TOKEN}/send?via=mailto`,
      reason: `bad token ${ACTION_TOKEN} for ${LEAD_EMAIL}`,
      code: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
      requestId: `${JWT}`,
      status: `refresh ${HUBSPOT_REFRESH_TOKEN}`,
      kind: SESSION_COOKIE,
      processingState: `https://app.example.com/auth/confirm#th=${MAGIC_LINK_HASH}`,
      outcome: `https://app.example.com/api/hubspot/oauth/callback?code=${OAUTH_CODE}`,
      provider: SUPABASE_SECRET,
      constraint: SHA256_HEX,
      codes: [OWNER_EMAIL, 'ok'],
    });
    const output = lines.join('\n');
    expect(findForbidden(output)).toBeUndefined();
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(record.route).toBe('/a/[token]/send?[redacted]');
    expect(record.event).toBe('http.rejected');
  });

  it('drops content passed through a cast, and objects passed wholesale', () => {
    const { lines, logger } = capture();
    const smuggled = {
      event: 'lead.drafted',
      leadId: 'lead-1',
      message: LEAD_MESSAGE,
      draft: { subject: 'Re: chairs', body: LEAD_MESSAGE },
      lead: { email: LEAD_EMAIL },
      code: { text: LEAD_MESSAGE },
      codes: [{ email: LEAD_EMAIL }],
    } as unknown as LogFields;
    logger.info('draft ready', smuggled);
    const output = lines.join('\n');
    expect(findForbidden(output)).toBeUndefined();
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({ level: 'info', msg: 'draft ready', event: 'lead.drafted', leadId: 'lead-1', droppedFields: 5 });
  });

  it('logs a provider error without its message', () => {
    const { lines, logger } = capture();
    const error = APIError.generate(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: `messages.0.content: ${LEAD_MESSAGE} <${LEAD_EMAIL}>` } },
      undefined,
      new Headers({ 'request-id': 'req_fixture' }),
    );
    logger.error('draft call failed', { event: 'ai.failed', leadId: 'lead-1' }, error);
    logger.error('parse failed', { event: 'intake.failed' }, new SyntaxError(`Unexpected token in ${LEAD_MESSAGE}`));
    logger.error('wrapped failure', { event: 'job.failed' }, new Error(`failed for ${LEAD_EMAIL}`, { cause: error }));
    const output = lines.join('\n');
    expect(findForbidden(output)).toBeUndefined();
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      level: 'error',
      msg: 'draft call failed',
      event: 'ai.failed',
      leadId: 'lead-1',
      errorName: 'Error',
      httpStatus: 400,
    });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ level: 'error', msg: 'parse failed', event: 'intake.failed', errorName: 'SyntaxError' });
    expect(JSON.parse(lines[2] ?? '{}')).toMatchObject({ level: 'error', msg: 'wrapped failure', event: 'job.failed', errorName: 'Error' });
  });

  it('redacts a message that slipped past the static-literal type', () => {
    const { lines, logger } = capture();
    const dynamic = `lead from ${LEAD_EMAIL} with ${ACTION_TOKEN}` as 'static';
    logger.info(dynamic);
    expect(lines).toHaveLength(1);
    expect(findForbidden(lines.join('\n'))).toBeUndefined();
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({ level: 'info', msg: 'lead from [email] with apt_[redacted]' });
  });

  it.each([
    ['a HubSpot refresh token', FAKE_HUBSPOT_REFRESH_TOKEN],
    ['a sha256 hex hash', SHA256_HEX],
  ])('does not keep %s as a code-shaped message', (_name, value) => {
    const { lines, logger } = capture();
    logger.info(value as 'static');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(value);
  });
});
