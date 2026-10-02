import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import portalJson from '../../../../../test/fixtures/hubspot-portal.json';
import { ConfigError, PermanentError, RevokedError, TransientError, isAppError } from '@/server/domain/errors';
import type { EmailMetadataProperty, HubSpotContactProperty, RefreshFailureClass } from '@/server/domain/types';
import type { TokenSet } from '@/server/ports/hubspot';
import { FakeClock } from '../clock';
import { FakeHubSpot } from './fake-hubspot';
import { REFRESH_WIRE, wireResponseOf } from './wire';

const START = new Date('2026-10-06T14:00:00.000Z');
const CONTACT_US = 'b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01';
const QUOTE = 'b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f02';
const NEWSLETTER = 'b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f03';
const OWNER = 'owner@brightside-plumbing.example';
const REDIRECT = 'http://localhost:3000/api/hubspot/oauth/callback';
const SCOPES = ['oauth', 'crm.objects.contacts.read', 'forms', 'sales-email-read'];
const STOP_PROPS: HubSpotContactProperty[] = ['email', 'firstname', 'message', 'hs_email_optout', 'hs_additional_emails'];
const ALL_EMAIL_PROPS: EmailMetadataProperty[] = [
  'hs_timestamp',
  'hs_email_direction',
  'hs_email_status',
  'hs_email_from_email',
  'hs_email_to_email',
];

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function portalWith(changes: (portal: typeof portalJson) => void): unknown {
  const copy = structuredClone(portalJson);
  changes(copy);
  return copy;
}

let clock: FakeClock;
let hubspot: FakeHubSpot;
let tokens: TokenSet;
let token: string;

/** A fresh access token after the clock has moved past the 30-minute lifetime. */
async function refreshToken(): Promise<string> {
  tokens = await hubspot.refresh(tokens.refreshToken);
  token = tokens.accessToken;
  return token;
}

beforeEach(() => {
  // Everything below runs on fake time; a 2030 system time proves nothing reads the wall clock.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  clock = new FakeClock(START);
  hubspot = new FakeHubSpot({ clock });
  tokens = hubspot.installTokens();
  token = tokens.accessToken;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OAuth', () => {
  it('builds the fake consent URL with exactly the requested scopes', () => {
    const url = hubspot.authorizeUrl({ state: 'st/1+2', redirectUri: REDIRECT, scopes: SCOPES });
    expect(url).toBe(
      'http://localhost:3000/dev/fake-hubspot/authorize?client_id=fake-hubspot-client-id' +
        '&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fhubspot%2Foauth%2Fcallback' +
        '&scope=oauth%20crm.objects.contacts.read%20forms%20sales-email-read&state=st%2F1%2B2',
    );
  });

  it('exchanges a consent code once for tokens carrying the hub id and granted scopes', async () => {
    const fresh = new FakeHubSpot({ clock });
    expect(fresh.isInstalled()).toBe(false);
    const code = fresh.createAuthCode({ redirectUri: REDIRECT });
    const set = await fresh.exchangeCode(code, REDIRECT);
    expect(set).toMatchObject({ expiresInSeconds: 1800, hubId: '1234567', scopes: SCOPES });
    expect(set.refreshToken).toMatch(/^na1-/);
    expect(fresh.isInstalled()).toBe(true);
    expect(await fresh.accountDetails(set.accessToken)).toMatchObject({ portalId: '1234567' });

    const reused = await rejection(fresh.exchangeCode(code, REDIRECT));
    expect(reused).toBeInstanceOf(PermanentError);
    expect(reused).toMatchObject({ code: 'hubspot_bad_auth_code', httpStatus: 400 });
    expect(wireResponseOf(reused)?.body).toMatchObject({ error: 'invalid_grant', status: 'BAD_AUTH_CODE' });
  });

  it('rejects an expired code and a redirect URI that differs from the authorize request', async () => {
    const late = hubspot.createAuthCode({ redirectUri: REDIRECT });
    clock.advance({ minutes: 10 });
    expect(await rejection(hubspot.exchangeCode(late, REDIRECT))).toMatchObject({ code: 'hubspot_bad_auth_code' });

    const code = hubspot.createAuthCode({ redirectUri: REDIRECT });
    const mismatch = await rejection(hubspot.exchangeCode(code, 'https://elsewhere.example/callback'));
    expect(mismatch).toBeInstanceOf(ConfigError);
    expect(mismatch).toMatchObject({ code: 'hubspot_oauth_config', httpStatus: 400 });
    expect(wireResponseOf(mismatch)?.body).toMatchObject({ status: 'BAD_REDIRECT_URI' });
  });

  it('expires access tokens after 1800 s of fake time; a refresh gives a working one', async () => {
    clock.advance({ seconds: 1799 });
    await expect(hubspot.listForms(token)).resolves.toHaveLength(3);
    clock.advance({ seconds: 1 });
    const expired = await rejection(hubspot.listForms(token));
    expect(expired).toBeInstanceOf(PermanentError);
    expect(expired).toMatchObject({ code: 'hubspot_unauthorized', httpStatus: 401 });
    expect(wireResponseOf(expired)?.body).toMatchObject({ category: 'INVALID_AUTHENTICATION' });

    const previousRefresh = tokens.refreshToken;
    await refreshToken();
    expect(tokens.refreshToken).toBe(previousRefresh);
    await expect(hubspot.listForms(token)).resolves.toHaveLength(3);
  });

  it('introspects refresh and access tokens with the installer email, hub domain and scopes', async () => {
    const expected = {
      active: true,
      hubId: '1234567',
      hubDomain: 'brightside-plumbing.example',
      userEmail: OWNER,
      scopes: SCOPES,
      appId: '7100001',
    };
    expect(await hubspot.introspect(tokens.refreshToken, 'refresh_token')).toEqual({ ...expected, tokenType: 'refresh_token' });
    expect(await hubspot.introspect(token, 'access_token')).toEqual({ ...expected, tokenType: 'access_token' });
    expect(await hubspot.introspect('na1-unknown', 'refresh_token')).toEqual({ active: false });
  });

  it('revokes a refresh token without killing the access token already issued (no cascade)', async () => {
    await hubspot.revoke(tokens.refreshToken);
    expect(await hubspot.introspect(tokens.refreshToken, 'refresh_token')).toEqual({ active: false });
    expect(await rejection(hubspot.refresh(tokens.refreshToken))).toBeInstanceOf(RevokedError);
    await expect(hubspot.listForms(token)).resolves.toHaveLength(3);
    await expect(hubspot.revoke('na1-never-issued')).resolves.toBeUndefined();
  });

  it('revokeToken() makes every refresh fail as revoked and introspection inactive', async () => {
    hubspot.revokeToken();
    expect(await hubspot.introspect(tokens.refreshToken, 'refresh_token')).toEqual({ active: false });
    expect(await rejection(hubspot.refresh(tokens.refreshToken))).toMatchObject({ code: 'hubspot_refresh_revoked' });
  });

  it('uninstallApp removes the install: API calls 401, refresh revoked, introspection inactive; a reinstall works', async () => {
    await hubspot.uninstallApp(token);
    expect(hubspot.isInstalled()).toBe(false);
    expect(await rejection(hubspot.listForms(token))).toMatchObject({ code: 'hubspot_unauthorized' });
    expect(await rejection(hubspot.refresh(tokens.refreshToken))).toMatchObject({ code: 'hubspot_refresh_revoked' });
    expect(await hubspot.introspect(tokens.refreshToken, 'refresh_token')).toEqual({ active: false });

    const set = await hubspot.exchangeCode(hubspot.createAuthCode({ redirectUri: REDIRECT }), REDIRECT);
    expect(hubspot.isInstalled()).toBe(true);
    await expect(hubspot.listForms(set.accessToken)).resolves.toHaveLength(3);
  });
});

