import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleHubSpotCallback } from '@/server/http/hubspot-callback';
import { handleHubSpotInstall } from '@/server/http/hubspot-install';
import { canReadEmails, missingRequiredScopes, REQUIRED_SCOPES } from '@/server/hubspot/scopes';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, type JobTestRig } from '@/server/jobs/testing';
import { CookieJar } from '@/server/security/cookies';
import { useTestDb as setUpTestDb } from '../db/harness';

// D-03 path (b), run now (WIRE_UP 9.5 row 1): with the switch off, the install asks HubSpot for the
// three scopes without `sales-email-read`, an install granted exactly those completes, and the
// stored grant can't read emails, so every email feature says "Not enough data". Flipping the switch
// (src/server/hubspot/email-scope-switch.ts) and app-hsmeta.json is the whole code change.

vi.mock('@/server/hubspot/email-scope-switch', () => ({ ASK_FOR_EMAIL_READ_SCOPE: false }));

const getDb = setUpTestDb();
const PATH_B_SCOPES = ['oauth', 'crm.objects.contacts.read', 'forms'];

let rig: JobTestRig;
let alerts: RaisedAlert[];
let stopAlerts: () => void;

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
  for (const method of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  stopAlerts();
  vi.restoreAllMocks();
});

const url = (path: string): string => `${rig.deps.env.APP_URL}${path}`;

/** Install → fake consent → callback; returns the consent URL's scope list and the callback's Location. */
async function install(): Promise<{ askedFor: string | null; location: string | null }> {
  const jar = new CookieJar();
  const started = await handleHubSpotInstall(jar.request(url('/api/hubspot/install'), { headers: { 'x-real-ip': '203.0.113.7' } }), rig.deps);
  jar.storeFrom(started);
  const consent = new URL(started.headers.get('location') ?? '');
  const code = rig.fakes.hubspot.createAuthCode({ redirectUri: consent.searchParams.get('redirect_uri') ?? '' });
  const query = new URLSearchParams({ code, state: consent.searchParams.get('state') ?? '' }).toString();
  const res = await handleHubSpotCallback(jar.request(url(`/api/hubspot/oauth/callback?${query}`)), rig.deps, {
    sendReconnectMagicLink: async () => true,
  });
  return { askedFor: consent.searchParams.get('scope'), location: res.headers.get('location') };
}

async function storedScopes(): Promise<string[]> {
  return (await getDb().one<{ scopes: string[] }>(`select scopes from hubspot_connections`)).scopes;
}

describe('D-03 path (b): sales-email-read switched off', () => {
  it('requires only the three scopes, so a grant without the email scope is complete', () => {
    expect([...REQUIRED_SCOPES]).toEqual(PATH_B_SCOPES);
    expect(missingRequiredScopes(PATH_B_SCOPES)).toEqual([]);
    expect(missingRequiredScopes(['oauth', 'forms'])).toEqual(['crm.objects.contacts.read']);
  });

  it('asks HubSpot for the three scopes and completes an install granted exactly those; emails are not readable', async () => {
    rig.fakes.hubspot.setGrantedScopes(PATH_B_SCOPES);
    const { askedFor, location } = await install();
    expect(askedFor).toBe('oauth crm.objects.contacts.read forms');
    expect(location).toBe(url('/onboarding/email'));
    const scopes = await storedScopes();
    expect(scopes).toEqual(PATH_B_SCOPES);
    expect(canReadEmails(scopes)).toBe(false);
    expect(alerts).toEqual([]);
  });

  it('a grant that still carries sales-email-read is alerted as extra and not stored (law 2)', async () => {
    rig.fakes.hubspot.setGrantedScopes([...PATH_B_SCOPES, 'sales-email-read']);
    const { location } = await install();
    expect(location).toBe(url('/onboarding/email'));
    expect(await storedScopes()).toEqual(PATH_B_SCOPES);
    expect(alerts.map((alert) => alert.code)).toEqual(['hubspot_install_extra_scopes']);
  });
});
