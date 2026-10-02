import { describe, expect, expectTypeOf, it } from 'vitest';
import type { BriefDraft, ClassifyOutput, DraftOutput } from '@/server/ports/llm';
import {
  BriefOutputSchema,
  ClassificationOutputSchema,
  DraftOutputSchema,
  type BriefOutput,
  type ClassificationOutput,
  type DraftOutputParsed,
} from './schemas';

const BRIEF = {
  company_name: 'Brightside Plumbing',
  one_line: 'A family-run plumber.',
  services: ['Drain cleaning'],
  who_we_serve: 'Homeowners in Riverton',
  booking_link: null,
  tone: { style: 'Friendly', note: 'Warm.' },
  sign_off_name: '',
  allow_pricing: true,
  never_promise: [],
  faqs: [{ q: 'Do you work weekends?', a: 'Yes.' }],
};

describe('output schemas', () => {
  it('parse into exactly the port types', () => {
    expectTypeOf<ClassificationOutput>().toExtend<ClassifyOutput>();
    expectTypeOf<BriefOutput>().toEqualTypeOf<BriefDraft>();
    expectTypeOf<DraftOutputParsed>().toEqualTypeOf<DraftOutput>();
  });

  it('lower-case and trim enum strings before validating (the API does not guarantee their case)', () => {
    expect(ClassificationOutputSchema.parse({ classification: ' Lead', reason_code: 'ASKS_ABOUT_SERVICES' })).toEqual({
      classification: 'lead',
      reason_code: 'asks_about_services',
    });
    expect(BriefOutputSchema.parse(BRIEF).tone.style).toBe('friendly');
    expect(DraftOutputSchema.parse({ subject: 'Hi', body: 'Hello', used_booking_link: false, flags: ['Urgent', 'ASKS_PRICING'] }).flags).toEqual([
      'urgent',
      'asks_pricing',
    ]);
  });

  it('leave free text untouched', () => {
    const draft = DraftOutputSchema.parse({ subject: 'Thanks, Maya', body: 'Hello Maya', used_booking_link: true, flags: [] });
    expect(draft).toEqual({ subject: 'Thanks, Maya', body: 'Hello Maya', used_booking_link: true, flags: [] });
  });

  it('reject values outside the closed enums', () => {
    expect(ClassificationOutputSchema.safeParse({ classification: 'customer', reason_code: 'other' }).success).toBe(false);
    expect(DraftOutputSchema.safeParse({ subject: 'Hi', body: 'x', used_booking_link: false, flags: ['call_now'] }).success).toBe(false);
    expect(BriefOutputSchema.safeParse({ ...BRIEF, tone: { style: 'casual', note: '' } }).success).toBe(false);
  });

  it('reject missing required fields', () => {
    expect(ClassificationOutputSchema.safeParse({ classification: 'lead' }).success).toBe(false);
    const { booking_link: _omitted, ...withoutLink } = BRIEF;
    expect(BriefOutputSchema.safeParse(withoutLink).success).toBe(false);
  });

  it('do not enforce limits the grammar cannot express (FAQs ≤ 8 is cut in code)', () => {
    const faqs = Array.from({ length: 9 }, (_, i) => ({ q: `Question ${i}?`, a: 'Yes.' }));
    expect(BriefOutputSchema.parse({ ...BRIEF, faqs }).faqs).toHaveLength(9);
  });
});
