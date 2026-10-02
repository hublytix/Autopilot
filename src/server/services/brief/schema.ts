import 'server-only';
import { z } from 'zod';
import { TONE_STYLES, type BookingLinkChoice } from '@/server/domain/types';
import type { BriefDraft } from '@/server/ports/llm';
import { parseBookingLink } from './booking-link';
import { MAX_FAQS } from './limits';

// The brief the owner saves (brief §5.3, PLAN §7.5 /onboarding/brief, D-47): every field of the
// generated brief, editable, plus the booking-link decision. Text is trimmed, control characters are
// dropped, and each field has a length limit; generated briefs are cut to the same limits so the
// editor can save one unchanged. "unset" is never an owner choice: the owner either gives an https
// link and confirms its host, or says there is no booking link.

export const BRIEF_FIELD_LIMITS = {
  companyName: 120,
  oneLine: 300,
  services: 20,
  service: 120,
  whoWeServe: 300,
  toneNote: 200,
  signOffName: 80,
  neverPromise: 12,
  neverPromiseItem: 200,
  faqs: MAX_FAQS,
  faqQuestion: 300,
  faqAnswer: 1000,
} as const;

/** Drops C0/C1 controls and line separators (keeping newlines only when asked), then trims. */
export function cleanText(value: string, keepNewlines = false): string {
  let out = '';
  for (const char of value.replace(/\r\n?/g, '\n')) {
    const code = char.codePointAt(0) ?? 0;
    const control = (code <= 0x1f && !(keepNewlines && code === 0x0a)) || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += control ? (code === 0x09 || code === 0x0a ? ' ' : '') : char;
  }
  const collapsed = keepNewlines ? out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : out.replace(/\s+/g, ' ');
  return collapsed.trim();
}

/** Cuts to `max` code points (whole characters, never half a surrogate pair). */
export function cutText(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('').trimEnd();
}

function length(value: string): number {
  return Array.from(value).length;
}

function text(max: number, options: { min?: number; multiline?: boolean } = {}) {
  return z
    .string()
    .transform((value) => cleanText(value, options.multiline === true))
    .refine((value) => length(value) >= (options.min ?? 0), { message: 'required' })
    .refine((value) => length(value) <= max, { message: 'too_long' });
}

/** The owner's choice: the stored `booking_link_choice` minus `unset`. */
export const OWNER_BOOKING_LINK_CHOICES = ['link', 'none'] as const satisfies readonly BookingLinkChoice[];

export const OwnerBriefInputSchema = z
  .object({
    company_name: text(BRIEF_FIELD_LIMITS.companyName, { min: 1 }),
    one_line: text(BRIEF_FIELD_LIMITS.oneLine),
    services: z.array(text(BRIEF_FIELD_LIMITS.service, { min: 1 })).max(BRIEF_FIELD_LIMITS.services, { message: 'too_many' }),
    who_we_serve: text(BRIEF_FIELD_LIMITS.whoWeServe),
    tone: z.object({ style: z.enum(TONE_STYLES, { message: 'invalid_choice' }), note: text(BRIEF_FIELD_LIMITS.toneNote) }),
    sign_off_name: text(BRIEF_FIELD_LIMITS.signOffName, { min: 1 }),
    allow_pricing: z.boolean(),
    never_promise: z.array(text(BRIEF_FIELD_LIMITS.neverPromiseItem, { min: 1 })).max(BRIEF_FIELD_LIMITS.neverPromise, { message: 'too_many' }),
    faqs: z
      .array(z.object({ q: text(BRIEF_FIELD_LIMITS.faqQuestion, { min: 1 }), a: text(BRIEF_FIELD_LIMITS.faqAnswer, { min: 1, multiline: true }) }))
      .max(BRIEF_FIELD_LIMITS.faqs, { message: 'too_many' }),
    booking_link_choice: z.enum(OWNER_BOOKING_LINK_CHOICES, { message: 'booking_link_choice_required' }),
    booking_link: z.string().nullable(),
    /** The owner ticked "Yes, <host> is my booking page" (required with a link, D-47). */
    booking_link_confirmed: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.booking_link_choice !== 'link') return;
    if (parseBookingLink(value.booking_link) === null) {
      ctx.addIssue({ code: 'custom', path: ['booking_link'], message: 'booking_link_not_https' });
    } else if (!value.booking_link_confirmed) {
      ctx.addIssue({ code: 'custom', path: ['booking_link_confirmed'], message: 'booking_link_not_confirmed' });
    }
  })
  .transform((value) => {
    const link = value.booking_link_choice === 'link' ? (parseBookingLink(value.booking_link)?.href ?? null) : null;
    const brief: BriefDraft = {
      company_name: value.company_name,
      one_line: value.one_line,
      services: value.services,
      who_we_serve: value.who_we_serve,
      booking_link: link,
      tone: value.tone,
      sign_off_name: value.sign_off_name,
      allow_pricing: value.allow_pricing,
      never_promise: value.never_promise,
      faqs: value.faqs,
    };
    return { brief, bookingLinkChoice: value.booking_link_choice, bookingLinkConfirmed: link !== null };
  });

export type OwnerBriefInput = z.input<typeof OwnerBriefInputSchema>;
export type OwnerBriefParsed = z.output<typeof OwnerBriefInputSchema>;

/** One problem with the owner's form, by field path (e.g. `faqs.2.a`) and code (`too_long`, `required`, …). */
export interface BriefFieldIssue {
  path: string;
  code: string;
}

export function briefFieldIssues(error: z.ZodError): BriefFieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: /^[a-z_]{1,40}$/.test(issue.message) ? issue.message : 'invalid',
  }));
}

/** A brief as stored in `briefs.brief` / `brief_versions.brief` (read back defensively). */
export const StoredBriefSchema = z.object({
  company_name: z.string(),
  one_line: z.string(),
  services: z.array(z.string()),
  who_we_serve: z.string(),
  booking_link: z.string().nullable(),
  tone: z.object({ style: z.enum(TONE_STYLES), note: z.string() }),
  sign_off_name: z.string(),
  allow_pricing: z.boolean(),
  never_promise: z.array(z.string()),
  faqs: z.array(z.object({ q: z.string(), a: z.string() })),
});

/** What the editor shows when there is nothing to start from (a refusal, a failed crawl). */
export const EMPTY_BRIEF: Readonly<BriefDraft> = Object.freeze<BriefDraft>({
  company_name: '',
  one_line: '',
  services: [],
  who_we_serve: '',
  booking_link: null,
  tone: { style: 'friendly', note: '' },
  sign_off_name: '',
  allow_pricing: false,
  never_promise: [],
  faqs: [],
});
