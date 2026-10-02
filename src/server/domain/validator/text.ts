import 'server-only';

// Text helpers shared by the draft validator's rules (PLAN §9.4). Pure: no I/O, no clock.

/**
 * Zero-width, bidi and other invisible format characters. A draft (or a lead steering it) could hide
 * a phrase from a plain substring match by splitting it with one of these ("ign" + ZERO WIDTH SPACE + "ore previous").
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
];

function isInvisible(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return INVISIBLE_RANGES.some(([from, to]) => code >= from && code <= to);
}

/** A character class of the given code points, built at runtime (no escapes in the source). */
function charClass(codes: readonly number[]): RegExp {
  return new RegExp(`[${String.fromCodePoint(...codes)}]`, 'gu');
}

/** Curly single quotes, the modifier apostrophe and the prime; curly double quotes and the double prime. */
const SINGLE_QUOTES = charClass([0x2018, 0x2019, 0x02bc, 0x2032]);
const DOUBLE_QUOTES = charClass([0x201c, 0x201d, 0x2033]);

export function stripInvisible(text: string): string {
  let out = '';
  for (const char of text) if (!isInvisible(char)) out += char;
  return out;
}

/**
 * The form the URL, contact and markup rules scan: invisible characters dropped and NFKC applied,
 * so fullwidth or compatibility look-alikes (`ｅｖｉｌ．ｃｏｍ`, `＄５０`) become the ASCII they stand for.
 * Case is kept (a booking link is compared verbatim).
 */
export function prepare(text: string): string {
  return stripInvisible(text).normalize('NFKC');
}

/** `prepare`, lower-cased, with curly quotes straightened: the form the phrase rules match. */
export function fold(text: string): string {
  return prepare(text)
    .toLowerCase()
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"');
}

const WORD = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;

/** Folded words without diacritics: letters and digits, inner apostrophes kept ("don't", "o'brien"). */
export function matchWords(text: string): string[] {
  return fold(text).normalize('NFKD').replace(/\p{M}/gu, '').match(WORD) ?? [];
}

/** True when `words` contains `phrase` as a run of whole words. */
export function containsWordRun(words: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > words.length) return false;
  return ` ${words.join(' ')} `.includes(` ${phrase.join(' ')} `);
}

/** Whitespace-separated words, as the length rule counts them (brief §5.4). */
export function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
}

/** Escapes `text` for use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
