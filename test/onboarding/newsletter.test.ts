import { describe, expect, it } from 'vitest';
import type { HubSpotFormField } from '@/server/ports';
import { isLikelyNewsletter, newsletterSignal, type NewsletterFormInput } from '@/server/services/onboarding/newsletter';

// Newsletter detection (HS-ONBOARD-NEWSLETTER-DETECT): (a) email-only visible fields or (b) a
// `subscriber` lifecycle stage untick a form; consent and wording are supporting signals only.

function field(name: string, fieldType = 'single_line_text', hidden = false): HubSpotFormField {
  return { name, fieldType, hidden, objectTypeId: '0-1' };
}

function form(overrides: Partial<NewsletterFormInput> = {}): NewsletterFormInput {
  return {
    name: 'Contact us',
    fields: [field('firstname'), field('lastname'), field('email', 'email'), field('company'), field('message', 'multi_line_text')],
    lifecycleStages: ['lead'],
    hasSubscriptionConsent: false,
    submitButtonText: 'Send message',
    ...overrides,
  };
}

describe('isLikelyNewsletter', () => {
  it('leaves an enquiry form with a message field ticked', () => {
    expect(isLikelyNewsletter(form())).toBe(false);
  });

  it('flags a form whose only field is the email address (the fixture newsletter form)', () => {
    const newsletter = form({
      name: 'Newsletter signup',
      fields: [field('email', 'email')],
      lifecycleStages: ['subscriber'],
      hasSubscriptionConsent: true,
      submitButtonText: 'Subscribe',
    });
    expect(newsletterSignal(newsletter)).toBe('email_only');
  });

  it('flags an email form that also asks for first and last name', () => {
    expect(newsletterSignal(form({ fields: [field('firstname'), field('lastname'), field('email', 'email')] }))).toBe('email_only');
  });

  it('ignores hidden fields when deciding that only the email is asked for', () => {
    expect(newsletterSignal(form({ fields: [field('email', 'email'), field('utm_source', 'single_line_text', true)] }))).toBe('email_only');
  });

  it('does not flag an email-only form that has a message field, even a hidden one', () => {
    expect(isLikelyNewsletter(form({ fields: [field('email', 'email'), field('message', 'multi_line_text', true)] }))).toBe(false);
  });

  it('does not flag an email-only form with any multi-line text field', () => {
    expect(isLikelyNewsletter(form({ fields: [field('email', 'email'), field('project_details', 'multi_line_text')] }))).toBe(false);
  });

  it('does not flag a short form that asks for a phone number', () => {
    expect(isLikelyNewsletter(form({ fields: [field('email', 'email'), field('phone', 'phone')] }))).toBe(false);
  });

  it('flags any form that makes the contact a subscriber', () => {
    expect(newsletterSignal(form({ lifecycleStages: ['Subscriber'] }))).toBe('subscriber_stage');
  });

  it('does not flag a contact form only because it carries subscription consent checkboxes', () => {
    expect(isLikelyNewsletter(form({ hasSubscriptionConsent: true }))).toBe(false);
  });

  it('does not flag a contact form only because of its wording', () => {
    expect(isLikelyNewsletter(form({ name: 'Contact us for updates', submitButtonText: 'Get updates' }))).toBe(false);
  });

  it('flags consent together with newsletter wording', () => {
    expect(newsletterSignal(form({ hasSubscriptionConsent: true, submitButtonText: 'Subscribe' }))).toBe('consent_and_wording');
    expect(newsletterSignal(form({ hasSubscriptionConsent: true, name: 'Monthly newsletter' }))).toBe('consent_and_wording');
  });
});
