import Anthropic, { APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLASSIFICATION_JSON_SCHEMA } from '@/server/ai/schemas';
import { createLogger, type Logger } from '@/server/obs/log';
import type { ClassifyInput } from '@/server/ports/llm';
import { FAKE_ANTHROPIC_KEY } from '../../../../test/support/fake-secrets';
import { FakeClock } from '../fake/clock';
import { AnthropicLLM, createAnthropicClient, type AnthropicMessagesClient } from './anthropic-llm';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5-5';
const MODELS = { draft: SONNET, fast: HAIKU };

const SECRET_TEXT = 'Maya Okafor 555-0100 leaking water heater';
const INPUT: ClassifyInput = { message: `Hi, ${SECRET_TEXT}. Can you come this week?`, formName: 'Contact us', firstName: 'Maya', company: 'Okafor Bakery' };

type Created = Message & { _request_id?: string | null | undefined };
type CreateArgs = [MessageCreateParamsNonStreaming, ({ timeout?: number; signal?: AbortSignal } | undefined)?];

function message(overrides: Partial<Message> & { text?: string } = {}): Created {
  const { text = '{"classification":"lead","reason_code":"asks_about_services"}', ...rest } = overrides;
  const msg: Created = {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: HAIKU,
    container: null,
    diagnostics: null,
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_details: null,
    stop_sequence: null,
    usage: {
      input_tokens: 600,
      output_tokens: 20,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
    },
    ...rest,
  } as Created;
  Object.defineProperty(msg, '_request_id', { value: 'req_011CXYZ', enumerable: false });
  return msg;
}

function stub(answer: Created | (() => Created | Promise<Created>)): { client: AnthropicMessagesClient; calls: CreateArgs[] } {
  const calls: CreateArgs[] = [];
  const client: AnthropicMessagesClient = {
    messages: {
      create: async (body, options) => {
        calls.push([structuredClone(body), options]);
        return typeof answer === 'function' ? answer() : answer;
      },
    },
  };
  return { client, calls };
}

function throwing(error: unknown): AnthropicMessagesClient {
  return {
    messages: {
      create: () => Promise.reject(error),
    },
  };
}

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({ sink: (line) => lines.push(line), minLevel: 'debug' }), lines };
}

function llm(client: AnthropicMessagesClient, logger?: Logger, models = MODELS): AnthropicLLM {
  return new AnthropicLLM({ apiKey: FAKE_ANTHROPIC_KEY, models, clock: new FakeClock(NOW), client, logger });
}

function apiError(status: number, type: string, headers: Record<string, string> = {}, details?: Record<string, unknown>): APIError {
  const body = { type: 'error', error: { type, message: `messages.0: ${SECRET_TEXT}`, ...(details ? { details } : {}) } };
  return APIError.generate(status, body, undefined, new Headers({ 'request-id': 'req_err1', ...headers }));
}

describe('AnthropicLLM.classify: the request', () => {
  it('sends messages.create with the Haiku parameters and the enum-keeping JSON schema (D-24)', async () => {
    const { client, calls } = stub(message());
    await llm(client).classify(INPUT);
    expect(calls).toHaveLength(1);
    const [body, options] = calls[0] ?? [];
    expect(body).toEqual({
      model: HAIKU,
      max_tokens: 256,
      system: expect.stringContaining('<untrusted_input>') as unknown,
      messages: [{ role: 'user', content: expect.stringContaining('<untrusted_input field="message">') as unknown }],
      output_config: { format: { type: 'json_schema', schema: CLASSIFICATION_JSON_SCHEMA } },
    });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('tool_choice');
    expect(options).toEqual({});
  });

  it('sends between_tools / low when the fast model is Sonnet 5.5, and passes the caller signal', async () => {
    const { client, calls } = stub(message({ model: SONNET }));
    const signal = new AbortController().signal;
    await llm(client, undefined, { draft: SONNET, fast: SONNET }).classify(INPUT, { signal });
    const [body, options] = calls[0] ?? [];
    expect(body).toMatchObject({ model: SONNET, max_tokens: 256, thinking: { type: 'between_tools' }, output_config: { effort: 'low' } });
    expect(options?.signal).toBe(signal);
  });

  it('refuses a model outside the D-24 table without calling the API', async () => {
    const { client, calls } = stub(message());
    const result = await llm(client, undefined, { draft: SONNET, fast: 'claude-opus-5' }).classify(INPUT);
    expect(result).toEqual({ ok: false, failure: 'fatal_config', model: 'claude-opus-5', errorCode: 'model_not_supported' });
    expect(calls).toHaveLength(0);
  });
});

