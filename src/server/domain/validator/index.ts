import 'server-only';
import { VALIDATION_ERROR_CODES, type DraftKind, type ValidationErrorCode } from '@/server/domain/types';
import { hasCurrencyAmount } from './currency';
import { findAddresses, hostOfUrl, samePhone, type FoundUrl } from './links';
import { addressesOwner, hasMarkup, hasPlaceholder } from './markup';
import { containsWordRun, countWords, escapeRegExp, fold, matchWords } from './text';

// The deterministic draft validator (PLAN §9.4, brief §5.4, D-47). Pure: it returns error codes
// only, never text, so a code can be stored (`drafts.validation_errors`), logged and fed back to the
// model's retry without carrying any content.
//
// | Code                   | Rule
// |------------------------|------------------------------------------------------------------------------
// | too_long               | body ≤ 120 words (follow-ups ≤ 70), counted on whitespace
// | not_plain_text         | no HTML (tags, comments, entities) and no markdown (headings, emphasis, links, code, quotes, rules, tables)
// | placeholder            | no [Name], {{x}}, {first_name}, <NAME>, %NAME%, XXX, "lorem ipsum", "name here"
// | missing_first_name     | the (safe) first name appears as a whole word when it is known
// | missing_booking_link   | the brief's booking link appears verbatim when it has one
// | currency               | no amount of money (symbol, ISO code or currency word next to a number) unless allow_pricing
// | never_promise          | no never_promise phrase (NFKC, case, punctuation and diacritics ignored; whole words)
// | bad_subject            | the subject is one non-empty line of at most 120 characters, without control or bidi characters
// | url_not_allowed        | no web address but the booking link (verbatim) and the brief's site (host, within its path); no other bare domain
// | contact_not_allowed    | no email address or phone number that the brief does not contain
// | addresses_owner        | no note to the owner/assistant/AI, injected-instruction echoes ("ignore previous"), AI talk
// | echoes_lead            | no run of ≥ 12 consecutive words copied from the lead's message
//
// Subject and body are both checked, except the length, first-name, booking-link and echo rules,
// which look at the body (the subject has its own rule).

export const DRAFT_WORD_LIMITS: Readonly<Record<DraftKind, number>> = { initial: 120, fu1: 70, fu2: 70 };
export const SUBJECT_MAX_CHARS = 120;
/** D-47: this many consecutive words copied from the lead's message is an echo. */
export const ECHO_RUN_WORDS = 12;

/** The brief fields the validator reads (structurally the port's `BriefDraft`). */
export interface ValidatorBrief {
  readonly company_name: string;
  readonly one_line: string;
  readonly services: readonly string[];
  readonly who_we_serve: string;
  /** The booking link in force (normalised href), or null when the owner has none. */
  readonly booking_link: string | null;
  readonly tone: { readonly note: string };
  readonly sign_off_name: string;
  readonly allow_pricing: boolean;
  readonly never_promise: readonly string[];
  readonly faqs: readonly { readonly q: string; readonly a: string }[];
}

export interface DraftToValidate {
  readonly subject: string;
  readonly body: string;
}

export interface ValidationContext {
  readonly kind: DraftKind;
  readonly brief: ValidatorBrief;
  /** The lead's safe first name (`safeFirstName`), or null when unknown or unusable. */
  readonly firstName: string | null;
  /** The lead's form message, or null. */
  readonly leadMessage: string | null;
  /**
   * The brief's website (`briefs.source_url`), e.g. "https://brightside.example/"; null when unknown.
   * Links on its host are allowed, within its path when it has one (a page on a shared host such as
   * facebook.com/joesplumbing allows that page, never facebook.com/someone-else).
   */
  readonly siteUrl?: string | null | undefined;
}

/** The owner's site as the URL rule reads it: its host (`www.` removed) and its lower-case path without a trailing `/` ('' for the root). */
export interface SiteScope {
  readonly host: string;
  readonly path: string;
}

/** The host and path scope of a site URL (http or https); null when unusable. */
export function siteScopeOf(siteUrl: string | null | undefined): SiteScope | null {
  const trimmed = siteUrl?.trim() ?? '';
  if (trimmed === '') return null;
  const host = hostOfUrl(trimmed);
  if (host === null) return null;
  try {
    return { host, path: new URL(trimmed).pathname.toLowerCase().replace(/\/+$/u, '') };
  } catch {
    return null;
  }
}

/** The host of a site URL (lower-case ASCII, `www.` removed); null when unusable. */
export function siteHostOf(siteUrl: string | null | undefined): string | null {
  return siteScopeOf(siteUrl)?.host ?? null;
}

/** True when `path` is the site's path or below it (a root site allows every path). */
function withinSitePath(path: string | null, site: SiteScope): boolean {
  if (site.path === '') return true;
  if (path === null) return false;
  return path === site.path || path.startsWith(`${site.path}/`);
}

function briefText(brief: ValidatorBrief): string {
  return [
    brief.company_name,
    brief.one_line,
    ...brief.services,
    brief.who_we_serve,
    brief.tone.note,
    brief.sign_off_name,
    ...brief.faqs.flatMap((faq) => [faq.q, faq.a]),
  ].join('\n');
}

