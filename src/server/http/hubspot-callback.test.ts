import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CookieJar } from '@/server/security/cookies';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { REQUIRED_SCOPES } from '@/server/hubspot/scopes';
import { mintActionTokens, verifyActionToken } from '@/server/security/action-tokens';
import { seedOwner, seedSelectedForm } from '@/server/services/accounts/testing';
import { revokeConnection } from '@/server/services/hubspot/revoke';
import { decryptAccessToken } from '@/server/services/hubspot/tokens';
import type { ReconnectMagicLinkInput } from '@/server/services/install/reconnect-magic-link';
import { PENDING_INSTALL_COOKIE_NAME, readPendingInstall, STATE_COOKIE_NAME } from '@/server/services/install/cookies';
import { TRIAL_MS } from '@/server/services/install/callback';
import { useTestDb as setUpTestDb } from '../../../test/db/harness';
import { handleHubSpotCallback } from './hubspot-callback';
import { handleHubSpotInstall } from './hubspot-install';

const getDb = setUpTestDb();
const DAY = 86_400_000;
const PORTAL = '1234567';
const INSTALLER = 'owner@brightside-plumbing.example';

let rig: JobTestRig;
let magicLinks: ReconnectMagicLinkInput[];
let alerts: RaisedAlert[];
let stopAlerts: () => void;
let logged: string[];

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  magicLinks = [];
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
  logged = [];
  for (const method of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  stopAlerts();
  vi.restoreAllMocks();
});

const url = (path: string): string => `${rig.deps.env.APP_URL}${path}`;

/** The install route: returns HubSpot's `state` and redirect URI, keeping the state cookie in the jar. */
async function beginInstall(jar: CookieJar): Promise<{ state: string; redirectUri: string }> {
  const res = await handleHubSpotInstall(jar.request(url('/api/hubspot/install'), { headers: { 'x-real-ip': '203.0.113.7' } }), rig.deps);
  jar.storeFrom(res);
  const location = new URL(res.headers.get('location') ?? '');
  return { state: location.searchParams.get('state') ?? '', redirectUri: location.searchParams.get('redirect_uri') ?? '' };
}

async function callback(jar: CookieJar, params: Record<string, string>): Promise<Response> {
  const query = new URLSearchParams(params).toString();
  const res = await handleHubSpotCallback(jar.request(url(`/api/hubspot/oauth/callback?${query}`)), rig.deps, {
    sendReconnectMagicLink: async (_deps, input) => {
      magicLinks.push(input);
      return true;
    },
  });
  jar.storeFrom(res);
  return res;
}

/** The whole round trip: install → fake consent ("Approve") → callback. */
async function install(jar: CookieJar = new CookieJar()): Promise<{ res: Response; code: string }> {
  const { state, redirectUri } = await beginInstall(jar);
  const code = rig.fakes.hubspot.createAuthCode({ redirectUri });
  return { res: await callback(jar, { code, state }), code };
}

function locationOf(res: Response): string {
  expect(res.status).toBe(303);
  return res.headers.get('location') ?? '';
}

async function accounts() {
  return getDb().query<{
    id: string;
    processing_state: string;
    trial_started_at: Date;
    trial_ends_at: Date;
    last_install_at: Date;
    created_at: Date;
    timezone: string | null;
    timezone_source: string | null;
    owner_user_id: string | null;
    pending_owner_email: string | null;
    pending_owner_expires_at: Date | null;
    pending_owner_auth_user_id: string | null;
    purge_after: Date | null;
    disconnected_at: Date | null;
  }>(`select * from accounts`);
}

async function connectionOf(accountId: string) {
  return getDb().one<{
    id: string;
    portal_id: string;
    status: string;
    status_reason: string | null;
    token_version: number;
    access_token_enc: string;
    refresh_token_enc: string;
    access_expires_at: Date;
    scopes: string[];
    hub_domain: string | null;
    ui_domain: string | null;
    data_hosting_location: string | null;
    account_type: string | null;
    reconnect_email_sent_at: Date | null;
  }>(`select * from hubspot_connections where account_id = $1`, [accountId]);
}

