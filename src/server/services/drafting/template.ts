import 'server-only';
import type { DraftKind, ValidationErrorCode } from '@/server/domain/types';
import { SUBJECT_MAX_CHARS, validateDraft, type ValidatorBrief } from '@/server/domain/validator';

// The minimal safe template (brief §5.4, PLAN §9.3 step 5, D-24): the "needs your touch" draft used
// when the model refused, failed twice, hit a FATAL-CONFIG error, could not be reached on the final
// delivery, or the AI budget breaker is tripped. Deterministic and without any LLM: a greeting with
// the safe first name when known, a short acknowledgement (which mentions the lead's message only
// when there is one), the booking link verbatim when the brief has one, and the brief's sign-off. It
// must pass the validator itself; if an unusual brief or name makes the fuller wording fail (say, a
// company name the rules object to), plainer variants are tried, down to "Hi there," +
// acknowledgement + link.

export interface TemplateInput {
  readonly kind: DraftKind;
  /** The brief in force with the booking link in force; null before the owner saved one. */
  readonly brief: ValidatorBrief | null;
  /** `safeFirstName` of the lead's first name. */
  readonly firstName: string | null;
  readonly leadMessage: string | null;
  /** The brief's website (`briefs.source_url`), for the URL rule. */
  readonly siteUrl: string | null;
}

export interface TemplateDraft {
  readonly subject: string;
  readonly body: string;
  readonly usedBookingLink: boolean;
  /** Empty unless no variant passed (then the plainest one is used and the codes are reported). */
  readonly validationErrors: readonly ValidationErrorCode[];
}

/** Collapses whitespace (brief text is one line in a subject or greeting). */
function oneLine(text: string | undefined): string {
  return (text ?? '').replace(/\s+/gu, ' ').trim();
}

const EMPTY_BRIEF: ValidatorBrief = {
  company_name: '',
  one_line: '',
  services: [],
  who_we_serve: '',
  booking_link: null,
  tone: { note: '' },
  sign_off_name: '',
  allow_pricing: false,
  never_promise: [],
  faqs: [],
};

interface Variant {
  /** The greeting's name; null greets "Hi there,". */
  firstName: string | null;
  company: string;
  signOff: string;
}

/** True when the lead left the form's message empty: the draft then never claims to have read one (law 5). */
function hasMessage(leadMessage: string | null): boolean {
  return leadMessage !== null && leadMessage.trim() !== '';
}

function compose(input: TemplateInput, variant: Variant): { subject: string; body: string } {
  const link = input.brief?.booking_link?.trim() ?? '';
  const greeting = variant.firstName === null ? 'Hi there,' : `Hi ${variant.firstName},`;
  const signOff = variant.signOff === '' ? 'Thanks' : `Thanks,\n${variant.signOff}`;
  if (input.kind === 'initial') {
    const subjectWithCompany = `Thanks for contacting ${variant.company}`;
    const subject = variant.company !== '' && Array.from(subjectWithCompany).length <= SUBJECT_MAX_CHARS ? subjectWithCompany : 'Thanks for getting in touch';
    const thanks = variant.company === '' ? 'Thanks for getting in touch.' : `Thanks for getting in touch with ${variant.company}.`;
    const promise = hasMessage(input.leadMessage) ? 'I have your message and will reply with the details.' : "I'll get back to you with the details.";
    const next = link === '' ? 'Reply with a time that suits you and we can take it from there.' : `If it suits you, you can pick a time here: ${link}`;
    return { subject, body: [greeting, `${thanks} ${promise}`, next, signOff].join('\n\n') };
  }
  const next = link === '' ? 'If you would still like a hand, just reply to this email.' : `If you would still like a hand, you can pick a time here: ${link}`;
  return {
    subject: 'Following up on your enquiry',
    body: [greeting, 'Just following up on my earlier email in case it got buried.', next, signOff].join('\n\n'),
  };
}

/**
 * The needs-touch draft for `input`: the first variant that passes the validator, else the plainest.
 * Variants drop, in turn, the company name, the sign-off and then the lead's name: a "first name"
 * that breaks a rule (a sentence, an instruction, an amount) never reaches the starter draft.
 */
export function minimalSafeTemplate(input: TemplateInput): TemplateDraft {
  const brief = input.brief ?? EMPTY_BRIEF;
  const company = oneLine(brief.company_name);
  const signOff = oneLine(brief.sign_off_name);
  const names = input.firstName === null ? [null] : [input.firstName, null];
  const variants: Variant[] = names.flatMap((firstName) => [
    { firstName, company, signOff },
    { firstName, company: '', signOff },
    { firstName, company: '', signOff: '' },
  ]);
  const link = brief.booking_link?.trim() ?? '';
  let last: { subject: string; body: string } = { subject: '', body: '' };
  let lastErrors: ValidationErrorCode[] = [];
  for (const variant of variants) {
    last = compose(input, variant);
    // Without the name, the draft is not expected to greet by it.
    lastErrors = validateDraft(last, { kind: input.kind, brief, firstName: variant.firstName, leadMessage: input.leadMessage, siteUrl: input.siteUrl });
    if (lastErrors.length === 0) break;
  }
  return { ...last, usedBookingLink: link !== '' && last.body.includes(link), validationErrors: lastErrors };
}
