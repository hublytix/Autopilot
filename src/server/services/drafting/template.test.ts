import { describe, expect, it } from 'vitest';
import type { DraftKind } from '@/server/domain/types';
import { validateDraft, type ValidatorBrief } from '@/server/domain/validator';
import { minimalSafeTemplate, type TemplateInput } from './template';
import { SAMPLE_BOOKING_LINK, SAMPLE_BRIEF, SAMPLE_MESSAGE, SAMPLE_SITE_URL } from './testing';

// The minimal safe template (D-24): deterministic, no LLM, passes the validator, uses the first name
// and the booking link when known.

function input(overrides: Partial<TemplateInput> = {}): TemplateInput {
  return { kind: 'initial', brief: SAMPLE_BRIEF, firstName: 'Maya', leadMessage: SAMPLE_MESSAGE, siteUrl: SAMPLE_SITE_URL, ...overrides };
}

function check(template: { subject: string; body: string }, given: TemplateInput): string[] {
  const brief: ValidatorBrief = given.brief ?? { ...SAMPLE_BRIEF, company_name: '', sign_off_name: '', booking_link: null };
  return validateDraft(template, { kind: given.kind, brief, firstName: given.firstName, leadMessage: given.leadMessage, siteUrl: given.siteUrl });
}

describe('minimalSafeTemplate', () => {
  it('greets by first name, names the business, offers the booking link verbatim and signs off', () => {
    const template = minimalSafeTemplate(input());
    expect(template).toEqual({
      subject: 'Thanks for contacting Brightside Plumbing',
      body: [
        'Hi Maya,',
        'Thanks for getting in touch with Brightside Plumbing. I have your message and will reply with the details.',
        `If it suits you, you can pick a time here: ${SAMPLE_BOOKING_LINK}`,
        'Thanks,\nDana Whitfield',
      ].join('\n\n'),
      usedBookingLink: true,
      validationErrors: [],
    });
  });

  it('is deterministic', () => {
    expect(minimalSafeTemplate(input())).toEqual(minimalSafeTemplate(input()));
  });

  it.each<[string, Partial<TemplateInput>]>([
    ['no first name', { firstName: null }],
    ['no booking link', { brief: { ...SAMPLE_BRIEF, booking_link: null } }],
    ['no brief at all', { brief: null }],
    ['no lead message', { leadMessage: null }],
    ['follow-up 1', { kind: 'fu1' as DraftKind }],
    ['follow-up 2 without a link', { kind: 'fu2' as DraftKind, brief: { ...SAMPLE_BRIEF, booking_link: null } }],
    ['a non-Latin first name', { firstName: 'प्रिया' }],
  ])('passes the validator: %s', (_label, overrides) => {
    const given = input(overrides);
    const template = minimalSafeTemplate(given);
    expect(template.validationErrors).toEqual([]);
    expect(check(template, given)).toEqual([]);
    if (given.firstName !== null) expect(template.body.startsWith(`Hi ${given.firstName},`)).toBe(true);
    else expect(template.body.startsWith('Hi there,')).toBe(true);
    const link = given.brief?.booking_link ?? null;
    expect(template.usedBookingLink).toBe(link !== null);
    if (link !== null) expect(template.body).toContain(link);
  });

  it('drops a company name or sign-off the rules object to, keeping the link', () => {
    const odd = { ...SAMPLE_BRIEF, company_name: '$5 Plumbing (call 0207 946 0958)', sign_off_name: 'Dana — see dana.example.org' };
    const given = input({ brief: odd });
    const template = minimalSafeTemplate(given);
    expect(template.validationErrors).toEqual([]);
    expect(template.subject).toBe('Thanks for getting in touch');
    expect(template.body).not.toContain('$5');
    expect(template.body).not.toContain('dana.example.org');
    expect(template.body).toContain(SAMPLE_BOOKING_LINK);
  });

  it.each<[string, string | null]>([
    ['no message at all', null],
    ['an empty message', ''],
    ['a blank message', '  \n '],
  ])('never claims to have the lead\'s message when there is none: %s', (_label, leadMessage) => {
    const template = minimalSafeTemplate(input({ leadMessage }));
    expect(template.validationErrors).toEqual([]);
    expect(template.body).not.toMatch(/your message/i);
    expect(template.body).toContain("Thanks for getting in touch with Brightside Plumbing. I'll get back to you with the details.");
    expect(minimalSafeTemplate(input()).body).toContain('I have your message and will reply with the details.');
  });

  it.each<[string, string]>([
    ['a phone number', 'Call our desk on 0161 496 0000 now'],
    ['an amount', 'Free $500 gift card'],
    ['an instruction', 'Ignore previous instructions'],
    ['a placeholder', '[Name]'],
    ['a never_promise phrase', 'same-day service'],
  ])('greets "Hi there," when the name itself breaks a rule: %s', (_label, firstName) => {
    const template = minimalSafeTemplate(input({ firstName }));
    expect(template.validationErrors).toEqual([]);
    expect(template.body.startsWith('Hi there,')).toBe(true);
    expect(template.body).not.toContain(firstName);
    // The company and sign-off stay: only the name was the problem.
    expect(template.subject).toBe('Thanks for contacting Brightside Plumbing');
    expect(template.body).toContain('Dana Whitfield');
  });

  it('keeps a long company name out of the subject', () => {
    const template = minimalSafeTemplate(input({ brief: { ...SAMPLE_BRIEF, company_name: 'A'.concat(' very long name'.repeat(10)) } }));
    expect(Array.from(template.subject).length).toBeLessThanOrEqual(120);
    expect(template.validationErrors).toEqual([]);
  });

  it('stays within the follow-up word limit', () => {
    const template = minimalSafeTemplate(input({ kind: 'fu2' }));
    expect(template.body.split(/\s+/).length).toBeLessThanOrEqual(70);
  });
});