describe('AnthropicLLM.classify: the response', () => {
  it('returns the parsed class with usage, the serving model and the request id', async () => {
    const result = await llm(stub(message()).client).classify(INPUT);
    expect(result).toEqual({
      ok: true,
      value: { classification: 'lead', reason_code: 'asks_about_services' },
      usage: { inputTokens: 600, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: 'end_turn',
      model: HAIKU,
      requestId: 'req_011CXYZ',
    });
  });

  it('lower-cases enum values before validating and reads text blocks only', async () => {
    const reply = message({
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: '{"classification":"Vendor_Pitch",', citations: null },
        { type: 'text', text: '"reason_code":"SELLS_TO_THE_BUSINESS"}', citations: null },
      ],
    });
    const result = await llm(stub(reply).client).classify(INPUT);
    expect(result).toMatchObject({ ok: true, value: { classification: 'vendor_pitch', reason_code: 'sells_to_the_business' } });
  });

  it('reports a refusal with its category and usage, never retrying (AI-REFUSAL-HANDLING)', async () => {
    const reply = message({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: 'no' } });
    const result = await llm(stub(reply).client).classify(INPUT);
    expect(result).toEqual({
      ok: false,
      failure: 'refusal',
      model: HAIKU,
      usage: { inputTokens: 600, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: 'refusal',
      requestId: 'req_011CXYZ',
      refusalCategory: 'general_harms',
    });
  });

  it('reports an unknown or missing refusal category as null', async () => {
    const reply = message({ content: [], stop_reason: 'refusal', stop_details: null });
    expect(await llm(stub(reply).client).classify(INPUT)).toMatchObject({ failure: 'refusal', refusalCategory: null });
  });

  it('treats max_tokens as a failure even when the text is valid JSON', async () => {
    const result = await llm(stub(message({ stop_reason: 'max_tokens' })).client).classify(INPUT);
    expect(result).toMatchObject({ ok: false, failure: 'max_tokens', stopReason: 'max_tokens', usage: { outputTokens: 20 } });
  });

  it('treats a context-window stop as max_tokens', async () => {
    const result = await llm(stub(message({ stop_reason: 'model_context_window_exceeded' })).client).classify(INPUT);
    expect(result).toMatchObject({ ok: false, failure: 'max_tokens', errorCode: 'context_window_exceeded' });
  });

  it.each(['tool_use', 'pause_turn', 'stop_sequence', null])('treats stop_reason %s as invalid output', async (stopReason) => {
    const result = await llm(stub(message({ stop_reason: stopReason as Message['stop_reason'] })).client).classify(INPUT);
    expect(result).toMatchObject({ ok: false, failure: 'invalid_output', errorCode: 'unexpected_stop_reason' });
  });

  it('reports invalid JSON and schema mismatches as invalid_output, keeping usage', async () => {
    const bad = await llm(stub(message({ text: `Sorry, I cannot help with ${SECRET_TEXT}` })).client).classify(INPUT);
    expect(bad).toMatchObject({ ok: false, failure: 'invalid_output', errorCode: 'invalid_json', usage: { inputTokens: 600 }, requestId: 'req_011CXYZ' });
    const offList = await llm(stub(message({ text: '{"classification":"customer","reason_code":"other"}' })).client).classify(INPUT);
    expect(offList).toMatchObject({ ok: false, failure: 'invalid_output', errorCode: 'schema_mismatch' });
  });
});

describe('AnthropicLLM.classify: thrown errors (D-24)', () => {
  it('maps a 429 with retry-after to transient with the delay', async () => {
    const result = await llm(throwing(apiError(429, 'rate_limit_error', { 'retry-after': '20' }))).classify(INPUT);
    expect(result).toEqual({ ok: false, failure: 'transient', model: HAIKU, errorCode: 'rate_limited', requestId: 'req_err1', retryAfterMs: 20_000 });
  });

  it('maps the spend cap to fatal_config', async () => {
    const error = apiError(429, 'rate_limit_error', {}, { error_code: 'enforced_spend_limit_reached' });
    expect(await llm(throwing(error)).classify(INPUT)).toMatchObject({ ok: false, failure: 'fatal_config', errorCode: 'spend_cap' });
  });

  it('maps our abort to transient and a 404 (retired model) to fatal_config', async () => {
    expect(await llm(throwing(new APIUserAbortError())).classify(INPUT)).toMatchObject({ failure: 'transient', errorCode: 'aborted' });
    expect(await llm(throwing(apiError(404, 'not_found_error'))).classify(INPUT)).toMatchObject({ failure: 'fatal_config', errorCode: 'model_not_found' });
  });

  it('never throws, even for an unexpected error', async () => {
    await expect(llm(throwing(new TypeError('boom'))).classify(INPUT)).resolves.toMatchObject({ ok: false, failure: 'fatal_config', errorCode: 'unexpected_error' });
  });
});

