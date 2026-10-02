import { FAKE_ANTHROPIC_KEY } from '../support/fake-secrets';
import { APIError } from '@anthropic-ai/sdk';
import { createTransport, type BaseTransportOptions, type Transport } from '@sentry/core';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgliteDb } from '@/server/db/pglite';
import { buildSentryOptions } from '@/shared/observability/sentry-options';
import { createTestDb } from '../db/harness';
import {
  ACTION_TOKEN,
  HUBSPOT_ACCESS_TOKEN,
  LEAD_EMAIL,
  LEAD_MESSAGE,
  OAUTH_CODE,
  OWNER_EMAIL,
  RESEARCH_TOKEN,
  SESSION_COOKIE,
  findForbidden,
} from './fixtures';

// Envelope-level proof (PLAN §11, D-23, SENTRY-SCRUBBER-TEST): the REAL @sentry/node pipeline
// (integrations, scopes, RequestData, beforeSend, envelope serialisation) with an in-memory
// transport. Each scenario runs once with Sentry's v11 defaults, to prove the fixtures do reach
// the envelope without our options, and once with the shared options, where nothing may leak.

const DSN = 'https://publickey@o0.ingest.sentry.invalid/0';

function memoryTransport(sink: string[]): (options: BaseTransportOptions) => Transport {
  return (options) =>
    createTransport(options, (request) => {
      sink.push(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
      return Promise.resolve({ statusCode: 200 });
    });
}

/** Runs `scenario` under a fresh client and returns every serialised envelope it sent. */
async function capture(options: Sentry.NodeOptions, scenario: () => Promise<void>): Promise<string[]> {
  const sink: string[] = [];
  Sentry.init({ ...options, dsn: DSN, transport: memoryTransport(sink) });
  try {
    await Sentry.withIsolationScope(scenario);
    await Sentry.flush(2000);
  } finally {
    await Sentry.close(2000);
  }
  return sink;
}

// Each Sentry.init installs process-level uncaughtException/unhandledRejection listeners that
// Sentry.close leaves behind; this file inits a dozen clients in one process.
process.setMaxListeners(Math.max(process.getMaxListeners(), 32));

const SHARED: Sentry.NodeOptions = buildSentryOptions({ dsn: DSN });
const DEFAULTS: Sentry.NodeOptions = {};

/** Envelope items (headers and payloads) as parsed JSON. */
function items(envelopes: readonly string[]): unknown[] {
  return envelopes.flatMap((envelope) =>
    envelope
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as unknown),
  );
}

interface EventPayload {
  exception?: { values?: { type?: string; value?: string }[] };
  request?: { url?: string; headers?: unknown; cookies?: unknown; data?: unknown };
  transaction?: string;
}

function events(envelopes: readonly string[]): EventPayload[] {
  return items(envelopes).filter((item): item is EventPayload => typeof item === 'object' && item !== null && 'exception' in item);
}

// ---------------------------------------------------------------------------------------------
// (a) A Server Action whose input contains the fixture text
// ---------------------------------------------------------------------------------------------

/** The action body: a careless validation error that quotes the submitted draft. */
async function saveEditedDraft(formData: FormData): Promise<void> {
  const body = String(formData.get('body') ?? '');
  await Promise.resolve();
  throw new Error(`Draft rejected for ${String(formData.get('to'))}: ${body}`);
}

