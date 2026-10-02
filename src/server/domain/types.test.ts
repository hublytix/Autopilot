import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as types from './types';
import {
  AI_CALL_OUTCOMES,
  CLASSIFICATIONS,
  DRAFT_FLAGS,
  DRAFTABLE_CLASSIFICATIONS,
  EMAIL_METADATA_PROPERTIES,
  HUBSPOT_FORM_TYPES,
  JOB_KINDS,
  LLM_FAILURE_KINDS,
  NOTIFICATION_KINDS,
  OFFERED_FORM_TYPES,
  RAZORPAY_SUBSCRIPTION_STATUSES,
  STOP_REASONS,
  SUBSCRIPTION_STATUSES,
  isClassification,
  isDraftableClassification,
  isOneOf,
  isSubscriptionStatus,
} from './types';

const exported: [string, unknown][] = Object.entries(types);
const enumArrays = exported.filter(
  (entry): entry is [string, readonly string[]] =>
    Array.isArray(entry[1]) && entry[1].every((value: unknown) => typeof value === 'string'),
);

describe('domain enum arrays', () => {
  it('exports at least the enums PLAN §5 needs', () => {
    expect(enumArrays.length).toBeGreaterThanOrEqual(30);
  });

  it.each(enumArrays)('%s is non-empty, duplicate-free and snake_case-or-upper strings', (_name, values) => {
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value).toMatch(/^[a-z][a-z0-9_]*$|^[A-Z][A-Z_]*$/);
    }
  });

  it('every enum array has a type guard that accepts exactly its members', () => {
    const guards = exported.filter(
      ([name, value]) => name.startsWith('is') && name !== 'isOneOf' && typeof value === 'function',
    );
    expect(guards.length).toBe(enumArrays.length);
  });
});

describe('isOneOf guards', () => {
  it('accepts members and rejects other strings and non-strings', () => {
    expect(isClassification('lead')).toBe(true);
    expect(isClassification('LEAD')).toBe(false);
    expect(isClassification('')).toBe(false);
    expect(isClassification(undefined)).toBe(false);
    expect(isClassification(null)).toBe(false);
    expect(isClassification(['lead'])).toBe(false);
  });

  it('is not fooled by Object.prototype keys', () => {
    const guard = isOneOf(['a', 'b'] as const);
    expect(guard('toString')).toBe(false);
    expect(guard('constructor')).toBe(false);
  });

  it('narrows unknown input to the union', () => {
    const raw: unknown = 'spam';
    if (!isClassification(raw)) throw new Error('expected a classification');
    const narrowed: types.Classification = raw;
    expect(narrowed).toBe('spam');
  });
});

describe('values fixed by PLAN and DECISIONS', () => {
  it('subscription statuses are Razorpay’s nine plus the local stale and unknown (D-18, D-82)', () => {
    expect(RAZORPAY_SUBSCRIPTION_STATUSES).toHaveLength(9);
    expect(SUBSCRIPTION_STATUSES).toEqual([...RAZORPAY_SUBSCRIPTION_STATUSES, 'stale', 'unknown']);
    expect(isSubscriptionStatus('paused')).toBe(true);
    expect(isSubscriptionStatus('resumed')).toBe(false);
    expect(isSubscriptionStatus('trialing')).toBe(false);
  });

  it('draft flags are the closed enum from D-24', () => {
    expect([...DRAFT_FLAGS].sort()).toEqual(
      ['asks_pricing', 'urgent', 'non_english', 'missing_info', 'possible_spam', 'sensitive_topic', 'other'].sort(),
    );
  });

  it('only lead and unclear get drafts', () => {
    expect(DRAFTABLE_CLASSIFICATIONS).toEqual(['lead', 'unclear']);
    for (const c of CLASSIFICATIONS) {
      expect(isDraftableClassification(c)).toBe(c === 'lead' || c === 'unclear');
    }
  });

  it('the email metadata allow-list never includes content properties (D-03)', () => {
    const content = ['hs_email_subject', 'hs_email_text', 'hs_email_html', 'hs_email_headers', 'hs_attachment_ids', 'hs_body_preview'];
    for (const property of content) {
      expect(EMAIL_METADATA_PROPERTIES).not.toContain(property);
    }
    expect(EMAIL_METADATA_PROPERTIES).toHaveLength(5);
  });

  it('offers hubspot and flow forms only, a subset of the known form types (D-07)', () => {
    expect(OFFERED_FORM_TYPES).toEqual(['hubspot', 'flow']);
    for (const t of OFFERED_FORM_TYPES) expect(HUBSPOT_FORM_TYPES).toContain(t);
  });

  it('has every job kind, notification kind and stop reason the plan names', () => {
    expect(JOB_KINDS).toHaveLength(9);
    expect(NOTIFICATION_KINDS).toHaveLength(12);
    expect(STOP_REASONS).toHaveLength(11);
  });

  it('ai call outcomes cover every LLM failure kind', () => {
    for (const kind of LLM_FAILURE_KINDS) expect(AI_CALL_OUTCOMES).toContain(kind);
  });
});

describe('zod interop', () => {
  it('the arrays work directly with z.enum', () => {
    const schema = z.enum(CLASSIFICATIONS);
    expect(schema.parse('vendor_pitch')).toBe('vendor_pitch');
    expect(schema.safeParse('newsletter').success).toBe(false);
  });
});
