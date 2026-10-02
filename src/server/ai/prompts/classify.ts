import 'server-only';
import type { ClassifyInput } from '@/server/ports/llm';
import { UNTRUSTED_INPUT_RULES, untrustedField } from './untrusted';

// The classification prompt (brief §5.2, PLAN §9.3 step 2, D-47). The fast model sorts one form
// submission into a class; the structured-output schema (CLASSIFICATION_JSON_SCHEMA) constrains the
// answer to the enum, so the prompt carries only the definitions and the injection rules. It never
// asks the model to explain itself (that invites reasoning_extraction refusals, AI-REFUSAL-HANDLING).
// Only `lead` and `unclear` get a draft, and any failure becomes `unclear`, so the prompt leans
// towards keeping a possible customer rather than filtering one out.

/** Character budgets per field: classification needs the gist, and long input costs money. */
export const CLASSIFY_FIELD_LIMITS = { message: 4000, formName: 200, firstName: 100, company: 200 } as const;

export const CLASSIFY_SYSTEM_PROMPT = [
  'You sort messages that arrive through the contact forms on a small business\'s website.',
  'Choose exactly one class for the submission:',
  '- lead: a person or company that might become a customer: asks about the business\'s products or services, prices, availability, a quote, a booking or an appointment.',
  '- spam: junk with no real enquiry: scams, crypto or casino offers, link building or guest posts, gibberish, mass mailings.',
  '- vendor_pitch: someone selling something to the business, such as marketing, SEO, web design, lead generation, software, staffing, outsourcing or financing.',
  '- job_seeker: someone asking for a job, an apprenticeship or an internship, or sending a CV.',
  '- support_request: an existing customer about something already bought or done: an order, invoice, refund, account, warranty or a past job.',
  '- unclear: too little information to tell, or it fits none of the classes above.',
  'If the submission could plausibly be a genuine enquiry from a potential customer, choose lead (or unclear when it is too thin to tell), not one of the filtered classes.',
  'Also choose the reason_code that best names the main signal.',
  UNTRUSTED_INPUT_RULES,
].join('\n');

export interface ClassifyPrompt {
  system: string;
  /** A single user turn: the conversation always ends with the user (no prefill, D-24). */
  messages: [{ role: 'user'; content: string }];
}

export function buildClassifyPrompt(input: ClassifyInput): ClassifyPrompt {
  const content = [
    'Classify this form submission.',
    untrustedField('form_name', input.formName, CLASSIFY_FIELD_LIMITS.formName),
    untrustedField('first_name', input.firstName, CLASSIFY_FIELD_LIMITS.firstName),
    untrustedField('company', input.company, CLASSIFY_FIELD_LIMITS.company),
    untrustedField('message', input.message, CLASSIFY_FIELD_LIMITS.message),
  ].join('\n');
  return { system: CLASSIFY_SYSTEM_PROMPT, messages: [{ role: 'user', content }] };
}
