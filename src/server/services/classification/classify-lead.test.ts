import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@/server/adapters/fake/clock';
import { FakeLLM, fakeLlmMarker, type FakeLlmFault, type FakeLlmRequest } from '@/server/adapters/fake/llm/fake-llm';
import { InvalidModelParamsError } from '@/server/ai/model-params';
import type { Db } from '@/server/db';
import type { AiCallOutcome } from '@/server/domain/types';
import { parseEnv } from '@/server/env';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { seedAccount, seedLead } from '@/server/jobs/testing';
import type { ClassifyOutput, LLM, LlmResult } from '@/server/ports/llm';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { aiCallRecord, recordAiCall } from './ai-calls';
import { classifyLead, type ClassifyDeps, type ClassifyLeadInput } from './classify-lead';

const getDb = setUpTestDb();
const START = new Date('2026-10-06T14:00:00.000Z');

interface AiCallRow {
  account_id: string | null;
  lead_id: string | null;
  purpose: string;
  attempt: number;
  model: string;
  request_id: string | null;
  stop_reason: string | null;
  refusal_category: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_micro_usd: number;
  latency_ms: number | null;
  outcome: AiCallOutcome;
  created_at: Date;
}

let clock: FakeClock;
let requests: FakeLlmRequest[];
let llm: FakeLLM;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(() => {
  clock = new FakeClock(START);
  requests = [];
  // The built-in buildModelParams assertion is always on; the hook below records what it checked.
  llm = new FakeLLM({ assertRequest: (request) => requests.push(request) });
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
});

function deps(overrides: Partial<ClassifyDeps> = {}): ClassifyDeps {
  return { db: getDb(), clock, llm, env: parseEnv({ APP_MODE: 'fake' }), ...overrides };
}

async function seed(db: Db): Promise<{ accountId: string; leadId: string }> {
  const accountId = await seedAccount(db, { now: START });
  const leadId = await seedLead(db, { accountId, now: START });
  return { accountId, leadId };
}

function input(ids: { accountId: string; leadId: string }, message: string | null): ClassifyLeadInput {
  return { ...ids, message, formName: 'Contact us', firstName: 'Maya', company: 'Okafor Bakery' };
}

async function aiCalls(db: Db): Promise<AiCallRow[]> {
  return db.query<AiCallRow>('select * from ai_calls order by id');
}

