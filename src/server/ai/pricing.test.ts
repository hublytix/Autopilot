import { describe, expect, it } from 'vitest';
import { costMicroUsd, hasKnownPrice } from './pricing';

const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5-20251001';

describe('costMicroUsd (TV6, prices as of 2026-10-01)', () => {
  it('prices a Sonnet draft: 1500 in / 250 out = 5500 micro-USD', () => {
    expect(costMicroUsd({ model: SONNET, usage: { inputTokens: 1500, outputTokens: 250 } })).toBe(5500);
  });

  it('prices a Haiku classification: 600 in / 20 out = 700 micro-USD', () => {
    expect(costMicroUsd({ model: HAIKU, usage: { inputTokens: 600, outputTokens: 20 } })).toBe(700);
    expect(costMicroUsd({ model: 'claude-haiku-4-5', usage: { inputTokens: 600, outputTokens: 20 } })).toBe(700);
  });

  it('prices a Sonnet brief: 30000 in / 1500 out = 75000 micro-USD', () => {
    expect(costMicroUsd({ model: SONNET, usage: { inputTokens: 30_000, outputTokens: 1500 } })).toBe(75_000);
  });

  it('bills nothing for a general_harms (or uncategorised) refusal before any output', () => {
    const usage = { inputTokens: 412, outputTokens: 0 };
    expect(costMicroUsd({ model: SONNET, usage, stopReason: 'refusal', refusalCategory: 'general_harms' })).toBe(0);
    expect(costMicroUsd({ model: SONNET, usage, stopReason: 'refusal', refusalCategory: null })).toBe(0);
    expect(costMicroUsd({ model: SONNET, usage, stopReason: 'refusal', refusalCategory: 'cyber' })).toBe(0);
  });

  it('bills the input of a bio, frontier_llm or reasoning_extraction refusal: 412 in = 824 micro-USD', () => {
    const usage = { inputTokens: 412, outputTokens: 0 };
    for (const refusalCategory of ['bio', 'frontier_llm', 'reasoning_extraction'] as const) {
      expect(costMicroUsd({ model: SONNET, usage, stopReason: 'refusal', refusalCategory })).toBe(824);
    }
  });

  it('bills a refusal that came after some output in full', () => {
    expect(costMicroUsd({ model: SONNET, usage: { inputTokens: 100, outputTokens: 10 }, stopReason: 'refusal', refusalCategory: 'general_harms' })).toBe(300);
  });

  it('prices cache reads and (5-minute) cache writes separately, rounding up to whole micro-USD', () => {
    expect(costMicroUsd({ model: SONNET, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 1000 } })).toBe(2700);
    expect(costMicroUsd({ model: HAIKU, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 3 } })).toBe(1);
  });

  it('has no price for an unknown model', () => {
    expect(hasKnownPrice('claude-opus-5-5')).toBe(false);
    expect(hasKnownPrice('constructor')).toBe(false);
    expect(costMicroUsd({ model: 'claude-opus-5-5', usage: { inputTokens: 10, outputTokens: 10 } })).toBeNull();
  });

  it('treats missing or nonsensical token counts as zero', () => {
    expect(costMicroUsd({ model: SONNET, usage: { inputTokens: Number.NaN, outputTokens: -5 } })).toBe(0);
  });
});
