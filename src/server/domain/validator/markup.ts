import 'server-only';
import { fold, prepare } from './text';

// `placeholder`, `not_plain_text` and `addresses_owner` (PLAN §9.4, D-47): pattern rules over the
// prepared (NFKC, invisible characters dropped) or folded (also lower-cased) text.

/** HTML element names: `<b>`, `<br/>`, `</p>`, … are markup; any other `<Word>` is a placeholder (`<NAME>`). */
const HTML_TAGS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'big', 'blockquote', 'body', 'br', 'button',
  'canvas', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'data', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl',
  'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'font', 'footer', 'form', 'frame', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'head', 'header', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'mark',
  'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre', 'progress',
  'q', 's', 'samp', 'script', 'section', 'select', 'small', 'source', 'span', 'strike', 'strong', 'style', 'sub', 'summary',
  'sup', 'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'tt', 'u', 'ul',
  'var', 'video', 'wbr',
]);

type AngleKind = 'markup' | 'placeholder' | 'none';

/** What one `<…>` token is: an HTML tag, comment or autolink (markup), a `<NAME>` placeholder, or neither. */
function angleKind(inner: string): AngleKind {
  if (/^[/!?]/.test(inner)) return 'markup';
  if (inner.includes('://') || inner.includes('@') || /^mailto:/i.test(inner)) return 'markup';
  const name = /^([a-z][a-z0-9-]*)(?=[\s/]|$)/i.exec(inner)?.[1];
  if (name !== undefined && HTML_TAGS.has(name.toLowerCase())) return 'markup';
  return /\p{L}/u.test(inner) ? 'placeholder' : 'none';
}

const ANGLE = /<([A-Za-z/!?][^<>\n]{0,60})>/g;

function angleKinds(text: string): Set<AngleKind> {
  const kinds = new Set<AngleKind>();
  for (const match of text.matchAll(ANGLE)) kinds.add(angleKind(match[1] ?? ''));
  return kinds;
}

const PLACEHOLDERS: readonly RegExp[] = [
  // {{first_name}}
  /\{\{[^{}\n]{0,60}\}\}/u,
  // %FIRST_NAME%, %%name%%, __NAME__
  /%%?[A-Za-z_][A-Za-z0-9_]{1,40}%%?/u,
  /__[A-Z][A-Z0-9_]{1,40}__/u,
  // XXX, xxxx, XX:XX, XX/XX/XXXX, $XX
  /(?<![\p{L}\p{N}])[Xx]{3,}(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])XX(?:[:/.-]X{2,4})+(?![\p{L}\p{N}])/u,
  /\p{Sc}\s?X{2,}(?![\p{L}\p{N}])/u,
  /\blorem ipsum\b/iu,
  /\b(?:insert|enter|add)\s+(?:your\s+|the\s+|a\s+)?(?:first\s+)?(?:name|date|time|link|url|address|phone(?:\s+number)?|number|company|price|details)\s+here\b/iu,
  /\b(?:your|their|the\s+lead's|customer's|client's)\s+(?:first\s+|company\s+)?name\s+here\b/iu,
];

const MARKDOWN: readonly RegExp[] = [
  /^\s{0,3}#{1,6}\s+\S/mu, // # heading
  /\*\*[^*\n]{1,500}\*\*/u, // **bold**
  /(?<![\p{L}\p{N}_])__(?![A-Z][A-Z0-9_]{0,40}__)[^_\n]{1,500}__(?![\p{L}\p{N}_])/u, // __bold__ (not a __NAME__ placeholder)
  /(?<![\p{L}\p{N}*])\*(?=\S)[^*\n]{1,500}(?<=\S)\*(?![\p{L}\p{N}*])/u, // *emphasis*
  /(?<![\p{L}\p{N}_])_(?=\S)[^_\n]{1,500}(?<=\S)_(?![\p{L}\p{N}_])/u, // _emphasis_
  /!?\[[^\]\n]{0,500}\]\([^)\n]{0,2000}\)/u, // [text](url), ![alt](src)
  /^\s{0,3}\[[^\]\n]{1,500}\]:\s*\S/mu, // [ref]: url
  /`[^`\n]{1,500}`/u, // `code`
  /```/u, // fences
  /^\s{0,3}>\s?\S/mu, // > quote
  /^\s{0,3}(?:[-*_][ \t]*){3,}$/mu, // --- rule
  /^\s*\|[^\n]*\|\s*$/mu, // | table |
  /~~[^~\n]{1,500}~~/u, // ~~strike~~
];

