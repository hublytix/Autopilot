import 'server-only';
import type { DraftFlag } from '@/server/domain/types';
import type { BriefDraft, DraftInput, DraftLeadInput, DraftOutput, FollowUpDraftInput } from '@/server/ports/llm';

// Templated drafts that pass the draft validator (PLAN §9.4, brief §5.4): plain text, at most 120
// words (70 for follow-ups), the first name when known, the booking link verbatim when the brief has
// one, no currency, no placeholders, no URL other than the booking link, no contact details and no
// text copied from the lead. Lead-controlled text is never echoed except the first name.

export const MAX_SUBJECT_CHARS = 120;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function subjectOf(text: string): string {
  const line = oneLine(text);
  return line.length <= MAX_SUBJECT_CHARS ? line : `${line.slice(0, MAX_SUBJECT_CHARS - 3).trimEnd()}...`;
}

function greeting(lead: DraftLeadInput): string {
  const first = oneLine(lead.firstName ?? '');
  return first.length > 0 ? `Hi ${first},` : 'Hi there,';
}

function bookingLink(brief: BriefDraft): string | null {
  const link = brief.booking_link?.trim() ?? '';
  return link.length > 0 ? link : null;
}

/** Closed-enum flags from simple keyword checks on the lead's message (D-24). */
export function flagsFor(lead: DraftLeadInput): DraftFlag[] {
  const message = lead.message?.trim() ?? '';
  const flags: DraftFlag[] = [];
  if (/\b(?:price|prices|pricing|quote|quotes|cost|costs|how much|estimate|rates?)\b/i.test(message)) flags.push('asks_pricing');
  if (/\b(?:urgent|asap|emergency|leak(?:ing|s)?|burst|flood(?:ed|ing)?|no water|tonight|today)\b/i.test(message)) flags.push('urgent');
  const letters = message.match(/\p{L}/gu) ?? [];
  const nonAscii = letters.filter((ch) => ch.charCodeAt(0) > 0x7f).length;
  if (letters.length > 0 && nonAscii / letters.length > 0.3) flags.push('non_english');
  if (message.split(/\s+/).filter(Boolean).length < 4) flags.push('missing_info');
  return flags;
}

function signature(brief: BriefDraft, closing: string, withCompany: boolean): string {
  const name = oneLine(brief.sign_off_name);
  const company = oneLine(brief.company_name);
  return [closing, name, ...(withCompany && company !== name ? [company] : [])].join('\n');
}

/** A sentence for what the enquiry asks (from its flags), so drafts differ the way a model's would. */
function answerFor(flags: readonly DraftFlag[]): string[] {
  const lines: string[] = [];
  if (flags.includes('urgent')) lines.push('It sounds like this cannot wait, so we will look at it as soon as we can.');
  if (flags.includes('asks_pricing')) lines.push('We would need a quick look at the job before we can talk about cost.');
  return lines;
}

export function initialDraft(input: DraftInput): DraftOutput {
  const { brief, lead } = input;
  const company = oneLine(brief.company_name);
  const link = bookingLink(brief);
  const flags = flagsFor(lead);
  // An empty form message: never claim to have read one (law 5).
  const hasMessage = (lead.message?.trim() ?? '') !== '';
  const nextStep =
    link !== null
      ? `The quickest next step is to pick a time that suits you here: ${link}`
      : 'The quickest next step is to reply with a couple of times that suit you, and I will get a visit booked in.';
  const body = [
    greeting(lead),
    hasMessage
      ? [`Thanks for getting in touch with ${company}. I have read your message and we would be glad to help.`, ...answerFor(flags)].join(' ')
      : `Thanks for getting in touch with ${company}. Your form came through without a message, so tell me a little about what you need and we will take it from there.`,
    nextStep,
    ...(hasMessage ? ['If anything has changed since you wrote, just reply to this email and I will take it from there.'] : []),
    signature(brief, 'Thanks,', true),
  ].join('\n\n');
  return {
    subject: subjectOf(`Thanks for contacting ${company}`),
    body,
    used_booking_link: link !== null,
    flags,
  };
}

export function followUpDraft(input: FollowUpDraftInput): DraftOutput {
  const { brief, lead, original, followUpNumber } = input;
  const company = oneLine(brief.company_name);
  const link = bookingLink(brief);
  const offer =
    link !== null ? `If you would still like a hand, you can pick a time here: ${link}` : 'If you would still like a hand, just reply with a time that suits you.';
  const middle =
    followUpNumber === 1
      ? `Just following up on my earlier note from ${company} in case it got buried. ${offer}`
      : `A last quick check-in from ${company}. If now is not the right time, no problem at all. ${offer}`;
  const originalSubject = original !== null ? oneLine(original.subject) : '';
  const subject =
    originalSubject.length > 0 ? (/^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`) : `Following up from ${company}`;
  return {
    subject: subjectOf(subject),
    body: [greeting(lead), middle, signature(brief, followUpNumber === 1 ? 'Thanks,' : 'Best wishes,', false)].join('\n\n'),
    used_booking_link: link !== null,
    flags: flagsFor(lead),
  };
}

/** Whitespace-separated words, as the validator counts them. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
