import 'server-only';

// Server Components and Server Actions see request headers through next/headers, not a Request.
// The services read sessions from a Request (the AuthProvider port), so this builds one carrying
// only what they read: the cookies and the client-IP headers (for rate limits, HMAC-ed before
// storage). Nothing else from the incoming request is copied.

/** Anything with `get(name)`: Headers, or the ReadonlyHeaders next/headers returns. */
export interface HeadersLike {
  get(name: string): string | null;
}

const FORWARDED = ['cookie', 'x-real-ip', 'x-forwarded-for'] as const;

/** A GET Request for `path` on APP_URL carrying the session cookies and client-IP headers of `source`. */
export function requestFromHeaders(appUrl: string, source: HeadersLike, path = '/'): Request {
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Request(`${appUrl}${path}`, { headers });
}

/** Personal-data responses (D-49, PLAN §10.7): never cached, never indexed, no Referer to other sites (D-62). */
export const PRIVATE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex',
  'Referrer-Policy': 'same-origin',
});
