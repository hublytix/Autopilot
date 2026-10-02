import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { CookieJar, toCookieHeader } from '@/server/security/cookies';
import { seedOwner } from '@/server/services/accounts/testing';
import { isAdminRequiredError, isOwnerRequiredError, requireAdmin, requireOwner } from '@/server/services/auth/owner-scope';
import { seedPendingInstall } from '@/server/services/auth/testing';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { onboardingAccess, requireAdminPage, requireOwnerPage } from './guards';
import { handleSignOut } from './signout';

const getDb = setUpTestDb();
let rig: JobTestRig;

const OWNER = 'owner@brightside-plumbing.example';

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  for (const method of ['info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A bound owner with a signed-in browser. */
async function signedInOwner(): Promise<{ accountId: string; userId: string; jar: CookieJar }> {
  const install = await seedPendingInstall(rig.deps);
  const { userId } = await rig.fakes.auth.createUser(OWNER);
  await seedOwner(getDb(), install.accountId, OWNER, userId);
  const jar = new CookieJar();
  jar.set([rig.fakes.auth.issueSession(userId)]);
  return { accountId: install.accountId, userId, jar };
}

function headersOf(jar: CookieJar): Headers {
  const headers = new Headers();
  const cookie = jar.header();
  if (cookie !== null) headers.set('cookie', cookie);
  return headers;
}

/** The digest Next puts on the errors redirect() and notFound() throw. */
async function nextNavigation(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String((error as { digest?: unknown }).digest ?? error);
  }
  throw new Error('expected a Next navigation error');
}

describe('requireOwner / requireAdmin', () => {
  it('turns a bound owner session into an OwnerScope, and nothing else into one', async () => {
    const { accountId, userId, jar } = await signedInOwner();
    expect(await requireOwner(rig.deps, jar.request(`${rig.deps.env.APP_URL}/dashboard`))).toEqual({ accountId, userId });

    // A verified session whose user owns no account is not an owner.
    const { userId: stranger } = await rig.fakes.auth.createUser('stranger@example.com');
    const strangerJar = new CookieJar();
    strangerJar.set([rig.fakes.auth.issueSession(stranger)]);
    await expect(requireOwner(rig.deps, strangerJar.request(`${rig.deps.env.APP_URL}/dashboard`))).rejects.toSatisfy(isOwnerRequiredError);
    await expect(requireOwner(rig.deps, new Request(`${rig.deps.env.APP_URL}/dashboard`))).rejects.toSatisfy(isOwnerRequiredError);
  });

  it('needs both sides of the binding (users row and accounts.owner_user_id)', async () => {
    const { accountId, jar } = await signedInOwner();
    await getDb().query(`update accounts set owner_user_id = null where id = $1`, [accountId]);
    await expect(requireOwner(rig.deps, jar.request(`${rig.deps.env.APP_URL}/dashboard`))).rejects.toSatisfy(isOwnerRequiredError);
  });

  it('accepts an admin only by a verified session whose email is in ADMIN_EMAILS', async () => {
    const admin = rig.deps.env.ADMIN_EMAILS[0] ?? '';
    const { userId } = await rig.fakes.auth.createUser(admin);
    const jar = new CookieJar();
    jar.set([rig.fakes.auth.issueSession(userId)]);
    expect(await requireAdmin(rig.deps, jar.request(`${rig.deps.env.APP_URL}/admin`))).toEqual({ userId, email: admin });
    const owner = await signedInOwner();
    await expect(requireAdmin(rig.deps, owner.jar.request(`${rig.deps.env.APP_URL}/admin`))).rejects.toSatisfy(isAdminRequiredError);
  });
});

describe('page guards', () => {
  it('requireOwnerPage returns the scope, or redirects to /login', async () => {
    const { accountId, userId, jar } = await signedInOwner();
    expect(await requireOwnerPage(rig.deps, headersOf(jar))).toEqual({ accountId, userId });
    expect(await nextNavigation(requireOwnerPage(rig.deps, new Headers()))).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login;/);
  });

  it('requireAdminPage answers 404 to everyone but an admin', async () => {
    const { jar } = await signedInOwner();
    expect(await nextNavigation(requireAdminPage(rig.deps, headersOf(jar)))).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('onboardingAccess: owner, else a genuine pending_install cookie, else none', async () => {
    const { jar } = await signedInOwner();
    expect(await onboardingAccess(rig.deps, headersOf(jar))).toBe('owner');
    const install = await seedPendingInstall(rig.deps);
    expect(await onboardingAccess(rig.deps, new Headers({ cookie: toCookieHeader([install.cookie]) }))).toBe('pending');
    expect(await onboardingAccess(rig.deps, new Headers({ cookie: `${install.cookie.name}=forged.value` }))).toBe('none');
    expect(await onboardingAccess(rig.deps, new Headers())).toBe('none');
  });
});

describe('POST /auth/signout', () => {
  it('ends the session and clears its cookie (same-origin only)', async () => {
    const { jar } = await signedInOwner();
    const cross = await handleSignOut(jar.request(`${rig.deps.env.APP_URL}/auth/signout`, { method: 'POST', headers: { origin: 'https://evil.example' } }), rig.deps);
    expect(cross.status).toBe(403);
    expect(await requireOwner(rig.deps, jar.request(`${rig.deps.env.APP_URL}/dashboard`))).toBeDefined();

    const before = jar.request(`${rig.deps.env.APP_URL}/dashboard`);
    const res = await handleSignOut(jar.request(`${rig.deps.env.APP_URL}/auth/signout`, { method: 'POST', headers: { origin: rig.deps.env.APP_URL } }), rig.deps);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${rig.deps.env.APP_URL}/login?signed_out=1`);
    jar.storeFrom(res);
    expect(jar.header()).toBeNull();
    // The old cookie no longer works either: the session is gone server-side.
    await expect(requireOwner(rig.deps, before)).rejects.toSatisfy(isOwnerRequiredError);
  });

  it('accepts the sign-out form posted with Origin null when the browser says same-origin, and refuses it otherwise', async () => {
    const { jar } = await signedInOwner();
    const url = `${rig.deps.env.APP_URL}/auth/signout`;
    for (const headers of [{ origin: 'null', 'sec-fetch-site': 'cross-site' }, { origin: 'null' }]) {
      const refused = await handleSignOut(jar.request(url, { method: 'POST', headers }), rig.deps);
      expect(refused.status).toBe(403);
      expect(await requireOwner(rig.deps, jar.request(`${rig.deps.env.APP_URL}/dashboard`))).toBeDefined();
    }
    const res = await handleSignOut(jar.request(url, { method: 'POST', headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } }), rig.deps);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${rig.deps.env.APP_URL}/login?signed_out=1`);
    jar.storeFrom(res);
    expect(jar.header()).toBeNull();
  });
});
