import 'server-only';
import { z } from 'zod';
import { CLASSIFICATIONS, DRAFT_FLAGS, TONE_STYLES } from '@/server/domain/types';
import { toClaudeJsonSchema, type JsonSchema } from './json-schema';

// Output schemas for the three structured-output calls (D-24, brief §5.2–5.4). One Zod schema per
// call serves both directions: toClaudeJsonSchema() turns it into the grammar sent to the API, and
// the same schema validates the reply. Rules [AI-SO-SCHEMA-LIMITS]:
// - every field is required; "may be absent" is `.nullable()`;
// - enums are lower-case snake_case, and the reply's enum strings are trimmed and lower-cased
//   before validation (the API does not guarantee their capitalisation);
// - no length or count limits here: FAQs ≤ 8, word limits and subject length are enforced in code
//   after parsing (the brief post-processing in M3 and the draft validator in M4).
// Schemas never contain personal data: the API caches them for 24 h [AI-DATA-RETENTION].

/** Trims and lower-cases a string before it reaches the enum check; other values pass unchanged. */
function lowerCased(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/** A closed enum whose model output is compared case-insensitively. */
export function lowerEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(lowerCased, z.enum(values));
}

// ---------------------------------------------------------------------------------------------
// Classification (fast model, brief §5.2)
// ---------------------------------------------------------------------------------------------

/**
 * Why the model chose its class: a closed set, so the reason is machine-readable and can never
 * carry lead text. Diagnostic only; nothing branches on it.
 */
export const CLASSIFICATION_REASON_CODES = [
  'asks_about_services',
  'asks_for_quote_or_booking',
  'sells_to_the_business',
  'job_application',
  'existing_customer_issue',
  'promotional_or_irrelevant',
  'too_little_information',
  'other',
] as const;
export type ClassificationReasonCode = (typeof CLASSIFICATION_REASON_CODES)[number];

export const ClassificationOutputSchema = z.object({
  classification: lowerEnum(CLASSIFICATIONS).describe(
    'lead: a possible customer asking about the business\'s products or services. spam: junk, scams, link or SEO spam, gibberish. ' +
      'vendor_pitch: someone selling something to the business. job_seeker: someone asking for a job or sending a CV. ' +
      'support_request: an existing customer about an existing order, invoice, account or job already done. ' +
      'unclear: too little to tell, or none of the above.',
  ),
  reason_code: lowerEnum(CLASSIFICATION_REASON_CODES).describe('The main signal behind the classification.'),
});
export type ClassificationOutput = z.output<typeof ClassificationOutputSchema>;

// ---------------------------------------------------------------------------------------------
// Business brief (draft model, brief §5.3)
// ---------------------------------------------------------------------------------------------

export const BriefOutputSchema = z.object({
  company_name: z.string().describe('The business name as the website writes it.'),
  one_line: z.string().describe('One sentence: what the business does and for whom.'),
  services: z.array(z.string()).describe('The services or products the business offers, as short phrases.'),
  who_we_serve: z.string().describe('The customers the business serves, e.g. area or kind of customer.'),
  booking_link: z
    .string()
    .nullable()
    .describe('An https booking or scheduling URL that appears in the pages, exactly as written; null if there is none.'),
  tone: z.object({
    style: lowerEnum(TONE_STYLES).describe('The voice the website uses.'),
    note: z.string().describe('A short note on the voice, e.g. "warm, uses first names".'),
  }),
  sign_off_name: z.string().describe('The person who should sign replies, if the pages name one; otherwise an empty string.'),
  allow_pricing: z.boolean().describe('Whether replies may mention prices.'),
  never_promise: z.array(z.string()).describe('Things a reply must never promise, as short phrases.'),
  faqs: z
    .array(z.object({ q: z.string().describe('A question customers ask.'), a: z.string().describe('The answer the pages give.') }))
    .describe('Up to 8 questions and answers taken from the pages.'),
});
export type BriefOutput = z.output<typeof BriefOutputSchema>;

// ---------------------------------------------------------------------------------------------
// Drafts and follow-ups (draft model, brief §5.4)
// ---------------------------------------------------------------------------------------------

export const DraftOutputSchema = z.object({
  subject: z.string().describe('A single-line email subject.'),
  body: z.string().describe('The plain-text email body.'),
  used_booking_link: z.boolean().describe('Whether the body includes the booking link.'),
  flags: z.array(lowerEnum(DRAFT_FLAGS)).describe('Short codes for anything the owner should check; empty if none.'),
});
export type DraftOutputParsed = z.output<typeof DraftOutputSchema>;

// ---------------------------------------------------------------------------------------------
// The JSON Schemas sent as output_config.format (built once, at module load)
// ---------------------------------------------------------------------------------------------

export const CLASSIFICATION_JSON_SCHEMA: JsonSchema = toClaudeJsonSchema(ClassificationOutputSchema);
export const BRIEF_JSON_SCHEMA: JsonSchema = toClaudeJsonSchema(BriefOutputSchema);
export const DRAFT_JSON_SCHEMA: JsonSchema = toClaudeJsonSchema(DraftOutputSchema);
