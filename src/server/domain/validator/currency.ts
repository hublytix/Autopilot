import 'server-only';
import { fold } from './text';

// `currency` (PLAN §9.4, brief §5.4): a draft may not name an amount of money unless the brief has
// `allow_pricing`. An amount is a number (digits, or number words such as "fifty" or "a few
// hundred") next to a currency symbol (any Unicode currency sign), an ISO 4217 code, or a currency
// word ("dollars", "rupees", "quid", …). Bare numbers ("3 bedrooms", "2 days") are not money.
// Abbreviations that precede the amount ("Rs 500", "USD 40") are matched on both sides; words only
// after it ("40 dollars"), so "won 3 awards" or "try 2 options" never count.

const NUMBER_WORD =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|' +
  'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?|grand|a\\s+few|a\\s+couple(?:\\s+of)?|several';
const DIGITS = String.raw`\d(?:[\d,.' ]{0,24}\d)?`;
/**
 * One amount: digits ("1,250.00", "1 500") or number words ("a few hundred", "twenty-five"), with an
 * optional magnitude. Every repetition is bounded, so a long run of digits or words stays linear.
 */
const AMOUNT = String.raw`(?:${DIGITS}|(?:${NUMBER_WORD})(?:[\s-]{1,3}(?:${NUMBER_WORD}|and)){0,6})(?:\s{0,3}(?:k|m|bn|mn|lakhs?|crores?|thousand|million|grand)\b)?`;

/** Major ISO 4217 codes (codes that are also common words, such as TRY, ALL, CUP, MAD, RUB, COP or PHP, are left out). */
const ISO_CODES =
  'usd|eur|gbp|inr|aud|cad|nzd|jpy|cny|rmb|chf|sgd|hkd|zar|aed|sar|mxn|brl|sek|nok|dkk|pln|czk|huf|ils|krw|thb|myr|idr|vnd|' +
  'ngn|kes|egp|pkr|bdt|lkr|npr|uah|ars|clp|qar|kwd|bhd|omr|twd|ghs|tzs|ugx';
/** Abbreviations written before (or after) the number. */
const PREFIX_WORDS = String.raw`rs\.?|inr|usd|us\s?dollars?|aed|sar`;
/** Currency words written after the number. */
const SUFFIX_WORDS =
  'dollars?|bucks?|euros?|pounds?(?:\\s+sterling)?|quid|pence|pennies|penny|cents?|rupees?|yen|yuan|renminbi|francs?|pesos?|' +
  'dirhams?|riyals?|ringgits?|baht|rand|kronor|kroner|krona|krone|zloty|rubles?|roubles?|shekels?|liras?|naira|shillings?|takas?';

const SYMBOL_BEFORE = new RegExp(String.raw`\p{Sc}\s?(?:${DIGITS})`, 'u');
const SYMBOL_AFTER = new RegExp(String.raw`(?:${DIGITS})\s?\p{Sc}`, 'u');
const CODE_BEFORE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${ISO_CODES}|${PREFIX_WORDS})\s?(?:${DIGITS})`, 'u');
const CODE_AFTER = new RegExp(String.raw`(?<![\p{L}\p{N}])${AMOUNT}\s*(?:${ISO_CODES})(?![\p{L}\p{N}])`, 'u');
const WORD_AFTER = new RegExp(String.raw`(?<![\p{L}\p{N}])${AMOUNT}\s*(?:of\s+)?(?:${SUFFIX_WORDS})(?![\p{L}\p{N}])`, 'u');

/** True when `text` names an amount of money. */
export function hasCurrencyAmount(text: string): boolean {
  const folded = fold(text);
  return [SYMBOL_BEFORE, SYMBOL_AFTER, CODE_BEFORE, CODE_AFTER, WORD_AFTER].some((pattern) => pattern.test(folded));
}