function bookingLinkOf(brief: ValidatorBrief): string | null {
  const link = brief.booking_link?.trim() ?? '';
  return link === '' ? null : link;
}

/**
 * C0 and C1 controls (line breaks included), the Unicode line and paragraph separators, and the bidi
 * controls (marks, embeddings, overrides, isolates), which can show a subject in another order than
 * the one that was checked.
 */
function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function badSubject(subject: string): boolean {
  if (subject.trim() === '') return true;
  const chars = Array.from(subject);
  return chars.length > SUBJECT_MAX_CHARS || chars.some(isControl);
}

function missingFirstName(body: string, firstName: string | null): boolean {
  const name = firstName === null ? '' : fold(firstName).trim();
  if (name === '') return false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'u');
  return !pattern.test(fold(body));
}

function breaksNeverPromise(text: string, phrases: readonly string[]): boolean {
  const words = matchWords(text);
  return phrases.some((phrase) => containsWordRun(words, matchWords(phrase)));
}

function echoesLead(text: string, leadMessage: string | null): boolean {
  if (leadMessage === null) return false;
  const lead = matchWords(leadMessage);
  if (lead.length < ECHO_RUN_WORDS) return false;
  const runs = new Set<string>();
  for (let i = 0; i + ECHO_RUN_WORDS <= lead.length; i += 1) runs.add(lead.slice(i, i + ECHO_RUN_WORDS).join(' '));
  const words = matchWords(text);
  for (let i = 0; i + ECHO_RUN_WORDS <= words.length; i += 1) {
    if (runs.has(words.slice(i, i + ECHO_RUN_WORDS).join(' '))) return true;
  }
  return false;
}

interface AddressVerdict {
  urlNotAllowed: boolean;
  contactNotAllowed: boolean;
}

function judgeAddresses(text: string, context: ValidationContext): AddressVerdict {
  const found = findAddresses(text);
  const bookingLink = bookingLinkOf(context.brief);
  const bookingHost = bookingLink === null ? null : hostOfUrl(bookingLink);
  const site = siteScopeOf(context.siteUrl);
  const fromBrief = findAddresses(briefText(context.brief));
  const companyDomains = new Set(findAddresses(context.brief.company_name).domains);

  const urlAllowed = (url: FoundUrl): boolean => {
    if (bookingLink !== null && url.text === bookingLink) return true;
    if (url.scheme !== null && url.scheme !== 'http' && url.scheme !== 'https') return false;
    return site !== null && url.host === site.host && withinSitePath(url.path, site);
  };
  // A bare mention (no path) of the site's host, the booking link's host or a domain in the company name.
  const domainAllowed = (domain: string): boolean =>
    domain === site?.host || domain === bookingHost || companyDomains.has(domain);

  const urlNotAllowed = found.urls.some((url) => !urlAllowed(url)) || found.domains.some((domain) => !domainAllowed(domain));
  const briefEmails = new Set(fromBrief.emails);
  const contactNotAllowed =
    found.emails.some((email) => !briefEmails.has(email)) ||
    found.phones.some((phone) => !fromBrief.phones.some((known) => samePhone(phone, known)));
  return { urlNotAllowed, contactNotAllowed };
}

/**
 * Checks one draft; returns the failed rules' codes in VALIDATION_ERROR_CODES order (empty when the
 * draft passes). Never throws for any input.
 */
export function validateDraft(draft: DraftToValidate, context: ValidationContext): ValidationErrorCode[] {
  const failed = new Set<ValidationErrorCode>();
  const { subject, body } = draft;
  const both = `${subject}\n${body}`;
  const bookingLink = bookingLinkOf(context.brief);

  if (countWords(body) > DRAFT_WORD_LIMITS[context.kind]) failed.add('too_long');
  if (hasMarkup(subject) || hasMarkup(body)) failed.add('not_plain_text');
  if (hasPlaceholder(subject) || hasPlaceholder(body)) failed.add('placeholder');
  if (missingFirstName(body, context.firstName)) failed.add('missing_first_name');
  if (bookingLink !== null && !body.includes(bookingLink)) failed.add('missing_booking_link');
  if (!context.brief.allow_pricing && (hasCurrencyAmount(subject) || hasCurrencyAmount(body))) failed.add('currency');
  if (breaksNeverPromise(subject, context.brief.never_promise) || breaksNeverPromise(body, context.brief.never_promise)) {
    failed.add('never_promise');
  }
  if (badSubject(subject)) failed.add('bad_subject');

  const subjectAddresses = judgeAddresses(subject, context);
  const bodyAddresses = judgeAddresses(body, context);
  if (subjectAddresses.urlNotAllowed || bodyAddresses.urlNotAllowed) failed.add('url_not_allowed');
  if (subjectAddresses.contactNotAllowed || bodyAddresses.contactNotAllowed) failed.add('contact_not_allowed');

  if (addressesOwner(both)) failed.add('addresses_owner');
  if (echoesLead(subject, context.leadMessage) || echoesLead(body, context.leadMessage)) failed.add('echoes_lead');

  return VALIDATION_ERROR_CODES.filter((code) => failed.has(code));
}
