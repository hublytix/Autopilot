import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransientError } from '@/server/domain/errors';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { CookieJar } from '@/server/security/cookies';
import { buildCsp } from '@/server/security/csp';
import { seedOwner } from '@/server/services/accounts/testing';
import { insertLoginIntent, loginIntentKey } from '@/server/services/auth/login-intents';
import { deliverMagicLink, issueMagicLink, sendMagicLink } from '@/server/services/auth/magic-link';
import { submitOnboardingEmail } from '@/server/services/auth/onboarding-email';
import { resolveOwner } from '@/server/services/auth/owner-scope';
import { accountAuthState, confirmPostRequest, lastMagicLink, seedPendingInstall, type PendingInstallSeed } from '@/server/services/auth/testing';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { handleConfirmGet, handleConfirmPost } from './confirm';

const getDb = setUpTestDb();
let rig: JobTestRig;
let ipCounter = 0;

const OWNER = 'owner@brightside-plumbing.example';
const HOUR = 3_600_000;

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  for (const method of ['info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fresh client IP per request, so the per-IP confirm limit only bites where a test wants it. */
function nextIp(): string {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

/** The email step in the installer's browser (jar A), as the onboarding page's Server Action runs it. */
async function emailStep(install: PendingInstallSeed, email: string): Promise<void> {
  const outcome = await submitOnboardingEmail(rig.deps, { pendingCookie: install.cookie.value, email, ip: nextIp() });
  expect(outcome).toEqual({ type: 'sent' });
}

/** Opens the link in `jar` (empty by default: another device) and taps "Sign in". */
async function confirm(input: { tokenHash: string; type?: string }, jar: CookieJar = new CookieJar(), ip = nextIp()): Promise<Response> {
  const res = await handleConfirmPost(confirmPostRequest(rig.deps.env.APP_URL, { tokenHash: input.tokenHash, type: input.type ?? 'email', ip, cookie: jar.header() }), rig.deps);
  jar.storeFrom(res);
  return res;
}

function location(res: Response): string {
  expect(res.status).toBe(303);
  return res.headers.get('location') ?? '';
}

async function ownerOf(jar: CookieJar) {
  return resolveOwner(rig.deps, jar.request(`${rig.deps.env.APP_URL}/dashboard`));
}

describe('GET /auth/confirm', () => {
  it('renders a Sign in button and a nonce-carrying script that reads the fragment; it never reads a token itself', async () => {
    const nonce = 'proxyNonceAAAAAAAAAAAA==';
    const res = handleConfirmGet(new Request(`${rig.deps.env.APP_URL}/auth/confirm`, { headers: { 'x-nonce': nonce } }), rig.deps);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<button type="submit" id="submit" disabled>Sign in</button>');
    expect(html).toContain('<form id="confirm" method="post" action="/auth/confirm">');
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('location.hash');
    expect(html).toContain('history.replaceState');
    expect(html).toContain('<noscript>');
    // The page never auto-submits: only a tap posts (link scanners sign nobody in).
    expect(html).not.toMatch(/\.submit\(\)|requestSubmit/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    // The proxy's policy applies; the handler adds none of its own.
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(() => buildCsp({ nonce, dev: false, sentryOrigin: null })).not.toThrow();
  });

  it('brings its own nonce and policy when no proxy ran', async () => {
    const res = handleConfirmGet(new Request(`${rig.deps.env.APP_URL}/auth/confirm`), rig.deps);
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(await res.text()).toContain(`<script nonce="${nonce}">`);
    expect(csp).not.toContain("'unsafe-inline' 'nonce");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('POST /auth/confirm: the onboarding bind', () => {
  it('binds the owner from an empty cookie jar on another device and starts the session there', async () => {
    const install = await seedPendingInstall(rig.deps);
    await emailStep(install, OWNER);
    const link = lastMagicLink(rig.fakes);
    expect(link.type).toBe('email');

    const otherDevice = new CookieJar();
    const res = await confirm(link, otherDevice);
    expect(location(res)).toBe(`${rig.deps.env.APP_URL}/onboarding/brief`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const user = await rig.fakes.auth.findUserByEmail(OWNER);
    expect(await accountAuthState(getDb(), install.accountId)).toMatchObject({
      owner_user_id: user?.userId,
      pending_owner_email: null,
      pending_owner_expires_at: null,
      pending_owner_auth_user_id: null,
    });
    expect(await getDb().query(`select auth_user_id, account_id, email from users`)).toEqual([
      { auth_user_id: user?.userId, account_id: install.accountId, email: OWNER },
    ]);
    // The other device now holds a verified owner session.
    expect(await ownerOf(otherDevice)).toEqual({ accountId: install.accountId, userId: user?.userId });
    const audit = await getDb().query(`select action, actor from audit_log where account_id = $1`, [install.accountId]);
    expect(audit).toEqual([{ action: 'auth.owner_bound', actor: 'owner' }]);
  });

  it('binds when the link is confirmed at minute 45', async () => {
    const install = await seedPendingInstall(rig.deps);
    await emailStep(install, OWNER);
    rig.clock.advance({ minutes: 45 });
    const res = await confirm(lastMagicLink(rig.fakes));
    expect(location(res)).toBe(`${rig.deps.env.APP_URL}/onboarding/brief`);
    expect((await accountAuthState(getDb(), install.accountId)).owner_user_id).not.toBeNull();
  });

  it('accepts the link at 59:59.999 and refuses it at 60:00', async () => {
    const early = await seedPendingInstall(rig.deps);
    await emailStep(early, 'early@example.com');
    const earlyLink = lastMagicLink(rig.fakes);
    rig.clock.advance(HOUR - 1);
    expect(location(await confirm(earlyLink))).toBe(`${rig.deps.env.APP_URL}/onboarding/brief`);

    const late = await seedPendingInstall(rig.deps);
    await emailStep(late, 'late@example.com');
    const lateLink = lastMagicLink(rig.fakes);
    rig.clock.advance(HOUR);
    expect(location(await confirm(lateLink))).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=link`);
    expect((await accountAuthState(getDb(), late.accountId)).owner_user_id).toBeNull();
  });

  it('works once: the second tap is refused and sets no cookie', async () => {
    const install = await seedPendingInstall(rig.deps);
    await emailStep(install, OWNER);
    const link = lastMagicLink(rig.fakes);
    await confirm(link);
    const again = await confirm(link);
    expect(location(again)).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=link`);
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it('refuses a wrong type without using the link up, then accepts type=email', async () => {
    const install = await seedPendingInstall(rig.deps);
    await emailStep(install, OWNER);
    const link = lastMagicLink(rig.fakes);
    // A brand-new user's token is a signup token: Supabase rejects `magiclink` for it.
    expect(location(await confirm({ tokenHash: link.tokenHash, type: 'magiclink' }))).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=link`);
    expect(location(await confirm({ tokenHash: link.tokenHash, type: 'recovery' }))).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=link`);
    expect(location(await confirm({ tokenHash: link.tokenHash, type: 'email' }))).toBe(`${rig.deps.env.APP_URL}/onboarding/brief`);
  });

  it('login-CSRF: a link verified for another email cannot bind the account', async () => {
    // The attacker's auth user stays alive (it is pending on the attacker's own install).
    const attackerInstall = await seedPendingInstall(rig.deps);
    await emailStep(attackerInstall, 'attacker@example.com');
    const install = await seedPendingInstall(rig.deps);
    await emailStep(install, 'attacker@example.com');
    const attackerLink = lastMagicLink(rig.fakes);
    await emailStep(install, OWNER);

    const victim = new CookieJar();
    const res = await confirm(attackerLink, victim);
    expect(location(res)).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=setup`);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(victim.header()).toBeNull();
    expect(await accountAuthState(getDb(), install.accountId)).toMatchObject({ owner_user_id: null, pending_owner_email: OWNER });
    expect(await getDb().query(`select 1 from users`)).toEqual([]);
  });

  it("a replaced email's link dies with its auth user", async () => {
    const install = await seedPendingInstall(rig.deps);
    await emailStep(install, 'typo@example.com');
    const typoLink = lastMagicLink(rig.fakes);
    await emailStep(install, OWNER);
    expect(location(await confirm(typoLink))).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=link`);
    expect(location(await confirm(lastMagicLink(rig.fakes)))).toBe(`${rig.deps.env.APP_URL}/onboarding/brief`);
  });

  it('two pending installs with the same email: the second bind is refused and its pending owner cleared', async () => {
    const first = await seedPendingInstall(rig.deps);
    await emailStep(first, OWNER);
    await confirm(lastMagicLink(rig.fakes));
    const user = await rig.fakes.auth.findUserByEmail(OWNER);

    // The second portal was waiting for the same address (its email step ran before the first bind).
    const second = await seedPendingInstall(rig.deps);
    await getDb().query(
      `update accounts set pending_owner_email = $2, pending_owner_expires_at = $3, pending_owner_auth_user_id = $4 where id = $1`,
      [second.accountId, OWNER, new Date(rig.clock.now().getTime() + 24 * HOUR), user?.userId],
    );
    const link = await issueMagicLink(rig.deps, { email: OWNER, purpose: 'onboarding', accountId: second.accountId, next: '/onboarding/brief' });
    await deliverMagicLink(rig.deps, link);

    const res = await confirm(lastMagicLink(rig.fakes));
    expect(location(res)).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=already_owner`);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await accountAuthState(getDb(), second.accountId)).toMatchObject({
      owner_user_id: null,
      pending_owner_email: null,
      pending_owner_expires_at: null,
      pending_owner_auth_user_id: null,
    });
    expect((await accountAuthState(getDb(), first.accountId)).owner_user_id).toBe(user?.userId);
    // The first account's owner still signs in.
    await sendMagicLink(rig.deps, { email: OWNER, purpose: 'login', accountId: first.accountId, next: '/dashboard' });
    const jar = new CookieJar();
    expect(location(await confirm(lastMagicLink(rig.fakes), jar))).toBe(`${rig.deps.env.APP_URL}/dashboard`);
    expect(await ownerOf(jar)).toEqual({ accountId: first.accountId, userId: user?.userId });
  });

  it('refuses after the pending owner expired (24 h)', async () => {
    const install = await seedPendingInstall(rig.deps);
    await emailStep(install, OWNER);
    const link = lastMagicLink(rig.fakes);
    await getDb().query(`update accounts set pending_owner_expires_at = $2 where id = $1`, [install.accountId, rig.clock.now()]);
    expect(location(await confirm(link))).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=setup`);
  });
});

describe('POST /auth/confirm: sign-in and the next allow-list', () => {
  async function owner(): Promise<{ accountId: string; userId: string }> {
    const install = await seedPendingInstall(rig.deps);
    const { userId } = await rig.fakes.auth.createUser(OWNER);
    await seedOwner(getDb(), install.accountId, OWNER, userId);
    return { accountId: install.accountId, userId };
  }

  it('signs a bound owner in to /dashboard?reconnect=1, keeping the query', async () => {
    const { accountId, userId } = await owner();
    await sendMagicLink(rig.deps, { email: OWNER, purpose: 'login', accountId, next: '/dashboard?reconnect=1' });
    const jar = new CookieJar();
    expect(location(await confirm(lastMagicLink(rig.fakes), jar))).toBe(`${rig.deps.env.APP_URL}/dashboard?reconnect=1`);
    expect(await ownerOf(jar)).toEqual({ accountId, userId });
  });

  it('lands on /dashboard when a stored next is not allow-listed', async () => {
    const { accountId } = await owner();
    const { hashedToken } = await rig.fakes.auth.generateLink(OWNER);
    await insertLoginIntent(getDb(), { key: loginIntentKey(hashedToken), purpose: 'login', accountId, next: 'https://evil.example/dashboard', now: rig.clock.now() });
    expect(location(await confirm({ tokenHash: hashedToken }))).toBe(`${rig.deps.env.APP_URL}/dashboard`);
  });

  it('refuses a token Supabase still accepts once its intent has expired (the hour is ours to enforce)', async () => {
    await owner();
    const { hashedToken } = await rig.fakes.auth.generateLink(OWNER);
    // The intent was stored 61 minutes ago; the fake token itself is fresh, so verify accepts it.
    await insertLoginIntent(getDb(), { key: loginIntentKey(hashedToken), purpose: 'login', accountId: null, next: '/dashboard', now: new Date(rig.clock.now().getTime() - 61 * 60_000) });
    const verify = vi.spyOn(rig.fakes.auth, 'verify');
    const res = await confirm({ tokenHash: hashedToken });
    expect(await verify.mock.results[0]?.value).not.toBeNull();
    expect(location(res)).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=link`);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('refuses a token Supabase still accepts once its intent was used', async () => {
    const { accountId } = await owner();
    const { hashedToken } = await rig.fakes.auth.generateLink(OWNER);
    const key = loginIntentKey(hashedToken);
    await insertLoginIntent(getDb(), { key, purpose: 'login', accountId, next: '/dashboard', now: rig.clock.now() });
    await getDb().query(`update login_intents set consumed_at = $2 where token_hash_sha256 = $1`, [key, rig.clock.now()]);
    const verify = vi.spyOn(rig.fakes.auth, 'verify');
    const res = await confirm({ tokenHash: hashedToken });
    expect(await verify.mock.results[0]?.value).not.toBeNull();
    expect(location(res)).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=link`);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('refuses a token Supabase accepts but we never issued an intent for', async () => {
    await owner();
    const { hashedToken } = await rig.fakes.auth.generateLink(OWNER);
    const res = await confirm({ tokenHash: hashedToken });
    expect(location(res)).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=link`);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('signs an admin in to /admin', async () => {
    const admin = rig.deps.env.ADMIN_EMAILS[0] ?? '';
    await rig.fakes.auth.createUser(admin);
    await sendMagicLink(rig.deps, { email: admin, purpose: 'login', accountId: null, next: '/admin' });
    expect(location(await confirm(lastMagicLink(rig.fakes)))).toBe(`${rig.deps.env.APP_URL}/admin`);
  });

  it('a second onboarding link for an account this user already owns just signs them in', async () => {
    const install = await seedPendingInstall(rig.deps);
    await emailStep(install, OWNER);
    await confirm(lastMagicLink(rig.fakes));
    await sendMagicLink(rig.deps, { email: OWNER, purpose: 'onboarding', accountId: install.accountId, next: '/onboarding/brief' });
    expect(location(await confirm(lastMagicLink(rig.fakes)))).toBe(`${rig.deps.env.APP_URL}/onboarding/brief`);
  });

  it('says so honestly when Supabase is unreachable (not "expired")', async () => {
    vi.spyOn(rig.fakes.auth, 'verify').mockRejectedValue(new TransientError('auth_unavailable', { httpStatus: 503 }));
    expect(location(await confirm({ tokenHash: 'c'.repeat(56) }))).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=unavailable`);
  });

  it('rejects malformed input', async () => {
    for (const tokenHash of ['', 'short', 'has spaces in it but long enough', '<script>alert(1)</script>xxxxxx']) {
      expect(location(await confirm({ tokenHash }))).toBe(`${rig.deps.env.APP_URL}/auth/error?reason=link`);
    }
  });
});

describe('POST /auth/confirm: origin and rate limit', () => {
  it('refuses a cross-site POST (403) and one with no Origin or Sec-Fetch-Site', async () => {
    const install = await seedPendingInstall(rig.deps);
    await emailStep(install, OWNER);
    const link = lastMagicLink(rig.fakes);
    const cross = await handleConfirmPost(confirmPostRequest(rig.deps.env.APP_URL, { ...link, origin: 'https://evil.example' }), rig.deps);
    expect(cross.status).toBe(403);
    const bare = await handleConfirmPost(confirmPostRequest(rig.deps.env.APP_URL, { ...link, origin: null }), rig.deps);
    expect(bare.status).toBe(403);
    expect((await accountAuthState(getDb(), install.accountId)).owner_user_id).toBeNull();

    const fetchSite = confirmPostRequest(rig.deps.env.APP_URL, { ...link, origin: null });
    fetchSite.headers.set('sec-fetch-site', 'same-origin');
    expect(location(await handleConfirmPost(fetchSite, rig.deps))).toBe(`${rig.deps.env.APP_URL}/onboarding/brief`);
  });

  it('accepts a plain form post that carries Origin null with Sec-Fetch-Site same-origin, as a browser sends it', async () => {
    const install = await seedPendingInstall(rig.deps);
    await emailStep(install, OWNER);
    const link = lastMagicLink(rig.fakes);
    const browserPost = confirmPostRequest(rig.deps.env.APP_URL, { ...link, origin: 'null' });
    browserPost.headers.set('sec-fetch-site', 'same-origin');
    const res = await handleConfirmPost(browserPost, rig.deps);
    expect(location(res)).toBe(`${rig.deps.env.APP_URL}/onboarding/brief`);
    expect(res.headers.getSetCookie().length).toBeGreaterThan(0);
    expect((await accountAuthState(getDb(), install.accountId)).owner_user_id).not.toBeNull();
  });

  it('refuses Origin null from another site or without Sec-Fetch-Site (403), leaving the link unused', async () => {
    const install = await seedPendingInstall(rig.deps);
    await emailStep(install, OWNER);
    const link = lastMagicLink(rig.fakes);
    const crossSite = confirmPostRequest(rig.deps.env.APP_URL, { ...link, origin: 'null' });
    crossSite.headers.set('sec-fetch-site', 'cross-site');
    expect((await handleConfirmPost(crossSite, rig.deps)).status).toBe(403);
    const noFetchSite = confirmPostRequest(rig.deps.env.APP_URL, { ...link, origin: 'null' });
    expect((await handleConfirmPost(noFetchSite, rig.deps)).status).toBe(403);
    expect((await accountAuthState(getDb(), install.accountId)).owner_user_id).toBeNull();
    // The refused posts did not use the link up.
    expect(location(await confirm(link))).toBe(`${rig.deps.env.APP_URL}/onboarding/brief`);
  });

  it('allows 10 POSTs per IP per 15 minutes, then answers 429 with Retry-After', async () => {
    const ip = '203.0.113.200';
    for (let i = 0; i < 10; i += 1) {
      expect((await confirm({ tokenHash: `unknown-token-${i}-xxxxxxxxxxxx` }, new CookieJar(), ip)).status).toBe(303);
    }
    const limited = await confirm({ tokenHash: 'unknown-token-11-xxxxxxxxxxxx' }, new CookieJar(), ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    rig.clock.advance({ minutes: 15 });
    expect((await confirm({ tokenHash: 'unknown-token-12-xxxxxxxxxxxx' }, new CookieJar(), ip)).status).toBe(303);
  });
});
