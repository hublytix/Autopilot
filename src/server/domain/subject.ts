import 'server-only';
import { hasCurrencyAmount } from './validator/currency';
import { findAddresses } from './validator/links';
import { addressesOwner, hasMarkup, hasPlaceholder } from './validator/markup';
import { stripInvisible } from './validator/text';

// The owner email's subject line (brief §5.5, PLAN §9.3 step 6, D-47). The lead's first name comes
// from a public form, so before it goes into a subject it is sanitised: control characters and line
// breaks removed (no header injection), invisible and bidi format characters removed (no spoofed
// reading order), whitespace collapsed, at most 40 characters. A "name" that holds a web address
// (any form the validator finds, `-evil.com` and `evil.academy` included), an `@`, a phone number,
// a digit or currency sign, more than three words, no letter at all, or text the draft rules reject
// (an instruction, a placeholder, markup) is not used: the subject, the greeting and the template
// then fall back to the nameless wording. The same safe name is the one the draft must greet
// (validator `missing_first_name`) and the one the drafting prompt receives.

export const SAFE_FIRST_NAME_MAX_CHARS = 40;

const FALLBACK_SUBJECT = 'New lead — your reply is ready';

/** Line breaks and tabs become spaces; other C0/C1 controls are dropped. */
function withoutControls(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d || code === 0x85 || code === 0x2028 || code === 0x2029) {
      out += ' ';
    } else if (code > 0x1f && !(code >= 0x7f && code <= 0x9f)) {
      out += char;
    }
  }
  return out;
}

/** A first name has a few words at most; more is a sentence typed into the field. */
export const SAFE_FIRST_NAME_MAX_WORDS = 3;

function looksLikeAddress(text: string): boolean {
  if (text.includes('@') || /:\/\/|\bwww\./iu.test(text)) return true;
  const found = findAddresses(text);
  return found.urls.length > 0 || found.domains.length > 0 || found.emails.length > 0 || found.phones.length > 0;
}

/**
 * A "name" the draft rules would object to as soon as the greeting carries it: digits or a currency
 * sign, an amount, a placeholder, markup, or a note to the owner/AI ("Ignore previous instructions").
 * Using it would make every model draft fail the validator (it must greet by the name) and put the
 * lead's text in the owner's mouth.
 */
function breaksDraftRules(name: string): boolean {
  if (/[\p{Nd}\p{Sc}]/u.test(name)) return true;
  const greeting = `Hi ${name},`;
  return hasCurrencyAmount(greeting) || hasPlaceholder(greeting) || hasMarkup(greeting) || addressesOwner(greeting);
}

/**
 * The lead's first name as it may appear in a subject or greeting, or null when there is none or
 * it is unusable: an address, an `@`, a phone number, any digit or currency sign, more than
 * SAFE_FIRST_NAME_MAX_WORDS words, no letters, or text the draft rules reject.
 */
export function safeFirstName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const cleaned = stripInvisible(withoutControls(name)).normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (cleaned === '' || !/\p{L}/u.test(cleaned)) return null;
  if (cleaned.split(' ').length > SAFE_FIRST_NAME_MAX_WORDS) return null;
  if (looksLikeAddress(cleaned) || breaksDraftRules(cleaned)) return null;
  const chars = Array.from(cleaned);
  return chars.length <= SAFE_FIRST_NAME_MAX_CHARS ? cleaned : chars.slice(0, SAFE_FIRST_NAME_MAX_CHARS).join('').trimEnd();
}

/** `New lead: {Name} — your reply is ready`, or `New lead — your reply is ready` without a safe name. */
export function newLeadSubject(firstName: string | null | undefined): string {
  const safe = safeFirstName(firstName);
  return safe === null ? FALLBACK_SUBJECT : `New lead: ${safe} — your reply is ready`;
}
