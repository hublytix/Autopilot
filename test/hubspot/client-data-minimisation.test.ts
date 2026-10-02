import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubSpotHttpClient } from '@/server/adapters/live/hubspot';
import { ConfigError } from '@/server/domain/errors';
import { EMAIL_METADATA_PROPERTIES, HUBSPOT_CONTACT_PROPERTIES, type EmailMetadataProperty } from '@/server/domain/types';
import { REQUIRED_SCOPES } from '@/server/hubspot/scopes';
import { isHubSpotRequestAllowed } from '@/server/security/hubspot-allow-list';
import { FAKE_HUBSPOT_REFRESH_TOKEN } from '../support/fake-secrets';
import {
  CONTENT_EMAIL_PROPERTIES,
  emptyResponse,
  jsonBody,
  jsonResponse,
  recordingFetch,
  type RecordedRequest,
  type Responder,
} from './http-harness';

// Law 2 and law 4 across the whole client (D-03, HS-EMAIL-DATA-MINIMISATION): one tour calls every
// HubSpotClient method against a recording fetch, then checks every request it made. A new method or
// property list that requests content, writes, or leaks a secret into a URL fails here.

const CLIENT_SECRET = 'fake-hubspot-client-secret';
const ACCESS_TOKEN = 'test-access-token-0001';
const REFRESH_TOKEN = FAKE_HUBSPOT_REFRESH_TOKEN;

const TOKEN = { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 1800, hub_id: 1234567, scopes: [...REQUIRED_SCOPES], token_use: 'access_token' };

/** Answers each endpoint with a plausible HubSpot body. */
const portal: Responder = (request) => {
  const path = request.url.pathname;
  if (path.startsWith('/oauth/2026-09/token/introspect')) return jsonResponse(200, { active: true, hub_id: 1234567, app_id: 7100001, user: 'owner@example.org', scopes: [...REQUIRED_SCOPES], token_use: 'refresh_token' });
  if (path.startsWith('/oauth/2026-09/token/revoke')) return emptyResponse(200);
  if (path === '/oauth/2026-09/token') return jsonResponse(200, TOKEN);
  if (path === '/account-info/2026-09/details') {
    return jsonResponse(200, { portalId: 1234567, accountType: 'STANDARD', timeZone: 'America/New_York', utcOffsetMilliseconds: -14400000, uiDomain: 'app.hubspot.com', dataHostingLocation: 'na1' });
  }
  if (path === '/marketing/v3/forms') return jsonResponse(200, { results: [{ id: 'f1', name: 'Contact us', formType: 'hubspot', archived: false }] });
  if (path.startsWith('/form-integrations/v1/submissions/forms/')) return jsonResponse(200, { results: [{ submittedAt: 1790000000000, values: [{ name: 'email', value: 'lead@example.org' }] }] });
  if (path.endsWith('/associations/emails')) return jsonResponse(200, { results: [{ toObjectId: 501 }] });
  if (path.startsWith('/crm/objects/2026-09/contacts/')) {
    return jsonResponse(200, { id: '101', properties: { email: 'lead@example.org' }, associations: { emails: { results: [{ id: '501', type: 'contact_to_email' }] } } });
  }
  if (path === '/crm/objects/2026-09/emails/batch/read') return jsonResponse(200, { results: [{ id: '501', properties: { hs_timestamp: '2026-10-06T14:13:00Z' } }] });
  if (path === '/crm/objects/2026-09/emails/search') return jsonResponse(200, { total: 2, results: [] });
  if (path === '/appinstalls/2026-09/external-install') return emptyResponse(204);
  return jsonResponse(404, { status: 'error', category: 'OBJECT_NOT_FOUND' });
};

/** Every HubSpotClient method, with every property the allow-lists permit. */
async function tour(hubspot: HubSpotHttpClient): Promise<void> {
  hubspot.authorizeUrl({ state: 'state', redirectUri: 'https://autopilot.example.com/api/hubspot/oauth/callback', scopes: REQUIRED_SCOPES });
  await hubspot.exchangeCode('code', 'https://autopilot.example.com/api/hubspot/oauth/callback');
  await hubspot.refresh(REFRESH_TOKEN);
  await hubspot.introspect(REFRESH_TOKEN, 'refresh_token');
  await hubspot.revoke(REFRESH_TOKEN);
  await hubspot.accountDetails(ACCESS_TOKEN);
  await hubspot.listForms(ACCESS_TOKEN);
  await hubspot.listSubmissions(ACCESS_TOKEN, 'b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01', { limit: 50 });
  await hubspot.getContact(ACCESS_TOKEN, '101', { properties: HUBSPOT_CONTACT_PROPERTIES, associations: ['emails'] });
  await hubspot.getContact(ACCESS_TOKEN, 'lead@example.org', { idProperty: 'email', properties: ['email', 'firstname', 'lastname', 'company', 'message'] });
  await hubspot.listContactEmailIds(ACCESS_TOKEN, '101', { after: 'a' });
  await hubspot.batchReadEmails(ACCESS_TOKEN, ['501', '502'], EMAIL_METADATA_PROPERTIES);
  await hubspot.searchEmailsCount(ACCESS_TOKEN, { direction: 'outbound', since: new Date(1788566400000) });
  await hubspot.searchEmailsCount(ACCESS_TOKEN, { direction: 'inbound', since: new Date(1788566400000) });
  await hubspot.uninstallApp(ACCESS_TOKEN);
}