describe('call timeouts (AbortSignal)', () => {
  const aborted = (): { signal: AbortSignal } => {
    const controller = new AbortController();
    controller.abort();
    return { signal: controller.signal };
  };

  it('ends a refresh with an aborted signal as TransientError hubspot_timeout, consuming nothing', async () => {
    hubspot.setRefreshMode({ kind: 'transient', times: 1 });
    const error = await rejection(hubspot.refresh(tokens.refreshToken, aborted()));
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ code: 'hubspot_timeout' });
    expect((error as TransientError).httpStatus).toBeUndefined();
    // The injected transient failure is still queued: the aborted call never reached the "server".
    expect(await rejection(hubspot.refresh(tokens.refreshToken))).toMatchObject({ code: 'hubspot_server_error' });
    await expect(hubspot.refresh(tokens.refreshToken, { signal: new AbortController().signal })).resolves.toMatchObject({
      refreshToken: tokens.refreshToken,
    });
  });

  it('does not use up an authorization code when the exchange is aborted', async () => {
    const fresh = new FakeHubSpot({ clock });
    const code = fresh.createAuthCode({ redirectUri: REDIRECT });
    expect(await rejection(fresh.exchangeCode(code, REDIRECT, aborted()))).toMatchObject({ code: 'hubspot_timeout' });
    expect(fresh.isInstalled()).toBe(false);
    await expect(fresh.exchangeCode(code, REDIRECT)).resolves.toMatchObject({ hubId: '1234567' });
  });

  it('honours an aborted signal on every network method', async () => {
    const calls: [string, () => Promise<unknown>][] = [
      ['introspect', () => hubspot.introspect(token, 'access_token', aborted())],
      ['revoke', () => hubspot.revoke(tokens.refreshToken, aborted())],
      ['accountDetails', () => hubspot.accountDetails(token, aborted())],
      ['listForms', () => hubspot.listForms(token, aborted())],
      ['listSubmissions', () => hubspot.listSubmissions(token, QUOTE, { limit: 50, ...aborted() })],
      ['getContact', () => hubspot.getContact(token, OWNER, { idProperty: 'email', properties: ['email'], ...aborted() })],
      ['listContactEmailIds', () => hubspot.listContactEmailIds(token, '1', aborted())],
      ['batchReadEmails', () => hubspot.batchReadEmails(token, ['1'], ['hs_timestamp'], aborted())],
      ['searchEmailsCount', () => hubspot.searchEmailsCount(token, { direction: 'outbound', since: START }, aborted())],
      ['uninstallApp', () => hubspot.uninstallApp(token, aborted())],
    ];
    for (const [name, call] of calls) {
      expect(await rejection(call()), name).toMatchObject({ code: 'hubspot_timeout' });
    }
    // Nothing happened: the refresh token was not revoked and the app is still installed.
    expect(hubspot.isInstalled()).toBe(true);
    expect(await hubspot.introspect(tokens.refreshToken, 'refresh_token')).toMatchObject({ active: true });
  });
});

