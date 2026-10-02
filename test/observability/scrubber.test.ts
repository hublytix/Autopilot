import { FAKE_HUBSPOT_REFRESH_TOKEN } from '../support/fake-secrets';
import type { Breadcrumb, ErrorEvent, Integration } from '@sentry/core';
import { describe, expect, it } from 'vitest';
import { MAX_REDACT_INPUT, REDACTED, TRUNCATED, isSafeCode, isSafeErrorCode, redact, sanitizeUrl } from '@/shared/observability/redact';
import { scrubBreadcrumb, scrubEvent } from '@/shared/observability/scrub';
import {
  REMOVED_SENTRY_INTEGRATIONS,
  buildSentryOptions,
  filterSentryIntegrations,
  isBrowserSentryAllowedPath,
  sentryDataCollection,
  sentryDsn,
  tracingRequestedByEnv,
} from '@/shared/observability/sentry-options';
import {
  ACTION_TOKEN,
  ANTHROPIC_KEY,
  DRAFT_BODY,
  HUBSPOT_ACCESS_TOKEN,
  HUBSPOT_REFRESH_TOKEN,
  JWT,
  LEAD_EMAIL,
  LEAD_MESSAGE,
  MAGIC_LINK_HASH,
  OAUTH_CODE,
  OAUTH_STATE,
  OWNER_EMAIL,
  RAZORPAY_KEY,
  RESEARCH_TOKEN,
  SESSION_COOKIE,
  SHA256_HEX,
  SUPABASE_SECRET,
  findForbidden,
} from './fixtures';

// Golden cases for the shared redaction and the Sentry scrubbers (PLAN §11, D-23).