function isEmailRequest(request: RecordedRequest): boolean {
  return request.url.pathname.includes('/emails/');
}

/** The property names a request asks for, from the `properties` query parameter or JSON body. */
function requestedProperties(request: RecordedRequest): string[] {
  const fromQuery = request.url.searchParams.get('properties');
  if (fromQuery !== null) return fromQuery.split(',');
  if (request.headers.get('content-type') === 'application/json') {
    const body = jsonBody(request) as { properties?: unknown };
    return Array.isArray(body.properties) ? body.properties.map(String) : [];
  }
  return [];
}

describe('HubSpotHttpClient: every request of a full tour', () => {
  let requests: RecordedRequest[];
  const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(async () => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
    const recording = recordingFetch(portal);
    requests = recording.requests;
    await tour(new HubSpotHttpClient({ clientId: 'fake-hubspot-client-id', clientSecret: CLIENT_SECRET, fetch: recording.fetch }));
  });

  afterEach(() => {
    for (const spy of consoleSpies.splice(0)) spy.mockRestore();
  });

  it('covers every endpoint the client knows', () => {
    expect(new Set(requests.map((r) => `${r.method} ${r.url.pathname.replace(/\/\d+(?=\/|$)/g, '/{id}')}`))).toEqual(
      new Set([
        'POST /oauth/2026-09/token',
        'POST /oauth/2026-09/token/introspect',
        'POST /oauth/2026-09/token/revoke',
        'GET /account-info/2026-09/details',
        'GET /marketing/v3/forms',
        'GET /form-integrations/v1/submissions/forms/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01',
        'GET /crm/objects/2026-09/contacts/{id}',
        'GET /crm/objects/2026-09/contacts/lead%40example.org',
        'GET /crm/objects/2026-09/contacts/{id}/associations/emails',
        'POST /crm/objects/2026-09/emails/batch/read',
        'POST /crm/objects/2026-09/emails/search',
        'DELETE /appinstalls/2026-09/external-install',
      ]),
    );
  });

  it('only calls api.hubapi.com over HTTPS, and only requests on the read-only allow-list (law 2)', () => {
    for (const request of requests) {
      expect(request.url.origin).toBe('https://api.hubapi.com');
      expect(isHubSpotRequestAllowed(request.method, `${request.url.pathname}${request.url.search}`)).toBe(true);
      expect(request.redirect).toBe('manual');
    }
  });

  it('never requests an email content property (law 4)', () => {
    for (const request of requests) {
      const text = `${request.url.href} ${request.body ?? ''}`;
      for (const content of CONTENT_EMAIL_PROPERTIES) expect(text, `${request.method} ${request.url.pathname}`).not.toContain(content);
    }
  });

  it('asks email endpoints for metadata properties only, and contact endpoints for allow-listed properties only', () => {
    const emailAllowed: ReadonlySet<string> = new Set(EMAIL_METADATA_PROPERTIES);
    const contactAllowed: ReadonlySet<string> = new Set(HUBSPOT_CONTACT_PROPERTIES);
    let checked = 0;
    for (const request of requests) {
      const properties = requestedProperties(request);
      if (properties.length === 0) continue;
      checked++;
      const allowed = isEmailRequest(request) ? emailAllowed : contactAllowed;
      for (const property of properties) expect(allowed.has(property), `${request.url.pathname}: ${property}`).toBe(true);
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it('never uses the free-text search query, which searches subjects', () => {
    for (const request of requests.filter((r) => r.url.pathname.endsWith('/search'))) {
      expect(Object.keys(jsonBody(request) as object)).not.toContain('query');
    }
  });

  it('keeps secrets out of URLs: the client secret only in OAuth form bodies, the access token only in the Authorization header', () => {
    for (const request of requests) {
      expect(request.url.href).not.toContain(CLIENT_SECRET);
      expect(request.url.href).not.toContain(ACCESS_TOKEN);
      expect(request.url.href).not.toContain(REFRESH_TOKEN);
      const isOAuth = request.url.pathname.startsWith('/oauth/');
      if (!isOAuth) {
        expect(request.body ?? '').not.toContain(CLIENT_SECRET);
        expect(request.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
      } else {
        expect(request.headers.get('authorization')).toBeNull();
        expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      }
    }
  });

  it('logs nothing', () => {
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('HubSpotHttpClient: refusing content before the network', () => {
  it.each(CONTENT_EMAIL_PROPERTIES)('refuses the email property %s', async (property) => {
    const recording = recordingFetch(portal);
    const hubspot = new HubSpotHttpClient({ clientId: 'fake-hubspot-client-id', clientSecret: CLIENT_SECRET, fetch: recording.fetch });
    const properties = ['hs_timestamp', property] as unknown as readonly EmailMetadataProperty[];
    await expect(hubspot.batchReadEmails(ACCESS_TOKEN, ['501'], properties)).rejects.toBeInstanceOf(ConfigError);
    expect(recording.requests).toHaveLength(0);
  });
});