describe('refresh modes', () => {
  it('revoked: 400 invalid_grant / BAD_REFRESH_TOKEN, thrown as RevokedError', async () => {
    hubspot.setRefreshMode('revoked');
    const error = await rejection(hubspot.refresh(tokens.refreshToken));
    expect(error).toBeInstanceOf(RevokedError);
    expect(error).toMatchObject({ code: 'hubspot_refresh_revoked', httpStatus: 400, message: 'hubspot_refresh_revoked' });
    expect(wireResponseOf(error)).toEqual({
      status: 400,
      headers: {},
      body: {
        error: 'invalid_grant',
        error_description: 'refresh token is invalid, expired or revoked',
        status: 'BAD_REFRESH_TOKEN',
        message: 'refresh token is invalid, expired or revoked',
      },
    });
    // The refresh mode concerns the token endpoint only: the token still introspects as active.
    expect(await hubspot.introspect(tokens.refreshToken, 'refresh_token')).toMatchObject({ active: true });
  });

  it('revoked BAD_HUB variant carries access_denied', async () => {
    hubspot.setRefreshMode({ kind: 'revoked', variant: 'bad_hub' });
    const error = await rejection(hubspot.refresh(tokens.refreshToken));
    expect(error).toBeInstanceOf(RevokedError);
    expect(wireResponseOf(error)?.body).toEqual({ status: 'BAD_HUB', message: 'missing or unknown hub id', error: 'access_denied' });
  });

  it('transient×N fails N times with a 5xx gateway page, then succeeds', async () => {
    hubspot.setRefreshMode({ kind: 'transient', times: 2 });
    for (let i = 0; i < 2; i++) {
      const error = await rejection(hubspot.refresh(tokens.refreshToken));
      expect(error).toBeInstanceOf(TransientError);
      expect(error).toMatchObject({ code: 'hubspot_server_error', httpStatus: 502 });
      expect(typeof wireResponseOf(error)?.body).toBe('string');
    }
    await expect(hubspot.refresh(tokens.refreshToken)).resolves.toMatchObject({ refreshToken: tokens.refreshToken });
  });

  it('transient can be a 429 or a timeout', async () => {
    hubspot.setRefreshMode({ kind: 'transient', times: 1, failure: 429 });
    expect(await rejection(hubspot.refresh(tokens.refreshToken))).toMatchObject({ code: 'hubspot_rate_limited', httpStatus: 429 });
    hubspot.setRefreshMode({ kind: 'transient', times: 1, failure: 'timeout' });
    const timeout = await rejection(hubspot.refresh(tokens.refreshToken));
    expect(timeout).toMatchObject({ code: 'hubspot_timeout', httpStatus: undefined });
    expect(wireResponseOf(timeout)).toEqual({ status: null, headers: {}, body: null });
  });

  it('config: invalid_client fails refresh, code exchange, introspection and revocation as ConfigError', async () => {
    hubspot.setRefreshMode('config');
    const error = await rejection(hubspot.refresh(tokens.refreshToken));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ code: 'hubspot_oauth_config', httpStatus: 400 });
    expect(wireResponseOf(error)?.body).toMatchObject({ error: 'invalid_client', status: 'BAD_CLIENT_ID' });
    const code = hubspot.createAuthCode({ redirectUri: REDIRECT });
    expect(await rejection(hubspot.exchangeCode(code, REDIRECT))).toBeInstanceOf(ConfigError);
    expect(await rejection(hubspot.introspect(tokens.refreshToken, 'refresh_token'))).toBeInstanceOf(ConfigError);
    expect(await rejection(hubspot.revoke(tokens.refreshToken))).toBeInstanceOf(ConfigError);
    hubspot.setRefreshMode('ok');
    await expect(hubspot.refresh(tokens.refreshToken)).resolves.toBeDefined();
  });

  it('477: Migration in Progress with Retry-After in seconds, then ok', async () => {
    hubspot.setRefreshMode({ kind: 'migration', retryAfterSeconds: 3600 });
    const error = await rejection(hubspot.refresh(tokens.refreshToken));
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ code: 'hubspot_migration_in_progress', httpStatus: 477, retryAfterMs: 3_600_000 });
    expect(wireResponseOf(error)?.headers).toEqual({ 'Retry-After': '3600' });
    await expect(hubspot.refresh(tokens.refreshToken)).resolves.toBeDefined();
  });

  it('lets an injected classifier decide the class from the HubSpot-shaped response', async () => {
    const seen: [number, unknown][] = [];
    const classify = (status: number, body: unknown): RefreshFailureClass => {
      seen.push([status, body]);
      return 'config';
    };
    const classified = new FakeHubSpot({ clock, classifyRefreshFailure: classify });
    const set = classified.installTokens();
    classified.setRefreshMode('revoked');
    expect(await rejection(classified.refresh(set.refreshToken))).toBeInstanceOf(ConfigError);
    expect(seen).toEqual([[400, REFRESH_WIRE.badRefreshToken.body]]);
  });

  it('never puts provider text or tokens in the error itself (law 4)', async () => {
    hubspot.setRefreshMode('revoked');
    const error = await rejection(hubspot.refresh(tokens.refreshToken));
    expect(isAppError(error)).toBe(true);
    expect(JSON.stringify(error)).not.toContain('invalid');
    expect(String(error)).not.toContain(tokens.refreshToken);
    expect((error as Error).cause).toBeUndefined();
  });
});

describe('account details', () => {
  it('reports America/New_York with the offset for the current fake instant', async () => {
    expect(await hubspot.accountDetails(token)).toEqual({
      portalId: '1234567',
      timeZone: 'America/New_York',
      utcOffsetMilliseconds: -4 * 3_600_000,
      uiDomain: 'app.hubspot.com',
      dataHostingLocation: 'na1',
      accountType: 'STANDARD',
    });
    clock.set(new Date('2026-11-02T14:00:00.000Z'));
    const winter = hubspot.installTokens().accessToken;
    expect(await hubspot.accountDetails(winter)).toMatchObject({ utcOffsetMilliseconds: -5 * 3_600_000 });
  });

  it('falls back to the fixed offset for a non-IANA zone name', async () => {
    const custom = new FakeHubSpot({
      clock,
      portal: portalWith((p) => {
        Object.assign(p.portal, { timeZone: 'Eastern Standard Time', utcOffsetMilliseconds: -18_000_000 });
      }),
    });
    const details = await custom.accountDetails(custom.installTokens().accessToken);
    expect(details).toMatchObject({ timeZone: 'Eastern Standard Time', utcOffsetMilliseconds: -18_000_000 });
  });
});

