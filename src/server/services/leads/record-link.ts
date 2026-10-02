import 'server-only';

// The contact's record page in HubSpot (D-12, D-31): `https://{uiDomain}/contacts/{portalId}/record/0-1/{contactId}`.
// `uiDomain` is the account's UI domain from HubSpot's account details (app.hubspot.com,
// app-eu1.hubspot.com, …); only a HubSpot host is used, so a stored value can never point an email
// link elsewhere. Ids are HubSpot's numeric ids.

const HUBSPOT_UI_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*hubspot\.com$/i;
const NUMERIC_ID = /^\d{1,20}$/;

export const DEFAULT_HUBSPOT_UI_DOMAIN = 'app.hubspot.com';

/** The record URL, or null when the portal or contact id is unusable. */
export function hubspotContactRecordUrl(uiDomain: string | null, portalId: string | null, contactId: string | null): string | null {
  if (portalId === null || contactId === null || !NUMERIC_ID.test(portalId) || !NUMERIC_ID.test(contactId)) return null;
  const host = uiDomain !== null && HUBSPOT_UI_HOST.test(uiDomain) ? uiDomain.toLowerCase() : DEFAULT_HUBSPOT_UI_DOMAIN;
  return `https://${host}/contacts/${portalId}/record/0-1/${contactId}`;
}
