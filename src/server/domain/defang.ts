import 'server-only';
import { stripInvisible } from './validator/text';

// Lead text shown to the owner (D-47 "Display"): the message is shown under "Message from the lead
// (unverified)" in emails, the edit page and the dashboard. A lead can write anything there, so
// before display:
// - control characters are removed (line breaks kept as \n, tabs become spaces), as are invisible
//   and bidi format characters (no hidden or reordered text);
// - web addresses and email addresses are defanged so no mail client or browser turns them into
//   links: `https://evil.com/x` → `hxxps://evil[.]com/x`, `www.evil.com` → `www[.]evil[.]com`,
//   `evil.com` → `evil[.]com` (also `-evil.com`, `//evil.com` and `evil。com`),
//   `jane@evil.com` → `jane[@]evil[.]com`.
// The result is plain text for React to escape; it is idempotent (defanging twice changes nothing).

/** Line breaks normalised to \n, tabs to spaces, every other C0/C1 control removed. */
export function stripControls(text: string): string {
  let out = '';
  for (const char of text.replace(/\r\n?/g, '\n')) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x2028 || code === 0x2029 || code === 0x85) out += '\n';
    else if (code === 0x09) out += ' ';
    else if (code > 0x1f && !(code >= 0x7f && code <= 0x9f)) out += char;
  }
  return stripInvisible(out);
}

const EMAIL = String.raw`[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}`;
const SCHEME_URL = String.raw`[a-z][a-z0-9+.-]{0,15}:\/\/[^\s<>"']+`;
const WWW = String.raw`www\.[^\s<>"']+`;
const DOMAIN = String.raw`(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,24}|xn--[a-z0-9-]{1,59})(?![\p{L}\p{N}])`;
// An email starts where its local part starts; a URL or host may follow `/`, `_` or a leading `-`
// and a mail client still links it (`//evil.com`, `-evil.com`), so only a letter, digit, `@` or `.`
// before one, or a hyphen inside a label, means it is the middle of something else.
const NOT_IN_LOCAL_PART = String.raw`(?<![\p{L}\p{N}._%+-])`;
const NOT_IN_HOST = String.raw`(?<![\p{L}\p{N}@.])(?<![\p{L}\p{N}]-)`;
const ADDRESS = new RegExp(
  String.raw`${NOT_IN_LOCAL_PART}(?<email>${EMAIL})|${NOT_IN_HOST}(?:(?<url>${SCHEME_URL})|(?<www>${WWW})|(?<domain>${DOMAIN}))`,
  'giu',
);

/**
 * The ideographic, fullwidth and halfwidth full stops are dots to browsers' IDNA: between the labels
 * of a host (an ASCII or fullwidth letter or digit follows) they become '.', and so get defanged.
 */
const DOT_LIKE = new RegExp(
  `[${String.fromCodePoint(0x3002, 0xff0e, 0xff61)}](?=[A-Za-z0-9${String.fromCodePoint(0xff10)}-${String.fromCodePoint(0xff19)}${String.fromCodePoint(0xff21)}-${String.fromCodePoint(0xff3a)}${String.fromCodePoint(0xff41)}-${String.fromCodePoint(0xff5a)}])`,
  'gu',
);

/** Every dot not already bracketed becomes `[.]`. */
function defangDots(text: string): string {
  return text.replace(/(?<!\[)\.(?!\])/g, '[.]');
}

function defangUrl(url: string): string {
  const at = url.indexOf('://');
  // `http`/`ftp` at the end of the scheme, also when glued to a word before it (`x-https://`).
  const safeScheme = url
    .slice(0, at)
    .replace(/http(s?)$/iu, (_match: string, s: string) => `hxxp${s.toLowerCase()}`)
    .replace(/ftp(s?)$/iu, (_match: string, s: string) => `fxp${s.toLowerCase()}`);
  return `${safeScheme}://${defangDots(url.slice(at + 3))}`;
}

/** Defangs web and email addresses in already-cleaned text. */
export function defangAddresses(text: string): string {
  return text.replace(DOT_LIKE, '.').replace(ADDRESS, (match: string, ...rest: unknown[]) => {
    const groups = rest.at(-1) as Partial<Record<'email' | 'url' | 'www' | 'domain', string>>;
    if (groups.email !== undefined) {
      const at = match.lastIndexOf('@');
      return `${match.slice(0, at)}[@]${defangDots(match.slice(at + 1))}`;
    }
    if (groups.url !== undefined) return defangUrl(match);
    return defangDots(match);
  });
}

/** Lead-controlled text made safe to display: controls stripped, addresses defanged. */
export function defangLeadText(text: string): string {
  return defangAddresses(stripControls(text));
}