describe('callback branch (a): a new portal', () => {
  it('creates the account, connection, settings and portal history, then sends the installer to /onboarding/email', async () => {
    const now = rig.clock.now();
    const { res, code } = await install();
    expect(locationOf(res)).toBe(url('/onboarding/email'));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');

    const [account, ...others] = await accounts();
    expect(others).toHaveLength(0);
    expect(account).toMatchObject({
      processing_state: 'onboarding',
      trial_started_at: now,
      trial_ends_at: new Date(now.getTime() + 14 * DAY),
      last_install_at: now,
      created_at: now,
      timezone: 'America/New_York',
      timezone_source: 'hubspot',
      owner_user_id: null,
    });
    const accountId = account?.id ?? '';

    const connection = await connectionOf(accountId);
    expect(connection).toMatchObject({
      portal_id: PORTAL,
      status: 'active',
      token_version: 1,
      scopes: [...REQUIRED_SCOPES],
      hub_domain: 'brightside-plumbing.example',
      ui_domain: 'app.hubspot.com',
      data_hosting_location: 'na1',
      account_type: 'STANDARD',
    });
    expect(connection.access_expires_at).toEqual(new Date(now.getTime() + 1800 * 1000));
    const accessToken = decryptAccessToken(rig.deps.env, connection.id, connection.access_token_enc);
    expect(await rig.fakes.hubspot.accountDetails(accessToken)).toMatchObject({ portalId: PORTAL });
    expect(connection.access_token_enc).not.toContain(accessToken);

    const settings = await getDb().one(`select quiet_start_hour, quiet_end_hour, skip_weekends, followups_enabled from settings where account_id = $1`, [accountId]);
    expect(settings).toEqual({ quiet_start_hour: 19, quiet_end_hour: 8, skip_weekends: true, followups_enabled: true });
    expect(await getDb().query(`select * from portal_history`)).toEqual([{ hubspot_portal_id: PORTAL, first_trial_started_at: now }]);

    // The signed pending_install cookie (24 h) carries the account and the installer's email; the state cookie is spent.
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith(`${STATE_COOKIE_NAME}=;`) && c.includes('Max-Age=0'))).toBe(true);
    expect(setCookies.find((c) => c.startsWith(`${PENDING_INSTALL_COOKIE_NAME}=`))).toMatch(/; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax$/);
    expect(readPendingInstall(rig.deps.env, res.headers.getSetCookie().find((c) => c.startsWith(PENDING_INSTALL_COOKIE_NAME))?.split(';')[0]?.split('=')[1], now)).toEqual({
      accountId,
      installerEmail: INSTALLER,
      installedAt: now,
    });
    rig.clock.advance({ hours: 24 });
    const jarValue = setCookies.find((c) => c.startsWith(PENDING_INSTALL_COOKIE_NAME))?.split(';')[0]?.split('=')[1];
    expect(readPendingInstall(rig.deps.env, jarValue, rig.clock.now())).toBeNull();

    // Law 4: neither the code nor the installer's email is logged.
    expect(logged.join('\n')).not.toContain(code);
    expect(logged.join('\n')).not.toContain(INSTALLER);
  });

  it('keeps the first trial of a portal that was purged and reinstalled', async () => {
    const firstTrial = new Date(rig.clock.now().getTime() - 10 * DAY);
    await getDb().query(`insert into portal_history (hubspot_portal_id, first_trial_started_at) values ($1, $2)`, [PORTAL, firstTrial]);
    await install();
    const [account] = await accounts();
    expect(account).toMatchObject({ trial_started_at: firstTrial, trial_ends_at: new Date(firstTrial.getTime() + TRIAL_MS) });
    expect((await getDb().one<{ first_trial_started_at: Date }>(`select first_trial_started_at from portal_history`)).first_trial_started_at).toEqual(firstTrial);
  });

  it('leaves the timezone for the owner when HubSpot account details fail', async () => {
    rig.fakes.hubspot.injectFailure('accountDetails', { kind: 'server_error' });
    const { res } = await install();
    expect(locationOf(res)).toBe(url('/onboarding/email'));
    const [account] = await accounts();
    expect(account).toMatchObject({ timezone: null, timezone_source: null });
    expect((await connectionOf(account?.id ?? '')).ui_domain).toBeNull();
  });
});

