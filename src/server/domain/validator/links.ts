import 'server-only';
import { prepare } from './text';

// Finding web addresses, email addresses and phone numbers in a draft (D-47 `url_not_allowed`,
// `contact_not_allowed`). The text is first put in a canonical form: invisible characters dropped,
// NFKC (fullwidth look-alikes become ASCII), and common obfuscations undone (`hxxps`, `[.]`, `(dot)`,
// `example dot com`, `[at]`), because a lead steering the model would use exactly those to slip an
// address past a plain pattern. Detection errs on the side of finding an address: a false find costs
// one retry, a miss could put an attacker's link in the owner's mouth.

/** TLDs `name dot tld` is rewritten for: the common gTLDs and big country codes (not every two-letter word). */
const SPOKEN_TLDS = 'com|net|org|io|co|ai|app|dev|info|biz|xyz|online|site|shop|store|me|us|uk|ca|au|de|fr|in|nz|ie|eu|ly|gg|tv';

/** Characters that end a URL in running text. */
const URL_BODY = '[^\\s<>"\'`{}|\\\\^]+';

/**
 * The ideographic full stop (U+3002; NFKC also turns the halfwidth U+FF61 into it, and the fullwidth
 * U+FF0E into '.') is a dot to browsers' IDNA. It counts as one when an ASCII letter or digit follows,
 * as in a host name; in running CJK text, where a sentence ends with it, it is left alone.
 */
const IDEOGRAPHIC_DOT = new RegExp(`${String.fromCodePoint(0x3002)}(?=[A-Za-z0-9])`, 'gu');

