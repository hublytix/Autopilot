import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { seedOwner } from '@/server/services/accounts/testing';
import { issuePendingInstallCookie } from '@/server/services/install/cookies';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { onboardingEmailContext, PENDING_OWNER_TTL_MS, submitOnboardingEmail } from './onboarding-email';
import { accountAuthState, deliveredMagicLinks, seedPendingInstall, type PendingInstallSeed } from './testing';

const getDb = setUpTestDb();
let rig: JobTestRig;

const INSTALLER = 'installer@brightside-plumbing.example';
const OWNER = 'owner@brightside-plumbing.example';

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  for (const method of ['info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function submit(install: PendingInstallSeed | null, email: unknown, ip = '203.0.113.10') {
  return submitOnboardingEmail(rig.deps, { pendingCookie: install?.cookie.value, email, ip });
}

async function intents() {
  return getDb().query<{ purpose: string; account_id: string | null; next: string }>(`select purpose, account_id, next from login_intents order by created_at`);
}

describe('the onboarding email step', () => {
  it('stores the pending owner for 24 h, creates the auth user and emails an onboarding link', async () => {
    const install = await seedPendingInstall(rig.deps, { installerEmail: INSTALLER });
    await expect(submit(install, ' Owner@Brightside-Plumbing.example ')).resolves.toEqual({ type: 'sent' });
    const user = await rig.fakes.auth.findUserByEmail(OWNER);
    expect(user).not.toBeNull();
    expect(await accountAuthState(getDb(), install.accountId)).toMatchObject({
      owner_user_id: null,
      pending_owner_email: OWNER,
      pending_owner_expires_at: new Date(rig.clock.now().getTime() + PENDING_OWNER_TTL_MS),
      pending_owner_auth_user_id: user?.userId,
    });
    const links = deliveredMagicLinks(rig.fakes);
    expect(links.map((link) => link.to)).toEqual([[OWNER]]);
    expect(links[0]?.subject).toContain('Confirm your email');
    expect(await intents()).toEqual([{ purpose: 'onboarding', account_id: install.accountId, next: '/onboarding/brief' }]);
  });

  it('reuses an existing auth user for the same email, but never records it as this install\'s own', async () => {
    const { userId } = await rig.fakes.auth.createUser(OWNER);
    const install = await seedPendingInstall(rig.deps);
    await submit(install, OWNER);
    // The user existed before: the account does not list it, so replacing the address never deletes it.
    expect((await accountAuthState(getDb(), install.accountId)).pending_owner_auth_user_id).toBeNull();
    expect(rig.fakes.auth.users()).toHaveLength(1);
    await submit(install, 'other@example.com', '198.51.100.40');
    expect(await rig.fakes.auth.findUserByEmail(OWNER)).toMatchObject({ userId });
    expect(deliveredMagicLinks(rig.fakes)).toHaveLength(2);
  });

  it('keeps the user it created when the same address is submitted again', async () => {
    const install = await seedPendingInstall(rig.deps);
    await submit(install, OWNER);
    const created = await rig.fakes.auth.findUserByEmail(OWNER);
    await submit(install, OWNER, '198.51.100.41');
    expect((await accountAuthState(getDb(), install.accountId)).pending_owner_auth_user_id).toBe(created?.userId);
    // ...so a later replacement still cleans it up.
    await submit(install, 'second@example.com', '198.51.100.42');
    expect(await rig.fakes.auth.findUserByEmail(OWNER)).toBeNull();
  });

  it('never deletes an admin\'s auth user, even one the flow created, when the installer moves on to another address', async () => {
    const admin = rig.deps.env.ADMIN_EMAILS[0];
    if (admin === undefined) throw new Error('fake env has no ADMIN_EMAILS');
    // (1) The admin has signed in before: the flow reuses the user and never lists it.
    await rig.fakes.auth.createUser(admin);
    const before = await rig.fakes.auth.findUserByEmail(admin);
    const install = await seedPendingInstall(rig.deps);
    await expect(submit(install, admin, '198.51.100.43')).resolves.toEqual({ type: 'sent' });
    await expect(submit(install, 'someone@example.com', '198.51.100.44')).resolves.toEqual({ type: 'sent' });
    expect(await rig.fakes.auth.findUserByEmail(admin)).toEqual(before);

    // (2) The admin's user did not exist yet: the flow created and listed it, and still never deletes it.
    const user = await rig.fakes.auth.findUserByEmail(admin);
    if (user !== null) await rig.fakes.auth.deleteUser(user.userId);
    const second = await seedPendingInstall(rig.deps);
    await expect(submit(second, admin, '198.51.100.45')).resolves.toEqual({ type: 'sent' });
    const created = await rig.fakes.auth.findUserByEmail(admin);
    expect((await accountAuthState(getDb(), second.accountId)).pending_owner_auth_user_id).toBe(created?.userId);
    await expect(submit(second, 'someone-else@example.com', '198.51.100.46')).resolves.toEqual({ type: 'sent' });
    expect(await rig.fakes.auth.findUserByEmail(admin)).toEqual(created);
  });

  it('names the HubSpot account it sets up in the email', async () => {
    const install = await seedPendingInstall(rig.deps);
    await getDb().query(`update hubspot_connections set hub_domain = 'brightside-plumbing.example' where account_id = $1`, [install.accountId]);
    const portal = await getDb().one<{ hubspot_portal_id: string }>(`select hubspot_portal_id from accounts where id = $1`, [install.accountId]);
    await submit(install, OWNER);
    const [link] = deliveredMagicLinks(rig.fakes);
    expect(link?.text).toContain(`for the HubSpot account brightside-plumbing.example (ID ${portal.hubspot_portal_id})`);
    expect(link?.text).toContain('Not your HubSpot account?');

    // A domain that is not a plain host name is left out; the ID is always there.
    const other = await seedPendingInstall(rig.deps);
    await getDb().query(`update hubspot_connections set hub_domain = 'your bank <b>' where account_id = $1`, [other.accountId]);
    const otherPortal = await getDb().one<{ hubspot_portal_id: string }>(`select hubspot_portal_id from accounts where id = $1`, [other.accountId]);
    await submit(other, 'second@example.com', '198.51.100.47');
    const last = deliveredMagicLinks(rig.fakes).at(-1);
    expect(last?.text).toContain(`for the HubSpot account with ID ${otherPortal.hubspot_portal_id}.`);
    expect(last?.text).not.toContain('your bank');
  });

  it('without a valid pending_install cookie, does nothing and says to start from Install', async () => {
    await expect(submit(null, OWNER)).resolves.toEqual({ type: 'no_install' });
    const install = await seedPendingInstall(rig.deps);
    const forged = { ...install, cookie: { ...install.cookie, value: `${install.cookie.value.slice(0, -2)}xx` } };
    await expect(submit(forged, OWNER)).resolves.toEqual({ type: 'no_install' });
    rig.clock.advance({ hours: 24 });
    await expect(submit(install, OWNER)).resolves.toEqual({ type: 'no_install' });
    expect(rig.fakes.mailer.sent).toEqual([]);
  });

  it('a newer reinstall invalidates an older cookie', async () => {
    const install = await seedPendingInstall(rig.deps);
    rig.clock.advance({ minutes: 5 });
    await getDb().query(`update accounts set last_install_at = $2 where id = $1`, [install.accountId, rig.clock.now()]);
    await expect(submit(install, OWNER)).resolves.toEqual({ type: 'superseded' });
    expect(await accountAuthState(getDb(), install.accountId)).toMatchObject({ pending_owner_email: null });
    expect(await onboardingEmailContext(rig.deps, install.cookie.value)).toEqual({ type: 'superseded' });
    // The newest cookie works.
    const newest = issuePendingInstallCookie(rig.deps.env, { accountId: install.accountId, installerEmail: INSTALLER, installedAt: rig.clock.now() }, rig.clock.now());
    await expect(submitOnboardingEmail(rig.deps, { pendingCookie: newest.value, email: OWNER, ip: '203.0.113.11' })).resolves.toEqual({ type: 'sent' });
  });

  it('refuses an email that already owns an account', async () => {
    const other = await seedPendingInstall(rig.deps);
    await seedOwner(getDb(), other.accountId, OWNER);
    const install = await seedPendingInstall(rig.deps);
    await expect(submit(install, OWNER.toUpperCase())).resolves.toEqual({ type: 'already_owner' });
    expect(await accountAuthState(getDb(), install.accountId)).toMatchObject({ pending_owner_email: null });
    expect(rig.fakes.mailer.sent).toEqual([]);
  });

  it('refuses when the account already has its owner', async () => {
    const install = await seedPendingInstall(rig.deps);
    await seedOwner(getDb(), install.accountId, 'someone@example.com');
    await expect(submit(install, OWNER)).resolves.toEqual({ type: 'already_set_up' });
    expect(await onboardingEmailContext(rig.deps, install.cookie.value)).toEqual({ type: 'already_set_up' });
  });

  it('rejects a malformed address', async () => {
    const install = await seedPendingInstall(rig.deps);
    await expect(submit(install, 'owner at example')).resolves.toEqual({ type: 'invalid_email' });
  });

  it('with a different email, deletes the previous auth user when nothing else refers to it', async () => {
    const install = await seedPendingInstall(rig.deps);
    await submit(install, 'first@example.com');
    const first = await rig.fakes.auth.findUserByEmail('first@example.com');
    await submit(install, OWNER);
    expect(await rig.fakes.auth.findUserByEmail('first@example.com')).toBeNull();
    const owner = await rig.fakes.auth.findUserByEmail(OWNER);
    expect(await accountAuthState(getDb(), install.accountId)).toMatchObject({ pending_owner_email: OWNER, pending_owner_auth_user_id: owner?.userId });
    expect(first).not.toBeNull();
  });

  it('keeps the previous auth user when another account is still pending on it, or it owns an account', async () => {
    const other = await seedPendingInstall(rig.deps);
    await submit(other, 'shared@example.com', '198.51.100.1');
    const shared = await rig.fakes.auth.findUserByEmail('shared@example.com');
    const install = await seedPendingInstall(rig.deps);
    await submit(install, 'shared@example.com', '198.51.100.2');
    await submit(install, OWNER, '198.51.100.3');
    expect(await rig.fakes.auth.findUserByEmail('shared@example.com')).toEqual(shared);

    // An auth user that owns an account is never deleted either.
    const third = await seedPendingInstall(rig.deps);
    await submit(third, 'bound@example.com', '198.51.100.4');
    const bound = await rig.fakes.auth.findUserByEmail('bound@example.com');
    const owned = await seedPendingInstall(rig.deps);
    await getDb().query(`insert into users (auth_user_id, account_id, email) values ($1, $2, 'bound-elsewhere@example.com')`, [bound?.userId, owned.accountId]);
    await submit(third, 'next@example.com', '198.51.100.5');
    expect(await rig.fakes.auth.findUserByEmail('bound@example.com')).toEqual(bound);
  });

  it('allows at most 3 distinct emails per pending install; an accepted one can be sent again', async () => {
    const install = await seedPendingInstall(rig.deps);
    const ips = ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '192.0.2.5', '192.0.2.6'];
    await expect(submit(install, 'a@example.com', ips[0])).resolves.toEqual({ type: 'sent' });
    await expect(submit(install, 'b@example.com', ips[1])).resolves.toEqual({ type: 'sent' });
    await expect(submit(install, 'c@example.com', ips[2])).resolves.toEqual({ type: 'sent' });
    await expect(submit(install, 'd@example.com', ips[3])).resolves.toEqual({ type: 'too_many_emails' });
    await expect(submit(install, 'd@example.com', ips[4])).resolves.toEqual({ type: 'too_many_emails' });
    await expect(submit(install, 'a@example.com', ips[5])).resolves.toEqual({ type: 'sent' });
    expect((await accountAuthState(getDb(), install.accountId)).pending_owner_email).toBe('a@example.com');
  });

  it('charges owner probes to the same 3 slots: a 4th new address gets too_many_emails, not already_owner', async () => {
    const owners = ['own1@example.com', 'own2@example.com', 'own3@example.com', 'own4@example.com'];
    for (const email of owners) {
      const owned = await seedPendingInstall(rig.deps);
      const { userId } = await rig.fakes.auth.createUser(email);
      await seedOwner(getDb(), owned.accountId, email, userId);
    }
    const install = await seedPendingInstall(rig.deps);
    const ips = ['192.0.2.31', '192.0.2.32', '192.0.2.33', '192.0.2.34'];
    await expect(submit(install, owners[0], ips[0])).resolves.toEqual({ type: 'already_owner' });
    await expect(submit(install, owners[1], ips[1])).resolves.toEqual({ type: 'already_owner' });
    await expect(submit(install, owners[2], ips[2])).resolves.toEqual({ type: 'already_owner' });
    // The 4th address reveals nothing: whether it owns an account is never checked.
    await expect(submit(install, owners[3], ips[3])).resolves.toEqual({ type: 'too_many_emails' });
    await expect(submit(install, 'fresh@example.com', '192.0.2.35')).resolves.toEqual({ type: 'too_many_emails' });
    expect(deliveredMagicLinks(rig.fakes)).toHaveLength(0);
  });

  it('rate-limits 5 per 15 min per IP and 3 per 15 min per email', async () => {
    const install = await seedPendingInstall(rig.deps);
    for (let i = 0; i < 3; i += 1) await expect(submit(install, OWNER, `192.0.2.${10 + i}`)).resolves.toEqual({ type: 'sent' });
    await expect(submit(install, OWNER, '192.0.2.20')).resolves.toEqual({ type: 'rate_limited' });

    const other = await seedPendingInstall(rig.deps);
    for (let i = 0; i < 5; i += 1) await submit(other, `x${i}@example.com`, '192.0.2.99');
    await expect(submit(other, 'x0@example.com', '192.0.2.99')).resolves.toEqual({ type: 'rate_limited' });
    rig.clock.advance({ minutes: 15 });
    await expect(submit(install, OWNER, '192.0.2.20')).resolves.toEqual({ type: 'sent' });
  });

  it('pre-fills the installer email, then the pending email once a link went out', async () => {
    const install = await seedPendingInstall(rig.deps, { installerEmail: INSTALLER });
    expect(await onboardingEmailContext(rig.deps, install.cookie.value)).toEqual({ type: 'ready', email: INSTALLER, linkSent: false });
    await submit(install, OWNER);
    expect(await onboardingEmailContext(rig.deps, install.cookie.value)).toEqual({ type: 'ready', email: OWNER, linkSent: true });
    expect(await onboardingEmailContext(rig.deps, undefined)).toEqual({ type: 'no_install' });
  });
});