describe('callback branch (b): an existing portal nobody has bound', () => {
  it('stores fresh tokens, restarts the orphan clock, resets the pending owner email and issues a new pending_install', async () => {
    const firstAt = rig.clock.now();
    await install();
    const [first] = await accounts();
    const accountId = first?.id ?? '';
    const pendingAuthUser = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
    await getDb().query(`update accounts set pending_owner_email = 'someone@example.com', pending_owner_expires_at = $2, pending_owner_auth_user_id = $3 where id = $1`, [
      accountId,
      new Date(firstAt.getTime() + DAY),
      pendingAuthUser,
    ]);
    const before = await connectionOf(accountId);

    rig.clock.advance({ days: 6 });
    const jar = new CookieJar();
    const { res } = await install(jar);
    expect(locationOf(res)).toBe(url('/onboarding/email'));
    expect(readPendingInstall(rig.deps.env, jar.get(PENDING_INSTALL_COOKIE_NAME), rig.clock.now())).toEqual({
      accountId,
      installerEmail: INSTALLER,
      installedAt: rig.clock.now(),
    });

    const rows = await accounts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: accountId,
      last_install_at: rig.clock.now(),
      pending_owner_email: null,
      pending_owner_expires_at: null,
      pending_owner_auth_user_id: pendingAuthUser,
      trial_started_at: firstAt,
      trial_ends_at: new Date(firstAt.getTime() + TRIAL_MS),
      created_at: firstAt,
    });
    const after = await connectionOf(accountId);
    expect(after.id).toBe(before.id);
    expect(after.token_version).toBe(2);
    expect(after.access_token_enc).not.toBe(before.access_token_enc);
    expect(after.status).toBe('active');
  });
});

describe('callback branch (b): only the newest install’s pending_install matches the account', () => {
  it('an earlier installer’s cookie carries an install instant the reinstall moved on from (M3 guards on it)', async () => {
    const jarA = new CookieJar();
    await install(jarA);
    rig.clock.advance({ hours: 2 });
    const jarB = new CookieJar();
    await install(jarB);
    const [account] = await accounts();
    const now = rig.clock.now();
    const a = readPendingInstall(rig.deps.env, jarA.get(PENDING_INSTALL_COOKIE_NAME), now);
    const b = readPendingInstall(rig.deps.env, jarB.get(PENDING_INSTALL_COOKIE_NAME), now);
    // Both are still within 24 h and name the same account…
    expect(a?.accountId).toBe(account?.id);
    expect(b?.accountId).toBe(account?.id);
    // …but only B's install instant is the account's last_install_at.
    expect(b?.installedAt).toEqual(account?.last_install_at);
    expect(a?.installedAt).not.toEqual(account?.last_install_at);
  });
});

describe('callback branch (b) after a revoke', () => {
  it('clears the stale purge date, so the reinstalled account is not refused as pending purge', async () => {
    await install();
    const [first] = await accounts();
    const accountId = first?.id ?? '';
    const connection = await connectionOf(accountId);
    expect(
      await revokeConnection(rig.deps, { accountId, connectionId: connection.id, tokenVersion: connection.token_version, reason: 'refresh_revoked' }),
    ).toBe('revoked');
    const [revoked] = await accounts();
    expect(revoked?.processing_state).toBe('revoked');
    expect(revoked?.purge_after).not.toBeNull();

    rig.clock.advance({ days: 2 });
    const { res } = await install(new CookieJar());
    expect(locationOf(res)).toBe(url('/onboarding/email'));
    const [after] = await accounts();
    expect(after).toMatchObject({ id: accountId, processing_state: 'onboarding', purge_after: null, disconnected_at: null });
    expect((await connectionOf(accountId)).status).toBe('active');

    // Action tokens (M3's onboarding buttons) are accepted again: verify refuses them while purge_after is set.
    const minted = await mintActionTokens(getDb(), { accountId, notificationKey: `inbox-test:${accountId}`, purposes: ['send'], now: rig.clock.now() });
    const verified = await verifyActionToken(getDb(), minted.send ?? '', 'send', rig.clock.now());
    expect(verified.ok).toBe(true);
  });
});

