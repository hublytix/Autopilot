import { describe, expect, it } from 'vitest';
import type { BriefDraft, DraftInput } from '@/server/ports/llm';
import { buildDraftPrompt, DRAFT_FIELD_LIMITS, DRAFT_SYSTEM_PROMPT, retryBlock } from './draft';
import { buildFollowUpPrompt, FOLLOW_UP_SYSTEM_PROMPT } from './followup';

const BRIEF: BriefDraft = {
  company_name: 'Smith & Sons Plumbing',
  one_line: 'Plumbers.',
  services: ['Repairs'],
  who_we_serve: 'Homes',
  booking_link: 'https://cal.example.com/smith',
  tone: { style: 'direct', note: '' },
  sign_off_name: 'Sam',
  allow_pricing: true,
  never_promise: [],
  faqs: [],
};

const INPUT: DraftInput = { brief: BRIEF, lead: { firstName: null, company: null, message: 'x'.repeat(10_000), formName: 'Quote' }, previousErrorCodes: [] };

describe('draft prompts (D-47)', () => {
  it('cuts the lead message to its budget and marks the cut', () => {
    const content = buildDraftPrompt(INPUT).messages[0].content;
    const message = /<untrusted_input field="message">(x*)( \[truncated\])?<\/untrusted_input>/.exec(content);
    expect(message?.[1]).toHaveLength(DRAFT_FIELD_LIMITS.message);
    expect(message?.[2]).toBe(' [truncated]');
  });

  it('writes a missing first name and company as empty elements', () => {
    const content = buildDraftPrompt(INPUT).messages[0].content;
    expect(content).toContain('<untrusted_input field="first_name"></untrusted_input>');
    expect(content).toContain('<untrusted_input field="company"></untrusted_input>');
  });

  it('escapes brief text too, and tells the model how to write it back', () => {
    expect(buildDraftPrompt(INPUT).messages[0].content).toContain('<untrusted_input field="company_name">Smith &amp; Sons Plumbing</untrusted_input>');
    expect(DRAFT_SYSTEM_PROMPT).toContain('write them as the plain characters');
  });

  it('states the pricing rule from the brief', () => {
    expect(buildDraftPrompt(INPUT).messages[0].content).toContain('Pricing: allowed');
    expect(buildDraftPrompt({ ...INPUT, brief: { ...BRIEF, allow_pricing: false } }).messages[0].content).toContain('Pricing: not allowed');
  });

  it('keeps the system prompt identical across attempts (only the user turn changes)', () => {
    const first = buildDraftPrompt(INPUT);
    const retry = buildDraftPrompt({ ...INPUT, previousErrorCodes: ['too_long'] });
    expect(retry.system).toBe(first.system);
    expect(retry.messages).toHaveLength(1);
    expect(buildFollowUpPrompt({ ...INPUT, followUpNumber: 1, original: null, previousErrorCodes: ['echoes_lead'] }).system).toBe(FOLLOW_UP_SYSTEM_PROMPT);
  });

  it('never asks the model to explain its reasoning (AI-REFUSAL-HANDLING)', () => {
    for (const prompt of [DRAFT_SYSTEM_PROMPT, FOLLOW_UP_SYSTEM_PROMPT]) expect(prompt).not.toMatch(/explain|reasoning|think/i);
  });
});

describe('retryBlock', () => {
  it('is null on a first attempt', () => {
    expect(retryBlock([], 120)).toBeNull();
  });

  it('explains each code once, in a fixed order, without any draft text', () => {
    const block = retryBlock(['url_not_allowed', 'too_long', 'url_not_allowed', 'max_tokens'], 70) ?? '';
    const lines = block.split('\n').slice(1);
    expect(lines).toEqual([
      '- The body was longer than 70 words.',
      '- It contained a web address or domain other than the booking link.',
      '- The answer was cut off before it was complete. Keep it short.',
    ]);
  });
});