describe('forms', () => {
  it('lists the live forms with their fields, lifecycle stages and consent', async () => {
    const forms = await hubspot.listForms(token);
    expect(forms.map((f) => f.name)).toEqual(['Contact us', 'Request a quote', 'Newsletter signup']);
    const newsletter = forms.find((f) => f.id === NEWSLETTER);
    expect(newsletter).toEqual({
      id: NEWSLETTER,
      name: 'Newsletter signup',
      formType: 'hubspot',
      archived: false,
      fieldNames: ['email'],
      fields: [{ name: 'email', fieldType: 'email', hidden: false, objectTypeId: '0-1' }],
      lifecycleStages: ['subscriber'],
      hasSubscriptionConsent: true,
      submitButtonText: 'Subscribe',
    });
    expect(forms.find((f) => f.id === CONTACT_US)?.fieldNames).toEqual(['firstname', 'lastname', 'email', 'company', 'message']);
  });

  it('includes flow forms but leaves out archived and captured ones', async () => {
    const extra = (id: string, name: string, formType: string, archived: boolean) => ({
      id,
      name,
      formType,
      archived,
      fields: [{ name: 'email', fieldType: 'email', hidden: false, objectTypeId: '0-1' }],
      lifecycleStages: [],
      hasSubscriptionConsent: false,
    });
    const custom = new FakeHubSpot({
      clock,
      portal: portalWith((p) => {
        (p.forms as unknown[]).push(
          extra('f-archived', 'Old contact form', 'hubspot', true),
          extra('f-captured', 'Embedded form', 'captured', false),
          extra('f-popup', 'Pop-up offer', 'flow', false),
        );
      }),
    });
    const names = (await custom.listForms(custom.installTokens().accessToken)).map((f) => f.name);
    expect(names).toEqual(['Contact us', 'Request a quote', 'Newsletter signup', 'Pop-up offer']);
  });
});

describe('submissions', () => {
  it('returns the fixture submissions newest first, with values and page URL', async () => {
    const page = await hubspot.listSubmissions(token, CONTACT_US, { limit: 50 });
    expect(page.nextAfter).toBeUndefined();
    expect(page.results.map((s) => s.submittedAt.toISOString())).toEqual([
      '2026-09-29T15:20:00.000Z',
      '2026-09-19T17:45:00.000Z',
      '2026-09-10T14:12:00.000Z',
    ]);
    expect(page.results[2]).toMatchObject({
      conversionId: '5e0d7c1a-9b2f-4c3e-8d4a-000000000101',
      pageUrl: 'https://brightside-plumbing.example/contact',
    });
    expect(page.results[2]?.values.find((v) => v.name === 'email')).toEqual({
      name: 'email',
      value: 'maya.okafor@example.com',
      objectTypeId: '0-1',
    });
  });

  it('pages 50 at a time, newest first, with an `after` cursor', async () => {
    for (let i = 0; i < 120; i++) {
      hubspot.submitForm({ formId: NEWSLETTER, email: `reader${i}@example.com`, at: new Date(START.getTime() - (120 - i) * 60_000) });
    }
    const seen: string[] = [];
    let after: string | undefined;
    const sizes: number[] = [];
    do {
      const page = await hubspot.listSubmissions(token, NEWSLETTER, { limit: 50, after });
      sizes.push(page.results.length);
      for (const s of page.results) seen.push(s.values[0]?.value ?? '');
      after = page.nextAfter;
    } while (after !== undefined);
    expect(sizes).toEqual([50, 50, 20]);
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `reader${119 - i}@example.com`));
  });

  it('keeps the cursor stable when a newer submission arrives between pages', async () => {
    for (let i = 0; i < 60; i++) {
      hubspot.submitForm({ formId: NEWSLETTER, email: `reader${i}@example.com`, at: new Date(START.getTime() - (60 - i) * 1000) });
    }
    const first = await hubspot.listSubmissions(token, NEWSLETTER, { limit: 50 });
    hubspot.submitForm({ formId: NEWSLETTER, email: 'late@example.com' });
    const second = await hubspot.listSubmissions(token, NEWSLETTER, { limit: 50, after: first.nextAfter });
    expect(second.results.map((s) => s.values[0]?.value)).toEqual(
      Array.from({ length: 10 }, (_, i) => `reader${9 - i}@example.com`),
    );
    expect(second.nextAfter).toBeUndefined();
    const fresh = await hubspot.listSubmissions(token, NEWSLETTER, { limit: 1 });
    expect(fresh.results[0]?.values[0]?.value).toBe('late@example.com');
  });

  it('orders equal timestamps by arrival and pages through them without loss', async () => {
    for (let i = 0; i < 3; i++) hubspot.submitForm({ formId: NEWSLETTER, email: `same${i}@example.com` });
    const a = await hubspot.listSubmissions(token, NEWSLETTER, { limit: 2 });
    const b = await hubspot.listSubmissions(token, NEWSLETTER, { limit: 2, after: a.nextAfter });
    expect([...a.results, ...b.results].map((s) => s.values[0]?.value)).toEqual([
      'same2@example.com',
      'same1@example.com',
      'same0@example.com',
    ]);
  });

  it('hides a submission dated in the future until the clock reaches it', async () => {
    hubspot.submitForm({ formId: QUOTE, email: 'future@example.com', at: new Date(START.getTime() + 60_000) });
    expect((await hubspot.listSubmissions(token, QUOTE, { limit: 50 })).results).toHaveLength(2);
    clock.advance({ minutes: 1 });
    expect((await hubspot.listSubmissions(token, QUOTE, { limit: 50 })).results).toHaveLength(3);
  });

  it('includes only the fields submitted, and can omit the conversionId', async () => {
    const result = hubspot.submitForm({
      formId: CONTACT_US,
      email: 'No.Message@Example.com',
      firstName: 'Rosa',
      withConversionId: false,
    });
    expect(result.conversionId).toBeNull();
    const [latest] = (await hubspot.listSubmissions(token, CONTACT_US, { limit: 1 })).results;
    expect(latest?.conversionId).toBeUndefined();
    expect(latest?.values).toEqual([
      { name: 'firstname', value: 'Rosa', objectTypeId: '0-1' },
      { name: 'email', value: 'no.message@example.com', objectTypeId: '0-1' },
    ]);
  });

  it('refuses a limit outside 1..50, a malformed cursor and an unknown form', async () => {
    for (const limit of [0, 51, 2.5]) {
      expect(await rejection(hubspot.listSubmissions(token, CONTACT_US, { limit }))).toMatchObject({
        code: 'hubspot_bad_request',
        httpStatus: 400,
      });
    }
    expect(await rejection(hubspot.listSubmissions(token, CONTACT_US, { limit: 10, after: 'bm9wZQ' }))).toMatchObject({
      code: 'hubspot_bad_request',
    });
    expect(await rejection(hubspot.listSubmissions(token, 'no-such-form', { limit: 10 }))).toMatchObject({
      code: 'hubspot_not_found',
      httpStatus: 404,
    });
  });

  it('rejects helper misuse: unknown field, unknown form, wrong newContact expectation', () => {
    expect(() => hubspot.submitForm({ formId: NEWSLETTER, email: 'x@example.com', message: 'hi' })).toThrow(/no message field/);
    expect(() => hubspot.submitForm({ formId: 'nope', email: 'x@example.com' })).toThrow(/unknown form/);
    expect(() => hubspot.submitForm({ formId: CONTACT_US, email: 'maya.okafor@example.com', newContact: true })).toThrow();
    expect(() => hubspot.submitForm({ formId: CONTACT_US, email: 'nobody@example.com', newContact: false })).toThrow();
  });
});