const HTML_EXTRA: readonly RegExp[] = [
  /<!--/u,
  /&(?:[a-z][a-z0-9]{1,31}|#\d{1,7}|#x[0-9a-f]{1,6});/iu, // &amp; &nbsp; &#39;
];

/** [Name], [Your Company], {first_name}, ${name} — but not a markdown link's [text](url) (markup). */
const BRACKETED = /(?:\[([^[\]\n]{1,120})\](?!\()|\{([^{}\n]{1,120})\})/gu;
/** Bracketed obfuscations of an address ("[at]", "(dot)") are judged by the address rules instead. */
const OBFUSCATION = /^\s*(?:at|dot|\.|@|:|:\/\/)\s*$/iu;

function hasBracketedSlot(text: string): boolean {
  for (const match of text.matchAll(BRACKETED)) {
    const inner = match[1] ?? match[2] ?? '';
    if (/\p{L}/u.test(inner) && !OBFUSCATION.test(inner)) return true;
  }
  return false;
}

/** `placeholder`: an unfilled template slot. */
export function hasPlaceholder(text: string): boolean {
  const prepared = prepare(text);
  return angleKinds(prepared).has('placeholder') || hasBracketedSlot(prepared) || PLACEHOLDERS.some((pattern) => pattern.test(prepared));
}

/**
 * `not_plain_text`: HTML (tags, comments, entities) or markdown (headings, emphasis, links, code,
 * quotes, rules, tables). Plain "- " and "1. " lists are allowed: they read the same in any client.
 */
export function hasMarkup(text: string): boolean {
  const prepared = prepare(text);
  return (
    angleKinds(prepared).has('markup') || HTML_EXTRA.some((pattern) => pattern.test(prepared)) || MARKDOWN.some((pattern) => pattern.test(prepared))
  );
}

/**
 * `addresses_owner` (D-47): the draft speaks to the owner or about itself instead of to the lead —
 * notes to the owner or the assistant, echoes of injected instructions ("ignore previous …"),
 * talk of being an AI, "here is your draft", the lead in the third person.
 */
const ADDRESSES_OWNER: readonly RegExp[] = [
  /\bnotes?\s+(?:to|for)\s+(?:the\s+)?(?:business\s+)?(?:owner|assistant|ai|a\.i\.|model|bot|system|admin|administrator|operator|reviewer|developer|user|sender|self)\b/u,
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|my|these|those|of)\s+)*(?:previous|prior|above|earlier|preceding|original|system)\b/u,
  /\b(?:previous|prior|above|earlier|system|original|hidden|secret)\s+(?:instructions?|prompts?|directives?)\b/u,
  /\bsystem\s+(?:prompt|message|instructions?)\b/u,
  /\b(?:as|i\s+am|i'm)\s+an?\s+(?:ai|a\.i\.|artificial\s+intelligence)(?:\s+(?:language\s+model|assistant|model|chatbot))?(?=\s*[,.;:!?)]|\s*$)/mu,
  /\b(?:as|i\s+am|i'm)\s+an?\s+(?:large\s+)?(?:language\s+model|llm|chatbot|virtual\s+assistant|ai\s+assistant|ai\s+model|ai\s+language\s+model)\b/u,
  /\b(?:large\s+)?language\s+model\b/u,
  /\b(?:chatgpt|openai|anthropic|gpt-?\d(?:\.\d)?)\b/u,
  /\b(?:here\s+is|here's|below\s+is)\s+(?:a|the|your|my)\s+(?:suggested\s+|proposed\s+|draft(?:ed)?\s+)?(?:draft|reply|response)\b/u,
  /\b(?:draft|template)\s+(?:reply|response|email|message)\b/u,
  /\bbefore\s+(?:you\s+)?send(?:ing)?\s+(?:this|it|the\s+(?:draft|reply|email))\b/u,
  /\b(?:do\s+not|don't)\s+send\s+(?:this|it)\b/u,
  /\b(?:dear|hi|hello|hey)\s+(?:business\s+)?(?:owner|assistant|ai|bot)\b/u,
  /\b(?:the|this)\s+(?:lead|prospect|enquirer|inquirer|sender|submitter)\s+(?:wrote|said|says|asked|asks|mentioned|mentions|wants|is\s+asking|claims|requested|requests|is\s+interested)\b/u,
  /\bthis\s+prospect\b/u,
  /\byou\s+are\s+now\b/u,
  /\b(?:developer|jailbreak|god|dan)\s+mode\b/u,
  /\bprompt\s+injection\b/u,
  /\b(?:feel\s+free\s+to|you\s+(?:may|might|can|could|should)\s+(?:want\s+to\s+)?)(?:edit|adjust|personali[sz]e|tweak|customi[sz]e|review)\s+(?:this|the)\s+(?:draft|reply|email|message|template)\b/u,
  /^\s*(?:assistant|ai|system|user|owner|note\s+to\s+self)\s*:/mu,
  /\[\s*(?:owner|assistant|ai|internal|note)\b[^\]]*\]/u,
];

export function addressesOwner(text: string): boolean {
  const folded = fold(text);
  return ADDRESSES_OWNER.some((pattern) => pattern.test(folded));
}
