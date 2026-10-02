import { describe, expect, it } from 'vitest';
import { FakeLLM } from '@/server/adapters/fake/llm/fake-llm';
import { ConfigError } from '@/server/domain/errors';
import { ENV_DEFAULTS, parseEnv } from '@/server/env';
import type { BriefDraft, DraftLeadInput } from '@/server/ports/llm';
import {
  assertValidModelParams,
  buildModelParams,
  DEFAULT_MODEL_PARAMS_CONFIG,
  InvalidModelParamsError,
  modelParamsConfig,
  validateModelParams,
  type ModelParamsConfig,
} from './model-params';

const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5-20251001';

const BRIEF: BriefDraft = {
  company_name: 'Brightside Plumbing',
  one_line: 'A family-run plumber.',
  services: ['Drain cleaning'],
  who_we_serve: 'Homeowners',
  booking_link: null,
  tone: { style: 'friendly', note: 'Warm.' },
  sign_off_name: 'Dana',
  allow_pricing: false,
  never_promise: [],
  faqs: [],
};
const LEAD: DraftLeadInput = { firstName: 'Maya', company: null, message: 'Leaking tap in the kitchen.', formName: 'Contact us' };

describe('buildModelParams (the D-24 table)', () => {
  it('Haiku 4.5 classification: no thinking, no effort, 256 tokens', () => {
    expect(buildModelParams({ model: HAIKU, purpose: 'classify', attempt: 1 })).toEqual({ params: { max_tokens: 256 }, timeoutMs: undefined });
    expect(buildModelParams({ model: 'claude-haiku-4-5', purpose: 'classify', attempt: 1 }).params).toEqual({ max_tokens: 256 });
  });

  it('Sonnet 5.5 as the fast model: between_tools / low / 256 (D-25 swap needs no code change)', () => {
    expect(buildModelParams({ model: SONNET, purpose: 'classify', attempt: 1 }).params).toEqual({
      max_tokens: 256,
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low' },
    });
  });

  it('Sonnet 5.5 drafts and follow-ups: the ANTHROPIC_DRAFT_* settings (defaults between_tools / medium / 1024)', () => {
    for (const purpose of ['draft', 'followup'] as const) {
      expect(buildModelParams({ model: SONNET, purpose, attempt: 1 }).params).toEqual({
        max_tokens: 1024,
        thinking: { type: 'between_tools' },
        output_config: { effort: 'medium' },
      });
    }
    const config: ModelParamsConfig = { draftThinking: 'adaptive', draftEffort: 'high', draftMaxTokens: 8000, briefEffort: 'high' };
    expect(buildModelParams({ model: SONNET, purpose: 'draft', attempt: 1 }, config).params).toEqual({
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
  });

  it('a draft retry after max_tokens doubles the budget, capped at 16000', () => {
    expect(buildModelParams({ model: SONNET, purpose: 'draft', attempt: 2, afterMaxTokens: true }).params.max_tokens).toBe(2048);
    expect(buildModelParams({ model: SONNET, purpose: 'draft', attempt: 2 }).params.max_tokens).toBe(1024);
    const big: ModelParamsConfig = { ...DEFAULT_MODEL_PARAMS_CONFIG, draftMaxTokens: 12_000 };
    expect(buildModelParams({ model: SONNET, purpose: 'followup', attempt: 2, afterMaxTokens: true }, big).params.max_tokens).toBe(16_000);
  });

  it('Sonnet 5.5 brief, first delivery: adaptive / ANTHROPIC_BRIEF_EFFORT / 16000, timed to the remaining budget', () => {
    expect(buildModelParams({ model: SONNET, purpose: 'brief', attempt: 1, remainingMs: 52_500 })).toEqual({
      params: { max_tokens: 16_000, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
      timeoutMs: 52_500,
    });
    const medium: ModelParamsConfig = { ...DEFAULT_MODEL_PARAMS_CONFIG, briefEffort: 'medium' };
    expect(buildModelParams({ model: SONNET, purpose: 'brief', attempt: 1, remainingMs: 1000 }, medium).params.output_config).toEqual({ effort: 'medium' });
  });

  it('Sonnet 5.5 brief, any later delivery: between_tools / high / 4096', () => {
    for (const attempt of [2, 3, 5]) {
      expect(buildModelParams({ model: SONNET, purpose: 'brief', attempt, remainingMs: 30_000 })).toEqual({
        params: { max_tokens: 4096, thinking: { type: 'between_tools' }, output_config: { effort: 'high' } },
        timeoutMs: 30_000,
      });
    }
  });

  it('never produces sampling parameters, prefill, tools or tool_choice', () => {
    for (const model of [SONNET, HAIKU]) {
      for (const purpose of ['classify', 'brief', 'draft', 'followup'] as const) {
        for (const attempt of [1, 2]) {
          const { params } = buildModelParams({ model, purpose, attempt, remainingMs: 10_000, afterMaxTokens: attempt === 2 });
          expect(Object.keys(params).every((k) => ['max_tokens', 'thinking', 'output_config'].includes(k))).toBe(true);
          expect(validateModelParams(model, params)).toEqual([]);
        }
      }
    }
  });

  it('refuses any model outside the table, including Covered Models', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-sonnet-4-5-20250929', 'toString']) {
      expect(() => buildModelParams({ model, purpose: 'classify', attempt: 1 })).toThrow(ConfigError);
    }
  });

  it('reads its settings from the env, and the defaults match PLAN §14', () => {
    const env = parseEnv({ APP_MODE: 'fake', ANTHROPIC_DRAFT_EFFORT: 'low', ANTHROPIC_DRAFT_MAX_TOKENS: '900', ANTHROPIC_BRIEF_EFFORT: 'xhigh' });
    expect(modelParamsConfig(env)).toEqual({ draftThinking: 'between_tools', draftEffort: 'low', draftMaxTokens: 900, briefEffort: 'xhigh' });
    expect(DEFAULT_MODEL_PARAMS_CONFIG).toEqual({
      draftThinking: ENV_DEFAULTS.ANTHROPIC_DRAFT_THINKING,
      draftEffort: ENV_DEFAULTS.ANTHROPIC_DRAFT_EFFORT,
      draftMaxTokens: Number(ENV_DEFAULTS.ANTHROPIC_DRAFT_MAX_TOKENS),
      briefEffort: ENV_DEFAULTS.ANTHROPIC_BRIEF_EFFORT,
    });
  });
});

describe('validateModelParams', () => {
  const sonnetOk = { max_tokens: 1024, thinking: { type: 'between_tools' }, output_config: { effort: 'medium' } };

  it.each([
    ['Sonnet 5.5 thinking disabled (400)', SONNET, { ...sonnetOk, thinking: { type: 'disabled' } }, 'thinking_type_rejected'],
    ['Sonnet 5.5 manual extended thinking (400)', SONNET, { ...sonnetOk, thinking: { type: 'enabled', budget_tokens: 2048 } }, 'thinking_invalid'],
    ['between_tools at xhigh (400)', SONNET, { ...sonnetOk, output_config: { effort: 'xhigh' } }, 'between_tools_effort_too_high'],
    ['between_tools at max (400)', SONNET, { ...sonnetOk, output_config: { effort: 'max' } }, 'between_tools_effort_too_high'],
    ['Sonnet 5.5 without an explicit effort (policy)', SONNET, { max_tokens: 256, thinking: { type: 'adaptive' } }, 'effort_required'],
    ['an unknown effort', SONNET, { ...sonnetOk, output_config: { effort: 'extreme' } }, 'effort_invalid'],
    ['temperature', SONNET, { ...sonnetOk, temperature: 0 }, 'sampling_param_not_allowed'],
    ['top_p on Haiku', HAIKU, { max_tokens: 256, top_p: 0.9 }, 'sampling_param_not_allowed'],
    ['forced tool_choice', SONNET, { ...sonnetOk, tool_choice: { type: 'any' } }, 'tool_choice_not_allowed'],
    ['tools', SONNET, { ...sonnetOk, tools: [] }, 'tools_not_allowed'],
    ['an assistant prefill', SONNET, { ...sonnetOk, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '{' }] }, 'prefill_not_allowed'],
    ['no messages at all', HAIKU, { max_tokens: 256, messages: [] }, 'prefill_not_allowed'],
    ['inference_geo (400 on Haiku)', HAIKU, { max_tokens: 256, inference_geo: 'us' }, 'unknown_param'],
    ['adaptive thinking on Haiku 4.5 (400)', HAIKU, { max_tokens: 256, thinking: { type: 'adaptive' } }, 'thinking_not_allowed'],
    ['effort on Haiku 4.5 (not supported)', HAIKU, { max_tokens: 256, output_config: { effort: 'low' } }, 'effort_not_supported'],
    ['max_tokens above Haiku output limit', HAIKU, { max_tokens: 64_001 }, 'max_tokens_above_model_limit'],
    ['a fractional max_tokens', HAIKU, { max_tokens: 1.5 }, 'max_tokens_invalid'],
    ['a missing max_tokens', HAIKU, {}, 'max_tokens_invalid'],
    ['a bad output format', HAIKU, { max_tokens: 256, output_config: { format: { type: 'json_object' } } }, 'output_config_invalid'],
    ['an unknown model', 'claude-opus-5', { max_tokens: 256 }, 'model_not_supported'],
  ])('rejects %s', (_label, model, params, issue) => {
    expect(validateModelParams(model, params)).toContain(issue);
    expect(() => assertValidModelParams(model, params)).toThrow(InvalidModelParamsError);
  });

  it('accepts a full request body with a user turn last and a json_schema format', () => {
    const body = {
      model: SONNET,
      max_tokens: 1024,
      system: 'rules',
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'between_tools' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: { type: 'object' } } },
    };
    expect(validateModelParams(SONNET, body)).toEqual([]);
  });
});

