import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedCronRequest } from './cron-auth';

const join = (...parts: string[]): string => parts.join('');
const CRON_SECRET = join('test-cron-secret-', '0123456789abcdef0123456789');
const CURRENT_KEY = join('sig_', 'cronCurrentKey', '0000000000');
const NEXT_KEY = join('sig_', 'cronNextKey', '0000000000000');
const URL = 'https://autopilot.example/api/cron/poll';
const NOW = 1_790_000_000;

const config = { cronSecret: CRON_SECRET, currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY, url: URL };

async function qstashToken(key: string, url: string, body: string): Promise<string> {
  return new SignJWT({ body: createHash('sha256').update(body).digest('base64url') })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('Upstash')
    .setSubject(url)
    .setIssuedAt(NOW)
    .setNotBefore(0)
    .setExpirationTime(NOW + 300)
    .sign(new TextEncoder().encode(key));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date((NOW + 5) * 1000));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isAuthorizedCronRequest', () => {
  it('accepts a Vercel Cron GET with the bearer secret', async () => {
    const req = new Request(URL, { headers: { Authorization: `Bearer ${CRON_SECRET}`, 'User-Agent': 'vercel-cron/1.0' } });
    expect(await isAuthorizedCronRequest(req, config)).toBe(true);
  });

  it('refuses a GET with a wrong, missing or malformed secret, whatever the user agent', async () => {
    const wrong = new Request(URL, { headers: { Authorization: `Bearer ${CRON_SECRET}x` } });
    const missing = new Request(URL, { headers: { 'User-Agent': 'vercel-cron/1.0' } });
    const basic = new Request(URL, { headers: { Authorization: `Basic ${CRON_SECRET}` } });
    for (const req of [wrong, missing, basic]) expect(await isAuthorizedCronRequest(req, config)).toBe(false);
  });

  it('refuses every GET when the secret is empty', async () => {
    const req = new Request(URL, { headers: { Authorization: 'Bearer ' } });
    expect(await isAuthorizedCronRequest(req, { ...config, cronSecret: '' })).toBe(false);
  });

  it('accepts a QStash schedule POST signed for the route’s own URL', async () => {
    const body = '';
    const req = new Request(URL, { method: 'POST', headers: { 'Upstash-Signature': await qstashToken(CURRENT_KEY, URL, body) }, body });
    expect(await isAuthorizedCronRequest(req, config)).toBe(true);
  });

  it('refuses a POST signed for another route, signed with another key, or unsigned', async () => {
    const body = '{}';
    const otherRoute = new Request(URL, {
      method: 'POST',
      headers: { 'Upstash-Signature': await qstashToken(CURRENT_KEY, 'https://autopilot.example/api/cron/daily', body) },
      body,
    });
    const otherKey = new Request(URL, {
      method: 'POST',
      headers: { 'Upstash-Signature': await qstashToken(join('sig_', 'notOurKey', '000000000000'), URL, body) },
      body,
    });
    const unsigned = new Request(URL, { method: 'POST', body });
    for (const req of [otherRoute, otherKey, unsigned]) expect(await isAuthorizedCronRequest(req, config)).toBe(false);
  });

  it('refuses a POST that carries only the bearer secret, and other methods', async () => {
    const post = new Request(URL, { method: 'POST', headers: { Authorization: `Bearer ${CRON_SECRET}` }, body: '' });
    const put = new Request(URL, { method: 'PUT', headers: { Authorization: `Bearer ${CRON_SECRET}` }, body: '' });
    expect(await isAuthorizedCronRequest(post, config)).toBe(false);
    expect(await isAuthorizedCronRequest(put, config)).toBe(false);
  });

  it('leaves the request body readable for the handler', async () => {
    const body = '{"x":1}';
    const req = new Request(URL, { method: 'POST', headers: { 'Upstash-Signature': await qstashToken(CURRENT_KEY, URL, body) }, body });
    expect(await isAuthorizedCronRequest(req, config)).toBe(true);
    expect(await req.text()).toBe(body);
  });
});