describe('callback branch (c): the owner reconnects with a verified session', () => {
  it('reactivates the connection, clears the purge and reconnect fields and moves the floors', async () => {
    const db = getDb();
    await install();
    const [account] = await accounts();
    const accountId = account?.id ?? '';
    const { userId } = await rig.fakes.auth.createUser(INSTALLER);
    await seedOwner(db, accountId, INSTALLER, userId);
    await seedSelectedForm(db, { accountId, formId: 'form-a', floor: rig.clock.now() });
    await db.query(`update accounts set onboarding_completed_at = $2, processing_state = 'revoked', purge_after = $3 where id = $1`, [
      accountId,
      rig.clock.now(),
      new Date(rig.clock.now().getTime() + 30 * DAY),
    ]);
    await db.query(
      `update hubspot_connections set status = 'revoked', status_reason = 'refresh_revoked', access_token_enc = null, refresh_token_enc = null,
              reconnect_email_sent_at = $2 where account_id = $1`,
      [accountId, rig.clock.now()],
    );

    rig.clock.advance({ days: 3 });
    const jar = new CookieJar();
    jar.set([rig.fakes.auth.issueSession(userId)]);
    const { res } = await install(jar);
    expect(locationOf(res)).toBe(url('/dashboard?reconnected=1'));
    expect(res.headers.getSetCookie().some((c) => c.startsWith(PENDING_INSTALL_COOKIE_NAME))).toBe(false);

    const [after] = await accounts();
    expect(after).toMatchObject({ processing_state: 'active', purge_after: null, disconnected_at: null });
    const connection = await connectionOf(accountId);
    expect(connection).toMatchObject({ status: 'active', status_reason: null, reconnect_email_sent_at: null, token_version: 2 });
    const form = await db.one<{ intake_floor_at: Date }>(`select intake_floor_at from selected_forms where account_id = $1`, [accountId]);
    expect(form.intake_floor_at).toEqual(rig.clock.now());
    expect(magicLinks).toHaveLength(0);
    expect(rig.fakes.mailer.sent).toHaveLength(0);
  });
});

