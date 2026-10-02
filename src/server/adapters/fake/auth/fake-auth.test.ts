import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermanentError } from '@/server/domain/errors';
import type { AuthOtpType } from '@/server/domain/types';
import { FakeClock } from '../clock';
import { CookieJar, parseCookieHeader, serializeSetCookie, toCookieHeader, withSetCookies } from '@/server/security/cookies';
import { FakeAuthProvider, SESSION_COOKIE_NAME } from './fake-auth';

const START = new Date('2026-10-06T13:00:00.000Z');
const KEY = 'fake-session-signing-key-0123456789abcdef';
const APP = 'http://localhost:3000';

let clock: FakeClock;
let auth: FakeAuthProvider;

function requestWith(cookie: string | null): Request {
  return new Request(`${APP}/dashboard`, cookie === null ? {} : { headers: { cookie } });
}

/** Signs `email` in through a link and returns a jar holding the session cookie. */
async function signIn(email: string, type: AuthOtpType = 'email'): Promise<{ jar: CookieJar; userId: string }> {
  const { hashedToken } = await auth.generateLink(email);
  const verified = await auth.verify(hashedToken, type);
  if (verified === null) throw new Error('expected verify to succeed');
  const jar = new CookieJar();
  jar.set(verified.cookies);
  return { jar, userId: verified.userId };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  clock = new FakeClock(START);
  auth = new FakeAuthProvider({ clock, sessionSigningKey: KEY });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FakeAuthProvider: users', () => {
  it('keys users by lower-cased email, one per email', async () => {
    const { userId } = await auth.createUser('Owner@Brightside-Plumbing.example ');
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await auth.findUserByEmail('OWNER@brightside-plumbing.EXAMPLE')).toEqual({ userId });
    const error = await auth.createUser('owner@brightside-plumbing.example').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermanentError);
    expect(error).toMatchObject({ code: 'auth_user_exists' });
    expect(auth.users()).toEqual([{ userId, email: 'owner@brightside-plumbing.example', lastSignInAt: null }]);
  });

  it('rejects a malformed email', async () => {
    await expect(auth.createUser('not an email')).rejects.toMatchObject({ code: 'auth_email_address_invalid' });
    await expect(auth.generateLink('nope')).rejects.toMatchObject({ code: 'auth_email_address_invalid' });
  });

  it('returns null for an unknown email and treats deleting a missing user as success', async () => {
    expect(await auth.findUserByEmail('nobody@example.com')).toBeNull();
    await auth.deleteUser('00000000-0000-0000-0000-000000000000');
  });

  it('silently creates an unknown user in generateLink, as live Supabase does (D-22)', async () => {
    const { userId } = await auth.generateLink('new@example.com');
    expect(await auth.findUserByEmail('new@example.com')).toEqual({ userId });
  });
});

describe('FakeAuthProvider: magic links', () => {
  it('verifies a link once and returns the session cookie to set', async () => {
    const { userId } = await auth.createUser('owner@example.com');
    const link = await auth.generateLink('OWNER@example.com');
    expect(link.userId).toBe(userId);
    expect(link.hashedToken).toMatch(/^[0-9a-f]{56}$/);
    const verified = await auth.verify(link.hashedToken, 'email');
    expect(verified).toMatchObject({ userId, email: 'owner@example.com' });
    expect(verified?.cookies).toHaveLength(1);
    expect(verified?.cookies[0]).toMatchObject({
      name: SESSION_COOKIE_NAME,
      options: { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7 * 86_400 },
    });
    expect(await auth.verify(link.hashedToken, 'email')).toBeNull();
  });

  it('accepts a link until the last millisecond of its hour on the Clock (D-22)', async () => {
    await auth.createUser('a@example.com');
    const link = await auth.generateLink('a@example.com');
    clock.advance({ minutes: 59, seconds: 59, milliseconds: 999 });
    expect(await auth.verify(link.hashedToken, 'email')).not.toBeNull();
  });

  it('rejects a link exactly one hour old, even though no newer link replaced it', async () => {
    await auth.createUser('a@example.com');
    const link = await auth.generateLink('a@example.com');
    clock.advance({ hours: 1 });
    expect(await auth.verify(link.hashedToken, 'email')).toBeNull();
  });

  it('starts the hour when the link is generated, not when the user was created', async () => {
    await auth.createUser('a@example.com');
    clock.advance({ minutes: 45 });
    const link = await auth.generateLink('a@example.com');
    clock.advance({ minutes: 59 });
    expect(await auth.verify(link.hashedToken, 'email')).not.toBeNull();
  });

  it('replaces an older unused link when a newer one is generated', async () => {
    await auth.createUser('a@example.com');
    const first = await auth.generateLink('a@example.com');
    const second = await auth.generateLink('a@example.com');
    expect(await auth.verify(first.hashedToken, 'email')).toBeNull();
    expect(await auth.verify(second.hashedToken, 'email')).not.toBeNull();
  });

  it('rejects a wrong type for a brand-new user without using the token up', async () => {
    await auth.createUser('new@example.com');
    const { hashedToken } = await auth.generateLink('new@example.com');
    expect(await auth.verify(hashedToken, 'magiclink')).toBeNull();
    expect(await auth.verify(hashedToken, 'signup')).not.toBeNull();
  });

  it('gives a returning user a magic-link token: magiclink and email work, signup does not', async () => {
    await signIn('back@example.com');
    const one = await auth.generateLink('back@example.com');
    expect(await auth.verify(one.hashedToken, 'signup')).toBeNull();
    expect(await auth.verify(one.hashedToken, 'magiclink')).not.toBeNull();
    const two = await auth.generateLink('back@example.com');
    expect(await auth.verify(two.hashedToken, 'email')).not.toBeNull();
  });

  it('rejects unknown hashes, unsupported types and links of deleted users', async () => {
    expect(await auth.verify('f'.repeat(56), 'email')).toBeNull();
    const { hashedToken, userId } = await auth.generateLink('gone@example.com');
    expect(await auth.verify(hashedToken, 'recovery' as AuthOtpType)).toBeNull();
    await auth.deleteUser(userId);
    expect(await auth.verify(hashedToken, 'email')).toBeNull();
  });
});

