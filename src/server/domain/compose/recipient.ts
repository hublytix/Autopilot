import 'server-only';
import { pct } from './encode';

// Recipient safety (CMP-RECIPIENT-SAFETY, D-13). The lead's address comes from a public form, so it
// must be ONE bare addr-spec before it goes into any compose link: OWA splits recipients on `,` and
// `;` after decoding (even percent-encoded ones), Gmail and RFC 6068 on `,`, and a display name,
// quote or line break would let a lead add recipients or headers. Rules:
// - one `@`, no display name, no whitespace, control or invisible format characters;
// - none of `, ; < > " ( ) [ ] \ ? & = # % :` anywhere (delimiters in at least one consumer);
// - local part: ASCII atext and dots (no leading, trailing or doubled dot), or any non-ASCII
//   character (internationalised local parts are percent-encoded as UTF-8 when written);
// - domain: letters, digits, hyphens and dots, converted to its IDNA ASCII form (RFC 6068 §2 item 4,
//   CMP-BUILDER-SPEC) with the WHATWG URL host parser, then checked as LDH labels with a non-numeric
//   top-level label (no IP literals);
// - at most 64 characters before the `@`, 253 after it and 254 in all;
// - the delimiter and single-`@` rules also hold for the NFKC form: a consumer that applies
//   compatibility folding before splitting recipients would turn fullwidth `，` `；` `＠` `＜` `＞`
//   or the small comma `﹐` into the delimiters themselves (D-62).

export type RecipientProblem =
  | 'empty'
  | 'not_well_formed'
  | 'too_long'
  | 'forbidden_character'
  | 'not_single_address'
  | 'bad_local_part'
  | 'bad_domain';

export interface BareAddress {
  /** The local part as given (it may be non-ASCII; links carry it percent-encoded). */
  readonly local: string;
  /** The domain in IDNA ASCII form, lower-cased. */
  readonly domain: string;
}

export type RecipientCheck = { readonly ok: true; readonly address: BareAddress } | { readonly ok: false; readonly problem: RecipientProblem };

const MAX_ADDRESS = 254;
const MAX_LOCAL = 64;
const MAX_DOMAIN = 253;

const FORBIDDEN = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp},;<>"()[\]\\?&=#%:]/u;
/** ASCII atext (RFC 5322 §3.2.3) and dots, or anything outside ASCII (FORBIDDEN already ran). */
const LOCAL_CHARS = /^(?:[A-Za-z0-9!$'*+\-/^_`{|}~.]|[^\x00-\x7F])+$/u;
const DOMAIN_INPUT = /^[\p{L}\p{M}\p{N}.-]+$/u;
const ASCII_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The domain's IDNA ASCII form, or null when it is not a usable host name. */
function asciiDomain(domain: string): string | null {
  if (!DOMAIN_INPUT.test(domain)) return null;
  let host: string;
  try {
    host = new URL(`http://${domain}/`).hostname;
  } catch {
    return null;
  }
  if (host.length === 0 || host.length > MAX_DOMAIN) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => ASCII_LABEL.test(label))) return null;
  const top = labels[labels.length - 1] ?? '';
  return /[a-z]/.test(top) ? host : null;
}

/** Checks `raw` (trimmed) as one bare address; the domain comes back in IDNA ASCII form. */
export function checkRecipient(raw: string): RecipientCheck {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, problem: 'empty' };
  if (!value.isWellFormed()) return { ok: false, problem: 'not_well_formed' };
  if (value.length > MAX_ADDRESS) return { ok: false, problem: 'too_long' };
  if (FORBIDDEN.test(value)) return { ok: false, problem: 'forbidden_character' };
  const folded = value.normalize('NFKC');
  if (FORBIDDEN.test(folded)) return { ok: false, problem: 'forbidden_character' };
  const parts = value.split('@');
  if (parts.length !== 2 || folded.split('@').length !== 2) return { ok: false, problem: 'not_single_address' };
  const [local = '', domain = ''] = parts;
  if (
    local.length === 0 ||
    local.length > MAX_LOCAL ||
    !LOCAL_CHARS.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..')
  ) {
    return { ok: false, problem: 'bad_local_part' };
  }
  const ascii = asciiDomain(domain);
  if (ascii === null) return { ok: false, problem: 'bad_domain' };
  if (local.length + 1 + ascii.length > MAX_ADDRESS) return { ok: false, problem: 'too_long' };
  return { ok: true, address: { local, domain: ascii } };
}

/** True when `raw` is one bare address. */
export function isBareAddress(raw: string): boolean {
  return checkRecipient(raw).ok;
}

/** The address as written into a link: the local part percent-encoded, `@` literal, ASCII domain. */
export function pctAddr(address: BareAddress): string {
  return `${pct(address.local)}@${address.domain}`;
}