describe('callback branch (d): an owned portal without the owner’s session', () => {
  async function ownedPortal(ownerEmail: string): Promise<{ accountId: string; before: Awaited<ReturnType<typeof connectionOf>> }> {
    await install();
    const [account] = await accounts();
    const accountId = account?.id ?? '';
    await seedOwner(getDb(), accountId, ownerEmail);
    return { accountId, before: await connectionOf(accountId) };
  }

  it('the owner as installer is asked to sign in (magic link hook), with no alert and nothing changed', async () => {
    const { accountId, before } = await ownedPortal(INSTALLER);
    const accountBefore = (await accounts())[0];
    rig.clock.advance({ hours: 2 });
    const { res } = await install();
    expect(locationOf(res)).toBe(url('/install/sign-in-to-reconnect?sent=1'));
    expect(magicLinks).toEqual([{ accountId }]);
    expect(rig.fakes.mailer.sent).toHaveLength(0);
    expect(alerts).toHaveLength(0);
    expect(await connectionOf(accountId)).toEqual(before);
    expect((await accounts())[0]).toEqual(accountBefore);
  });

  it('another installer sees "connected elsewhere" and the owner gets one alert a day; nothing changes', async () => {
    const { accountId, before } = await ownedPortal('real.owner@example.com');
    const accountBefore = (await accounts())[0];
    rig.clock.advance({ hours: 2 });
    const { res } = await install();
    expect(locationOf(res)).toBe(url('/install/connected-elsewhere'));

    const alertsSent = rig.fakes.mailer.sent.filter((mail) => mail.kind === 'owner_alert');
    expect(alertsSent).toHaveLength(1);
    expect(alertsSent[0]?.to).toEqual(['real.owner@example.com']);
    expect(alertsSent[0]?.text).toContain(
      `Someone in your HubSpot account tried to connect ${rig.deps.env.PRODUCT_NAME}. Nothing changed. If this was you, sign in and tap Reconnect.`,
    );
    expect(alertsSent[0]?.idempotencyKey).toBe(`${rig.deps.env.ENV_NAMESPACE}:alert:${accountId}:reconnect_attempt:2026-10-06`);
    expect(await connectionOf(accountId)).toEqual(before);
    expect((await accounts())[0]).toEqual(accountBefore);
    expect(magicLinks).toHaveLength(0);

    rig.clock.advance({ hours: 1 });
    expect(locationOf((await install()).res)).toBe(url('/install/connected-elsewhere'));
    expect(rig.fakes.mailer.sent.filter((mail) => mail.kind === 'owner_alert')).toHaveLength(1);
  });

  it('a session of someone other than the owner does not reconnect', async () => {
    const { accountId, before } = await ownedPortal('real.owner@example.com');
    const { userId } = await rig.fakes.auth.createUser('intruder@example.com');
    const jar = new CookieJar();
    jar.set([rig.fakes.auth.issueSession(userId)]);
    const { res } = await install(jar);
    expect(locationOf(res)).toBe(url('/install/connected-elsewhere'));
    expect(await connectionOf(accountId)).toEqual(before);
  });
});

