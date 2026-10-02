# hubspot-app/: the HubSpot developer-platform project

HubSpot no longer lets anyone create a legacy public app, so Autopilot's app is a developer-platform
project (D-02, HS-APP-PLATFORM). It is uploaded with the HubSpot CLI and kept here so that scopes,
the redirect URL and the webhook settings are versioned and reviewed like code.

| File | What it sets |
|---|---|
| `hsproject.json` | Project name, `srcDir`, `platformVersion: "2026.09"` |
| `src/app/app-hsmeta.json` | The app: `distribution: "marketplace"`, `auth.type: "oauth"`, redirect URL, required scopes |
| `src/app/webhooks/webhooks-hsmeta.json` | Webhook target URL, concurrency, subscriptions |

## Placeholders to replace before upload

The files use the placeholder host `autopilot.example.com`. Replace it with the host of `APP_URL`
(the production deployment). Each value must equal, byte for byte, the environment variable the app
uses at runtime:

| File and field | Placeholder | Must equal |
|---|---|---|
| `app-hsmeta.json` `config.auth.redirectUrls[0]` | `https://autopilot.example.com/api/hubspot/oauth/callback` | `HUBSPOT_REDIRECT_URI` (default `${APP_URL}/api/hubspot/oauth/callback`) |
| `webhooks-hsmeta.json` `config.settings.targetUrl` | `https://autopilot.example.com/api/hubspot/webhooks` | `HUBSPOT_WEBHOOK_TARGET_URL` (default `${APP_URL}/api/hubspot/webhooks`) |
| `app-hsmeta.json` `config.support.*` | `autopilot.example.com` addresses | The real support address and pages |

Why byte for byte:
- HubSpot's authorize request fails unless `redirect_uri` is one of `redirectUrls`. Redirect URLs must
  use HTTPS (only `http://localhost` is exempt). The CLI builds its sample install URL from
  `redirectUrls[0]`, so keep production first. A localhost URL may be added for a separate test app.
- HubSpot signs each webhook over the exact URL it calls (HS-WH-SIG-V3-URI). The verifier signs
  against `HUBSPOT_WEBHOOK_TARGET_URL`, never a URL rebuilt from request headers. Use no query string,
  no trailing slash and no redirect in front of the route.

## Scopes (D-03)

`requiredScopes` is exactly `oauth crm.objects.contacts.read forms sales-email-read`, all read-only.
It must match `REQUIRED_SCOPES` in `src/server/hubspot/scopes.ts`, which builds the install URL;
HubSpot blocks an install whose scope set differs from the app's. `test/hubspot/app-config.test.ts`
fails if the two drift apart, if a write scope appears, or if any optional scope is added.

The `forms` scope would also allow form edits. Autopilot never makes any: every HubSpot request
passes the allow-list in `src/server/security/hubspot-allow-list.ts` before it reaches the network.

If WIRE_UP finds that `sales-email-read` cannot be granted (D-03 path b), remove it from both
`requiredScopes` and `REQUIRED_SCOPES` in the same change.

## Webhooks (D-06)

- `crmObjects`: `object.creation` for `contact` (deliveries carry `subscriptionType: "object.creation"`
  and `objectTypeId: "0-1"`; the handler also accepts the classic `contact.creation`).
- `hubEvents`: `contact.privacyDeletion` (it has no generic `object.*` form).
- `maxConcurrentRequests: 10` (HubSpot requires more than 5; 10 is its default).

Settings changes can take up to 5 minutes to apply after an upload.

## Upload (WIRE_UP step 1; full steps arrive in docs/WIRE_UP.md)

```sh
npm install -g @hubspot/cli     # Node >= 20
hs account auth                 # browser flow with a personal access key
cd hubspot-app
hs project validate
hs project upload               # builds; deploys if auto-deploy is on, otherwise `hs project deploy`
hs project open                 # Auth tab: client ID and secret; Distribution tab: install URL
```

Then set `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` and `HUBSPOT_APP_ID` from the app page.
The installing HubSpot user must be a Super Admin or have App Marketplace Access.
