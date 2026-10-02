import 'server-only';

// The one encoder every compose link uses (D-13, CMP-ENCODING-PLUS-SPACE, CMP-BUILDER-SPEC):
// encodeURIComponent on a well-formed string, plus `!'()*`, which encodeURIComponent leaves bare.
// - A space becomes %20 and a literal plus %2B: Gmail and Outlook decode `+` as a space, and RFC 6068
//   treats it as a plus, so neither `+` nor URLSearchParams (which writes spaces as `+`) is ever used.
// - toWellFormed() first: encodeURIComponent throws URIError on a lone surrogate; it becomes U+FFFD.

const RFC3986_EXTRA = /[!'()*]/g;

/** Percent-encodes `value` as one URI component (RFC 3986 unreserved characters stay bare). */
export function pct(value: string): string {
  return encodeURIComponent(value.toWellFormed()).replace(RFC3986_EXTRA, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Every line break (CRLF, LF or a lone CR) normalised to `lineBreak`. */
export function eol(value: string, lineBreak: '\r\n' | '\n'): string {
  return value.replace(/\r\n|\r|\n/g, lineBreak);
}

/** A single-line header value (the subject): line breaks become spaces (RFC 6068 §5). */
export function oneLine(value: string): string {
  return value.replace(/\r\n|\r|\n/g, ' ');
}
