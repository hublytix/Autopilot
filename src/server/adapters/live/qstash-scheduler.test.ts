import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, PermanentError, TransientError } from '@/server/domain/errors';
import { FakeClock } from '@/server/adapters/fake/clock';
import { QstashScheduler } from './qstash-scheduler';

// The live Scheduler against a stubbed fetch (no network): the captured wire matches QS-PUBLISH-WIRE.

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

const TOKEN = ['test', 'qstash', 'token'].join('-');
const BASE_URL = 'https://qstash-us-east-1.upstash.io';
const APP_URL = 'https://autopilot.example';
const NOW = new Date('2026-10-06T14:00:00.000Z');

let captured: Captured[];
let respond: () => Response | Promise<Response>;

beforeEach(() => {
  captured = [];
  respond = () => Response.json({ messageId: 'msg_1' });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    captured.push({ url: String(input), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : null });
    return respond();
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function scheduler(): QstashScheduler {
  return new QstashScheduler({ token: TOKEN, baseUrl: BASE_URL, appUrl: APP_URL, clock: new FakeClock(NOW) });
}

describe('QstashScheduler.publish', () => {
  it('publishes {jobId} to the run route with notBefore, dedupe id, retries, backoff and failure callback', async () => {
    const runAt = new Date(NOW.getTime() + 2 * 86_400_000 + 500);
    const result = await scheduler().publish({ jobId: 'job-1', kind: 'followup', runAt, dedupeId: 'prod:lead:L:fu:1:s0', retries: 4 });
    expect(result).toEqual({ messageId: 'msg_1', deduplicated: false });
    expect(captured).toHaveLength(1);
    const [request] = captured;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(`${BASE_URL}/v2/publish/${APP_URL}/api/jobs/run`);
    expect(JSON.parse(request?.body ?? 'null')).toEqual({ jobId: 'job-1' });
    expect(request?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'upstash-not-before': String(Math.ceil(runAt.getTime() / 1000)),
      'upstash-deduplication-id': 'prod:lead:L:fu:1:s0',
      'upstash-retries': '4',
      'upstash-retry-delay': 'pow(2, retried) * 10000',
      'upstash-failure-callback': `${APP_URL}/api/jobs/failed`,
      'upstash-method': 'POST',
    });
    expect(request?.headers).not.toHaveProperty('upstash-delay');
    // Telemetry is off.
    expect(Object.keys(request?.headers ?? {}).some((name) => name.startsWith('upstash-telemetry'))).toBe(false);
  });

  it('omits notBefore for a job that is due now', async () => {
    await scheduler().publish({ jobId: 'job-1', kind: 'portal_poll', runAt: NOW, dedupeId: 'prod:poll:a', retries: 4 });
    expect(captured[0]?.headers).not.toHaveProperty('upstash-not-before');
  });

  it('reports a deduplicated publish (202 with the existing message id)', async () => {
    respond = () => Response.json({ messageId: 'msg_existing', deduplicated: true }, { status: 202 });
    expect(await scheduler().publish({ jobId: 'job-1', kind: 'portal_poll', runAt: NOW, dedupeId: 'prod:poll:a', retries: 4 })).toEqual({
      messageId: 'msg_existing',
      deduplicated: true,
    });
  });

  it.each([
    [429, TransientError, 'qstash_rate_limited'],
    [500, TransientError, 'qstash_server_error'],
    [503, TransientError, 'qstash_server_error'],
    [401, ConfigError, 'qstash_unauthorized'],
    [403, ConfigError, 'qstash_unauthorized'],
    [400, PermanentError, 'qstash_bad_request'],
  ])('maps HTTP %i to a typed error without the provider message', async (status, type, code) => {
    respond = () => new Response('the provider said something about job-1', { status });
    const error: unknown = await scheduler()
      .publish({ jobId: 'job-1', kind: 'portal_poll', runAt: NOW, dedupeId: 'prod:poll:a', retries: 4 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({ code, message: code });
  });

  it('maps a network failure to a transient error, with a single attempt', async () => {
    vi.stubGlobal('fetch', async () => {
      captured.push({ url: '', method: 'POST', headers: {}, body: null });
      throw new TypeError('fetch failed');
    });
    await expect(scheduler().publish({ jobId: 'job-1', kind: 'portal_poll', runAt: NOW, dedupeId: 'prod:poll:a', retries: 4 })).rejects.toMatchObject({
      code: 'qstash_network_error',
    });
    expect(captured).toHaveLength(1);
  });

  it('refuses an empty job or dedupe id before calling QStash', async () => {
    await expect(scheduler().publish({ jobId: '', kind: 'portal_poll', runAt: NOW, dedupeId: 'x', retries: 4 })).rejects.toBeInstanceOf(PermanentError);
    expect(captured).toEqual([]);
  });
});

describe('QstashScheduler.cancel', () => {
  it('deletes one message by id', async () => {
    respond = () => new Response(null, { status: 202 });
    await scheduler().cancel('msg_1');
    expect(captured).toEqual([expect.objectContaining({ method: 'DELETE', url: `${BASE_URL}/v2/messages/msg_1` })]);
  });

  it('treats 404 (already delivered or cancelled) as success', async () => {
    respond = () => new Response('Message not found', { status: 404 });
    await expect(scheduler().cancel('msg_gone')).resolves.toBeUndefined();
  });

  it('maps other failures to typed errors', async () => {
    respond = () => new Response('boom', { status: 500 });
    await expect(scheduler().cancel('msg_1')).rejects.toBeInstanceOf(TransientError);
  });

  it('never sends a request for an empty id (which would be a bulk cancel)', async () => {
    await expect(scheduler().cancel('')).rejects.toBeInstanceOf(PermanentError);
    expect(captured).toEqual([]);
  });
});
