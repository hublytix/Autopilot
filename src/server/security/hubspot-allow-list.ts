import 'server-only';
import { ConfigError } from '@/server/domain/errors';
import type { HubSpotErrorCode } from '@/server/ports/hubspot';

// Law 2 (HubSpot is read-only) enforced in code (D-03). HubSpot has no read-only `forms` scope, so the
// granted scopes alone would allow form edits. Every request the HubSpot client makes passes this
// allow-list first; anything else throws ConfigError('hubspot_request_not_allowed') before any
// network call.
//
// - GET: the forms list, form submissions, one contact, a contact's email associations, account info.
// - POST: only contacts/emails `search`, emails and contact-to-email association `batch/read`, and
//   the three OAuth token endpoints.
// - DELETE: only the app uninstall.
// Dated paths must carry a `YYYY-MM` version (D-04); the only undated ones are the two exceptions
// with no dated GA version (the forms list and form submissions). POST and DELETE take no query
// string, so a secret can never travel in a URL (HS-OAUTH-TOKEN-ENDPOINT).

type AllowedMethod = 'GET' | 'POST' | 'DELETE';

interface Rule {
  readonly method: AllowedMethod;
  /** Anchored; capture groups are path segments that hold ids. */
  readonly pattern: RegExp;
}

const VERSION = String.raw`\d{4}-\d{2}`;
/** One encoded path segment: exactly the characters `encodeURIComponent` can emit. */
const SEGMENT = String.raw`([A-Za-z0-9\-_.!~*'()%]+)`;

const rule = (method: AllowedMethod, pattern: string): Rule => ({ method, pattern: new RegExp(`^${pattern}$`) });

const RULES: readonly Rule[] = [
  rule('GET', '/marketing/v3/forms'),
  rule('GET', `/form-integrations/v1/submissions/forms/${SEGMENT}`),
  rule('GET', `/crm/objects/${VERSION}/contacts/${SEGMENT}`),
  rule('GET', `/crm/objects/${VERSION}/contacts/${SEGMENT}/associations/emails`),
  rule('GET', `/account-info/${VERSION}/details`),
  rule('POST', `/crm/objects/${VERSION}/(?:contacts|emails)/search`),
  rule('POST', `/crm/objects/${VERSION}/emails/batch/read`),
  rule('POST', `/crm/associations/${VERSION}/contacts/emails/batch/read`),
  rule('POST', `/oauth/${VERSION}/token(?:/introspect|/revoke)?`),
  rule('DELETE', `/appinstalls/${VERSION}/external-install`),
];

/** An id segment must stay one segment once decoded: no `/` or `\`, and never `.` or `..`. */
function isSafeSegment(encoded: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return false;
  }
  return decoded.length > 0 && decoded !== '.' && decoded !== '..' && !/[/\\]/.test(decoded);
}

/** Whether a request (method + path, with an optional query string for GET) is on the allow-list. */
export function isHubSpotRequestAllowed(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (path.includes('#')) return false;
  const queryAt = path.indexOf('?');
  if (queryAt !== -1 && verb !== 'GET') return false;
  const pathname = queryAt === -1 ? path : path.slice(0, queryAt);
  return RULES.some((r) => {
    if (r.method !== verb) return false;
    const match = r.pattern.exec(pathname);
    return match !== null && match.slice(1).every((s) => s === undefined || isSafeSegment(s));
  });
}

/** Throws ConfigError('hubspot_request_not_allowed') unless the request is on the allow-list. */
export function assertHubSpotRequestAllowed(method: string, path: string): void {
  if (!isHubSpotRequestAllowed(method, path)) throw new ConfigError<HubSpotErrorCode>('hubspot_request_not_allowed');
}
