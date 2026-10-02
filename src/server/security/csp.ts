import 'server-only';
import { randomBytes } from 'node:crypto';

// The Content-Security-Policy and the static security headers (PLAN §10.7, NX-CSP-HEADERS,
// SENTRY-TUNNEL-CSP). src/proxy.ts sets both on every response it handles, with a fresh nonce per
// request; Next.js reads the nonce back from the request's CSP header and puts it on its own
// scripts, which is why every page that runs scripts must render dynamically.
//
// - script-src: 'self', the nonce and 'strict-dynamic' (scripts a trusted script loads are trusted);
//   no 'unsafe-inline'. 'unsafe-eval' only in development, where React uses eval for error stacks.
// - style-src: 'self' 'unsafe-inline', without a nonce (a nonce would make browsers ignore
//   'unsafe-inline'). React `style` attributes, Next's route announcer and dev overlay, and the
//   self-contained /auth/confirm page use inline styles, and style attributes cannot carry a nonce.
//   Inline CSS cannot run script, and with img-src/font-src/connect-src limited to our own origin
//   (plus Sentry's ingest host for connect-src) injected CSS has nowhere to send what it reads.
// - connect-src: 'self' plus the Sentry ingest origin taken from NEXT_PUBLIC_SENTRY_DSN (no tunnel).
// - frame-ancestors 'none', object-src 'none', base-uri 'self', form-action 'self'.
//   Chrome also applies form-action to the redirects that follow a form submission, so a form that
//   ends on another origin (a POST answered by a redirect to a checkout page) must be a link or a
//   client-side navigation instead.

export interface CspInput {
  /** A fresh, unpredictable value per response (generateNonce()). */
  readonly nonce: string;
  /** Development server: adds 'unsafe-eval' for React's dev tooling. */
  readonly dev: boolean;
  /** The Sentry ingest origin browsers post errors to (sentryIngestOrigin()); null without browser Sentry. */
  readonly sentryOrigin: string | null;
}

// A CSP nonce is base64 (RFC 4648 §4 or §5); Next refuses one with HTML-escapable characters.
const NONCE = /^[A-Za-z0-9+/_-]{16,128}={0,2}$/;
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/** 128 random bits, base64: one per response. */
export function generateNonce(): string {
  return randomBytes(16).toString('base64');
}

/** The origin of a Sentry DSN (`https://<key>@o1.ingest.us.sentry.io/2` → `https://o1.ingest.us.sentry.io`); null when unset or malformed. */
export function sentryIngestOrigin(dsn: string | undefined): string | null {
  const value = dsn?.trim();
  if (value === undefined || value === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return ORIGIN.test(url.origin) ? url.origin : null;
  } catch {
    return null;
  }
}

/** The policy as one header value. */
export function buildCsp(input: CspInput): string {
  if (!NONCE.test(input.nonce)) throw new RangeError('csp_invalid_nonce');
  if (input.sentryOrigin !== null && !ORIGIN.test(input.sentryOrigin)) throw new RangeError('csp_invalid_origin');
  const scriptSrc = ["'self'", `'nonce-${input.nonce}'`, "'strict-dynamic'", ...(input.dev ? ["'unsafe-eval'"] : [])];
  const connectSrc = ["'self'", ...(input.sentryOrigin === null ? [] : [input.sentryOrigin])];
  const directives: readonly (readonly [string, readonly string[]])[] = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSrc],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'"]],
    ['connect-src', connectSrc],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

/** Request headers a client may send that would let it choose the policy (and the nonce) Next renders with. */
export const INBOUND_CSP_HEADERS = ['content-security-policy', 'content-security-policy-report-only', 'x-nonce'] as const;

/** The request header that carries the nonce to Server Components and route handlers. */
export const NONCE_HEADER = 'x-nonce';

/** Static security headers for every response (PLAN §10.7). HSTS is ignored by browsers on plain http. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  // same-origin, not no-referrer (D-62): a Referer never leaves the site, and a plain form POST still
  // carries the real Origin (under no-referrer browsers send `Origin: null`, which Next's Server Action
  // check and our same-origin check refuse).
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  'X-Frame-Options': 'DENY',
});
