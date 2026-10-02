import 'server-only';
import type { HubSpotForm } from '@/server/ports';

// Newsletter-like forms are unticked by default (brief §4 step 2.3, PLAN §7.5, HS-ONBOARD-NEWSLETTER-DETECT).
// HubSpot has no newsletter flag, so this is a heuristic over the form definition. Pure: no I/O.
//
// Sufficient on its own (either one):
//   (a) the only visible fields are `email`, optionally with `firstname`/`lastname`, and the form has
//       no `multi_line_text` field and no field named `message` (hidden ones included);
//   (b) a lifecycle stage of `subscriber`.
// Supporting only (research: every contact form with consent configured carries the consent
// checkboxes, and a contact form's button can say "Get updates"):
//   (c) a subscription consent option; (d) newsletter wording in the name or the submit button.
//   Together, (c) and (d) are enough; either alone is not.
// A false positive hides a real enquiry form's leads, which is worse than a false negative, so the
// rule stays conservative. The owner can always tick a form again.

const NAME_ONLY_FIELDS: ReadonlySet<string> = new Set(['email', 'firstname', 'lastname']);
const NEWSLETTER_WORDING = /newsletter|subscribe|blog|updates/i;

export type NewsletterSignal = 'email_only' | 'subscriber_stage' | 'consent_and_wording';

/** The detection inputs: the parts of a form definition the heuristic reads. */
export type NewsletterFormInput = Pick<HubSpotForm, 'name' | 'fields' | 'lifecycleStages' | 'hasSubscriptionConsent' | 'submitButtonText'>;

function isEmailOnly(form: NewsletterFormInput): boolean {
  const names = form.fields.map((field) => field.name.trim().toLowerCase());
  if (form.fields.some((field) => field.fieldType === 'multi_line_text') || names.includes('message')) return false;
  const visible = form.fields.filter((field) => !field.hidden).map((field) => field.name.trim().toLowerCase());
  return visible.includes('email') && visible.every((name) => NAME_ONLY_FIELDS.has(name));
}

/** Which signal marks the form as newsletter-like, or null when none does. */
export function newsletterSignal(form: NewsletterFormInput): NewsletterSignal | null {
  if (isEmailOnly(form)) return 'email_only';
  if (form.lifecycleStages.some((stage) => stage.trim().toLowerCase() === 'subscriber')) return 'subscriber_stage';
  const wording = NEWSLETTER_WORDING.test(form.name) || NEWSLETTER_WORDING.test(form.submitButtonText ?? '');
  if (form.hasSubscriptionConsent && wording) return 'consent_and_wording';
  return null;
}

export function isLikelyNewsletter(form: NewsletterFormInput): boolean {
  return newsletterSignal(form) !== null;
}