describe('contacts', () => {
  it('reads a contact by id or email with only the requested properties, null for empty ones', async () => {
    const { contactId, createdContact } = hubspot.submitForm({
      formId: CONTACT_US,
      email: 'nia.brooks@example.com',
      firstName: 'Nia',
      message: 'Our outdoor tap is dripping.',
      newContact: true,
    });
    expect(createdContact).toBe(true);
    expect(contactId).toMatch(/^\d+$/);
    const byId = await hubspot.getContact(token, contactId ?? '', { properties: STOP_PROPS });
    expect(byId).toEqual({
      id: contactId,
      properties: {
        email: 'nia.brooks@example.com',
        firstname: 'Nia',
        message: 'Our outdoor tap is dripping.',
        hs_email_optout: null,
        hs_additional_emails: null,
      },
    });
    const byEmail = await hubspot.getContact(token, 'NIA.BROOKS@example.com', { idProperty: 'email', properties: ['email'] });
    expect(byEmail?.id).toBe(contactId);
    expect(await hubspot.getContact(token, 'nobody@example.com', { idProperty: 'email', properties: ['email'] })).toBeNull();
    expect(await hubspot.getContact(token, '999999', { properties: ['email'] })).toBeNull();
  });

  it('keeps a new contact unreadable for its visibility delay while the submission is already listed', async () => {
    const { contactId } = hubspot.submitForm({
      formId: CONTACT_US,
      email: 'slow.index@example.com',
      message: 'Burst pipe under the sink.',
      visibilityDelayMs: 30 * 60_000,
    });
    const [listed] = (await hubspot.listSubmissions(token, CONTACT_US, { limit: 1 })).results;
    expect(listed?.values.find((v) => v.name === 'email')?.value).toBe('slow.index@example.com');
    const lookup = () => hubspot.getContact(token, 'slow.index@example.com', { idProperty: 'email', properties: ['email'] });
    expect(await lookup()).toBeNull();
    expect(await hubspot.getContact(token, contactId ?? '', { properties: ['email'] })).toBeNull();
    clock.advance({ minutes: 29, seconds: 59 });
    expect(await lookup()).toBeNull();
    clock.advance({ seconds: 1 });
    await refreshToken();
    expect((await lookup())?.id).toBe(contactId);
  });

  it('applies the portal-wide visibility delay to contacts created by submissions', async () => {
    hubspot.setContactVisibilityDelay(5 * 60_000);
    hubspot.submitForm({ formId: QUOTE, email: 'delayed@example.com' });
    const lookup = () => hubspot.getContact(token, 'delayed@example.com', { idProperty: 'email', properties: ['email'] });
    expect(await lookup()).toBeNull();
    clock.advance({ minutes: 5 });
    expect(await lookup()).not.toBeNull();
  });

  it('a repeat submission by an existing contact creates no contact and updates its message', async () => {
    const result = hubspot.submitForm({
      formId: QUOTE,
      email: 'lena.fischer@example.org',
      message: 'Following up: can you also look at the water softener?',
    });
    expect(result).toMatchObject({ contactId: '105', createdContact: false });
    const contact = await hubspot.getContact(token, '105', { properties: ['message', 'firstname'] });
    expect(contact?.properties).toEqual({ message: 'Following up: can you also look at the water softener?', firstname: 'Lena' });
  });

  it('creates no contact for a new email when the form is configured not to', async () => {
    const custom = new FakeHubSpot({
      clock,
      portal: portalWith((p) => {
        Object.assign(p.forms[0] ?? {}, { createNewContactForNewEmail: false });
      }),
    });
    const access = custom.installTokens().accessToken;
    expect(custom.submitForm({ formId: CONTACT_US, email: 'ghost@example.com' })).toMatchObject({ contactId: null });
    expect(await custom.getContact(access, 'ghost@example.com', { idProperty: 'email', properties: ['email'] })).toBeNull();
  });

  it('a deleted contact reads as 404: null from getContact, not-found from the associations endpoint', async () => {
    hubspot.deleteContact('101');
    expect(await hubspot.getContact(token, '101', { properties: ['email'] })).toBeNull();
    expect(await hubspot.getContact(token, 'maya.okafor@example.com', { idProperty: 'email', properties: ['email'] })).toBeNull();
    const error = await rejection(hubspot.listContactEmailIds(token, '101', {}));
    expect(error).toBeInstanceOf(PermanentError);
    expect(error).toMatchObject({ code: 'hubspot_not_found', httpStatus: 404 });
    expect(wireResponseOf(error)?.body).toMatchObject({ status: 'error', category: 'OBJECT_NOT_FOUND' });
  });

  it('a merge returns a different id for both old ids, keeps the primary values and moves associations', async () => {
    const primary = hubspot.createContact({ email: 'ann@example.com', firstName: 'Ann' });
    const secondary = hubspot.createContact({ email: 'ann.work@example.com', company: 'Ann Co' });
    const sent = hubspot.logOwnerSend({ to: 'ann.work@example.com' });
    const merged = hubspot.mergeContact(primary, secondary);
    expect(merged).not.toBe(primary);
    expect(merged).not.toBe(secondary);

    const props: HubSpotContactProperty[] = ['email', 'firstname', 'company', 'hs_additional_emails'];
    for (const oldId of [primary, secondary]) {
      const contact = await hubspot.getContact(token, oldId, { properties: props, associations: ['emails'] });
      expect(contact).toEqual({
        id: merged,
        properties: { email: 'ann@example.com', firstname: 'Ann', company: 'Ann Co', hs_additional_emails: 'ann.work@example.com' },
        associatedEmailIds: [sent],
      });
    }
    expect((await hubspot.getContact(token, 'ann@example.com', { idProperty: 'email', properties: ['email'] }))?.id).toBe(merged);
    // A lookup by email matches the primary email only (HS-INTAKE-SUBMISSION-CONTACT-MATCH).
    expect(await hubspot.getContact(token, 'ann.work@example.com', { idProperty: 'email', properties: ['email'] })).toBeNull();
    expect(hubspot.contactIdByEmail('ann.work@example.com')).toBe(merged);
  });

  it('a merge without a tracked secondary still re-ids the contact', async () => {
    const merged = hubspot.mergeContact('104');
    expect((await hubspot.getContact(token, '104', { properties: ['email'] }))?.id).toBe(merged);
    const assoc = await hubspot.getContact(token, merged, { properties: ['email'], associations: ['emails'] });
    expect(assoc?.associatedEmailIds).toEqual(['60005']);
  });

  it('records opt-outs and hard bounces as the stop-rule properties', async () => {
    hubspot.optOut('102');
    hubspot.hardBounce('103');
    hubspot.updateContact('104', { hs_email_bad_address: 'true' });
    const read = (id: string) =>
      hubspot.getContact(token, id, {
        properties: ['hs_email_optout', 'hs_email_hard_bounce_reason_enum', 'hs_email_bad_address'],
      });
    expect((await read('102'))?.properties).toMatchObject({ hs_email_optout: 'true' });
    expect((await read('103'))?.properties.hs_email_hard_bounce_reason_enum).toEqual(expect.stringMatching(/.+/));
    expect((await read('104'))?.properties).toMatchObject({ hs_email_bad_address: 'true' });
  });

  it('refuses contact properties outside the allow-list before reading anything (law 4)', async () => {
    const error = await rejection(
      hubspot.getContact(token, '101', { properties: ['email', 'hs_email_text' as HubSpotContactProperty] }),
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ code: 'hubspot_request_not_allowed' });
    expect(wireResponseOf(error)).toBeUndefined();
  });
});

