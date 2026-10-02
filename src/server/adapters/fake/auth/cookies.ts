import 'server-only';
import type { SessionCookie } from '@/server/ports/auth';

// Cookie helpers for the fake AuthProvider and the HTTP layer: build `Set-Cookie` values, read the
// `Cookie` header of a Request, and put cookies on a Response (copying it when its headers are
// immutable, as on `Response.redirect()`).

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// RFC 6265 cookie-octet: no controls, whitespace, `"`, `,`, `;` or `\`.
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/** One `Set-Cookie` header value for `cookie`. */
export function serializeSetCookie(cookie: SessionCookie): string {
  if (!COOKIE_NAME.test(cookie.name)) throw new RangeError('cookie_invalid_name');
  if (!COOKIE_VALUE.test(cookie.value)) throw new RangeError('cookie_invalid_value');
  const o = cookie.options;
  const parts = [`${cookie.name}=${cookie.value}`];
  if (o.path !== undefined) parts.push(`Path=${o.path}`);
  if (o.domain !== undefined) parts.push(`Domain=${o.domain}`);
  if (o.maxAge !== undefined) parts.push(`Max-Age=${Math.trunc(o.maxAge)}`);
  if (o.expires !== undefined) parts.push(`Expires=${o.expires.toUTCString()}`);
  if (o.httpOnly === true) parts.push('HttpOnly');
  if (o.secure === true) parts.push('Secure');
  if (o.sameSite !== undefined) parts.push(`SameSite=${o.sameSite[0]?.toUpperCase() ?? ''}${o.sameSite.slice(1)}`);
  return parts.join('; ');
}

/** Parses a `Cookie` header into name → value (the first occurrence of a name wins). */
export function parseCookieHeader(header: string | null | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of (header ?? '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name.length > 0 && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/** The value of cookie `name` on `request`, or undefined. */
export function readRequestCookie(request: Request, name: string): string | undefined {
  return parseCookieHeader(request.headers.get('cookie')).get(name);
}

/**
 * Appends `Set-Cookie` headers to `response`. Returns the same Response, or a copy with mutable
 * headers when the original's are immutable.
 */
export function withSetCookies(response: Response, cookies: readonly SessionCookie[]): Response {
  if (cookies.length === 0) return response;
  const values = cookies.map(serializeSetCookie);
  try {
    for (const value of values) response.headers.append('set-cookie', value);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    for (const value of values) headers.append('set-cookie', value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

/** A `Cookie` request-header value for `cookies` (`name=value; …`). */
export function toCookieHeader(cookies: readonly SessionCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * A minimal cookie jar for route tests and the simulation's "browser": it stores what responses set
 * (an empty value or `Max-Age=0` deletes) and builds Requests that send the cookies back. It ignores
 * Path, Domain and Expires.
 */
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  /** Applies cookies an adapter returned (e.g. `verify().cookies`, `signOut()`). */
  set(cookies: readonly SessionCookie[]): void {
    for (const c of cookies) {
      if (c.value.length === 0 || c.options.maxAge === 0) this.#cookies.delete(c.name);
      else this.#cookies.set(c.name, c.value);
    }
  }

  /** Applies every `Set-Cookie` header of `response`. */
  storeFrom(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = header.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
      if (value.length === 0 || expired) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  /** The `Cookie` header value, or null when the jar is empty. */
  header(): string | null {
    if (this.#cookies.size === 0) return null;
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** A Request carrying the jar's cookies. */
  request(url: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    const cookie = this.header();
    if (cookie !== null) headers.set('cookie', cookie);
    return new Request(url, { ...init, headers });
  }
}
