import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_BOOKING_LINK } from '@/server/adapters/fake/web-fetcher';
import { briefInputFromValues, parseBriefForm, parsePreferencesForm, preferencesInputFromValues } from '@/server/actions/onboarding/parse';
import { getLatestBrief, saveOwnerBrief } from '@/server/services/brief';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createOnboardingRig, type OnboardingRig } from './support';

// The onboarding forms' FormData → service input mapping (the Server Actions run exactly this).

function briefForm(fields: Record<string, string>): FormData {
  const form = new FormData();
  const base: Record<string, string> = {
    company_name: 'Brightside Plumbing',
    one_line: 'Family-run plumbers.',
    services: 'Emergency repairs\n\n  Drain cleaning  \r\nWater heaters',
    who_we_serve: 'Homeowners',
    tone_style: 'friendly',
    tone_note: '',
    sign_off_name: 'Dana',
    never_promise: 'same-day visits\n',
    booking_choice: 'none',
    ...fields,
  };
  for (const [name, value] of Object.entries(base)) form.set(name, value);
  return form;
}

describe('parseBriefForm', () => {
  it('reads list fields one item per line and leaves prices off unless ticked', () => {
    const input = briefInputFromValues(parseBriefForm(briefForm({})));
    expect(input).toMatchObject({
      services: ['Emergency repairs', 'Drain cleaning', 'Water heaters'],
      never_promise: ['same-day visits'],
      allow_pricing: false,
      faqs: [],
      booking_link_choice: 'none',
      booking_link: null,
      booking_link_confirmed: false,
    });
    expect(briefInputFromValues(parseBriefForm(briefForm({ allow_pricing: 'on' })))).toMatchObject({ allow_pricing: true });
  });

  it('moves filled FAQ rows first, so an error path names the row the form shows again', () => {
    const values = parseBriefForm(briefForm({ faq_q_0: 'Do you work weekends?', faq_a_0: 'Yes.', faq_q_3: 'Are you insured?', faq_a_3: '' }));
    expect(values.faqs.slice(0, 3)).toEqual([
      { q: 'Do you work weekends?', a: 'Yes.' },
      { q: 'Are you insured?', a: '' },
      { q: '', a: '' },
    ]);
    expect(values.faqs).toHaveLength(8);
    expect(briefInputFromValues(values).faqs).toEqual([
      { q: 'Do you work weekends?', a: 'Yes.' },
      { q: 'Are you insured?', a: '' },
    ]);
  });

  it('maps the booking choices: the found link, a typed link, none, or nothing chosen', () => {
    expect(briefInputFromValues(parseBriefForm(briefForm({ booking_choice: 'found', booking_link_found: FIXTURE_BOOKING_LINK })))).toMatchObject({
      booking_link_choice: 'link',
      booking_link: FIXTURE_BOOKING_LINK,
      booking_link_confirmed: true,
    });
    expect(
      briefInputFromValues(parseBriefForm(briefForm({ booking_choice: 'other', booking_link_found: FIXTURE_BOOKING_LINK, booking_link_other: ' https://book.example.com/x ' }))),
    ).toMatchObject({ booking_link_choice: 'link', booking_link: 'https://book.example.com/x', booking_link_confirmed: true });
    expect(briefInputFromValues(parseBriefForm(briefForm({ booking_choice: '' })))).toMatchObject({ booking_link_choice: 'unset', booking_link: null });
  });
});

describe('saving a brief from the form', () => {
  const getDb = setUpTestDb();
  let rig: OnboardingRig;

  beforeEach(async () => {
    rig = await createOnboardingRig(getDb());
  });

  it('refuses a form with no booking-link choice and names the field', async () => {
    const result = await saveOwnerBrief(rig.scope, rig.deps, briefInputFromValues(parseBriefForm(briefForm({ booking_choice: '' }))));
    expect(result).toEqual({ ok: false, issues: [{ path: 'booking_link_choice', code: 'booking_link_choice_required' }] });
  });

  it('refuses an http booking link the owner typed', async () => {
    const result = await saveOwnerBrief(rig.scope, rig.deps, briefInputFromValues(parseBriefForm(briefForm({ booking_choice: 'other', booking_link_other: 'http://book.example.com' }))));
    expect(result).toEqual({ ok: false, issues: [{ path: 'booking_link', code: 'booking_link_not_https' }] });
  });

  it('saves an owner version with the confirmed booking link', async () => {
    const result = await saveOwnerBrief(rig.scope, rig.deps, briefInputFromValues(parseBriefForm(briefForm({ booking_choice: 'found', booking_link_found: FIXTURE_BOOKING_LINK }))));
    expect(result.ok).toBe(true);
    const state = await getLatestBrief(rig.scope, rig.deps);
    expect(state.saved).toMatchObject({ source: 'owner', bookingLinkChoice: 'link', bookingLinkConfirmed: true });
    expect(state.saved?.brief.booking_link).toBe(FIXTURE_BOOKING_LINK);
  });
});

describe('parsePreferencesForm', () => {
  it('reads the three address fields, the hours as numbers and the checkboxes', () => {
    const form = new FormData();
    form.set('mail_client', 'outlook_work');
    form.set('notify_email_0', 'owner@example.com');
    form.set('notify_email_2', 'office@example.com');
    form.set('quiet_start_hour', '19');
    form.set('quiet_end_hour', '8');
    form.set('skip_weekends', 'on');
    form.set('bcc_address', '  ');
    expect(preferencesInputFromValues(parsePreferencesForm(form))).toEqual({
      mail_client: 'outlook_work',
      gmail_account_email: null,
      notify_emails: ['owner@example.com', '', 'office@example.com'],
      quiet_start_hour: 19,
      quiet_end_hour: 8,
      skip_weekends: true,
      followups_enabled: false,
      bcc_address: null,
      timezone: null,
    });
  });

  it('turns a non-numeric hour into NaN, which validation reports', () => {
    const form = new FormData();
    form.set('quiet_start_hour', '7pm');
    expect(preferencesInputFromValues(parsePreferencesForm(form)).quiet_start_hour).toBeNaN();
  });
});