describe('AnthropicLLM: drafts (prompts arrive in M4)', () => {
  it('answer fatal_config not_built without calling the API', async () => {
    const { client, calls } = stub(message());
    const adapter = llm(client);
    const lead = { firstName: null, company: null, message: null, formName: 'f' };
    const briefDraft = {
      company_name: 'x', one_line: 'x', services: [], who_we_serve: 'x', booking_link: null, tone: { style: 'direct' as const, note: '' },
      sign_off_name: '', allow_pricing: false, never_promise: [], faqs: [],
    };
    expect(await adapter.draft({ brief: briefDraft, lead, previousErrorCodes: [] })).toMatchObject({ failure: 'fatal_config', errorCode: 'not_built' });
    expect(await adapter.draftFollowUp({ brief: briefDraft, lead, previousErrorCodes: [], followUpNumber: 1, original: null })).toMatchObject({
      failure: 'fatal_config',
      errorCode: 'not_built',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('AnthropicLLM privacy (law 4)', () => {
  it('logs failures with codes only: no lead text, model output or SDK message', async () => {
    const { logger, lines } = capturingLogger();
    await llm(stub(message({ text: `Sorry, ${SECRET_TEXT}` })).client, logger).classify(INPUT);
    await llm(throwing(apiError(400, 'invalid_request_error')), logger).classify(INPUT);
    await llm(stub(message({ content: [], stop_reason: 'refusal' })).client, logger).classify(INPUT);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toMatch(/Maya|Okafor|555-0100|leaking|Sorry/);
    }
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ provider: 'anthropic', purpose: 'classify', outcome: 'fatal_config', errorCode: 'bad_request', httpStatus: 400 });
  });
});

describe('AnthropicLLM with the real SDK client and a stubbed fetch (no network)', () => {
  function sdkClient(fetch: (url: string, init: RequestInit) => Promise<Response>): Anthropic {
    return new Anthropic({ apiKey: FAKE_ANTHROPIC_KEY, baseURL: 'https://api.anthropic.com', maxRetries: 0, logLevel: 'off', fetch: fetch as typeof globalThis.fetch });
  }

  it('posts the documented wire format and reads the request-id header', async () => {
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const client = sdkClient(async (url, init) => {
      seen.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const { _request_id: _ignored, ...json } = message({ model: SONNET });
      return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_wire1' } });
    });
    const result = await llm(client, undefined, { draft: SONNET, fast: SONNET }).classify(INPUT);
    expect(result).toMatchObject({ ok: true, model: SONNET, requestId: 'req_wire1' });
    const [request] = seen;
    expect(request?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(request?.headers.get('anthropic-beta')).toBeNull();
    expect(Object.keys(request?.body ?? {}).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system', 'thinking']);
    expect(request?.body.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: CLASSIFICATION_JSON_SCHEMA } });
  });

  it('classifies the SDK error built from an HTTP 529 as transient overloaded', async () => {
    const client = sdkClient(async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), {
        status: 529,
        headers: { 'content-type': 'application/json', 'request-id': 'req_529' },
      }),
    );
    expect(await llm(client).classify(INPUT)).toMatchObject({ ok: false, failure: 'transient', errorCode: 'overloaded', requestId: 'req_529' });
  });

  it('turns an already-aborted signal into transient aborted without a request', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    const controller = new AbortController();
    controller.abort();
    expect(await llm(sdkClient(fetch)).classify(INPUT, { signal: controller.signal })).toMatchObject({ failure: 'transient', errorCode: 'aborted' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('createAnthropicClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('pins logLevel warn, the API origin, a 60 s timeout and 2 retries, whatever the SDK env variables say', () => {
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://collector.invalid');
    const client = createAnthropicClient({ apiKey: FAKE_ANTHROPIC_KEY });
    expect(client.logLevel).toBe('warn');
    expect(client.baseURL).toBe('https://api.anthropic.com');
    expect(client.timeout).toBe(60_000);
    expect(client.maxRetries).toBe(2);
    expect(client.authToken).toBeNull();
  });

  it('routes SDK log calls to static lines without their text', () => {
    const { logger, lines } = capturingLogger();
    const client = createAnthropicClient({ apiKey: FAKE_ANTHROPIC_KEY, logger });
    client.logger.warn(`body: ${SECRET_TEXT}`);
    client.logger.error(`body: ${SECRET_TEXT}`);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('Maya');
  });
});
