import { describe, expect, it } from 'vitest';
import { ConfigError, errorCode } from '@/server/domain/errors';
import { assertHubSpotRequestAllowed, isHubSpotRequestAllowed } from './hubspot-allow-list';

// D-03: law 2 holds by behaviour, because the `forms` scope also permits writes. These tables are the
// enumerated allow-list test the decision asks for.

const ALLOWED: readonly (readonly [string, string])[] = [
  // GET: forms, submissions, contacts, associations, account info
  ['GET', '/marketing/v3/forms'],
  ['GET', '/marketing/v3/forms?formTypes=hubspot&formTypes=flow&archived=false&limit=100'],
  ['GET', '/marketing/v3/forms?formTypes=hubspot&formTypes=flow&archived=false&limit=100&after=MTAw'],
  ['GET', '/form-integrations/v1/submissions/forms/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01?limit=50'],
  ['GET', '/form-integrations/v1/submissions/forms/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01?limit=50&after=abc'],
  ['GET', '/crm/objects/2026-09/contacts/101?properties=email%2Cfirstname&associations=emails'],
  ['GET', '/crm/objects/2026-09/contacts/jane%40example.com?properties=email&idProperty=email'],
  ['GET', '/crm/objects/2026-09/contacts/101/associations/emails'],
  ['GET', '/crm/objects/2026-09/contacts/101/associations/emails?after=200'],
  ['GET', '/account-info/2026-09/details'],
  // POST: search, batch/read, the three token endpoints
  ['POST', '/crm/objects/2026-09/emails/search'],
  ['POST', '/crm/objects/2026-09/contacts/search'],
  ['POST', '/crm/objects/2026-09/emails/batch/read'],
  ['POST', '/crm/associations/2026-09/contacts/emails/batch/read'],
  ['POST', '/oauth/2026-09/token'],
  ['POST', '/oauth/2026-09/token/introspect'],
  ['POST', '/oauth/2026-09/token/revoke'],
  // DELETE: the app uninstall only
  ['DELETE', '/appinstalls/2026-09/external-install'],
  // Another date version (HUBSPOT_API_VERSION fallback 2026-03, D-04)
  ['GET', '/crm/objects/2026-03/contacts/101'],
  ['POST', '/oauth/2026-03/token'],
  // fetch normalises standard method names, so the check is case-insensitive
  ['get', '/account-info/2026-09/details'],
];

/** Every write the `forms` scope would permit (HS-SCOPES: no read-only forms scope exists). */
const FORMS_SCOPE_WRITES: readonly (readonly [string, string])[] = [
  ['POST', '/marketing/v3/forms'],
  ['PATCH', '/marketing/v3/forms/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01'],
  ['PUT', '/marketing/v3/forms/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01'],
  ['DELETE', '/marketing/v3/forms/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01'],
  ['POST', '/marketing/forms/2026-09-beta'],
  ['PATCH', '/marketing/forms/2026-09-beta/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01'],
  ['PUT', '/marketing/forms/2026-09-beta/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01'],
  ['DELETE', '/marketing/forms/2026-09-beta/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01'],
  ['POST', '/forms/v2/forms'],
  ['POST', '/forms/v2/forms/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01'],
  ['DELETE', '/forms/v2/forms/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01'],
  ['POST', '/submissions/v3/integration/secure/submit/1234567/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01'],
  ['POST', '/submissions/v3/integration/submit/1234567/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01'],
  ['POST', '/form-integrations/v1/submissions/forms/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01'],
  ['DELETE', '/form-integrations/v1/submissions/forms/b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01'],
];

const OTHER_WRITES: readonly (readonly [string, string])[] = [
  // contacts and emails
  ['POST', '/crm/objects/2026-09/contacts'],
  ['PATCH', '/crm/objects/2026-09/contacts/101'],
  ['PUT', '/crm/objects/2026-09/contacts/101'],
  ['DELETE', '/crm/objects/2026-09/contacts/101'],
  ['POST', '/crm/objects/2026-09/contacts/batch/create'],
  ['POST', '/crm/objects/2026-09/contacts/batch/update'],
  ['POST', '/crm/objects/2026-09/contacts/batch/upsert'],
  ['POST', '/crm/objects/2026-09/contacts/batch/archive'],
  ['POST', '/crm/objects/2026-09/contacts/merge'],
  ['POST', '/crm/objects/2026-09/contacts/gdpr-delete'],
  ['POST', '/crm/objects/2026-09/emails'],
  ['PATCH', '/crm/objects/2026-09/emails/501'],
  ['DELETE', '/crm/objects/2026-09/emails/501'],
  // associations
  ['PUT', '/crm/objects/2026-09/contacts/101/associations/emails/501/197'],
  ['DELETE', '/crm/objects/2026-09/contacts/101/associations/emails/501/197'],
  ['POST', '/crm/associations/2026-09/contacts/emails/batch/create'],
  ['POST', '/crm/associations/2026-09/contacts/emails/batch/archive'],
  // OAuth and installs beyond the allowed ones
  ['DELETE', '/oauth/v1/refresh-tokens/some-token'],
  ['DELETE', '/appinstalls/v3/external-install'],
];