describe('email associations', () => {
  it('pages more than 100 associated emails: first page on the contact, the rest from the associations endpoint', async () => {
    const id = hubspot.createContact({ email: 'busy@example.com' });
    const logged: string[] = [];
    for (let i = 0; i < 250; i++) {
      const emailId = hubspot.logOwnerSend({ to: 'busy@example.com', at: new Date(START.getTime() - (250 - i) * 60_000) });
      if (emailId !== null) logged.push(emailId);
    }
    expect(logged).toHaveLength(250);

    const contact = await hubspot.getContact(token, id, { properties: ['email'], associations: ['emails'] });
    expect(contact?.associatedEmailIds).toHaveLength(100);
    expect(contact?.associationsNextAfter).toBeDefined();

    const ids = [...(contact?.associatedEmailIds ?? [])];
    let after = contact?.associationsNextAfter;
    const sizes = [ids.length];
    while (after !== undefined) {
      const page = await hubspot.listContactEmailIds(token, id, { after });
      sizes.push(page.ids.length);
      ids.push(...page.ids);
      after = page.nextAfter;
    }
    expect(sizes).toEqual([100, 100, 50]);
    expect(ids).toEqual(logged);
  });

  it('omits the cursor when everything fits on the first page', async () => {
    const contact = await hubspot.getContact(token, '101', { properties: ['email'], associations: ['emails'] });
    expect(contact).toMatchObject({ associatedEmailIds: ['60001', '60002'] });
    expect(contact?.associationsNextAfter).toBeUndefined();
    expect(await hubspot.listContactEmailIds(token, '101', {})).toEqual({ ids: ['60001', '60002'] });
  });
});