describe('classifyLead', () => {
  it('returns the model class and records one ai_calls row without content', async () => {
    const db = getDb();
    const ids = await seed(db);
    const result = await classifyLead(deps(), input(ids, 'Hi, our water heater is leaking. Could you come this week?'));
    expect(result).toEqual({ classification: 'lead', failed: false });

    const rows = await aiCalls(db);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      account_id: ids.accountId,
      lead_id: ids.leadId,
      purpose: 'classify',
      attempt: 1,
      model: 'claude-haiku-4-5-20251001',
      request_id: expect.stringMatching(/^req_fake_/) as unknown,
      stop_reason: 'end_turn',
      refusal_category: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      latency_ms: 0,
      outcome: 'ok',
      created_at: START,
    });
    expect(row?.input_tokens).toBeGreaterThan(0);
    expect(row?.output_tokens).toBeGreaterThan(0);
    // Haiku 4.5: $1/MTok in, $5/MTok out.
    expect(row?.cost_micro_usd).toBe((row?.input_tokens ?? 0) + 5 * (row?.output_tokens ?? 0));
    expect(JSON.stringify(rows)).not.toMatch(/water heater|Maya|Okafor/);
  });

  it('passes the filtered classes through', async () => {
    const db = getDb();
    const ids = await seed(db);
    expect(await classifyLead(deps(), input(ids, 'We offer SEO services to get you on the first page of Google'))).toEqual({
      classification: 'vendor_pitch',
      failed: false,
    });
    expect(await classifyLead(deps(), input(ids, 'Buy bitcoin now, click here'))).toEqual({ classification: 'spam', failed: false });
  });

  it('runs every call through the model-parameter assertion', async () => {
    const db = getDb();
    const ids = await seed(db);
    await classifyLead(deps(), input(ids, 'Leaking tap'));
    expect(requests).toEqual([{ purpose: 'classify', model: 'claude-haiku-4-5-20251001', maxTokens: 256 }]);

    const sonnet = new FakeLLM({ models: { fast: 'claude-sonnet-5-5' } });
    const env = parseEnv({ APP_MODE: 'fake', ANTHROPIC_MODEL_FAST: 'claude-sonnet-5-5' });
    expect(await classifyLead(deps({ llm: sonnet, env }), input(ids, 'Leaking tap'))).toEqual({ classification: 'lead', failed: false });
    const [, sonnetRow] = await aiCalls(db);
    // Sonnet 5.5: $2/MTok in, $10/MTok out (costs keyed by the serving model, D-25).
    expect(sonnetRow?.model).toBe('claude-sonnet-5-5');
    expect(sonnetRow?.cost_micro_usd).toBe(2 * (sonnetRow?.input_tokens ?? 0) + 10 * (sonnetRow?.output_tokens ?? 0));
  });

  it('lets an invalid parameter combination fail loudly (a test assertion, not an LLM outcome)', async () => {
    const db = getDb();
    const ids = await seed(db);
    const broken = new FakeLLM({ models: { fast: 'claude-opus-5' } });
    await expect(classifyLead(deps({ llm: broken }), input(ids, 'Leaking tap'))).rejects.toThrow();
    const badConfig = new FakeLLM({ models: { fast: 'claude-sonnet-5-5' }, modelParams: { draftThinking: 'between_tools', draftEffort: 'max', draftMaxTokens: 1024, briefEffort: 'high' } });
    // Classification on Sonnet uses its own row (between_tools/low), so the bad draft effort does not affect it…
    await expect(classifyLead(deps({ llm: badConfig }), input(ids, 'Leaking tap'))).resolves.toMatchObject({ failed: false });
    // …but a draft with it is refused.
    await expect(
      badConfig.draft({
        brief: {
          company_name: 'x', one_line: 'x', services: [], who_we_serve: 'x', booking_link: null, tone: { style: 'direct', note: '' },
          sign_off_name: '', allow_pricing: false, never_promise: [], faqs: [],
        },
        lead: { firstName: null, company: null, message: 'x', formName: 'f' },
        previousErrorCodes: [],
      }),
    ).rejects.toThrow(InvalidModelParamsError);
  });

  it.each<[FakeLlmFault, AiCallOutcome, string | null]>([
    ['refusal', 'refusal', 'refusal'],
    ['max_tokens', 'max_tokens', 'max_tokens'],
    ['invalid', 'invalid_output', 'end_turn'],
    ['transient', 'transient', null],
    ['fatal', 'fatal_config', null],
    ['slow', 'transient', null],
  ])('turns an injected %s into unclear and records outcome %s', async (fault, outcome, stopReason) => {
    const db = getDb();
    const ids = await seed(db);
    llm.injectFault(fault, { purpose: 'classify', refusalCategory: 'general_harms' });
    expect(await classifyLead(deps(), input(ids, 'Hi, our water heater is leaking'))).toEqual({ classification: 'unclear', failed: true });
    const rows = await aiCalls(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome, stop_reason: stopReason, model: 'claude-haiku-4-5-20251001', lead_id: ids.leadId });
    if (fault === 'refusal') expect(rows[0]).toMatchObject({ refusal_category: 'general_harms' });
    if (fault === 'transient' || fault === 'fatal' || fault === 'slow') expect(rows[0]).toMatchObject({ input_tokens: 0, output_tokens: 0, cost_micro_usd: 0 });
    if (fault === 'max_tokens') expect(rows[0]?.output_tokens).toBe(256);
  });

  it('honours a fault marker in the lead text (fake mode end to end)', async () => {
    const db = getDb();
    const ids = await seed(db);
    const result = await classifyLead(deps(), input(ids, `Quote please ${fakeLlmMarker('invalid', 'classify')}`));
    expect(result).toEqual({ classification: 'unclear', failed: true });
    expect((await aiCalls(db))[0]?.outcome).toBe('invalid_output');
  });

  it('alerts the admin once per fatal_config failure (bad key, retired model, spend cap)', async () => {
    const db = getDb();
    const ids = await seed(db);
    llm.injectFault('fatal', { purpose: 'classify', errorCode: 'model_not_found' });
    await classifyLead(deps(), input(ids, 'Hello'));
    expect(alerts).toEqual([{ code: 'ai_fatal_config', fields: { purpose: 'classify', model: 'claude-haiku-4-5-20251001', errorCode: 'model_not_found' } }]);
    llm.injectFault('transient', { purpose: 'classify' });
    await classifyLead(deps(), input(ids, 'Hello'));
    expect(alerts).toHaveLength(1);
  });

  it('times the call with the injected clock', async () => {
    const db = getDb();
    const ids = await seed(db);
    const slowLlm: LLM = {
      ...llm,
      classify: async (classifyInput) => {
        const result = await llm.classify(classifyInput);
        clock.advance(1234);
        return result;
      },
      generateBrief: (a, b) => llm.generateBrief(a, b),
      draft: (a, b) => llm.draft(a, b),
      draftFollowUp: (a, b) => llm.draftFollowUp(a, b),
    };
    await classifyLead(deps({ llm: slowLlm }), input(ids, 'Leaking tap'));
    expect((await aiCalls(db))[0]).toMatchObject({ latency_ms: 1234, created_at: new Date(START.getTime() + 1234) });
  });

  it('records the purpose, attempt and a null lead for the baseline, and passes the signal on', async () => {
    const db = getDb();
    const { accountId } = await seed(db);
    const signal = new AbortController().signal;
    await classifyLead(deps(), { accountId, leadId: null, message: 'Hi', formName: 'f', firstName: null, company: null, purpose: 'baseline_classify', attempt: 3, signal });
    expect((await aiCalls(db))[0]).toMatchObject({ purpose: 'baseline_classify', attempt: 3, lead_id: null, account_id: accountId });
    expect(llm.calls[0]?.hasSignal).toBe(true);
  });

  it('an aborted signal becomes unclear and a transient row', async () => {
    const db = getDb();
    const ids = await seed(db);
    const controller = new AbortController();
    controller.abort();
    expect(await classifyLead(deps(), { ...input(ids, 'Hi'), signal: controller.signal })).toEqual({ classification: 'unclear', failed: true });
    expect((await aiCalls(db))[0]).toMatchObject({ outcome: 'transient' });
  });

  it('skips the call while the AI budget breaker is tripped (D-36): unclear, no ai_calls row', async () => {
    const db = getDb();
    const ids = await seed(db);
    const result = await classifyLead(deps(), input(ids, 'Hi'), { isBudgetTripped: async () => true });
    expect(result).toEqual({ classification: 'unclear', failed: true });
    expect(llm.calls).toEqual([]);
    expect(await aiCalls(db)).toEqual([]);
  });
});

