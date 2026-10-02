import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/server/env';
import { deriveKey } from '@/server/security/keys';
import {
  issuePendingInstallCookie,
  issueStateCookie,
  readPendingInstall,
  secureCookies,
  signCookieValue,
  verifyCookieValue,
  verifyState,
} from './cookies';
import { resolveTimezone } from './timezone';

const env = parseEnv({ APP_MODE: 'fake' });
const NOW = new Date('2026-10-06T14:00:00.000Z');
const ACCOUNT = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('signed cookies', () => {
  const key = deriveKey(env.APP_SECRET, 'state');

  it('round-trips a payload and rejects any change to it or its signature', () => {
    const value = signCookieValue(key, { n: 'x' });
    expect(verifyCookieValue(key, value)).toEqual({ n: 'x' });
    const [body = '', signature = ''] = value.split('.');
    const otherBody = Buffer.from(JSON.stringify({ n: 'y' })).toString('base64url');
    expect(verifyCookieValue(key, `${otherBody}.${signature}`)).toBeNull();
    expect(verifyCookieValue(key, `${body}.${signature.slice(0, -1)}A`)).toBeNull();
    expect(verifyCookieValue(key, body)).toBeNull();
    expect(verifyCookieValue(key, undefined)).toBeNull();
  });

  it('accepts only the canonical base64url spelling', () => {
    const value = signCookieValue(key, { n: 'x' });
    expect(verifyCookieValue(key, value.replace('.', '=.'))).toBeNull();
  });

  it('a value signed for one purpose is refused for another', () => {
    const { cookie } = issueStateCookie(env, NOW);
    expect(readPendingInstall(env, cookie.value, NOW)).toBeNull();
    const pending = issuePendingInstallCookie(env, { accountId: ACCOUNT, installerEmail: null }, NOW);
    expect(verifyState(env, pending.value, 'anything', NOW)).toBe(false);
  });
});

describe('the state cookie', () => {
  it('accepts exactly its nonce, for 10 minutes', () => {
    const { state, cookie } = issueStateCookie(env, NOW);
    expect(verifyState(env, cookie.value, state, NOW)).toBe(true);
    expect(verifyState(env, cookie.value, issueStateCookie(env, NOW).state, NOW)).toBe(false);
    expect(verifyState(env, cookie.value, null, NOW)).toBe(false);
    expect(verifyState(env, cookie.value, state, new Date(NOW.getTime() + 10 * 60_000 - 1))).toBe(true);
    expect(verifyState(env, cookie.value, state, new Date(NOW.getTime() + 10 * 60_000))).toBe(false);
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: 'lax', maxAge: 600, path: '/api/hubspot/oauth/callback' });
  });
});

describe('the pending_install cookie', () => {
  it('carries the account and installer email for 24 hours', () => {
    const cookie = issuePendingInstallCookie(env, { accountId: ACCOUNT, installerEmail: 'owner@example.com' }, NOW);
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: 'lax', maxAge: 86_400, path: '/' });
    expect(readPendingInstall(env, cookie.value, new Date(NOW.getTime() + 86_400_000 - 1))).toEqual({ accountId: ACCOUNT, installerEmail: 'owner@example.com' });
    expect(readPendingInstall(env, cookie.value, new Date(NOW.getTime() + 86_400_000))).toBeNull();
  });
});

describe('secureCookies', () => {
  it('is off only for a plain-http loopback APP_URL', () => {
    expect(secureCookies(env)).toBe(false);
    expect(secureCookies({ ...env, APP_URL: 'https://autopilot.example.com' })).toBe(true);
    expect(secureCookies({ ...env, APP_URL: 'http://autopilot.example.com' })).toBe(true);
  });
});

describe('resolveTimezone (D-12)', () => {
  it('keeps an IANA zone, including HubSpot alias names Luxon knows', () => {
    expect(resolveTimezone({ timeZone: 'America/New_York', utcOffsetMilliseconds: -14_400_000 })).toEqual({ timezone: 'America/New_York', source: 'hubspot' });
    expect(resolveTimezone({ timeZone: 'US/Eastern', utcOffsetMilliseconds: -14_400_000 })).toEqual({ timezone: 'US/Eastern', source: 'hubspot' });
  });

  it('falls back to the fixed offset for a non-IANA zone', () => {
    expect(resolveTimezone({ timeZone: 'Eastern Standard Time', utcOffsetMilliseconds: -18_000_000 })).toEqual({ timezone: 'UTC-5', source: 'utc_offset' });
    expect(resolveTimezone({ timeZone: 'India', utcOffsetMilliseconds: 19_800_000 })).toEqual({ timezone: 'UTC+5:30', source: 'utc_offset' });
  });

  it('leaves the timezone to the owner when there are no details', () => {
    expect(resolveTimezone(null)).toEqual({ timezone: null, source: null });
  });
});
