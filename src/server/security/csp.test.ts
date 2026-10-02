import { describe, expect, it } from 'vitest';
import { buildCsp, generateNonce, SECURITY_HEADERS, sentryIngestOrigin } from './csp';

const NONCE = 'b64nonceAAAAAAAAAAAAAA==';

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
}

describe('buildCsp', () => {
  it('allows scripts only from our origin and the per-request nonce in production (no unsafe-inline, no unsafe-eval)', () => {
    const csp = directives(buildCsp({ nonce: NONCE, dev: false, sentryOrigin: null }));
    expect(csp.get('script-src')).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
    expect(csp.get('script-src')).not.toContain("'unsafe-inline'");
    expect(csp.get('script-src')).not.toContain("'unsafe-eval'");
  });

  it("adds 'unsafe-eval' only in development", () => {
    const csp = directives(buildCsp({ nonce: NONCE, dev: true, sentryOrigin: null }));
    expect(csp.get('script-src')).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'", "'unsafe-eval'"]);
  });

  it('locks down framing, plugins, base URLs, form targets and defaults', () => {
    const csp = directives(buildCsp({ nonce: NONCE, dev: false, sentryOrigin: null }));
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(csp.get('font-src')).toEqual(["'self'"]);
  });

  it('allows inline styles without a nonce (a nonce would disable unsafe-inline)', () => {
    const csp = directives(buildCsp({ nonce: NONCE, dev: false, sentryOrigin: null }));
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("connects only to our origin, plus Sentry's ingest origin when browser Sentry is configured", () => {
    expect(directives(buildCsp({ nonce: NONCE, dev: false, sentryOrigin: null })).get('connect-src')).toEqual(["'self'"]);
    const withSentry = buildCsp({ nonce: NONCE, dev: false, sentryOrigin: 'https://o1.ingest.us.sentry.io' });
    expect(directives(withSentry).get('connect-src')).toEqual(["'self'", 'https://o1.ingest.us.sentry.io']);
  });

  it('refuses a nonce or origin that could inject another directive', () => {
    expect(() => buildCsp({ nonce: "x'; script-src *", dev: false, sentryOrigin: null })).toThrow('csp_invalid_nonce');
    expect(() => buildCsp({ nonce: NONCE, dev: false, sentryOrigin: 'https://a.example; script-src *' })).toThrow('csp_invalid_origin');
  });
});

describe('generateNonce', () => {
  it('is fresh, base64 and usable in the policy', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64')).toHaveLength(16);
    expect(buildCsp({ nonce: a, dev: false, sentryOrigin: null })).toContain(`'nonce-${a}'`);
  });
});

describe('sentryIngestOrigin', () => {
  it('takes the origin of the DSN without its public key or project path', () => {
    expect(sentryIngestOrigin('https://abc123@o42.ingest.de.sentry.io/77')).toBe('https://o42.ingest.de.sentry.io');
  });

  it('is null when the DSN is unset or malformed', () => {
    expect(sentryIngestOrigin(undefined)).toBeNull();
    expect(sentryIngestOrigin('  ')).toBeNull();
    expect(sentryIngestOrigin('not a url')).toBeNull();
    expect(sentryIngestOrigin('javascript:alert(1)')).toBeNull();
  });
});

describe('SECURITY_HEADERS', () => {
  it('sets HSTS, nosniff, a same-origin referrer policy and a restrictive Permissions-Policy', () => {
    expect(SECURITY_HEADERS['Strict-Transport-Security']).toMatch(/^max-age=\d{8,}/);
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    // same-origin, not no-referrer: a plain form POST must carry the real Origin (D-62).
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['Permissions-Policy']).toContain('camera=()');
  });
});
