import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { CookieJar } from '@/server/security/cookies';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { REQUIRED_SCOPES } from '@/server/hubspot/scopes';
import { STATE_COOKIE_NAME, verifyState } from '@/server/services/install/cookies';
import { useTestDb as setUpTestDb } from '../../../test/db/harness';
import { clientIp, handleHubSpotInstall } from './hubspot-install';

const getDb = setUpTestDb();

let rig: JobTestRig;

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
});

function installRequest(jar: CookieJar, ip = '203.0.113.7'): Request {
  return jar.request(`${rig.deps.env.APP_URL}/api/hubspot/install`, { headers: { 'x-real-ip': ip } });
}

describe('GET /api/hubspot/install', () => {
  it('redirects to the consent page with exactly REQUIRED_SCOPES, the redirect URI and a state the signed cookie carries', async () => {
    const jar = new CookieJar();
    const res = await handleHubSpotInstall(installRequest(jar), rig.deps);
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const location = new URL(res.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${rig.deps.env.APP_URL}/dev/fake-hubspot/authorize`);
    expect(location.searchParams.get('scope')).toBe(REQUIRED_SCOPES.join(' '));
    expect(location.searchParams.get('redirect_uri')).toBe(rig.deps.env.HUBSPOT_REDIRECT_URI);
    expect(location.searchParams.get('client_id')).toBe(rig.deps.env.HUBSPOT_CLIENT_ID);
    const state = location.searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toMatch(/^ap_hs_state=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Path=\/api\/hubspot\/oauth\/callback; Max-Age=600; HttpOnly; SameSite=Lax$/);
    jar.storeFrom(res);
    expect(verifyState(rig.deps.env, jar.get(STATE_COOKIE_NAME), state, rig.clock.now())).toBe(true);
    // The state cookie lives 10 minutes.
    rig.clock.advance({ minutes: 10 });
    expect(verifyState(rig.deps.env, jar.get(STATE_COOKIE_NAME), state, rig.clock.now())).toBe(false);
  });

  it('marks the state cookie Secure when the app is served over https', async () => {
    // A non-loopback APP_URL needs non-fake secrets even in fake mode (D-29): random ones, made here.
    const env = {
      APP_URL: 'https://autopilot.example.com',
      APP_SECRET: randomBytes(32).toString('base64'),
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      HUBSPOT_CLIENT_SECRET: randomBytes(16).toString('hex'),
      QSTASH_CURRENT_SIGNING_KEY: `sig_${randomBytes(16).toString('hex')}`,
      QSTASH_NEXT_SIGNING_KEY: `sig_${randomBytes(16).toString('hex')}`,
      CRON_SECRET: randomBytes(24).toString('hex'),
    };
    rig = createJobTestRig(getDb(), createJobRegistry(), { env });
    const res = await handleHubSpotInstall(installRequest(new CookieJar()), rig.deps);
    expect(res.headers.getSetCookie()[0]).toContain('; HttpOnly; Secure; SameSite=Lax');
  });

  it('allows 20 installs a minute per IP, then answers 429 with Retry-After', async () => {
    rig.clock.set(new Date('2026-10-06T14:00:15.000Z'));
    for (let i = 0; i < 20; i += 1) expect((await handleHubSpotInstall(installRequest(new CookieJar()), rig.deps)).status).toBe(302);
    const limited = await handleHubSpotInstall(installRequest(new CookieJar()), rig.deps);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('45');
    expect(limited.headers.getSetCookie()).toHaveLength(0);

    expect((await handleHubSpotInstall(installRequest(new CookieJar(), '198.51.100.9'), rig.deps)).status).toBe(302);
    rig.clock.advance({ seconds: 45 });
    expect((await handleHubSpotInstall(installRequest(new CookieJar()), rig.deps)).status).toBe(302);

    const keys = await getDb().query<{ key_hash: string }>(`select key_hash from rate_limits`);
    expect(keys.every((row) => /^[0-9a-f]{64}$/.test(row.key_hash) && !row.key_hash.includes('203'))).toBe(true);
  });

  it('reads the client IP from x-real-ip, then the first x-forwarded-for hop', () => {
    expect(clientIp(new Request('http://x/', { headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1' } }))).toBe('203.0.113.7');
    expect(clientIp(new Request('http://x/', { headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' } }))).toBe('198.51.100.1');
    expect(clientIp(new Request('http://x/'))).toBe('unknown');
  });
});