/** Undoes the usual ways of writing an address so that pattern filters miss it. */
export function canonicalise(text: string): string {
  return prepare(text)
    .replace(IDEOGRAPHIC_DOT, '.')
    .replace(/\bh[xX]{2}p(s?)(?=\s*(?::|\[:|\(:|\{:))/gi, 'http$1')
    .replace(/[[({]\s*(:\/\/|:)\s*[\])}]/g, '$1')
    .replace(/\s*[[({]\s*(?:\.|dot)\s*[\])}]\s*/gi, '.')
    .replace(new RegExp(String.raw`([\p{L}\p{N}-])\s+dot\s+(?=(?:${SPOKEN_TLDS})(?![\p{L}\p{N}]))`, 'giu'), '$1.')
    .replace(/\s*[[({]\s*(?:at|@)\s*[\])}]\s*/gi, '@');
}

/** Sentence punctuation that may follow an address in prose: ASCII, and the closing guillemets and the ellipsis. */
const TRAILING_PUNCTUATION = new RegExp(`[.,;:!?'"${String.fromCodePoint(0xbb, 0x203a, 0x2026)}]+$`, 'u');

/** Strips sentence punctuation that follows an address in prose ("…/visit." or "(see x.com)"). */
export function trimTrailing(candidate: string): string {
  let out = candidate.replace(TRAILING_PUNCTUATION, '');
  for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
    while (out.endsWith(close) && out.split(open).length < out.split(close).length) {
      out = out.slice(0, -1).replace(TRAILING_PUNCTUATION, '');
    }
  }
  return out;
}

/** The lower-case ASCII host of `name`, `www.` removed; null when it is not a host. */
export function normaliseHost(name: string): string | null {
  const trimmed = name.trim().replace(/\.$/, '');
  if (trimmed === '' || /[\s/?#@]/.test(trimmed)) return null;
  try {
    const host = new URL(`http://${trimmed}`).hostname;
    if (host === '') return null;
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/** The host of an http(s) URL string (`www.` removed), or null. */
export function hostOfUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return normaliseHost(parsed.hostname);
  } catch {
    return null;
  }
}

export interface FoundUrl {
  /** As written (after canonicalisation and trailing-punctuation trimming). */
  text: string;
  /** Lower-case scheme without `:`; `null` for an address written without one (`www.x.com`, `x.com/path`, an IP). */
  scheme: string | null;
  /** Lower-case ASCII host without `www.`; null when it cannot be parsed. */
  host: string | null;
  /** Lower-case path (`/` at least) of an http(s) or scheme-less address; null for other schemes or when it cannot be parsed. */
  path: string | null;
}

export interface FoundAddresses {
  urls: FoundUrl[];
  /** Bare `name.tld` mentions, as normalised hosts. */
  domains: string[];
  /** Lower-cased email addresses. */
  emails: string[];
  /** Phone numbers as digit strings. */
  phones: string[];
}

const SCHEME_URL = new RegExp(String.raw`(?<![\p{L}\p{N}+.-])([a-z][a-z0-9+.-]{0,15}):\/\/${URL_BODY}`, 'giu');
/** Schemes that run something or carry content rather than point somewhere: always an address. */
const BARE_SCHEME = /(?<![\p{L}\p{N}+.-])(?:javascript|data|vbscript|mailto|tel|sms|file):[^\s<>"']+/giu;
/**
 * What may follow a host without a space and still be part of the link a mail client makes: a port,
 * then a path, query or fragment.
 */
const HOST_REST = String.raw`((?::\d{1,5})?(?:[/?#]${URL_BODY})?)`;
// A letter, digit, `@` or `.` before a host means it is the middle of something else, and so does a
// hyphen inside a label (`a-b`: the match starting at `a` covers it, and skipping those starts keeps
// the scan linear). After `/`, `_` or a leading `-` (`//evil.com`, `_evil.com`, `-evil.com`) a mail
// client still links the host, so the finders do too.
const NOT_INSIDE_HOST = String.raw`(?<![\p{L}\p{N}@.])(?<![\p{L}\p{N}]-)`;
const WWW_URL = new RegExp(String.raw`${NOT_INSIDE_HOST}www\.${URL_BODY}`, 'giu');
const IPV4 = new RegExp(String.raw`(?<![\p{L}\p{N}.])((?:\d{1,3}\.){3}\d{1,3})(?![\p{N}]|\.\d)${HOST_REST}`, 'gu');
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}(?![\p{L}\p{N}])/gu;
/**
 * A bare `name.tld`: any 2-24-letter top-level label (in any script) or a punycode one. Every such
 * mention counts, whether or not the TLD exists today (new gTLDs keep arriving and mail clients link
 * them); a sentence written without a space after its full stop costs one retry at most.
 */
const DOMAIN = new RegExp(
  String.raw`${NOT_INSIDE_HOST}((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,24}|xn--[a-z0-9-]{1,59}))(?![\p{L}\p{N}]|\.[\p{L}\p{N}])${HOST_REST}`,
  'giu',
);
const PHONE = /(?<![\p{L}\p{N}])(?:\+[ \t]?)?(?:\(\d{1,5}\)[ \t.-]?)?\d[\d \t().-]{5,22}\d(?![\p{L}\p{N}])/gu;

/** The lower-case path of an http(s) URL, or of a scheme-less address read as one; null when it cannot be parsed. */
function pathOf(text: string, scheme: string | null): string | null {
  try {
    return new URL(scheme === null ? `http://${text}` : text).pathname.toLowerCase();
  } catch {
    return null;
  }
}

function isIpv4(address: string): boolean {
  return address.split('.').every((octet) => Number(octet) <= 255);
}

/** Digit runs that look like dates, times, year ranges or grouped amounts rather than phone numbers. */
function isNotPhone(candidate: string): boolean {
  const compact = candidate.trim();
  return (
    /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(compact) ||
    /^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/.test(compact) ||
    /^(?:19|20)\d{2}\s*-\s*(?:19|20)\d{2}$/.test(compact) ||
    /^\d{1,2}[.:]\d{2}\s*-\s*\d{1,2}[.:]\d{2}$/.test(compact) ||
    /^\d{1,3}(?:[.,]\d{3})+$/.test(compact)
  );
}

/** Every web address, bare domain, email address and phone number in `text`. */
export function findAddresses(text: string): FoundAddresses {
  let rest = canonicalise(text);
  const urls: FoundUrl[] = [];
  const blank = (match: string): string => ' '.repeat(match.length);

  rest = rest.replace(SCHEME_URL, (match: string, scheme: string) => {
    const trimmed = trimTrailing(match);
    const lower = scheme.toLowerCase();
    const web = lower === 'http' || lower === 'https';
    urls.push({ text: trimmed, scheme: lower, host: web ? hostOfUrl(trimmed) : null, path: web ? pathOf(trimmed, lower) : null });
    return blank(match);
  });
  rest = rest.replace(BARE_SCHEME, (match: string) => {
    const trimmed = trimTrailing(match);
    urls.push({ text: trimmed, scheme: trimmed.slice(0, trimmed.indexOf(':')).toLowerCase(), host: null, path: null });
    return blank(match);
  });
  rest = rest.replace(WWW_URL, (match: string) => {
    const trimmed = trimTrailing(match);
    const host = trimmed.split(/[/?#:]/u)[0] ?? '';
    urls.push({ text: trimmed, scheme: null, host: normaliseHost(host), path: pathOf(trimmed, null) });
    return blank(match);
  });
  rest = rest.replace(IPV4, (match: string, address: string) => {
    if (!isIpv4(address)) return match;
    const trimmed = trimTrailing(match);
    urls.push({ text: trimmed, scheme: null, host: normaliseHost(address), path: pathOf(trimmed, null) });
    return blank(match);
  });

  const emails: string[] = [];
  rest = rest.replace(EMAIL, (match: string) => {
    emails.push(match.toLowerCase());
    return blank(match);
  });

  const domains: string[] = [];
  rest = rest.replace(DOMAIN, (match: string, name: string, after: string) => {
    const host = normaliseHost(name) ?? name.toLowerCase();
    const trimmed = trimTrailing(match);
    if (after === '' || trimmed.length <= name.length) {
      domains.push(host);
    } else {
      // A host followed by a port or a path is a link to that path, not just a mention of the site.
      urls.push({ text: trimmed, scheme: null, host, path: pathOf(trimmed, null) });
    }
    return blank(match);
  });

  const phones: string[] = [];
  for (const match of rest.matchAll(PHONE)) {
    const candidate = match[0];
    const digits = candidate.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15 || isNotPhone(candidate)) continue;
    phones.push(digits);
  }
  return { urls, domains, emails, phones };
}

/** Digits compared from the end when both numbers are this long (country code vs trunk prefix differ). */
const SUBSCRIBER_DIGITS = 9;

/**
 * True when two phone digit strings name the same number: one may carry a country code, the other
 * a trunk prefix ("+44 161 496 0000" vs "0161 496 0000") or no area code at all.
 */
export function samePhone(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= SUBSCRIBER_DIGITS && b.length >= SUBSCRIBER_DIGITS) return a.slice(-SUBSCRIBER_DIGITS) === b.slice(-SUBSCRIBER_DIGITS);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 7 && long.endsWith(short);
}