async function serverActionScenario(): Promise<void> {
  const formData = new FormData();
  formData.set('to', LEAD_EMAIL);
  formData.set('body', LEAD_MESSAGE);
  // What the request leaves on the isolation scope in Next: the action-link URL with its token,
  // the query string, cookies, headers and the raw form body.
  const isolation = Sentry.getIsolationScope();
  isolation.setSDKProcessingMetadata({
    normalizedRequest: {
      method: 'POST',
      url: `https://app.example.com/a/${ACTION_TOKEN}/edit?to=${encodeURIComponent(LEAD_EMAIL)}`,
      query_string: `to=${encodeURIComponent(LEAD_EMAIL)}`,
      headers: { cookie: SESSION_COOKIE, authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`, referer: `https://mail.example.com/?q=${LEAD_EMAIL}` },
      cookies: { ap_session: SESSION_COOKIE },
      data: `to=${encodeURIComponent(LEAD_EMAIL)}&body=${encodeURIComponent(LEAD_MESSAGE)}`,
    },
  });
  isolation.setTransactionName(`POST /a/${ACTION_TOKEN}/edit`);
  isolation.setContext('nextjs', { request_path: `/a/${ACTION_TOKEN}/edit`, router_path: '/a/[token]/edit' });
  isolation.setUser({ id: 'owner-1', email: OWNER_EMAIL });
  Sentry.addBreadcrumb({ category: 'lead', message: `editing reply to ${LEAD_MESSAGE}` });
  // Worst case: wrapped WITH the form data, headers and response recording, which D-23 forbids.
  await withServerActionInstrumentation(
    'saveEditedDraft',
    { formData, headers: new Headers({ cookie: SESSION_COOKIE, authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}` }), recordResponse: true },
    () => saveEditedDraft(formData),
  ).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// (b) An Anthropic APIError whose message contains the fixture text
// ---------------------------------------------------------------------------------------------

function anthropicError(): APIError {
  return APIError.generate(
    400,
    { type: 'error', error: { type: 'invalid_request_error', message: `messages.0.content: ${LEAD_MESSAGE} <${LEAD_EMAIL}>` } },
    undefined,
    new Headers({ 'request-id': 'req_fixture', 'x-api-key': FAKE_ANTHROPIC_KEY }),
  );
}

async function anthropicScenario(): Promise<void> {
  const error = anthropicError();
  Sentry.captureException(error);
  // The same error as the cause of a wrapper (LinkedErrors sends the chain).
  Sentry.captureException(new Error('draft_generation_failed', { cause: error }));
  await Promise.resolve();
}

// ---------------------------------------------------------------------------------------------
// Research vectors (09.y): vector 1 and the path-token transaction (vector 3)
// ---------------------------------------------------------------------------------------------

async function researchVectorScenario(): Promise<void> {
  Sentry.addBreadcrumb({ category: 'lead', message: `processing lead: ${LEAD_MESSAGE}` });
  Sentry.setExtra('debug', { token: RESEARCH_TOKEN, note: `Authorization: Bearer ${RESEARCH_TOKEN}` });
  Sentry.getIsolationScope().setTransactionName(`GET /a/${ACTION_TOKEN}/send`);
  Sentry.captureException(new Error(`HubSpot call failed with Bearer ${RESEARCH_TOKEN} for ${LEAD_EMAIL} code=${OAUTH_CODE}`));
  await Promise.resolve();
}

describe('Sentry envelopes with the real @sentry/node SDK', () => {
  describe('without our options (Sentry v11 defaults)', () => {
    it.each([
      ['a Server Action error', serverActionScenario],
      ['an Anthropic APIError', anthropicScenario],
      ['the research vectors', researchVectorScenario],
    ])('%s leaks fixture content, so the transport really captures it', async (_name, scenario) => {
      const envelopes = await capture(DEFAULTS, scenario);
      expect(envelopes.length).toBeGreaterThan(0);
      expect(findForbidden(envelopes.join('\n'))).toBeDefined();
    });
  });

  describe('with the shared options', () => {
    it('(a) a Server Action error: no fixture text, email, token, cookie or header, but the event is useful', async () => {
      const envelopes = await capture(SHARED, serverActionScenario);
      const text = envelopes.join('\n');
      expect(findForbidden(text)).toBeUndefined();
      const [event] = events(envelopes);
      expect(event?.exception?.values?.[0]).toMatchObject({ type: 'Error', value: '[redacted]' });
      expect(event?.request?.url).toBe('https://app.example.com/a/[token]/edit');
      expect(event?.request?.headers).toBeUndefined();
      expect(event?.request?.cookies).toBeUndefined();
      expect(event?.request?.data).toBeUndefined();
      expect(text).not.toContain('server_action_form_data');
    });

    it('(b) an Anthropic APIError, alone and as a cause: no fixture text, email or key', async () => {
      const envelopes = await capture(SHARED, anthropicScenario);
      expect(findForbidden(envelopes.join('\n'))).toBeUndefined();
      expect(envelopes.join('\n')).not.toContain(FAKE_ANTHROPIC_KEY);
      const captured = events(envelopes);
      expect(captured).toHaveLength(2);
      // The SDK's errors do not set `name`, so Sentry reports them as Error.
      expect(captured[0]?.exception?.values?.map((value) => [value.type, value.value])).toEqual([['Error', '[redacted]']]);
      // The wrapper's code-only message survives; the provider message in the cause does not.
      expect(captured[1]?.exception?.values?.map((value) => [value.type, value.value])).toEqual([
        ['Error', '[redacted]'],
        ['Error', 'draft_generation_failed'],
      ]);
    });

    it('research vector 1 and the path-token transaction: nothing leaks', async () => {
      const envelopes = await capture(SHARED, researchVectorScenario);
      const text = envelopes.join('\n');
      expect(findForbidden(text)).toBeUndefined();
      expect(events(envelopes)[0]?.transaction).toBe('GET /a/[token]/send');
    });

    it('install no Console, Anthropic_AI, session or Spotlight integration', async () => {
      let names: string[] = [];
      await capture(SHARED, async () => {
        names = (Sentry.getClient()?.getOptions().integrations ?? []).map((integration) => integration.name);
        await Promise.resolve();
      });
      expect(names).toContain('LinkedErrors');
      for (const removed of ['Console', 'Anthropic_AI', 'ProcessSession', 'Spotlight']) expect(names).not.toContain(removed);
    });

    it('send no server_name and no session envelope, even with SENTRY_SPOTLIGHT and SENTRY_DEBUG set', async () => {
      const previous = { spotlight: process.env.SENTRY_SPOTLIGHT, debug: process.env.SENTRY_DEBUG };
      process.env.SENTRY_SPOTLIGHT = 'http://127.0.0.1:9/stream';
      process.env.SENTRY_DEBUG = '1';
      let names: string[] = [];
      let resolved: { spotlight?: unknown; debug?: unknown } = {};
      try {
        // A release turns on release-health sessions in the defaults (see the next test).
        const envelopes = await capture({ ...SHARED, release: 'r1' }, async () => {
          const client = Sentry.getClient();
          names = (client?.getOptions().integrations ?? []).map((integration) => integration.name);
          const resolvedOptions = client?.getOptions() as { spotlight?: unknown; debug?: unknown } | undefined;
          resolved = { spotlight: resolvedOptions?.spotlight, debug: resolvedOptions?.debug };
          Sentry.captureException(new Error('job_failed'));
          await Promise.resolve();
        });
        const all = items(envelopes);
        expect(all.some((item) => typeof item === 'object' && item !== null && ('sid' in item || 'aggregates' in item))).toBe(false);
        expect(envelopes.join('\n')).not.toMatch(/"type":"sessions?"/);
        expect(envelopes).toHaveLength(1);
        expect(events(envelopes)).toHaveLength(1);
        expect(envelopes.join('\n')).not.toContain('server_name');
      } finally {
        if (previous.spotlight === undefined) delete process.env.SENTRY_SPOTLIGHT;
        else process.env.SENTRY_SPOTLIGHT = previous.spotlight;
        if (previous.debug === undefined) delete process.env.SENTRY_DEBUG;
        else process.env.SENTRY_DEBUG = previous.debug;
      }
      expect(names).not.toContain('Spotlight');
      expect(resolved).toEqual({ spotlight: false, debug: false });
    });

    it('with the v11 defaults, the same capture carries server_name and installs ProcessSession (the checks above have teeth)', async () => {
      let names: string[] = [];
      const envelopes = await capture({ ...DEFAULTS, release: 'r1' }, async () => {
        names = (Sentry.getClient()?.getOptions().integrations ?? []).map((integration) => integration.name);
        Sentry.captureException(new Error('job_failed'));
        await Promise.resolve();
      });
      expect(envelopes.join('\n')).toContain('server_name');
      // Its session envelopes go straight to the transport, never through beforeSend.
      expect(names).toContain('ProcessSession');
    });

    it('even if tracing were turned on: no Anthropic_AI integration and no token in error envelope headers', async () => {
      let names: string[] = [];
      const envelopes = await capture({ ...SHARED, tracesSampleRate: 1 }, async () => {
        names = (Sentry.getClient()?.getOptions().integrations ?? []).map((integration) => integration.name);
        await Sentry.startSpan({ name: `GET /a/${ACTION_TOKEN}/send`, op: 'http.server' }, async () => {
          Sentry.captureException(new Error('boom'));
          await Promise.resolve();
        });
      });
      expect(names).not.toContain('Anthropic_AI');
      const errorEnvelopes = envelopes.filter((envelope) => envelope.includes('"exception"'));
      expect(errorEnvelopes).toHaveLength(1);
      expect(errorEnvelopes[0]).not.toContain(ACTION_TOKEN);
      // Span envelopes are why tracing stays off: their names are not ours to scrub.
      expect(envelopes.filter((envelope) => !envelope.includes('"exception"')).join('\n')).toContain(ACTION_TOKEN);
    });
  });

  // -------------------------------------------------------------------------------------------
  // (c) A real PGlite NOT NULL violation on lead_messages (PLAN §11)
  // -------------------------------------------------------------------------------------------
  describe('(c) a database error from PGlite', () => {
    let db: PgliteDb | undefined;
    const NOW = new Date('2026-10-06T13:00:00.000Z');

    beforeAll(async () => {
      db = await createTestDb();
    });
    afterAll(async () => {
      await db?.close();
    });

    async function notNullViolation(): Promise<unknown> {
      if (db === undefined) throw new Error('db not ready');
      const account = await db.one<{ id: string }>(
        `insert into public.accounts
           (hubspot_portal_id, processing_state_changed_at, trial_started_at, trial_ends_at, last_install_at, created_at)
         values ('9001', $1, $1, $1, $1, $1) returning id`,
        [NOW],
      );
      const lead = await db.one<{ id: string }>(
        `insert into public.leads (account_id, hubspot_contact_id, form_id, submitted_at, intake_trigger, received_at)
         values ($1, '501', 'form-1', $2, 'cron', $2) returning id`,
        [account.id, NOW],
      );
      return db
        .query('insert into public.lead_messages (lead_id, account_id, message, email, purge_at) values ($1, $2, $3, $4, $5)', [
          lead.id,
          account.id,
          LEAD_MESSAGE,
          LEAD_EMAIL,
          null,
        ])
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    }

    it('reaches Sentry as DbError db_error with no row content', async () => {
      const error = await notNullViolation();
      expect(error).toMatchObject({ name: 'DbError', sqlstate: '23502', column: 'purge_at' });
      const envelopes = await capture(SHARED, async () => {
        Sentry.captureException(error);
        await Promise.resolve();
      });
      const text = envelopes.join('\n');
      expect(findForbidden(text)).toBeUndefined();
      expect(text).not.toContain('insert into');
      expect(text).not.toContain('Failing row');
      expect(events(envelopes)[0]?.exception?.values?.[0]).toMatchObject({ type: 'DbError', value: 'db_error' });
    });
  });
});