const OTHER_REFUSED: readonly (readonly [string, string])[] = [
  // legacy or v4 versions (D-04)
  ['GET', '/crm/v3/objects/contacts/101'],
  ['GET', '/crm/v4/objects/contacts/101/associations/emails'],
  ['POST', '/crm/v3/objects/emails/search'],
  ['POST', '/crm/v4/associations/contacts/emails/batch/read'],
  ['POST', '/oauth/v1/token'],
  ['GET', '/oauth/v1/access-tokens/some-token'],
  ['GET', '/account-info/v3/details'],
  ['GET', '/marketing/forms/2026-09-beta'],
  // secrets never travel in a URL: no query string on POST or DELETE
  ['POST', '/oauth/2026-09/token?client_secret=x&refresh_token=y'],
  ['POST', '/crm/objects/2026-09/emails/search?query=subject'],
  ['DELETE', '/appinstalls/2026-09/external-install?portalId=1'],
  // wrong method on an allowed path
  ['GET', '/oauth/2026-09/token'],
  ['POST', '/account-info/2026-09/details'],
  ['DELETE', '/crm/objects/2026-09/contacts/101'],
  ['HEAD', '/marketing/v3/forms'],
  ['OPTIONS', '/marketing/v3/forms'],
  ['GET', '/appinstalls/2026-09/external-install'],
  // other objects and endpoints
  ['GET', '/crm/objects/2026-09/deals/1'],
  ['POST', '/crm/objects/2026-09/deals/search'],
  ['POST', '/crm/objects/2026-09/contacts/batch/read'],
  ['GET', '/crm/objects/2026-09/contacts/101/associations/deals'],
  ['POST', '/webhooks-journal/subscriptions/2026-09'],
  // path tricks
  ['GET', '/crm/objects/2026-09/contacts/..%2F..%2F..%2Fmarketing%2Fv3%2Fforms'],
  ['GET', '/crm/objects/2026-09/contacts/%2E%2E'],
  ['GET', '/crm/objects/2026-09/contacts/..'],
  ['GET', '/crm/objects/2026-09/contacts/a%5Cb'],
  ['GET', '/crm/objects/2026-09/contacts/101/extra'],
  ['GET', '/crm/objects/2026-09/contacts/%E0%A4%A'],
  ['GET', '/marketing/v3/forms/'],
  ['GET', '/marketing/v3/forms#fragment'],
  ['GET', '//evil.example/marketing/v3/forms'],
  ['GET', 'https://api.hubapi.com/marketing/v3/forms'],
  ['GET', 'marketing/v3/forms'],
  ['GET', ''],
];

describe('HubSpot request allow-list', () => {
  it.each(ALLOWED)('allows %s %s', (method, path) => {
    expect(isHubSpotRequestAllowed(method, path)).toBe(true);
    expect(() => assertHubSpotRequestAllowed(method, path)).not.toThrow();
  });

  it.each([...FORMS_SCOPE_WRITES, ...OTHER_WRITES, ...OTHER_REFUSED])('refuses %s %s', (method, path) => {
    expect(isHubSpotRequestAllowed(method, path)).toBe(false);
    let thrown: unknown;
    try {
      assertHubSpotRequestAllowed(method, path);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(errorCode(thrown)).toBe('hubspot_request_not_allowed');
  });

  it('refuses every PUT and PATCH, whatever the path', () => {
    for (const [, path] of ALLOWED) {
      expect(isHubSpotRequestAllowed('PUT', path)).toBe(false);
      expect(isHubSpotRequestAllowed('PATCH', path)).toBe(false);
    }
  });
});
