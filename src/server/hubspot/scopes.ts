import 'server-only';

// The HubSpot scopes and routes the app is registered with (D-02, D-03). `REQUIRED_SCOPES` builds the
// install URL and must equal `requiredScopes` in hubspot-app/src/app/app-hsmeta.json: HubSpot blocks
// an install whose scope set differs from the app's (HS-APP-HSMETA-CONFIG). All four are read-only.

/** Exactly the app's `requiredScopes`, in the same order. */
export const REQUIRED_SCOPES = ['oauth', 'crm.objects.contacts.read', 'forms', 'sales-email-read'] as const;
export type RequiredScope = (typeof REQUIRED_SCOPES)[number];

/** Reading logged email metadata needs this scope; without it email features show "Not enough data" (D-03 path b). */
export const EMAIL_READ_SCOPE = 'sales-email-read' satisfies RequiredScope;

/** The path part of `HUBSPOT_REDIRECT_URI` (the app's `redirectUrls[0]`). */
export const HUBSPOT_OAUTH_CALLBACK_PATH = '/api/hubspot/oauth/callback';

/** The path part of `HUBSPOT_WEBHOOK_TARGET_URL` (the webhooks `targetUrl`). */
export const HUBSPOT_WEBHOOK_PATH = '/api/hubspot/webhooks';

/** The required scopes missing from a token response's `scopes`, in `REQUIRED_SCOPES` order. */
export function missingRequiredScopes(granted: readonly string[]): RequiredScope[] {
  const have = new Set(granted);
  return REQUIRED_SCOPES.filter((scope) => !have.has(scope));
}

/**
 * Granted scopes beyond REQUIRED_SCOPES (law 2: no write scopes in v1). The app requests exactly
 * the required set, so any extra means the app's configuration or HubSpot's grant changed.
 */
export function extraScopes(granted: readonly string[]): string[] {
  const required = new Set<string>(REQUIRED_SCOPES);
  return [...new Set(granted)].filter((scope) => !required.has(scope));
}

/** Whether a granted scope list allows reading logged email metadata. */
export function canReadEmails(granted: readonly string[]): boolean {
  return granted.includes(EMAIL_READ_SCOPE);
}