describe('FakeAuthProvider: sessions', () => {
  it('reads the verified user from the request cookie only', async () => {
    const { jar, userId } = await signIn('owner@example.com');
    expect(await auth.getVerifiedUser(jar.request(`${APP}/dashboard`))).toEqual({ userId, email: 'owner@example.com' });
    expect(await auth.getVerifiedUser(requestWith(null))).toBeNull();
    expect(await auth.getVerifiedUser(requestWith('other=1'))).toBeNull();
  });

  it('rejects a tampered or foreign-key cookie', async () => {
    const { jar } = await signIn('owner@example.com');
    const value = jar.get(SESSION_COOKIE_NAME) ?? '';
    const [payload = '', signature = ''] = value.split('.');
    const forged = Buffer.from(JSON.stringify({ sid: 'x', uid: 'y', exp: 9e15 })).toString('base64url');
    expect(await auth.getVerifiedUser(requestWith(`ap_session=${forged}.${signature}`))).toBeNull();
    expect(await auth.getVerifiedUser(requestWith(`ap_session=${payload}.${signature.slice(0, -2)}AA`))).toBeNull();
    expect(await auth.getVerifiedUser(requestWith('ap_session=garbage'))).toBeNull();
    const other = new FakeAuthProvider({ clock, sessionSigningKey: `${KEY}-other` });
    expect(await other.getVerifiedUser(jar.request(APP))).toBeNull();
  });

  // Buffer.from(…, 'base64url') ignores padding, invalid characters and the spare low bits of the
  // last character, so these all decode to the right signature bytes. Only the canonical text counts.
  it('accepts only the canonical spelling of a signed cookie', async () => {
    const { jar, userId } = await signIn('owner@example.com');
    const value = jar.get(SESSION_COOKIE_NAME) ?? '';
    const [payload = '', signature = ''] = value.split('.');
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await auth.getVerifiedUser(requestWith(`ap_session=${value}`))).toEqual({ userId, email: 'owner@example.com' });

    const last = signature.at(-1) ?? 'A';
    const index = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(last);
    const sameBits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[index ^ 1] ?? 'A';
    const variants = [
      `${value}=`,
      `${value}!!`,
      `${payload}.\t${signature}`,
      `${payload}.${signature.slice(0, -1)}${sameBits}`,
      `${payload}=.${signature}`,
      `${payload}!.${signature}`,
    ];
    for (const variant of variants) {
      expect(Buffer.from(variant.split('.')[1] ?? '', 'base64url').equals(Buffer.from(signature, 'base64url')), variant).toBe(true);
      expect(await auth.getVerifiedUser(requestWith(`ap_session=${variant}`)), variant).toBeNull();
    }
  });

  it('expires a session after its lifetime on the Clock', async () => {
    const { jar } = await signIn('owner@example.com');
    clock.advance({ days: 7 });
    expect(await auth.getVerifiedUser(jar.request(APP))).toBeNull();
  });

  it('refreshes a session nearing expiry and sets the new cookie on the response', async () => {
    const { jar, userId } = await signIn('owner@example.com');
    const fresh = await auth.refreshSession(jar.request(APP), new Response('ok'));
    expect(fresh.user).toEqual({ userId, email: 'owner@example.com' });
    expect(fresh.response.headers.getSetCookie()).toEqual([]);

    clock.advance({ days: 6, hours: 1 });
    const refreshed = await auth.refreshSession(jar.request(APP), new Response('ok'));
    expect(refreshed.user?.userId).toBe(userId);
    const [setCookie] = refreshed.response.headers.getSetCookie();
    expect(setCookie).toMatch(/^ap_session=[^;]+; Path=\/; Max-Age=604800; Expires=.+; HttpOnly; Secure; SameSite=Lax$/);
    jar.storeFrom(refreshed.response);

    clock.advance({ days: 3 });
    expect(await auth.getVerifiedUser(jar.request(APP))).toEqual({ userId, email: 'owner@example.com' });
  });

  it('refreshes onto an immutable redirect response by copying it', async () => {
    const { jar } = await signIn('owner@example.com');
    clock.advance({ days: 6, hours: 12 });
    const redirect = Response.redirect(`${APP}/dashboard`, 307);
    const { response } = await auth.refreshSession(jar.request(APP), redirect);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${APP}/dashboard`);
    expect(response.headers.getSetCookie()).toHaveLength(1);
  });

  it('clears an invalid cookie on refresh and reports no user', async () => {
    const { response, user } = await auth.refreshSession(requestWith('ap_session=bad.cookie'), new Response(null));
    expect(user).toBeNull();
    expect(response.headers.getSetCookie()[0]).toMatch(/^ap_session=; Path=\/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    const none = await auth.refreshSession(requestWith(null), new Response(null));
    expect(none.response.headers.getSetCookie()).toEqual([]);
  });

  it('signs out: the old cookie stops working and a clearing cookie is returned', async () => {
    const { jar } = await signIn('owner@example.com');
    const stolen = jar.header();
    const cookies = await auth.signOut(jar.request(APP));
    expect(cookies).toEqual([
      expect.objectContaining({ name: SESSION_COOKIE_NAME, value: '', options: expect.objectContaining({ maxAge: 0 }) }),
    ]);
    jar.set(cookies);
    expect(jar.header()).toBeNull();
    expect(await auth.getVerifiedUser(requestWith(stolen))).toBeNull();
  });

  it('ends sessions when the user is deleted', async () => {
    const { jar, userId } = await signIn('owner@example.com');
    await auth.deleteUser(userId);
    expect(await auth.getVerifiedUser(jar.request(APP))).toBeNull();
  });

  it('issues a session directly for route tests', async () => {
    const { userId } = await auth.createUser('owner@example.com');
    const cookie = auth.issueSession(userId);
    expect(await auth.getVerifiedUser(requestWith(toCookieHeader([cookie])))).toEqual({ userId, email: 'owner@example.com' });
    expect(() => auth.issueSession('missing')).toThrow('fake_auth_unknown_user');
  });

  it('round-trips users, links and sessions through a snapshot', async () => {
    const { jar, userId } = await signIn('owner@example.com');
    const pending = await auth.generateLink('second@example.com');
    const copy = new FakeAuthProvider({ clock, sessionSigningKey: KEY });
    copy.restore(JSON.parse(JSON.stringify(auth.snapshot())));
    expect(await copy.getVerifiedUser(jar.request(APP))).toEqual({ userId, email: 'owner@example.com' });
    expect(await copy.verify(pending.hashedToken, 'email')).not.toBeNull();
    expect(() => copy.restore({})).toThrow();
  });

  it('refuses a short signing key and can issue non-Secure cookies', async () => {
    expect(() => new FakeAuthProvider({ clock, sessionSigningKey: 'short' })).toThrow(RangeError);
    const plain = new FakeAuthProvider({ clock, sessionSigningKey: new Uint8Array(32).fill(7), secureCookies: false });
    const { userId } = await plain.createUser('a@example.com');
    expect(serializeSetCookie(plain.issueSession(userId))).not.toContain('Secure');
  });
});

describe('cookie helpers', () => {
  it('serialises every attribute and refuses unsafe names or values', () => {
    const header = serializeSetCookie({
      name: 'ap_session',
      value: 'abc.def',
      options: { path: '/', domain: 'example.com', maxAge: 60, expires: new Date(START.getTime() + 60_000), httpOnly: true, secure: true, sameSite: 'strict' },
    });
    expect(header).toBe('ap_session=abc.def; Path=/; Domain=example.com; Max-Age=60; Expires=Tue, 06 Oct 2026 13:01:00 GMT; HttpOnly; Secure; SameSite=Strict');
    expect(() => serializeSetCookie({ name: 'a b', value: 'x', options: {} })).toThrow(RangeError);
    expect(() => serializeSetCookie({ name: 'a', value: 'x;y', options: {} })).toThrow(RangeError);
  });

  it('parses a Cookie header, keeping the first of duplicate names and unquoting values', () => {
    const cookies = parseCookieHeader('a=1; b="two"; a=3; =skip; c');
    expect([...cookies]).toEqual([
      ['a', '1'],
      ['b', 'two'],
    ]);
    expect(parseCookieHeader(null).size).toBe(0);
  });

  it('appends Set-Cookie headers to a mutable response in place', () => {
    const response = new Response('x');
    const out = withSetCookies(response, [{ name: 'a', value: '1', options: { path: '/' } }]);
    expect(out).toBe(response);
    expect(out.headers.getSetCookie()).toEqual(['a=1; Path=/']);
    expect(withSetCookies(response, [])).toBe(response);
  });
});