describe('logging modes', () => {
  async function emailsOf(email: string) {
    const contact = await hubspot.getContact(token, email, { idProperty: 'email', properties: ['email'], associations: ['emails'] });
    return hubspot.batchReadEmails(token, contact?.associatedEmailIds ?? [], ALL_EMAIL_PROPS);
  }

  beforeEach(() => {
    hubspot.submitForm({ formId: CONTACT_US, email: 'lead@example.com', firstName: 'Lee', message: 'Need a boiler check.' });
  });

  it('log_all logs the owner send and the lead reply, and stamps the last-replied property', async () => {
    const sendAt = new Date(START.getTime() + 13 * 60_000);
    const replyAt = new Date(START.getTime() + 3 * 86_400_000);
    expect(hubspot.logOwnerSend({ to: 'lead@example.com', at: sendAt })).not.toBeNull();
    expect(hubspot.logLeadReply({ from: 'lead@example.com', at: replyAt })).not.toBeNull();
    clock.set(replyAt);
    await refreshToken();
    expect(await emailsOf('lead@example.com')).toEqual([
      expect.objectContaining({
        timestamp: sendAt,
        direction: 'EMAIL',
        status: 'SENT',
        fromEmail: OWNER,
        toEmails: ['lead@example.com'],
      }),
      expect.objectContaining({ timestamp: replyAt, direction: 'INCOMING_EMAIL', fromEmail: 'lead@example.com', toEmails: [OWNER] }),
    ]);
    const contact = await hubspot.getContact(token, 'lead@example.com', {
      idProperty: 'email',
      properties: ['hs_sales_email_last_replied'],
    });
    expect(contact?.properties.hs_sales_email_last_replied).toBe(replyAt.toISOString());
  });

  it('sends_only (BCC) logs the send but not the reply', async () => {
    hubspot.setLoggingMode('sends_only');
    expect(hubspot.logOwnerSend({ to: 'lead@example.com' })).not.toBeNull();
    expect(hubspot.logLeadReply({ from: 'lead@example.com' })).toBeNull();
    expect((await emailsOf('lead@example.com')).map((e) => e.direction)).toEqual(['EMAIL']);
  });

  it('none logs nothing', async () => {
    hubspot.setLoggingMode('none');
    expect(hubspot.logOwnerSend({ to: 'lead@example.com' })).toBeNull();
    expect(hubspot.logLeadReply({ from: 'lead@example.com' })).toBeNull();
    expect(await emailsOf('lead@example.com')).toEqual([]);
    expect(hubspot.loggingMode()).toBe('none');
  });

  it('keeps modes per mailbox', () => {
    hubspot.setLoggingMode('none', 'Colleague@Brightside-Plumbing.example');
    expect(hubspot.logOwnerSend({ to: 'lead@example.com', from: 'colleague@brightside-plumbing.example' })).toBeNull();
    expect(hubspot.logOwnerSend({ to: 'lead@example.com' })).not.toBeNull();
    expect(hubspot.logOwnerSend({ to: 'lead@example.com', from: 'unknown.mailbox@brightside-plumbing.example' })).toBeNull();
  });

  it('logs replies only from known contacts; a send to an unknown address creates its contact (BCC)', async () => {
    expect(hubspot.logLeadReply({ from: 'stranger@example.com' })).toBeNull();
    const test = 'owner.personal@example.net';
    expect(hubspot.contactIdByEmail(test)).toBeNull();
    hubspot.logOwnerSend({ to: test });
    expect(hubspot.contactIdByEmail(test)).not.toBeNull();
    expect(hubspot.logLeadReply({ from: test })).not.toBeNull();
    expect((await emailsOf(test)).map((e) => e.direction)).toEqual(['EMAIL', 'INCOMING_EMAIL']);
    expect(hubspot.logOwnerSend({ to: 'nobody.yet@example.com', createContactIfMissing: false })).not.toBeNull();
    expect(hubspot.contactIdByEmail('nobody.yet@example.com')).toBeNull();
  });

  it('hides an engagement until it is logged', async () => {
    hubspot.logOwnerSend({ to: 'lead@example.com', at: START, loggedAt: new Date(START.getTime() + 60_000) });
    expect(await emailsOf('lead@example.com')).toEqual([]);
    clock.advance({ minutes: 1 });
    expect(await emailsOf('lead@example.com')).toHaveLength(1);
  });

  it('associates a CC-only lead without putting it in the To addresses', async () => {
    hubspot.createContact({ email: 'colleague@example.com' });
    hubspot.logOwnerSend({ to: 'colleague@example.com', cc: ['lead@example.com'] });
    const [email] = await emailsOf('lead@example.com');
    expect(email?.toEmails).toEqual(['colleague@example.com']);
  });
});

describe('email reads', () => {
  it('batch-reads only the requested metadata, omitting missing and unlogged ids', async () => {
    const result = await hubspot.batchReadEmails(token, ['60001', '60001', '424242'], ['hs_timestamp', 'hs_email_direction']);
    expect(result).toEqual([{ id: '60001', timestamp: new Date('2026-09-10T14:42:00.000Z'), direction: 'EMAIL', toEmails: [] }]);
    expect(await hubspot.batchReadEmails(token, ['60001'], ['hs_email_direction'])).toEqual([]);
    expect(await hubspot.batchReadEmails(token, [], ALL_EMAIL_PROPS)).toEqual([]);
  });

  it('refuses content properties (D-03 metadata allow-list)', async () => {
    for (const property of ['hs_email_subject', 'hs_email_text', 'hs_body_preview']) {
      const error = await rejection(hubspot.batchReadEmails(token, ['60001'], [property as EmailMetadataProperty]));
      expect(error).toMatchObject({ code: 'hubspot_request_not_allowed' });
    }
  });

  it('counts logged emails per direction since a time', async () => {
    const since = new Date('2026-09-06T14:00:00.000Z');
    expect(await hubspot.searchEmailsCount(token, { direction: 'outbound', since })).toBe(4);
    expect(await hubspot.searchEmailsCount(token, { direction: 'inbound', since })).toBe(1);
    expect(await hubspot.searchEmailsCount(token, { direction: 'outbound', since: new Date('2026-09-20T00:00:00.000Z') })).toBe(1);
    hubspot.logEmail({
      direction: 'FORWARDED_EMAIL',
      from: 'someone@example.com',
      to: [OWNER],
      contactIds: ['105'],
      at: START,
    });
    expect(await hubspot.searchEmailsCount(token, { direction: 'inbound', since })).toBe(2);
  });

  it('answers 403 MISSING_SCOPES on email reads without sales-email-read; associations still work', async () => {
    hubspot.setGrantedScopes(['oauth', 'crm.objects.contacts.read', 'forms']);
    for (const call of [
      hubspot.batchReadEmails(token, ['60001'], ALL_EMAIL_PROPS),
      hubspot.searchEmailsCount(token, { direction: 'outbound', since: START }),
    ]) {
      const error = await rejection(call);
      expect(error).toBeInstanceOf(PermanentError);
      expect(error).toMatchObject({ code: 'hubspot_missing_scopes', httpStatus: 403 });
      expect(wireResponseOf(error)?.body).toMatchObject({ status: 'error', category: 'MISSING_SCOPES' });
    }
    const contact = await hubspot.getContact(token, '101', { properties: ['email'], associations: ['emails'] });
    expect(contact?.associatedEmailIds).toEqual(['60001', '60002']);
    expect(await hubspot.introspect(tokens.refreshToken, 'refresh_token')).toMatchObject({
      scopes: ['oauth', 'crm.objects.contacts.read', 'forms'],
    });
  });
});

