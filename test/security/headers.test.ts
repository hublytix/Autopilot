import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBeacon, handleSendLink } from '@/server/http/action-links';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig } from '@/server/jobs/testing';
import type { RefreshedSession } from '@/server/ports/auth';
import { useTestDb as setUpTestDb } from '../db/harness';

// The header audit (brief §7 "CSP and security headers", PLAN §10.6-10.7, D-49, D-56, D-62): through
// the real proxy, every response carries a fresh nonce CSP (no 'unsafe-inline' scripts, form-action
// 'self', frame-ancestors 'none', object-src 'none', base-uri 'self'), HSTS, nosniff, the referrer
// policy and a Permissions-Policy; every owner, admin and action-link page (enumerated from
// src/app, so a new page is covered by itself) is private, no-store and noindex, and declares noindex
// in its metadata; the action-link route handlers send the same headers themselves; Next's
// X-Powered-By header is off.

type Refresh = (request: Request, response: Response) => Promise<RefreshedSession>;
const fakeRefresh = vi.fn<Refresh>();

vi.mock('@/server/adapters/fake/auth/proxy-session', () => ({ checkFakeProxySession: fakeRefresh }));
vi.mock('@/server/adapters/live/auth', () => ({ refreshLiveProxySession: vi.fn() }));

const { proxy } = await import('@/proxy');
const getDb = setUpTestDb();

const APP = 'http://localhost:3000';
const SAMPLE_TOKEN = `apt_${'A'.repeat(43)}`;
const SAMPLE_UUID = '7fb4bd35-be1c-49eb-a15c-d4661a00c7ea';

/** Every page under src/app, as a module loader keyed by file path (`/src/app/…/page.tsx`). */
type MetadataModule = { metadata?: { robots?: unknown } };
const PAGE_MODULES = import.meta.glob('/src/app/**/page.tsx') as Record<string, () => Promise<MetadataModule>>;
const LAYOUT_MODULES = import.meta.glob('/src/app/**/layout.tsx') as Record<string, () => Promise<MetadataModule>>;

/** `/src/app/a/[token]/copy/page.tsx` → `/a/apt_…/copy`. */
function urlPathOf(file: string): string {
  const route = file.replace(/^\/src\/app/, '').replace(/\/page\.tsx$/, '');
  return (route === '' ? '/' : route).replace('[token]', SAMPLE_TOKEN).replace(/\[[a-z]+\]/g, SAMPLE_UUID);
}

/** Pages with personal data: owner (dashboard, onboarding), admin, and the action links (D-49). */
const PRIVATE_PAGE_FILES = Object.keys(PAGE_MODULES)
  .filter((file) => /^\/src\/app\/(?:dashboard|onboarding|admin|a)\//.test(file))
  .sort();

/** Representative pages of every kind: public, auth, owner, admin, action link, the email step. */
const REPRESENTATIVE = ['/', '/login', '/auth/confirm', '/onboarding/email', '/dashboard', '/dashboard/settings', '/admin', `/a/${SAMPLE_TOKEN}/copy`, '/api/health'];

function signedIn(): void {
  fakeRefresh.mockImplementation(async (_request, response) => ({ response, user: { userId: 'u-1', email: 'owner@example.com' } }));
}

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
}

beforeEach(() => {
  fakeRefresh.mockReset();
  vi.stubEnv('APP_MODE', 'fake');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '');
  signedIn();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the private pages list', () => {
  it('covers every owner, admin and action-link page of the build (settings included)', () => {
    expect(PRIVATE_PAGE_FILES.length).toBeGreaterThan(15);
    const paths = PRIVATE_PAGE_FILES.map(urlPathOf);
    for (const expected of ['/dashboard', '/dashboard/settings', '/dashboard/settings/disconnect', '/dashboard/settings/forms', '/dashboard/billing', '/admin', '/onboarding/preferences', `/a/${SAMPLE_TOKEN}/edit`, `/a/${SAMPLE_TOKEN}/verify-notify`]) {
      expect(paths).toContain(expected);
    }
  });
});

