import { describe, expect, it } from 'vitest';
import { ConfigError } from '@/server/domain/errors';
import { isHubSpotRequestAllowed } from '@/server/security/hubspot-allow-list';
import { DEFAULT_HUBSPOT_API_VERSION, HUBSPOT_FORMS_LIST_PATH, hubSpotPaths, type HubSpotPaths } from './paths';

/** Every path in the table, with sample ids, tagged with the method the client uses. */
function allPaths(paths: HubSpotPaths): { name: string; method: 'GET' | 'POST' | 'DELETE'; path: string }[] {
  return [
    { name: 'oauthToken', method: 'POST', path: paths.oauthToken },
    { name: 'oauthIntrospect', method: 'POST', path: paths.oauthIntrospect },
    { name: 'oauthRevoke', method: 'POST', path: paths.oauthRevoke },
    { name: 'accountDetails', method: 'GET', path: paths.accountDetails },
    { name: 'uninstall', method: 'DELETE', path: paths.uninstall },
    { name: 'formsList', method: 'GET', path: paths.formsList },
    { name: 'formSubmissions', method: 'GET', path: paths.formSubmissions('b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f01') },
    { name: 'contact', method: 'GET', path: paths.contact('101') },
    { name: 'contactsSearch', method: 'POST', path: paths.contactsSearch },
    { name: 'contactEmailAssociations', method: 'GET', path: paths.contactEmailAssociations('101') },
    { name: 'contactEmailAssociationsBatchRead', method: 'POST', path: paths.contactEmailAssociationsBatchRead },
    { name: 'emailsBatchRead', method: 'POST', path: paths.emailsBatchRead },
    { name: 'emailsSearch', method: 'POST', path: paths.emailsSearch },
  ];
}

const EXCEPTIONS = new Set(['formsList', 'formSubmissions']);

describe('hubSpotPaths', () => {
  it('defaults to the 2026-09 date version', () => {
    expect(DEFAULT_HUBSPOT_API_VERSION).toBe('2026-09');
    expect(hubSpotPaths().version).toBe('2026-09');
  });

  it('builds the documented dated paths', () => {
    const paths = hubSpotPaths('2026-09');
    expect(paths.oauthToken).toBe('/oauth/2026-09/token');
    expect(paths.oauthIntrospect).toBe('/oauth/2026-09/token/introspect');
    expect(paths.oauthRevoke).toBe('/oauth/2026-09/token/revoke');
    expect(paths.accountDetails).toBe('/account-info/2026-09/details');
    expect(paths.uninstall).toBe('/appinstalls/2026-09/external-install');
    expect(paths.contact('101')).toBe('/crm/objects/2026-09/contacts/101');
    expect(paths.contactsSearch).toBe('/crm/objects/2026-09/contacts/search');
    expect(paths.contactEmailAssociations('101')).toBe('/crm/objects/2026-09/contacts/101/associations/emails');
    expect(paths.contactEmailAssociationsBatchRead).toBe('/crm/associations/2026-09/contacts/emails/batch/read');
    expect(paths.emailsBatchRead).toBe('/crm/objects/2026-09/emails/batch/read');
    expect(paths.emailsSearch).toBe('/crm/objects/2026-09/emails/search');
  });

  it('keeps exactly the two dated-version exceptions on their legacy paths', () => {
    const paths = hubSpotPaths('2026-09');
    expect(paths.formsList).toBe('/marketing/v3/forms');
    expect(HUBSPOT_FORMS_LIST_PATH).toBe('/marketing/v3/forms');
    expect(paths.formSubmissions('abc-123')).toBe('/form-integrations/v1/submissions/forms/abc-123');
  });

  it.each(['2026-09', '2026-03'])('builds every other path from HUBSPOT_API_VERSION (%s)', (version) => {
    for (const { name, path } of allPaths(hubSpotPaths(version))) {
      if (EXCEPTIONS.has(name)) continue;
      expect(path, name).toContain(`/${version}/`);
      expect(path, name).not.toMatch(/\/v\d+\//);
    }
  });

  it('never builds a /v4/ path', () => {
    for (const { path } of allPaths(hubSpotPaths())) expect(path).not.toContain('/v4/');
  });

  it('produces only paths the request allow-list accepts, with the method the client uses', () => {
    for (const { name, method, path } of allPaths(hubSpotPaths())) expect(isHubSpotRequestAllowed(method, path), name).toBe(true);
  });

  it('encodes ids as one path segment', () => {
    const paths = hubSpotPaths();
    expect(paths.contact('jane.doe+leads@example.com')).toBe('/crm/objects/2026-09/contacts/jane.doe%2Bleads%40example.com');
    expect(paths.contact('a/../../x')).toBe('/crm/objects/2026-09/contacts/a%2F..%2F..%2Fx');
  });

  it.each(['', '.', '..'])('refuses the id %j', (id) => {
    expect(() => hubSpotPaths().contact(id)).toThrow(ConfigError);
    expect(() => hubSpotPaths().formSubmissions(id)).toThrow(ConfigError);
  });

  it.each(['v3', '2026-9', '2026-09-beta', '2026/09', ''])('refuses the version %j', (version) => {
    expect(() => hubSpotPaths(version)).toThrow(ConfigError);
  });
});