describe('aiCallRecord', () => {
  const context = {
    accountId: 'a',
    leadId: null,
    purpose: 'classify' as const,
    attempt: 1,
    requestedModel: 'claude-haiku-4-5-20251001',
    startedAt: START,
    finishedAt: START,
  };

  it('has no cost for an unknown serving model, and recording it alerts the admin and stores 0', async () => {
    const db = getDb();
    const { accountId } = await seed(db);
    const result: LlmResult<ClassifyOutput> = {
      ok: true,
      value: { classification: 'lead' },
      usage: { inputTokens: 10, outputTokens: 2 },
      stopReason: 'end_turn',
      model: 'claude-haiku-9',
    };
    const record = aiCallRecord({ ...context, accountId }, result);
    expect(record.costMicroUsd).toBeNull();
    await recordAiCall(db, record);
    expect(alerts).toEqual([{ code: 'ai_price_unknown_model', fields: { model: 'claude-haiku-9', purpose: 'classify' } }]);
    expect((await aiCalls(db))[0]).toMatchObject({ model: 'claude-haiku-9', cost_micro_usd: 0, input_tokens: 10 });
  });

  it('falls back to the requested model when the call failed before the API named one', () => {
    const record = aiCallRecord(context, { ok: false, failure: 'transient', errorCode: 'timeout' });
    expect(record).toMatchObject({ model: 'claude-haiku-4-5-20251001', costMicroUsd: 0, outcome: 'transient', stopReason: null, requestId: null });
  });
});