describe('Content-Security-Policy', () => {
  it.each(REPRESENTATIVE)('%s: a nonce CSP with no inline scripts, form-action self and frame-ancestors none', async (path) => {
    const res = await proxy(new NextRequest(`${APP}${path}`));
    const csp = res.headers.get('content-security-policy') ?? '';
    const policy = directives(csp);
    const scriptSrc = policy.get('script-src') ?? [];
    const nonce = res.headers.get('x-middleware-request-x-nonce');
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(scriptSrc).toEqual(["'self'", `'nonce-${nonce ?? ''}'`, "'strict-dynamic'"]);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(policy.get('form-action')).toEqual(["'self'"]);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    expect(policy.get('default-src')).toEqual(["'self'"]);
    // Next renders with the same policy (it reads the nonce from the forwarded request header).
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
  });

  it('every response gets a fresh nonce', async () => {
    const first = (await proxy(new NextRequest(`${APP}/login`))).headers.get('x-middleware-request-x-nonce');
    const second = (await proxy(new NextRequest(`${APP}/login`))).headers.get('x-middleware-request-x-nonce');
    expect(first).not.toBe(second);
  });

  it('a client cannot choose the policy or the nonce (inbound CSP headers are replaced)', async () => {
    const res = await proxy(
      new NextRequest(`${APP}/dashboard`, { headers: { 'content-security-policy': "script-src * 'unsafe-inline'", 'x-nonce': 'attacker-chosen-nonce-value' } }),
    );
    const forwardedNonce = res.headers.get('x-middleware-request-x-nonce');
    expect(forwardedNonce).not.toBe('attacker-chosen-nonce-value');
    expect(res.headers.get('x-middleware-request-content-security-policy')).toContain(`'nonce-${forwardedNonce ?? ''}'`);
    const scriptSrc = directives(res.headers.get('x-middleware-request-content-security-policy') ?? '').get('script-src') ?? [];
    expect(scriptSrc).not.toContain('*');
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});

describe('static security headers', () => {
  it.each(REPRESENTATIVE)('%s: HSTS, nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options', async (path) => {
    const res = await proxy(new NextRequest(`${APP}${path}`));
    expect(res.headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    const permissions = res.headers.get('permissions-policy') ?? '';
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()', 'browsing-topics=()']) expect(permissions).toContain(feature);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('a redirect to /login carries them too', async () => {
    fakeRefresh.mockImplementation(async (_request, response) => ({ response, user: null }));
    const res = await proxy(new NextRequest(`${APP}/dashboard/settings`));
    expect(res.status).toBe(303);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('strict-transport-security')).not.toBeNull();
  });
});

describe('private pages: no-store and noindex', () => {
  it.each(PRIVATE_PAGE_FILES)('%s is private, no-store and noindex through the proxy', async (file) => {
    const res = await proxy(new NextRequest(`${APP}${urlPathOf(file)}`));
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it.each(PRIVATE_PAGE_FILES)('%s declares noindex in its metadata (or its layout does)', async (file) => {
    const load = PAGE_MODULES[file];
    if (load === undefined) throw new Error('missing page module');
    const page = await load();
    let robots = page.metadata?.robots;
    // The nearest layout's metadata applies when the page has none.
    for (let dir = file.replace(/\/page\.tsx$/, ''); robots === undefined && dir.startsWith('/src/app'); dir = dir.replace(/\/[^/]+$/, '')) {
      const layout = LAYOUT_MODULES[`${dir}/layout.tsx`];
      if (layout !== undefined) robots = (await layout()).metadata?.robots;
    }
    expect(robots).toMatchObject({ index: false, follow: false });
  });

  it('the owner API routes and the auth pages are private too', async () => {
    for (const path of ['/api/billing/checkout', '/api/onboarding/status', '/auth/confirm', '/auth/error', '/login']) {
      const res = await proxy(new NextRequest(`${APP}${path}`));
      expect(res.headers.get('cache-control'), path).toBe('private, no-store');
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex');
    }
  });

  it('the public landing page is not marked private', async () => {
    const res = await proxy(new NextRequest(`${APP}/`));
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });
});

describe('action-link route handlers answer with the private headers themselves', () => {
  it('/a/{token}/send and /a/{token}/beacon', async () => {
    const rig = createJobTestRig(getDb(), createJobRegistry());
    const send = await handleSendLink(new Request(`${APP}/a/${SAMPLE_TOKEN}/send`, { headers: { 'x-real-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0' } }), rig.deps, SAMPLE_TOKEN);
    expect(send.status).toBe(404);
    expect(send.headers.get('cache-control')).toBe('private, no-store');
    expect(send.headers.get('x-robots-tag')).toBe('noindex');
    expect(send.headers.get('referrer-policy')).toBe('same-origin');
    const beacon = await handleBeacon(
      new Request(`${APP}/a/${SAMPLE_TOKEN}/beacon`, { method: 'POST', headers: { origin: APP, 'content-type': 'application/json', 'x-real-ip': '203.0.113.9' }, body: '{"n":"x"}' }),
      rig.deps,
      SAMPLE_TOKEN,
    );
    expect(beacon.status).toBe(404);
    expect(beacon.headers.get('cache-control')).toBe('private, no-store');
    expect(beacon.headers.get('x-robots-tag')).toBe('noindex');
  });
});

describe('X-Powered-By', () => {
  it('is off (next.config poweredByHeader: false)', async () => {
    const config = (await import('../../next.config')).default as { poweredByHeader?: unknown };
    expect(config.poweredByHeader).toBe(false);
  });
});
