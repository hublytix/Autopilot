import { describe, expect, it } from 'vitest';
import { FakeClock } from '@/server/adapters/fake/clock';
import { parseEnv } from '@/server/env';
import { toCookieHeader, withSetCookies } from '@/server/security/cookies';
import { deriveKey } from '@/server/security/keys';
import { DEFAULT_SESSION_TTL_MS, FakeAuthProvider, SESSION_COOKIE_NAME } from './fake-auth';
import { checkFakeProxySession, readFakeSessionCookie } from './proxy-session';

const START = new Date('2026-10-06T14:00:00.000Z');
const env = parseEnv({ APP_MODE: 'fake' });
const key = deriveKey(env.APP_SECRET, 'fake-session');

async function signedIn() {
  const clock = new FakeClock(START);
  const auth = new FakeAuthProvider({ clock, sessionSigningKey: key });
  const { userId } = await auth.createUser('owner@example.com');
  const cookie = auth.issueSession(userId);
  return { clock, auth, userId, cookie };
}

describe("the proxy's fake-mode session check", () => {
  it("accepts exactly the cookies FakeAuthProvider signs, until the cookie's own expiry", async () => {
    const { userId, cookie } = await signedIn();
    expect(readFakeSessionCookie(cookie.value, key, START.getTime())).toEqual({ userId, expiresAtMs: START.getTime() + DEFAULT_SESSION_TTL_MS });
    expect(readFakeSessionCookie(cookie.value, key, START.getTime() + DEFAULT_SESSION_TTL_MS)).toBeNull();
  });

  it('refuses a tampered, re-signed-with-another-key or malformed cookie', async () => {
    const { cookie } = await signedIn();
    const [payload = '', signature = ''] = cookie.value.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sid: 'x', uid: 'attacker', exp: 9e15 })).toString('base64url');
    expect(readFakeSessionCookie(`${forgedPayload}.${signature}`, key, START.getTime())).toBeNull();
    expect(readFakeSessionCookie(cookie.value, deriveKey(env.TOKEN_ENCRYPTION_KEY, 'fake-session'), START.getTime())).toBeNull();
    for (const value of [undefined, '', 'no-dot', `.${signature}`, `${payload}.`, `${payload}.${signature}x`]) {
      expect(readFakeSessionCookie(value, key, START.getTime())).toBeNull();
    }
  });

  it('reports the user without touching the response, and none without a valid cookie', async () => {
    const { clock, userId, cookie } = await signedIn();
    const response = new Response(null);
    const request = new Request('http://localhost:3000/dashboard', { headers: { cookie: toCookieHeader([cookie]) } });
    const result = await checkFakeProxySession(request, response, { key, clock });
    expect(result.user?.userId).toBe(userId);
    expect(result.response).toBe(response);
    expect(response.headers.getSetCookie()).toEqual([]);
    const none = await checkFakeProxySession(new Request('http://localhost:3000/dashboard'), response, { key, clock });
    expect(none.user).toBeNull();
  });

  it('matches the session cookie name FakeAuthProvider sets', async () => {
    const { cookie } = await signedIn();
    expect(cookie.name).toBe(SESSION_COOKIE_NAME);
    expect(withSetCookies(new Response(null), [cookie]).headers.getSetCookie()[0]).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`));
  });
});