describe('injected API failures', () => {
  it('429 ten-secondly with Retry-After, once; the next call succeeds', async () => {
    hubspot.injectFailure('listForms', { kind: 'rate_limited', retryAfterSeconds: 10 });
    const error = await rejection(hubspot.listForms(token));
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ code: 'hubspot_rate_limited', httpStatus: 429, retryAfterMs: 10_000 });
    expect(wireResponseOf(error)?.body).toMatchObject({ policyName: 'TEN_SECONDLY_ROLLING' });
    await expect(hubspot.listForms(token)).resolves.toHaveLength(3);
  });

  it('daily limit has no delay; 477 carries Retry-After; 423 is locked', async () => {
    hubspot.injectFailure('getContact', { kind: 'daily_limit' });
    expect(await rejection(hubspot.getContact(token, '101', { properties: ['email'] }))).toMatchObject({
      code: 'hubspot_daily_limit',
      retryAfterMs: undefined,
    });
    hubspot.injectFailure('getContact', { kind: 'migration', retryAfterSeconds: 7200 });
    expect(await rejection(hubspot.getContact(token, '101', { properties: ['email'] }))).toMatchObject({
      code: 'hubspot_migration_in_progress',
      httpStatus: 477,
      retryAfterMs: 7_200_000,
    });
    hubspot.injectFailure('getContact', { kind: 'locked' });
    expect(await rejection(hubspot.getContact(token, '101', { properties: ['email'] }))).toMatchObject({
      code: 'hubspot_locked',
      httpStatus: 423,
    });
  });

  it('a wildcard failure hits any operation, for the given number of calls', async () => {
    hubspot.injectFailure('*', { kind: 'server_error', times: 2 });
    expect(await rejection(hubspot.accountDetails(token))).toMatchObject({ code: 'hubspot_server_error', httpStatus: 502 });
    expect(await rejection(hubspot.listForms(token))).toMatchObject({ code: 'hubspot_server_error' });
    await expect(hubspot.listForms(token)).resolves.toHaveLength(3);
  });

  it('timeouts and network errors have no HTTP status; an injected 401 is unauthorized', async () => {
    hubspot.injectFailure('listForms', { kind: 'timeout' });
    hubspot.injectFailure('listSubmissions', { kind: 'network' });
    hubspot.injectFailure('accountDetails', { kind: 'unauthorized' });
    expect(await rejection(hubspot.listForms(token))).toMatchObject({ code: 'hubspot_timeout', httpStatus: undefined });
    expect(await rejection(hubspot.listSubmissions(token, CONTACT_US, { limit: 1 }))).toMatchObject({ code: 'hubspot_network' });
    expect(await rejection(hubspot.accountDetails(token))).toMatchObject({ code: 'hubspot_unauthorized', httpStatus: 401 });
  });
});

describe('snapshot and restore', () => {
  it('round-trips through JSON: data, tokens, modes and id counters survive', async () => {
    const { contactId } = hubspot.submitForm({ formId: CONTACT_US, email: 'kept@example.com', message: 'Water heater pilot keeps going out.' });
    hubspot.logOwnerSend({ to: 'kept@example.com' });
    hubspot.setLoggingMode('sends_only');
    hubspot.setRefreshMode({ kind: 'transient', times: 1 });

    const restored = new FakeHubSpot({ clock });
    restored.restore(JSON.parse(JSON.stringify(hubspot.snapshot())));

    const contact = await restored.getContact(token, 'kept@example.com', {
      idProperty: 'email',
      properties: ['message'],
      associations: ['emails'],
    });
    expect(contact).toMatchObject({ id: contactId, properties: { message: 'Water heater pilot keeps going out.' } });
    expect(contact?.associatedEmailIds).toHaveLength(1);
    expect(restored.loggingMode()).toBe('sends_only');
    expect(await rejection(restored.refresh(tokens.refreshToken))).toBeInstanceOf(TransientError);
    await expect(restored.refresh(tokens.refreshToken)).resolves.toBeDefined();
    const next = restored.createContact({ email: 'after.restore@example.com' });
    expect(Number(next)).toBeGreaterThan(Number(contactId));
  });

  it('returns a deep copy, so editing a snapshot does not change the portal', async () => {
    const snapshot = hubspot.snapshot();
    snapshot.contacts.length = 0;
    snapshot.portal.grantedScopes = [];
    expect(await hubspot.getContact(token, '101', { properties: ['email'] })).not.toBeNull();
    expect(hubspot.portal.grantedScopes).toEqual(SCOPES);
  });

  it('rejects a malformed snapshot and keeps the current state', async () => {
    expect(() => hubspot.restore({ version: 2 })).toThrow();
    expect(() => hubspot.restore({ ...hubspot.snapshot(), contacts: [{ id: 'not-digits' }] })).toThrow();
    await expect(hubspot.listForms(token)).resolves.toHaveLength(3);
  });
});

describe('fixture loading', () => {
  it('rejects a portal whose records point at unknown forms or contacts', () => {
    expect(
      () =>
        new FakeHubSpot({
          clock,
          portal: portalWith((p) => {
            Object.assign(p.submissions[0] ?? {}, { formId: 'missing-form' });
          }),
        }),
    ).toThrow(/unknown form/);
    expect(
      () =>
        new FakeHubSpot({
          clock,
          portal: portalWith((p) => {
            Object.assign(p.emails[0] ?? {}, { contactIds: ['999'] });
          }),
        }),
    ).toThrow(/unknown contact/);
  });

  it('exposes the owner and test addresses and resolves form names', () => {
    expect(hubspot.ownerEmail).toBe(OWNER);
    expect(hubspot.testAddress).toBe('owner.personal@example.net');
    expect(hubspot.formIdByName('Newsletter signup')).toBe(NEWSLETTER);
  });
});