describe('callback failures', () => {
  async function expectNothingCreated(): Promise<void> {
    expect(await getDb().query(`select id from accounts`)).toHaveLength(0);
    expect(await getDb().query(`select 1 from portal_history`)).toHaveLength(0);
  }

  it('a state that does not match the cookie fails without exchanging the code', async () => {
    const jar = new CookieJar();
    const { redirectUri } = await beginInstall(jar);
    const code = rig.fakes.hubspot.createAuthCode({ redirectUri });
    const exchange = vi.spyOn(rig.fakes.hubspot, 'exchangeCode');
    const res = await callback(jar, { code, state: 'A'.repeat(43) });
    expect(locationOf(res)).toBe(url('/install/failed?reason=state'));
    expect(exchange).not.toHaveBeenCalled();
    await expectNothingCreated();
  });

  it('a missing state cookie (another browser) fails', async () => {
    const { state, redirectUri } = await beginInstall(new CookieJar());
    const code = rig.fakes.hubspot.createAuthCode({ redirectUri });
    expect(locationOf(await callback(new CookieJar(), { code, state }))).toBe(url('/install/failed?reason=state'));
    await expectNothingCreated();
  });

  it('an expired state cookie fails', async () => {
    const jar = new CookieJar();
    const { state, redirectUri } = await beginInstall(jar);
    rig.clock.advance({ minutes: 10, seconds: 1 });
    const code = rig.fakes.hubspot.createAuthCode({ redirectUri });
    expect(locationOf(await callback(jar, { code, state }))).toBe(url('/install/failed?reason=state'));
  });

  it('missing scopes fail the install and store nothing', async () => {
    // `forms` is required on both D-03 paths (sales-email-read is not on path b: email-scope-path-b.test.ts).
    rig.fakes.hubspot.setGrantedScopes(REQUIRED_SCOPES.filter((scope) => scope !== 'forms'));
    const { res } = await install();
    expect(locationOf(res)).toBe(url('/install/failed?reason=missing_scopes'));
    await expectNothingCreated();
    expect(await getDb().query(`select 1 from hubspot_connections`)).toHaveLength(0);
  });

  it('extra granted scopes are alerted and not stored; the install still completes read-only (law 2)', async () => {
    rig.fakes.hubspot.setGrantedScopes([...REQUIRED_SCOPES, 'crm.objects.contacts.write']);
    const { res } = await install();
    expect(locationOf(res)).toBe(url('/onboarding/email'));
    const [account] = await accounts();
    expect((await connectionOf(account?.id ?? '')).scopes).toEqual([...REQUIRED_SCOPES]);
    expect(alerts.map((alert) => alert.code)).toEqual(['hubspot_install_extra_scopes']);
    expect(alerts[0]?.fields).toMatchObject({ count: 1, portalId: PORTAL });
  });

  it('a cancelled consent fails as denied', async () => {
    const jar = new CookieJar();
    const { state } = await beginInstall(jar);
    expect(locationOf(await callback(jar, { error: 'access_denied', state }))).toBe(url('/install/failed?reason=denied'));
    await expectNothingCreated();
  });

  it('a reused code fails as bad_code, without an alert', async () => {
    const jar = new CookieJar();
    const { state, redirectUri } = await beginInstall(jar);
    const code = rig.fakes.hubspot.createAuthCode({ redirectUri });
    await rig.fakes.hubspot.exchangeCode(code, redirectUri);
    expect(locationOf(await callback(jar, { code, state }))).toBe(url('/install/failed?reason=bad_code'));
    expect(alerts).toHaveLength(0);
    await expectNothingCreated();
  });

  it('an OAuth client misconfiguration fails as config and alerts the admin with the underlying code', async () => {
    rig.fakes.hubspot.setRefreshMode('config');
    const { res } = await install();
    expect(locationOf(res)).toBe(url('/install/failed?reason=config'));
    expect(alerts.map((alert) => alert.code)).toEqual(['hubspot_install_oauth_config']);
    expect(alerts[0]?.fields).toMatchObject({ errorCode: 'hubspot_oauth_config' });
  });

  it('spends the state once: a replayed cookie and state never reach HubSpot’s token endpoint again', async () => {
    const jar = new CookieJar();
    const { state } = await beginInstall(jar);
    const cookie = jar.header() ?? '';
    const exchange = vi.spyOn(rig.fakes.hubspot, 'exchangeCode');
    const replay = (code: string) =>
      handleHubSpotCallback(new Request(url(`/api/hubspot/oauth/callback?code=${code}&state=${state}`), { headers: { cookie } }), rig.deps);
    expect(locationOf(await replay('junk-code-1'))).toBe(url('/install/failed?reason=bad_code'));
    for (const code of ['junk-code-2', 'junk-code-3']) expect(locationOf(await replay(code))).toBe(url('/install/failed?reason=state'));
    expect(exchange).toHaveBeenCalledTimes(1);
    // The marker holds only an HMAC of the nonce.
    const rows = await getDb().query<{ key_hash: string }>(`select key_hash from rate_limits`);
    expect(rows.some((row) => row.key_hash.includes(state))).toBe(false);
  });

  it('allows 20 callbacks a minute per IP, then answers 429 with Retry-After without exchanging anything', async () => {
    rig.clock.set(new Date('2026-10-06T14:00:15.000Z'));
    const exchange = vi.spyOn(rig.fakes.hubspot, 'exchangeCode');
    const hit = (ip: string) =>
      handleHubSpotCallback(new Request(url('/api/hubspot/oauth/callback?code=x&state=y'), { headers: { 'x-real-ip': ip } }), rig.deps);
    for (let i = 0; i < 20; i += 1) expect(locationOf(await hit('203.0.113.9'))).toBe(url('/install/failed?reason=state'));
    const limited = await hit('203.0.113.9');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('45');
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(locationOf(await hit('198.51.100.9'))).toBe(url('/install/failed?reason=state'));
    expect(exchange).not.toHaveBeenCalled();
  });
});
