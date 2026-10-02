import 'server-only';
import { MAX_FAQS } from '@/server/services/brief/limits';
import type { PreferencesInput } from '@/server/services/onboarding';
import type { BriefFormValues, PreferencesFormValues } from './types';

// FormData → the services' inputs for the onboarding forms (pure, so the field mapping is tested).
// Every value is untrusted; the services validate. Lists are one item per line; FAQs come as
// numbered question/answer pairs (`faq_q_0` … `faq_a_7`); a pair left blank is dropped.

/** The longest value read from any field: longer input is cut, then the services' limits apply. */
const MAX_FIELD_CHARS = 20_000;

export function formText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_CHARS) : '';
}

function checked(formData: FormData, name: string): boolean {
  return formData.get(name) === 'on';
}

function lines(value: string): string[] {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isBlankFaq(faq: { q: string; a: string }): boolean {
  return faq.q.trim().length === 0 && faq.a.trim().length === 0;
}

/**
 * The form's values. FAQ pairs are compacted (filled pairs first, in order, then the blank ones), so
 * an issue path such as `faqs.1.a` from the service names the same row the form shows again.
 */
export function parseBriefForm(formData: FormData): BriefFormValues {
  const rows: BriefFormValues['faqs'] = [];
  for (let index = 0; index < MAX_FAQS; index += 1) {
    rows.push({ q: formText(formData, `faq_q_${index}`), a: formText(formData, `faq_a_${index}`) });
  }
  const faqs = [...rows.filter((faq) => !isBlankFaq(faq)), ...rows.filter(isBlankFaq)];
  return {
    company_name: formText(formData, 'company_name'),
    one_line: formText(formData, 'one_line'),
    services: formText(formData, 'services'),
    who_we_serve: formText(formData, 'who_we_serve'),
    tone_style: formText(formData, 'tone_style'),
    tone_note: formText(formData, 'tone_note'),
    sign_off_name: formText(formData, 'sign_off_name'),
    allow_pricing: checked(formData, 'allow_pricing'),
    never_promise: formText(formData, 'never_promise'),
    faqs,
    booking_choice: formText(formData, 'booking_choice'),
    booking_link_found: formText(formData, 'booking_link_found'),
    booking_link_other: formText(formData, 'booking_link_other'),
  };
}

/**
 * The saveOwnerBrief input. Booking link: `found` confirms the link the site gave (its host was
 * shown with the choice), `other` is a link the owner typed (typing it is the confirmation), `none`
 * is an explicit "no booking link"; anything else leaves the choice unset, which saving refuses.
 */
export function briefInputFromValues(values: BriefFormValues): Record<string, unknown> {
  const choice = values.booking_choice;
  const link = choice === 'found' ? values.booking_link_found : choice === 'other' ? values.booking_link_other : null;
  return {
    company_name: values.company_name,
    one_line: values.one_line,
    services: lines(values.services),
    who_we_serve: values.who_we_serve,
    tone: { style: values.tone_style, note: values.tone_note },
    sign_off_name: values.sign_off_name,
    allow_pricing: values.allow_pricing,
    never_promise: lines(values.never_promise),
    faqs: values.faqs.filter((faq) => !isBlankFaq(faq)),
    booking_link_choice: choice === 'found' || choice === 'other' ? 'link' : choice === 'none' ? 'none' : 'unset',
    booking_link: link === null ? null : link.trim(),
    booking_link_confirmed: link !== null,
  };
}

/** Notify-address inputs on the form (the service accepts 1–3). */
export const NOTIFY_EMAIL_FIELDS = 3;

export function parsePreferencesForm(formData: FormData): PreferencesFormValues {
  const notify: string[] = [];
  for (let index = 0; index < NOTIFY_EMAIL_FIELDS; index += 1) notify.push(formText(formData, `notify_email_${index}`));
  return {
    mail_client: formText(formData, 'mail_client'),
    gmail_account_email: formText(formData, 'gmail_account_email'),
    notify_emails: notify,
    quiet_start_hour: formText(formData, 'quiet_start_hour'),
    quiet_end_hour: formText(formData, 'quiet_end_hour'),
    skip_weekends: checked(formData, 'skip_weekends'),
    followups_enabled: checked(formData, 'followups_enabled'),
    bcc_address: formText(formData, 'bcc_address'),
    timezone: formText(formData, 'timezone'),
  };
}

function hour(value: string): number {
  return /^\d{1,2}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
}

export function preferencesInputFromValues(values: PreferencesFormValues): PreferencesInput {
  return {
    mail_client: values.mail_client,
    gmail_account_email: values.gmail_account_email.trim() === '' ? null : values.gmail_account_email,
    notify_emails: values.notify_emails,
    quiet_start_hour: hour(values.quiet_start_hour),
    quiet_end_hour: hour(values.quiet_end_hour),
    skip_weekends: values.skip_weekends,
    followups_enabled: values.followups_enabled,
    bcc_address: values.bcc_address.trim() === '' ? null : values.bcc_address,
    timezone: values.timezone.trim() === '' ? null : values.timezone,
  };
}
