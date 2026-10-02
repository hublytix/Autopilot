import 'server-only';
import { ConfigError } from '@/server/domain/errors';

// Every HubSpot request path, built from HUBSPOT_API_VERSION (D-04, HS-API-VERSIONING-PATHS). No
// `/v4/` call and no v1-v3 call exists, with two exceptions that have no dated GA version yet:
// - the forms list, `GET /marketing/v3/forms` (TODO: move to the dated forms path once one is GA;
//   only `-beta` dated versions exist today and betas are never used in production);
// - form submissions, `GET /form-integrations/v1/submissions/forms/{formGuid}` (legacy, the only read
//   path; HubSpot ends v1-v3 support in September 2027, HS-API-VERSIONING).
// Paths carry no query string; callers append their own. Ids are encoded as one path segment.

export const DEFAULT_HUBSPOT_API_VERSION = '2026-09';

/** The REST host for every account; it routes to the account's hublet (HS-HUB-DOMAIN-SEMANTICS). */
export const HUBSPOT_API_ORIGIN = 'https://api.hubapi.com';

/** The consent page (HS-OAUTH-AUTHORIZE-URL). Not an API call: the browser is redirected to it. */
export const HUBSPOT_AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';

/** The dated-version exceptions (D-04), exported so tests and the allow-list name them once. */
export const HUBSPOT_FORMS_LIST_PATH = '/marketing/v3/forms';
export const HUBSPOT_SUBMISSIONS_PATH_PREFIX = '/form-integrations/v1/submissions/forms/';

const API_VERSION_PATTERN = /^\d{4}-\d{2}$/;

export interface HubSpotPaths {
  readonly version: string;
  /** POST, form-encoded: code exchange and refresh. */
  readonly oauthToken: string;
  /** POST, form-encoded: token metadata. */
  readonly oauthIntrospect: string;
  /** POST, form-encoded: revokes a refresh token. */
  readonly oauthRevoke: string;
  /** GET: timezone, UI domain, hosting location (D-12). */
  readonly accountDetails: string;
  /** DELETE: uninstalls the app from the portal (D-10). */
  readonly uninstall: string;
  /** GET: the forms list (dated-version exception). */
  readonly formsList: string;
  /** GET: one form's submissions (dated-version exception). */
  formSubmissions(formGuid: string): string;
  /** GET: one contact by record id, or by email with `idProperty=email`. */
  contact(idOrEmail: string): string;
  /** POST: contacts search (the documented intake fallback, D-07). */
  readonly contactsSearch: string;
  /** GET: one contact's associated email ids, paged (D-04, D-08). */
  contactEmailAssociations(contactId: string): string;
  /** POST: associated email ids for many contacts (D-04). */
  readonly contactEmailAssociationsBatchRead: string;
  /** POST: email metadata for up to 100 ids. */
  readonly emailsBatchRead: string;
  /** POST: email search (counts only, D-14). */
  readonly emailsSearch: string;
}

/** Encodes one id as a single path segment; `.`/`..` and empty ids are refused. */
function segment(id: string): string {
  if (id.length === 0 || id === '.' || id === '..') throw new ConfigError('hubspot_request_not_allowed');
  return encodeURIComponent(id);
}

export function isHubSpotApiVersion(version: string): boolean {
  return API_VERSION_PATTERN.test(version);
}

/** The path table for one date version (`YYYY-MM`). */
export function hubSpotPaths(version: string = DEFAULT_HUBSPOT_API_VERSION): HubSpotPaths {
  if (!isHubSpotApiVersion(version)) throw new ConfigError('hubspot_api_version_invalid');
  const crm = `/crm/objects/${version}`;
  return Object.freeze({
    version,
    oauthToken: `/oauth/${version}/token`,
    oauthIntrospect: `/oauth/${version}/token/introspect`,
    oauthRevoke: `/oauth/${version}/token/revoke`,
    accountDetails: `/account-info/${version}/details`,
    uninstall: `/appinstalls/${version}/external-install`,
    formsList: HUBSPOT_FORMS_LIST_PATH,
    formSubmissions: (formGuid: string) => `${HUBSPOT_SUBMISSIONS_PATH_PREFIX}${segment(formGuid)}`,
    contact: (idOrEmail: string) => `${crm}/contacts/${segment(idOrEmail)}`,
    contactsSearch: `${crm}/contacts/search`,
    contactEmailAssociations: (contactId: string) => `${crm}/contacts/${segment(contactId)}/associations/emails`,
    contactEmailAssociationsBatchRead: `/crm/associations/${version}/contacts/emails/batch/read`,
    emailsBatchRead: `${crm}/emails/batch/read`,
    emailsSearch: `${crm}/emails/search`,
  });
}