describe('FakeLLM asserts every request against buildModelParams (M2 hook)', () => {
  it('accepts the default models and settings for every purpose', async () => {
    const llm = new FakeLLM();
    await expect(llm.classify({ message: 'Blocked drain', formName: 'Contact us', firstName: 'Ana', company: null })).resolves.toMatchObject({ ok: true });
    await expect(llm.generateBrief({ pages: [], sourceUrl: 'https://brightside-plumbing.example/' }, { timeoutMs: 50_000, attempt: 0 })).resolves.toMatchObject({ ok: true });
    await expect(llm.generateBrief({ pages: [], sourceUrl: 'https://brightside-plumbing.example/' }, { timeoutMs: 20_000, attempt: 1 })).resolves.toMatchObject({ ok: true });
    await expect(llm.draft({ brief: BRIEF, lead: LEAD, previousErrorCodes: ['max_tokens'] })).resolves.toMatchObject({ ok: true });
    await expect(llm.draftFollowUp({ brief: BRIEF, lead: LEAD, previousErrorCodes: [], followUpNumber: 1, original: null })).resolves.toMatchObject({ ok: true });
  });

  it('accepts Sonnet 5.5 as the fast model', async () => {
    const llm = new FakeLLM({ models: { draft: SONNET, fast: SONNET } });
    await expect(llm.classify({ message: 'Hi', formName: 'Contact us', firstName: null, company: null })).resolves.toMatchObject({ ok: true });
  });

  it('throws for a model outside the table', async () => {
    const llm = new FakeLLM({ models: { fast: 'claude-opus-5' } });
    await expect(llm.classify({ message: 'Hi', formName: 'Contact us', firstName: null, company: null })).rejects.toThrow(ConfigError);
    expect(llm.calls).toEqual([]);
  });

  it('throws for an env combination the API would reject (between_tools at effort max)', async () => {
    const llm = new FakeLLM({ modelParams: { ...DEFAULT_MODEL_PARAMS_CONFIG, draftEffort: 'max' } });
    await expect(llm.draft({ brief: BRIEF, lead: LEAD, previousErrorCodes: [] })).rejects.toThrow(InvalidModelParamsError);
  });

  it('still runs the extra assertRequest hook after the built-in check', async () => {
    const seen: string[] = [];
    const llm = new FakeLLM({ assertRequest: (request) => seen.push(request.purpose) });
    await llm.classify({ message: 'Hi', formName: 'Contact us', firstName: null, company: null });
    expect(seen).toEqual(['classify']);
  });
});
