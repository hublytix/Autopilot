import 'server-only';

/**
 * D-03's fallback as one switch. `true` (the plan): the app asks for `sales-email-read`, so logged
 * email metadata can be read. Set it to `false` (D-03 path (b)) only if WIRE_UP check #1 finds HubSpot
 * will not grant that scope, and in the same change remove `sales-email-read` from `requiredScopes` in
 * hubspot-app/src/app/app-hsmeta.json (test/hubspot/app-config.test.ts checks the two agree). The
 * install then asks for the other three scopes only, and every email feature says "Not enough data"
 * (canReadEmails is false for every grant). test/hubspot/email-scope-path-b.test.ts runs path (b).
 */
export const ASK_FOR_EMAIL_READ_SCOPE: boolean = true;