describe('redact()', () => {
  it.each([
    ['an action-link URL with a query', `https://app.example.com/a/${ACTION_TOKEN}/send?via=mailto`, 'https://app.example.com/a/[token]/send?[redacted]'],
    ['a relative action path', `GET /a/${ACTION_TOKEN}/edit`, 'GET /a/[token]/edit'],
    ['an action path that is already a route pattern', 'POST /a/[token]/edit', 'POST /a/[token]/edit'],
    ['an OAuth callback', `https://app.example.com/api/hubspot/oauth/callback?code=${OAUTH_CODE}&state=${OAUTH_STATE}`, 'https://app.example.com/api/hubspot/oauth/callback?[redacted]'],
    ['a magic-link fragment', `https://app.example.com/auth/confirm#th=${MAGIC_LINK_HASH}&type=email`, 'https://app.example.com/auth/confirm#[redacted]'],
    ['a relative path with a query', `/dashboard?reconnect=1&code=${OAUTH_CODE}`, '/dashboard?[redacted]'],
    ['URL credentials', 'postgresql://postgres.ref:pw-fixture@pooler.example.com:6543/postgres', 'postgresql://[redacted]@pooler.example.com:6543/postgres'],
    ['a mailto compose link', `mailto:${LEAD_EMAIL}?subject=Re&body=${encodeURIComponent(DRAFT_BODY)}`, 'mailto:[redacted]'],
    ['emails', `sent to ${LEAD_EMAIL} and ${OWNER_EMAIL}`, 'sent to [email] and [email]'],
    ['a bearer token', `Authorization: Bearer ${HUBSPOT_ACCESS_TOKEN}`, 'Authorization: Bearer [redacted]'],
    ['a JWT', `token ${JWT}`, 'token [jwt]'],
    ['an action token in text', `minted ${ACTION_TOKEN}`, 'minted apt_[redacted]'],
    ['a HubSpot refresh token', `refresh ${HUBSPOT_REFRESH_TOKEN} failed`, `refresh ${REDACTED} failed`],
    ['the research token fixture', `call failed with ${RESEARCH_TOKEN}`, `call failed with ${REDACTED}`],
    ['vendor keys', `${SUPABASE_SECRET} ${ANTHROPIC_KEY} ${RAZORPAY_KEY} re_Fx7Kq2Lm9Np4 sig_Fx7Kq2Lm9Np4`, 'sb_secret_[redacted] sk-ant-[redacted] rzp_live_[redacted] re_[redacted] sig_[redacted]'],
    ['a cookie', `cookie: ${SESSION_COOKIE}; theme=dark`, 'cookie: ap_session=[redacted]; theme=dark'],
    ['JSON secrets', `{"refresh_token":"${HUBSPOT_REFRESH_TOKEN}","portalId":123}`, '{"refresh_token":"[redacted]","portalId":123}'],
    ['a long hex hash', `hash ${SHA256_HEX}`, 'hash [hex]'],
    ['a long base64 secret', `key ${HUBSPOT_ACCESS_TOKEN}`, 'key [secret]'],
    ['our own ciphertext', 'v1.630dcd29.oKGio6Slpqeoqaqr.iHlNACSqY95PB-WxZVejvRPPdHT20yZB-WtD4xrOEGS3EyKa.oQdQQoXOveHyj8ujA7KVLw', '[ciphertext]'],
  ])('masks %s', (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it.each([
    ['an error code', 'hubspot_rate_limited'],
    ['an event name with ids', 'lead.created 3f1e2d4c-5b6a-4798-8a1b-2c3d4e5f6a7b portal 12345678'],
    ['a static sentence', 'job failed after 5 attempts'],
    ['a snake_case identifier', 'hubspot_connections_refresh_token_ciphertext'],
    ['a route pattern', 'GET /dashboard/leads/[id]'],
    ['an empty string', ''],
  ])('keeps %s', (_name, input) => {
    expect(redact(input)).toBe(input);
  });

  it('is idempotent', () => {
    const once = redact(`GET https://app.example.com/a/${ACTION_TOKEN}/send?x=1 by ${LEAD_EMAIL} ${JWT}`);
    expect(redact(once)).toBe(once);
  });

  it('cuts long input at a word boundary, so no half of a token survives', () => {
    const filler = 'a '.repeat((MAX_REDACT_INPUT - 12) / 2);
    const out = redact(`${filler}${ACTION_TOKEN} tail`);
    expect(out.endsWith(TRUNCATED)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_REDACT_INPUT + TRUNCATED.length);
    expect(out).not.toContain(ACTION_TOKEN.slice(0, 8));
    expect(redact('x'.repeat(MAX_REDACT_INPUT + 1))).toBe(TRUNCATED);
  });

  it(
    'handles adversarial input in linear time',
    () => {
      for (const unit of ['a.', 'a-', 'a=', '"a":"\\', 'a@a.', '/a/', 'eyJ', 'a1B', 'na1-', 'x?']) {
        expect(typeof redact(unit.repeat(MAX_REDACT_INPUT / unit.length))).toBe('string');
      }
    },
    5_000,
  );

  it('accepts only lower-case code-shaped strings as safe codes', () => {
    expect(isSafeCode('db_error')).toBe(true);
    expect(isSafeCode('crypto_auth_failed')).toBe(true);
    expect(isSafeCode('obs.register')).toBe(true);
    expect(isSafeCode('FIXTURE_LEAD_MESSAGE_42')).toBe(false);
    expect(isSafeCode('400 {"type":"error"}')).toBe(false);
    expect(isSafeCode('a'.repeat(65))).toBe(false);
  });

  // Code-shaped is not enough: these are lower-case, space-free and short, and still secrets or ids.
  it.each([
    ['a HubSpot refresh token', FAKE_HUBSPOT_REFRESH_TOKEN],
    ['the fixture refresh token', HUBSPOT_REFRESH_TOKEN],
    ['a sha224 hex hash (56)', 'd14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f'],
    ['a sha256 hex hash (64)', SHA256_HEX],
    ['a short hex token', 'a3f9c2e17b4d8e06a3f9'],
    ['a long digit run', 'contact_5550100123'],
    ['an email', 'maya@example.com'],
  ])('refuses %s as a safe code', (_name, value) => {
    expect(isSafeCode(value)).toBe(false);
    expect(isSafeErrorCode(value)).toBe(false);
  });

  it.each([
    ['a lower-case domain', 'brightside-plumbing.example'],
    ['a lead first name', 'maya'],
    ['a dotted event name', 'lead.created'],
    ['a dashed slug', 'request-a-quote'],
  ])('keeps %s out of error codes (snake_case with an underscore only)', (_name, value) => {
    expect(isSafeErrorCode(value)).toBe(false);
  });

  it.each(['db_error', 'crypto_auth_failed', 'hubspot_rate_limited', 'http_429', 'concurrent_idempotent_requests'])(
    'keeps the error code %s',
    (value) => {
      expect(isSafeErrorCode(value)).toBe(true);
    },
  );
});

describe('sanitizeUrl()', () => {
  it.each([
    [`https://app.example.com/a/${ACTION_TOKEN}/dismiss`, 'https://app.example.com/a/[token]/dismiss'],
    [`/a/${ACTION_TOKEN}/send?via=mailto`, '/a/[token]/send?[redacted]'],
    [`https://app.example.com/unsubscribe/${encodeURIComponent(LEAD_EMAIL)}`, 'https://app.example.com/unsubscribe/[email]'],
    ['https://app.example.com/dashboard/leads/3f1e2d4c-5b6a-4798-8a1b-2c3d4e5f6a7b', 'https://app.example.com/dashboard/leads/3f1e2d4c-5b6a-4798-8a1b-2c3d4e5f6a7b'],
    [`tel:+15550100`, 'tel:[redacted]'],
    ['not a url at all', 'not a url at all'],
  ])('%s', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });
});

/** An error event carrying every kind of sensitive value in every field Sentry fills. */
function goldenEvent(): ErrorEvent {
  return {
    type: undefined,
    event_id: '0123456789abcdef0123456789abcdef',
    timestamp: 1_790_000_000,
    level: 'error',
    platform: 'node',
    server_name: 'lambda-1',
    environment: 'production',
    release: 'abc123',
    message: `processing ${LEAD_EMAIL}`,
    logentry: { message: `lead from ${LEAD_EMAIL}`, params: [LEAD_MESSAGE] },
    transaction: `POST /a/${ACTION_TOKEN}/edit`,
    request: {
      method: 'POST',
      url: `https://app.example.com/a/${ACTION_TOKEN}/edit?draft=${encodeURIComponent(DRAFT_BODY)}`,
      query_string: `draft=${encodeURIComponent(DRAFT_BODY)}&code=${OAUTH_CODE}`,
      data: { subject: 'Re: chairs', body: DRAFT_BODY, message: LEAD_MESSAGE },
      cookies: { ap_session: SESSION_COOKIE },
      headers: { authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`, cookie: SESSION_COOKIE, referer: `https://mail.example.com/?q=${LEAD_EMAIL}` },
      env: { REMOTE_ADDR: '203.0.113.7' },
    },
    exception: {
      values: [
        {
          type: 'SyntaxError',
          value: `Unexpected token 'F', "${LEAD_MESSAGE}" is not valid JSON`,
          mechanism: { type: 'auto.function.nextjs.on_request_error', handled: false, data: { input: LEAD_MESSAGE } },
          stacktrace: {
            frames: [
              {
                filename: '/var/task/.next/server/app/a/[token]/edit/page.js',
                abs_path: '/var/task/.next/server/app/a/[token]/edit/page.js',
                function: 'submitEdit',
                lineno: 10,
                colno: 5,
                in_app: true,
                context_line: `const draft = "${DRAFT_BODY}"`,
                pre_context: [LEAD_MESSAGE],
                post_context: [LEAD_EMAIL],
                vars: { token: ACTION_TOKEN, email: LEAD_EMAIL },
              },
              { filename: `https://app.example.com/_next/static/chunks/main.js?token=${ACTION_TOKEN}`, function: 'onClick', lineno: 1, colno: 2 },
            ],
          },
        },
        { type: 'DbError', value: 'db_error', mechanism: { type: 'chained', source: 'cause' } },
      ],
    },
    breadcrumbs: [
      { category: 'console', message: `log ${LEAD_MESSAGE}`, level: 'log' },
      { category: 'lead', message: `processing lead: ${LEAD_MESSAGE}` },
      { category: 'navigation', data: { from: '/dashboard', to: `/a/${ACTION_TOKEN}/send?via=mailto` } },
      { category: 'fetch', type: 'http', data: { method: 'GET', url: `https://api.hubapi.com/crm/v3/objects/contacts?email=${LEAD_EMAIL}`, status_code: 200, 'url.query': `email=${LEAD_EMAIL}` } },
      { category: 'job', message: 'lead_process' },
    ],
    contexts: {
      trace: { trace_id: 'abcdefabcdefabcdefabcdefabcdefab', span_id: 'abcdefabcdefabcd', data: { 'http.url': `/a/${ACTION_TOKEN}/send` } },
      nextjs: { request_path: `/a/${ACTION_TOKEN}/send?via=mailto`, router_kind: 'App Router', router_path: '/a/[token]/send', route_type: 'render' },
      runtime: { name: 'node', version: 'v22.12.0' },
      lead: { email: LEAD_EMAIL, firstName: 'Fixture', message: LEAD_MESSAGE, id: '3f1e2d4c-5b6a-4798-8a1b-2c3d4e5f6a7b' },
    },
    tags: { runtime: 'node', token: ACTION_TOKEN, route: `/a/${ACTION_TOKEN}/send`, email: LEAD_EMAIL },
    extra: {
      debug: { token: RESEARCH_TOKEN, note: `Authorization: Bearer ${RESEARCH_TOKEN}` },
      leadId: '3f1e2d4c-5b6a-4798-8a1b-2c3d4e5f6a7b',
      attempt: 3,
      draft: DRAFT_BODY,
      nested: { deep: { url: `https://app.example.com/a/${ACTION_TOKEN}/copy?x=1`, note: `see ${OWNER_EMAIL}` } },
      __serialized__: { message: LEAD_MESSAGE },
    },
    user: { id: 'user-123', email: OWNER_EMAIL, ip_address: '203.0.113.7' },
    fingerprint: ['{{ default }}', `lead-${LEAD_EMAIL}`],
    sdkProcessingMetadata: {
      dynamicSamplingContext: { trace_id: 'abcdefabcdefabcdefabcdefabcdefab', public_key: 'pk', transaction: `GET /a/${ACTION_TOKEN}/send`, sampled: 'false' },
      normalizedRequest: { url: `/a/${ACTION_TOKEN}/send` },
      ipAddress: '203.0.113.7',
    },
  };
}

describe('scrubEvent() (beforeSend)', () => {
  it('produces the golden event: nothing sensitive left, debugging structure kept', () => {
    expect(scrubEvent(goldenEvent())).toEqual({
      type: undefined,
      event_id: '0123456789abcdef0123456789abcdef',
      timestamp: 1_790_000_000,
      level: 'error',
      platform: 'node',
      environment: 'production',
      release: 'abc123',
      message: 'processing [email]',
      logentry: { message: 'lead from [email]' },
      transaction: 'POST /a/[token]/edit',
      request: { method: 'POST', url: 'https://app.example.com/a/[token]/edit?[redacted]' },
      exception: {
        values: [
          {
            type: 'SyntaxError',
            value: REDACTED,
            mechanism: { type: 'auto.function.nextjs.on_request_error', handled: false },
            stacktrace: {
              frames: [
                {
                  filename: '/var/task/.next/server/app/a/[token]/edit/page.js',
                  abs_path: '/var/task/.next/server/app/a/[token]/edit/page.js',
                  function: 'submitEdit',
                  lineno: 10,
                  colno: 5,
                  in_app: true,
                },
                { filename: 'https://app.example.com/_next/static/chunks/main.js', function: 'onClick', lineno: 1, colno: 2 },
              ],
            },
          },
          { type: 'DbError', value: 'db_error', mechanism: { type: 'chained', source: 'cause' } },
        ],
      },
      breadcrumbs: [
        { category: 'lead', message: REDACTED },
        { category: 'navigation', data: { from: '/dashboard', to: '/a/[token]/send?[redacted]' } },
        { category: 'fetch', type: 'http', data: { method: 'GET', url: 'https://api.hubapi.com/crm/v3/objects/contacts?[redacted]', status_code: 200, 'url.query': REDACTED } },
        { category: 'job', message: 'lead_process' },
      ],
      contexts: {
        trace: { trace_id: 'abcdefabcdefabcdefabcdefabcdefab', span_id: 'abcdefabcdefabcd' },
        nextjs: { request_path: '/a/[token]/send?[redacted]', router_kind: 'App Router', router_path: '/a/[token]/send', route_type: 'render' },
        runtime: { name: 'node', version: 'v22.12.0' },
        lead: { email: REDACTED, firstName: REDACTED, message: REDACTED, id: '3f1e2d4c-5b6a-4798-8a1b-2c3d4e5f6a7b' },
      },
      tags: { runtime: 'node', route: '/a/[token]/send' },
      extra: {
        debug: { token: REDACTED, note: 'Authorization: Bearer [redacted]' },
        leadId: '3f1e2d4c-5b6a-4798-8a1b-2c3d4e5f6a7b',
        attempt: 3,
        draft: REDACTED,
        nested: { deep: { url: 'https://app.example.com/a/[token]/copy?[redacted]', note: 'see [email]' } },
        __serialized__: REDACTED,
      },
      user: { id: 'user-123' },
      fingerprint: ['{{ default }}', '[email]'],
      sdkProcessingMetadata: { dynamicSamplingContext: { trace_id: 'abcdefabcdefabcdefabcdefabcdefab', public_key: 'pk', sampled: 'false' } },
    });
  });

  it('leaves no fixture value anywhere in the serialised event', () => {
    const serialised = JSON.stringify(scrubEvent(goldenEvent()));
    expect(findForbidden(serialised)).toBeUndefined();
    expect(serialised).not.toContain('203.0.113.7');
    expect(serialised).not.toContain('Re: chairs');
  });

  it('does not modify its input', () => {
    const event = goldenEvent();
    const before = JSON.stringify(event);
    scrubEvent(event);
    expect(JSON.stringify(event)).toBe(before);
  });

  it('keeps error codes and drops provider messages, whatever the error type', () => {
    const scrubbed = scrubEvent({
      type: undefined,
      exception: {
        values: [
          { type: 'BadRequestError', value: `400 {"type":"error","error":{"message":"${LEAD_MESSAGE}"}}` },
          { type: 'TransientError', value: 'hubspot_rate_limited' },
          { type: 'Error', value: 'FIXTURE_LEAD_MESSAGE_42' },
          { type: `Weird ${LEAD_EMAIL}`, value: 'x' },
        ],
      },
    });
    expect(scrubbed.exception?.values?.map((value) => [value.type, value.value])).toEqual([
      ['BadRequestError', REDACTED],
      ['TransientError', 'hubspot_rate_limited'],
      ['Error', REDACTED],
      ['Error', REDACTED],
    ]);
  });

  // [AI-SDK-LOGGING-PRIVACY]: shapes that would carry model output or request text if an LLM error
  // ever reached Sentry. The adapter never forwards them; the scrubber must still drop them.
  it.each([
    ['a JSON.parse SyntaxError over model output', `Unexpected token 'S', "Sorry, I c"... is not valid JSON`],
    ['a JSON.parse SyntaxError quoting lead text', `Unexpected token 'F', "${LEAD_MESSAGE.slice(0, 10)}"... is not valid JSON`],
    ['an Anthropic SDK APIError message', '400 messages.0.content.0.text: FIXTURE_LEAD_MESSAGE_42 is too long'],
    ['an Anthropic SDK error body', `400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0: ${DRAFT_BODY}"}}`],
  ])('drops %s from exception values and breadcrumbs', (_name, value) => {
    const scrubbed = scrubEvent({
      type: undefined,
      exception: { values: [{ type: 'SyntaxError', value }] },
      breadcrumbs: [{ category: 'job', message: value }],
    });
    expect(scrubbed.exception?.values?.[0]?.value).toBe(REDACTED);
    expect(scrubbed.breadcrumbs?.[0]?.message).toBe(REDACTED);
    const serialised = JSON.stringify(scrubbed);
    for (const marker of ['Sorry, I c', 'FIXTURE_LEAD_MESSAGE_42', 'FIXTURE_DRAFT_BODY_77', LEAD_MESSAGE.slice(0, 10)]) {
      expect(serialised).not.toContain(marker);
    }
  });

  it.each([
    ['a HubSpot refresh token', FAKE_HUBSPOT_REFRESH_TOKEN],
    ['a 56-character hex hash', 'd14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f'],
    ['a 64-character hex hash', SHA256_HEX],
    ['a 60-character hex token', 'ab12'.repeat(15)],
    ['a lower-case domain', 'brightside-plumbing.example'],
    ['a lead first name', 'maya'],
  ])('never keeps %s as an exception value or breadcrumb message', (_name, value) => {
    const scrubbed = scrubEvent({
      type: undefined,
      exception: { values: [{ type: 'Error', value }] },
      breadcrumbs: [{ category: 'job', message: value }],
    });
    expect(scrubbed.exception?.values?.[0]?.value).toBe(REDACTED);
    expect(scrubbed.breadcrumbs?.[0]?.message).toBe(REDACTED);
    expect(scrubBreadcrumb({ category: 'job', message: value })?.message).toBe(REDACTED);
    expect(JSON.stringify(scrubbed)).not.toContain(value);
  });

  it('drops the host name (server_name)', () => {
    expect(scrubEvent({ type: undefined, server_name: 'ip-10-0-0-1.ec2.internal' })).not.toHaveProperty('server_name');
  });

  it('scrubs thread stack traces too', () => {
    const scrubbed = scrubEvent({
      type: undefined,
      threads: { values: [{ id: 1, stacktrace: { frames: [{ function: 'f', vars: { email: LEAD_EMAIL }, context_line: LEAD_MESSAGE }] } }] },
    });
    expect(scrubbed.threads).toEqual({ values: [{ id: 1, stacktrace: { frames: [{ function: 'f' }] } }] });
  });
});

describe('scrubBreadcrumb() (beforeBreadcrumb)', () => {
  it('drops console breadcrumbs', () => {
    expect(scrubBreadcrumb({ category: 'console', message: LEAD_MESSAGE, data: { arguments: [LEAD_EMAIL] } })).toBeNull();
  });

  it.each<[string, Breadcrumb, Breadcrumb]>([
    ['a lead-content message', { category: 'lead', message: `processing lead: ${LEAD_MESSAGE}` }, { category: 'lead', message: REDACTED }],
    ['a code message', { category: 'job', message: 'brief_generate', level: 'info' }, { category: 'job', message: 'brief_generate', level: 'info' }],
    [
      'a navigation to an action link',
      { category: 'navigation', data: { from: `/a/${ACTION_TOKEN}/send`, to: `/auth/confirm#th=${MAGIC_LINK_HASH}` } },
      { category: 'navigation', data: { from: '/a/[token]/send', to: '/auth/confirm#[redacted]' } },
    ],
    [
      'an xhr breadcrumb',
      { category: 'xhr', type: 'http', data: { method: 'POST', url: `/api/billing/checkout?session=${SESSION_COOKIE}`, status_code: 303 } },
      { category: 'xhr', type: 'http', data: { method: 'POST', url: '/api/billing/checkout?[redacted]', status_code: 303 } },
    ],
    [
      'a ui.click on an element whose selector carries content',
      { category: 'ui.click', message: `button[aria-label="Reply to ${LEAD_EMAIL}"]` },
      { category: 'ui.click', message: REDACTED },
    ],
  ])('scrubs %s', (_name, input, expected) => {
    expect(scrubBreadcrumb(input)).toEqual(expected);
  });
});

describe('shared Sentry options (D-23)', () => {
  const options = buildSentryOptions({ dsn: 'https://public@o0.ingest.sentry.invalid/0' });

  it('turn every v11 data-collection option off', () => {
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    });
    expect(sentryDataCollection()).not.toBe(sentryDataCollection());
  });

  it('enable no tracing and propagate no trace headers', () => {
    expect(options).not.toHaveProperty('tracesSampleRate');
    expect(options).not.toHaveProperty('tracesSampler');
    expect(options).not.toHaveProperty('sendDefaultPii');
    expect(options).not.toHaveProperty('includeLocalVariables');
    expect(options.tracePropagationTargets).toEqual([]);
  });

  it('remove the Anthropic_AI, Console, BrowserTracing, session and Spotlight integrations', () => {
    const fake = (name: string): Integration => ({ name });
    const kept = filterSentryIntegrations(
      ['Http', 'Anthropic_AI', 'Console', 'BrowserTracing', 'BrowserSession', 'ProcessSession', 'Spotlight', 'SpotlightBrowser', 'LinkedErrors'].map(fake),
    );
    expect(kept.map((integration) => integration.name)).toEqual(['Http', 'LinkedErrors']);
    expect(REMOVED_SENTRY_INTEGRATIONS).toEqual([
      'Anthropic_AI',
      'Console',
      'BrowserTracing',
      'BrowserSession',
      'ProcessSession',
      'Spotlight',
      'SpotlightBrowser',
    ]);
    expect(options.integrations).toBe(filterSentryIntegrations);
  });

  it('pin the egress and debug switches off, so SENTRY_SPOTLIGHT and SENTRY_DEBUG cannot turn them on', () => {
    expect(options).toMatchObject({ spotlight: false, debug: false, includeServerName: false, enhanceFetchErrorMessages: false });
  });

  it('scrub in beforeSend and beforeBreadcrumb, and send no logs or metrics', () => {
    const event = options.beforeSend(goldenEvent(), {});
    expect(findForbidden(JSON.stringify(event))).toBeUndefined();
    expect(options.beforeBreadcrumb({ category: 'console', message: 'x' })).toBeNull();
    expect(options).not.toHaveProperty('beforeSendTransaction');
    expect(options.beforeSendLog({ level: 'info', message: LEAD_MESSAGE })).toBeNull();
  });

  it('pass the DSN through and treat an empty DSN as none', () => {
    expect(options.dsn).toBe('https://public@o0.ingest.sentry.invalid/0');
    expect(sentryDsn('  ')).toBeUndefined();
    expect(sentryDsn(undefined)).toBeUndefined();
  });

  it('detect a tracing request from SENTRY_TRACES_SAMPLE_RATE', () => {
    expect(tracingRequestedByEnv(undefined)).toBe(false);
    expect(tracingRequestedByEnv('')).toBe(false);
    expect(tracingRequestedByEnv('0')).toBe(true);
  });

  it.each([
    ['/', true],
    ['/dashboard', true],
    ['/admin', true],
    ['/about', true],
    ['/authors', true],
    ['/a', false],
    [`/a/${ACTION_TOKEN}/send`, false],
    ['/auth', false],
    ['/auth/confirm', false],
  ])('browser Sentry on %s: %s', (path, allowed) => {
    expect(isBrowserSentryAllowedPath(path)).toBe(allowed);
  });
});
