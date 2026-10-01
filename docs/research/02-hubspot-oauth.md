## 02. HubSpot app platform, OAuth, scopes, tokens, account details, uninstall, versioning, rate limits

The official sources below are HubSpot's public OpenAPI spec collection (@476fa1a, 2026-10-01), the `hubspot-project-components` templates (@233e986), the HubSpot CLI 8.15.0 source, the Node SDKs (`@hubspot/api-client` 14.0.1, `@hubspot/sdk` 0.1.0-alpha.10) and `oauth-quickstart-nodejs`. The sandbox could not fetch developers.hubspot.com, community.hubspot.com or legacydocs.hubspot.com, so pages on those sites are cited through search summaries or through a verbatim third-party scrape (teostereciu/mcpsynth, scraped 2026-04-13, of pages last modified 2026-03-30/31), and both kinds are labelled as such. The sources **correct** the brief in six places:
1. Legacy public apps can no longer be created. The app must be a developer-platform project built with the HubSpot CLI (`platformVersion` `2026.09`, `distribution` `marketplace`, `auth.type` `oauth`).
2. The brief's minimum scope set is not enough. `requiredScopes` must be `oauth crm.objects.contacts.read forms sales-email-read`, because every email-engagement read in §5.6–5.9 needs `sales-email-read`.
3. The token-metadata `hub_domain` is the customer's website domain. Store `uiDomain`, `timeZone`, `utcOffsetMilliseconds` and `dataHostingLocation` from `GET /account-info/2026-09/details` (scope `oauth`).
4. HubSpot never pushes an uninstall webhook. An uninstall shows up only in the pull-based Webhooks Journal (`APP_LIFECYCLE_EVENT` `4-1916193`) or as a refresh that fails with HTTP 400 `invalid_grant` / `BAD_REFRESH_TOKEN` (or `BAD_HUB` / `access_denied`).
5. Every call should use a date-versioned path (`/oauth/2026-09/token`, `/crm/objects/2026-09/...`). The OAuth v1 endpoints stop working on 2027-02-16, v4 APIs become unsupported on 2027-03-30, and v1–v3 APIs become unsupported in September 2027.
6. The official Node client `@hubspot/api-client` still calls legacy paths, so `HubSpotClient` should use plain `fetch` with Zod.

The brief's revoked-vs-transient refresh model is **confirmed**, with the exact error body below. It is **extended** with a third `config` class (`invalid_client` and similar errors) so that a rotated client secret can never mass-revoke portals. The transient set also grows to 423, 477 and 5xx, including 521–526.

Other **extensions**:
- Disconnect must call `DELETE /appinstalls/2026-09/external-install` and then revoke the refresh token. Revocation does not invalidate an access token that was already issued, which can stay valid for up to 30 minutes.
- Marketplace-distribution apps are capped at 25 installs until they are listed. This blocks launch beyond 25 portals.
- The person installing must be a Super Admin or have the App Marketplace Access permission.
- Rate limits are 110 requests per 10 s per installing portal, plus 5 requests/s for CRM search.

### HS-APP-PLATFORM — New apps must be developer-platform projects; legacy public apps can no longer be created
- **Brief:** §10 WIRE_UP step 1: "Create the HubSpot public app (scopes, redirect URL, webhook URL and subscriptions)". This assumes the legacy public app created in the UI.
- **Verdict:** Corrected — high confidence. The platform, template and CLI facts come from official source code. The dates rest on search summaries of official changelog pages, corroborated by several independent community sources.
- **Finding:** Legacy public apps can **no longer be created**. HubSpot permanently disabled creating legacy public apps in the developer UI:
  - for developer accounts created on or after 2026-05-26, it was disabled on 2026-05-26;
  - for accounts created before that date, it was disabled on 2026-06-23.

  Existing legacy public apps keep working. On 2026-09-15 HubSpot announced that legacy public apps (and v1–v3 APIs) are unsupported, with a September 2027 enforcement date (no day published). After that date, marketplace apps still on the legacy architecture become eligible for delisting.

  A new multi-account app must be a **project** on the HubSpot developer platform, built and uploaded with the HubSpot CLI:
  - `hsproject.json` = `{"name": "...", "srcDir": "src", "platformVersion": "2026.09"}`;
  - exactly one app component, at `src/app/app-hsmeta.json`, with `"type": "app"`, `config.distribution` `"marketplace"` and `config.auth.type` `"oauth"`. For `distribution` `marketplace` the only valid `auth.type` is `oauth`, and the CLI hard-codes that rule.

  Platform versions:
  - `2025.1`: sunset on 2026-08-01;
  - `2025.2`: supported through March 2027;
  - `2026.03`: supported;
  - `2026.09`: GA on 2026-09-08 and current.

  `@hubspot/project-parsing-lib` 0.23.4 lists `2025.1` under `DEPRECATED_PLATFORM_VERSIONS` and already includes `2027.03`. HubSpot CLI 8.15.0 (2026-09-16) offers these `--platform-version` choices: `2025.2`, `2026.03-beta`, `2026.03`, `2026.09-beta`, `2026.09`, `2027.03-beta`. The default is `2026.09`. **Use `platformVersion` `2026.09`.**

  Verifier addition (community, usertour ADR): HubSpot is also removing UI creation of private apps (accounts created from 2026-09-28 lose it on that date; existing accounts lose it on 2026-10-26). WIRE_UP must not offer any UI-created app path.
- **Design consequence:** Rewrite WIRE_UP step 1 as a CLI/project flow, since no "Create app" button exists for legacy public apps. Keep the HubSpot app config in the repo, so scopes, redirect URLs and webhook settings are version-controlled and reviewed:
  - `hubspot-app/hsproject.json`
  - `hubspot-app/src/app/app-hsmeta.json`
  - `hubspot-app/src/app/webhooks/webhooks-hsmeta.json`

  Record in DECISIONS.md that the brief's "public app" becomes a 2026.09 marketplace OAuth project.
- **Open risk:** Platform 2026.09 is new. If a feature misbehaves, fall back to 2026.03, which uses an identical `app-hsmeta.json` template. All the dated statements come only from search summaries: the creation sunset, the 2026-09-15 announcement, the September 2027 enforcement, the 2025.1 sunset, the 2025.2 support window and the 2026.09 GA date. At WIRE_UP, re-check the changelog and versioning pages live, along with the community-only private-app UI removal dates.
- **Sources:**
  - https://developers.hubspot.com/changelog/legacy-public-app-creation-sunset — official page via search summary — direct fetch blocked in sandbox — "Beginning May 26, 2026, the ability to create new legacy public apps via the Developer Platform UI will be permanently disabled ... existing accounts created before that date had it disabled as of June 23, 2026." / "Existing legacy public apps are not affected by this change and will continue to function as-is."
  - https://developers.hubspot.com/changelog/legacy-apis-and-legacy-apps-whats-going-unsupported-and-when — official page via search summary — direct fetch blocked in sandbox — "announced September 15, 2026 (Fall Spotlight): end of support for v1-v3 APIs, legacy public apps and legacy private apps, all with a September 2027 enforcement date; 'Running on legacy app architecture (pre-Projects) after September 2027: your app is eligible for delisting.'"
  - https://github.com/HubSpot/hubspot-project-components/blob/main/2026.09/defaultFiles/hsproject.json — official SDK source — `{"name": "My Project", "srcDir": "src", "platformVersion": "2026.09"}`
  - https://github.com/HubSpot/hubspot-project-components/blob/main/2026.09/defaultFiles/CLAUDE.md — official SDK source — "There can only be one `app` component" / "`app` component must be in the `app` directory" / "If the `config.distribution` field is set to `marketplace`, the only valid `config.auth.type` value is `oauth`"
  - https://github.com/HubSpot/hubspot-cli/blob/main/commands/project/create.ts — official SDK source — "'platform-version': { choices: [v2025_2, v2026_03_BETA, v2026_03, v2026_09_BETA, v2026_09, v2027_03_BETA], default: PLATFORM_VERSIONS.v2026_09 }" (@hubspot/cli 8.15.0, commit c12a006, 2026-09-16)
  - https://developers.hubspot.com/docs/developer-tooling/platform/versioning — official page via search summary — direct fetch blocked in sandbox — "Platform version 2026.09 was released on September 8th, 2026"; "Version 2025.1 was sunset on August 1, 2026"; "Apps on version 2025.2 are supported through March 2027".
  - https://registry.npmjs.org/@hubspot/project-parsing-lib/-/project-parsing-lib-0.23.4.tgz (src/lib/constants.js) — official SDK source — "export const DEPRECATED_PLATFORM_VERSIONS = { v2025_1: '2025.1', }; // Supported Project Platform Versions export const PLATFORM_VERSIONS = { ... v2026_09: '2026.09', v2027_03_BETA: '2027.03-beta', v2027_03: '2027.03', UNSTABLE: 'unstable', };"
  - https://github.com/HubSpot/hubspot-cli/blob/main/lib/projects/create/v2.ts — official SDK source — "if (distribution === marketplaceDistribution) { // This is the only valid auth type for marketplace authType = oAuth; }"
  - https://github.com/prismatic-io/components/blob/ad372497f8e1f02e9e2f2fd55ae562b5b1d471bd/components/hubspot/documentation/connections/oauth2.mdx — community, non-authoritative — "As of **June 23, 2026**, legacy public apps can no longer be created. HubSpot disabled creation for developer accounts created on or after **May 26, 2026** first, then for all remaining accounts on **June 23, 2026**."
  - https://github.com/apideck-libraries/api-skills/blob/fbc259a0a50d78debe6ab97f3a3a772f4101699b/skills/hubspot/SKILL.md — community, non-authoritative — "legacy public app creation was disabled for all accounts on June 23, 2026. New apps are built on the Projects-based platform; existing apps keep working."
  - https://github.com/usertour/usertour/blob/ae33fbe63f77933129beb71e8fbdfbf2e35323d5/docs/adr/0013-crm-sync.md — community, non-authoritative — "HubSpot is removing UI creation of private apps (new accounts 2026-09-28, existing 2026-10-26). Legacy public apps cannot be created since 2026-06-23. New apps are **project-based** (HubSpot CLI, `app-hsmeta.json`) and, for multi-account distribution, **OAuth**."
  - https://github.com/jameskomo/docswatcher/blob/71d48dbf8cd4fcb842e489b2076e5469792944f2/knowledge/providers/hubspot/changes/hubspot-v1-v3-apis-unsupported-2027.yaml — community, non-authoritative — "url: https://developers.hubspot.com/changelog/legacy-apis-and-legacy-apps-whats-going-unsupported-and-when observed: 2026-09-24 note: \"Enforcement: September 2027; no day is published.\""

### HS-APP-HSMETA-CONFIG — `app-hsmeta.json` (auth, scopes, redirect URLs, distribution) and `webhooks-hsmeta.json` shapes
- **Brief:** not addressed.
- **Verdict:** Extended — high confidence.
- **Finding:** This is HubSpot's official "OAuth Marketplace App" template. It is byte-identical (md5 `22db124b5801ed05fd2b0b5c79a21834`) in 2025.2, 2026.03, 2026.09 and 2027.03-beta:
  ```json
  {"uid":"sample_oauth_marketplace_app","type":"app","config":{"description":"...","name":"...","distribution":"marketplace","auth":{"type":"oauth","redirectUrls":["http://localhost:3000"],"requiredScopes":["oauth","crm.objects.contacts.read","crm.objects.contacts.write"],"optionalScopes":[],"conditionallyRequiredScopes":[]},"permittedUrls":{"fetch":["https://api.hubapi.com"],"iframe":[],"img":[]},"support":{"supportEmail":"...","documentationUrl":"...","supportUrl":"...","supportPhone":"..."}}}
  ```
  Rules:
  - `uid` must be unique within the project and at most 64 characters (`MAX_UID_LENGTH = 64` in the official parser).
  - Config file names must end in `-hsmeta.json`.
  - Each redirect URL must use HTTPS. The only exception is `http://localhost`.
  - Scopes in the install URL:
    - every `requiredScopes` entry must appear in the install URL's `scope` parameter;
    - `optionalScopes` go in `optional_scope`;
    - `conditionallyRequiredScopes`, when requested, must be in `scope`, not in `optional_scope`.
  - Any mismatch blocks the install ("mismatch between the scopes in the install URL and the app's configured scopes").
  - To change redirect URLs or scopes, edit the file and run `hs project upload`.

  The webhooks feature (one per app) lives at `src/app/webhooks/webhooks-hsmeta.json`:
  ```json
  {"uid":"webhooks","type":"webhooks","config":{"settings":{"targetUrl":"https://example.com/webhook","maxConcurrentRequests":10},"subscriptions":{"crmObjects":[{"subscriptionType":"object.creation","objectType":"contact","active":false}],"legacyCrmObjects":[{"subscriptionType":"contact.propertyChange","propertyName":"lastname","active":false},{"subscriptionType":"contact.deletion","active":false}],"hubEvents":[{"subscriptionType":"contact.privacyDeletion","active":false}]}}}
  ```
  This is abbreviated. The official template has a second `crmObjects` entry, `{"subscriptionType":"object.propertyChange","objectType":"contact","propertyName":"firstname","active":false}`.

  **Proposed Autopilot `app-hsmeta.json`:**
  - `distribution` `"marketplace"`, `auth.type` `"oauth"`;
  - `redirectUrls` `["https://<APP_DOMAIN>/api/hubspot/oauth/callback"]`, plus `"http://localhost:3000/api/hubspot/oauth/callback"` for development;
  - `requiredScopes` `["oauth","crm.objects.contacts.read","forms"]` plus the email-read scope from HS-SCOPES (`sales-email-read`);
  - `optionalScopes` `[]`, `conditionallyRequiredScopes` `[]`;
  - `permittedUrls` all empty arrays (no UI extensions).

  **Proposed webhooks config:** `targetUrl` `"https://<APP_DOMAIN>/api/hubspot/webhooks"`, with one of these two subscription forms:
  - `legacyCrmObjects` `[{"subscriptionType":"contact.creation","active":true}]`: the classic `contact.creation` payload, which matches brief §5.2;
  - `crmObjects` `[{"subscriptionType":"object.creation","objectType":"contact","active":true}]`.

  Verifier note: with the `crmObjects` / `object.creation` form, deliveries carry `subscriptionType` `object.creation` and `objectTypeId` `0-1`, not `contact.creation`. Pick one form and keep it in step with the webhook-handler parser (webhooks section). One app may declare several redirect URLs (production, staging, `http://localhost`), as a real 2026.03 marketplace project does.
- **Design consequence:** Commit the hsmeta files, and have WIRE_UP replace `<APP_DOMAIN>`. The OAuth start route builds `scope` from exactly the `requiredScopes` list. A single constant is shared by the code and by a test that diff-checks it against `app-hsmeta.json`.
- **Open risk:** HubSpot validates the hsmeta schemas server-side per platform version, fetching them from `project-components-external/project-schemas/v3/{platformVersion}`. Run `hs project validate` before every upload. Two rules rest only on search summaries plus a community code comment: HTTPS except localhost, and the install-blocking scope mismatch. Confirm both on the first test install.
- **Sources:**
  - https://github.com/HubSpot/hubspot-project-components/blob/main/2026.09/components/app/oauth-marketplace/src/app/app-hsmeta.json — official SDK source — `"distribution" :"marketplace", "auth": { "type" : "oauth", "redirectUrls": ["http://localhost:3000"], "requiredScopes": ["oauth", "crm.objects.contacts.read", "crm.objects.contacts.write"], "optionalScopes": [], "conditionallyRequiredScopes": [] }`
  - https://github.com/HubSpot/hubspot-project-components/blob/main/2026.09/components/webhooks/src/app/webhooks/webhooks-hsmeta.json — official SDK source — `"settings": { "targetUrl": "https://example.com/webhook", "maxConcurrentRequests": 10 }` / `"crmObjects": [ { "subscriptionType": "object.creation", "objectType": "contact", "active": false }, { "subscriptionType": "object.propertyChange", "objectType": "contact", "propertyName": "firstname", "active": false } ]`
  - https://developers.hubspot.com/docs/apps/developer-platform/build-apps/app-configuration — official page via search summary — direct fetch blocked in sandbox — "Each redirect URL must use HTTPS, with the only exception being that http://localhost is allowed for testing"; uid "can be any string up to 64 characters".
  - https://developers.hubspot.com/changelog/advanced-auth-and-scope-settings-for-public-apps — official page via search summary — direct fetch blocked in sandbox — conditionally required scopes "can only be in the scope parameter"; optional scopes "are included in the optional_scope query parameter"; including scopes not in app settings causes a mismatch error that blocks install.
  - https://registry.npmjs.org/@hubspot/project-parsing-lib/-/project-parsing-lib-0.23.4.tgz (src/lib/uid.js) — official SDK source — `export const MAX_UID_LENGTH = 64;`
  - https://github.com/usertour/usertour/blob/ae33fbe63f77933129beb71e8fbdfbf2e35323d5/integrations/hubspot/src/app/app-hsmeta.json — community, non-authoritative — `"distribution": "marketplace", "auth": { "type": "oauth", "redirectUrls": [ "https://app.usertour.io/api/integrations/hubspot/oauth/callback", "https://staging.usertour.io/api/integrations/hubspot/oauth/callback", "http://localhost:5174/api/integrations/hubspot/oauth/callback" ], ...` (platformVersion "2026.03")
  - https://github.com/usertour/usertour/blob/ae33fbe63f77933129beb71e8fbdfbf2e35323d5/apps/server/src/modules/integrations/sync/hubspot-api.ts — community, non-authoritative — "Must equal `requiredScopes` in integrations/hubspot/src/app/app-hsmeta.json — * HubSpot refuses an authorize request whose scope set differs from the app's."

### HS-CLI-WORKFLOW — CLI commands, and where the client ID, client secret and install URL appear
- **Brief:** not addressed.
- **Verdict:** Extended — high confidence. The CLI behaviour is verified against the CLI 8.15.0 source. The Auth-tab UI location rests on search summaries plus community sources.
- **Finding:**
  1. Install Node >= 20 (`@hubspot/cli` 8.15.0 declares `engines` `node>=20`), then run `npm install -g @hubspot/cli`.
  2. Run `hs account auth`. This is a browser flow in which you paste a personal access key; `hs init` creates the config.
  3. Create the project non-interactively: `hs project create --name hublytix-autopilot --dest hubspot-app --platform-version 2026.09 --project-base app --distribution marketplace --auth oauth --features webhooks`.
     - CLI choices: `--project-base empty|app`, `--distribution private|marketplace`, `--auth oauth|static`.
     - `--features` takes a component type or `cliSelector`, such as `webhooks`. The 2026.09 `config.json` declares a `webhooks` component that supports `oauth` + `marketplace`.
  4. Edit `src/app/app-hsmeta.json` and `src/app/webhooks/webhooks-hsmeta.json`, then run `hs project validate`.
  5. Run `hs project upload`, which uploads and builds. The build deploys automatically when auto-deploy is enabled; otherwise run `hs project deploy`. Release management (`hs project release create --build=<id>`) applies only to builds on platform >= 2027.03.
  6. Run `hs project open`, or go to Development > Projects > the project. Under **Project components**, click the app UID.
     - **Auth** tab: "Client ID" and "Client secret" under "Client credentials", and the configured Redirect URL at the bottom of the page.
     - **Distribution** tab: install options and a sample install URL for marketplace apps ("Install now" for a standard install).
     - The CLI builds the install URL as `https://app.hubspot.com/oauth/{targetAccountId}/authorize?client_id=...&scope=<space-joined requiredScopes>&redirect_uri=<redirectUrls[0]>`.
  7. Test in a developer test account (`hs test-account create`) before using a real portal. Monitoring and logs are at `https://app.hubspot.com/developer-monitoring/{accountId}/?logType=...&appId=...`.
- **Design consequence:** WIRE_UP step 1 becomes the numbered CLI commands above, plus screenshots of the Auth and Distribution tabs. Environment variables:
  - `HUBSPOT_CLIENT_ID`;
  - `HUBSPOT_CLIENT_SECRET`, which also signs v3 webhooks;
  - `HUBSPOT_REDIRECT_URI`;
  - `HUBSPOT_APP_ID`, shown on the app page. The verifier corrected this one: it is **not** needed for the Webhooks Journal, because the client-credentials token is already app-scoped. It is only useful for the monitoring and log URLs.
- **Open risk:** The exact UI labels may shift between platform releases. The Auth-tab location of the client ID and secret is backed by search summaries plus Prismatic, not by a fetched official page. The step-9 screenshot checklist should capture these labels.
- **Sources:**
  - https://github.com/HubSpot/hubspot-project-components/blob/main/2026.09/defaultFiles/CLAUDE.md — official SDK source — "hs project create - Create a new HubSpot project interactively" / "hs project upload - Upload the project to HubSpot (build is created automatically)" / "hs project deploy - Deploy a specific build of the project to make it live" / "hs account auth - Authenticate a new account (requires browser interaction)"
  - https://github.com/HubSpot/hubspot-cli/blob/main/lib/constants.ts — official SDK source — "export const staticAuth = 'static'; export const oAuth = 'oauth'; export const privateDistribution = 'private'; export const marketplaceDistribution = 'marketplace'; export const EMPTY_PROJECT = 'empty'; export const PROJECT_WITH_APP = 'app';"
  - https://github.com/HubSpot/hubspot-cli/blob/main/lib/app/urls.ts — official SDK source — "`${websiteOrigin}/oauth/${targetAccountId}/authorize` + `?client_id=${encodeURIComponent(clientId)}` + `&scope=${encodeURIComponent(scopes.join(' '))}` + `&redirect_uri=${encodeURIComponent(redirectUrls[0])}`"
  - https://github.com/HubSpot/hubspot-cli/blob/main/commands/project/upload.ts — official SDK source — "if (meetsMinimumPlatformVersion(result.buildResult.platformVersion, PLATFORM_VERSIONS.v2027_03)) { const releaseCommand = `hs project release create --build=${result.buildId}` ...; (!result.buildResult.isAutoDeployEnabled || preview || skipAutoDeploy)"
  - https://developers.hubspot.com/docs/apps/developer-platform/build-apps/create-an-app — official page via search summary — direct fetch blocked in sandbox — "Run hs project open ... Under \"Project Components,\" click the app name, then click the Auth tab to find and copy the Client ID and Client secret under \"Client credentials\"".
  - https://developers.hubspot.com/docs/apps/developer-platform/build-apps/manage-apps-in-hubspot — official page via search summary — direct fetch blocked in sandbox — "click the Auth tab on the app details page. Your app's Client ID and Client secret will appear in the Client credentials section"; "For marketplace apps, you can use the sample install URL to install your app in any account."
  - https://github.com/HubSpot/hubspot-cli/blob/main/lib/prompts/selectProjectTemplatePrompt.ts — official SDK source — "if ( promptOptions.features?.includes( template.value.cliSelector || template.value.type ) ) {"
  - https://github.com/HubSpot/hubspot-project-components/blob/main/2026.09/config.json — official SDK source — `{"path": "components/webhooks", "type": "webhooks", "label": "Webhook", "parentType": "app", "supportedAuthTypes": ["oauth", "static"], "supportedDistributions": ["private", "marketplace"]}`
  - https://github.com/prismatic-io/components/blob/ad372497f8e1f02e9e2f2fd55ae562b5b1d471bd/components/hubspot/documentation/connections/oauth2.mdx — community, non-authoritative — "6. Open the project in the HubSpot developer portal: hs project open 7. Navigate to the **Auth** tab in the developer portal 8. Copy the **Client ID** and **Client Secret** from the Auth page"

### HS-MARKETPLACE-INSTALL-CAP — 25-install cap until listed; listing and certification rules to build for now
- **Brief:** §1, §4.1, §11: marketplace listing assets are out of scope for v1, and the marketplace name is undecided.
- **Verdict:** Extended — medium confidence. The install caps and listing rules are **not officially documented in any fetched page**: they rest on search summaries of official changelog pages plus several independent community sources. Only the deprecation of the v3 uninstall path comes from the official spec.
- **Finding:** Distribution constraints for a paid multi-portal launch (developer platform 2025.2+):
  - **Marketplace distribution:** apps are capped at **25 installs until the Marketplace listing is approved** (enforced from 2025-09-22).
  - **Private distribution:** apps are capped at **10 allowlisted accounts** (100 for Solutions Partners). They get the private-app rate tiers, not the 110/10 s OAuth limit (see HS-V4-PRIVATE-DISTRIBUTION-LIMITS).
  - Beyond 25 paying portals the app **must** be listed. This is a launch blocker even though listing assets are out of scope for v1.

  Listing and certification rules to build for now:
  - OAuth as the sole auth method.
  - Date-versioned OAuth endpoints: `/oauth/2026-03` or later. Use `/oauth/2026-09/token`, `/oauth/2026-09/token/introspect` and `/oauth/2026-09/token/revoke`.
  - The Uninstall App API on disconnect. The May-2026 listing rule names `DELETE /appinstalls/v3/external-install`, but the spec marks v3 `"deprecated": true` (the 2026-03 and 2026-09 paths are not deprecated), so call `DELETE /appinstalls/2026-09/external-install`.
  - A security questionnaire on token storage, encryption and lifecycle.
  - Error responses must stay under 5% of daily requests.
  - A supported developer platform version (2026.09). Community-reported floor: from 2026-11-02, listed and certified apps must be on a supported platform. 2025.2 and 2026.03 are named; 2026.09 is newer.

  **Listing risk:** apps that "primarily connect HubSpot to external generative AI tools" must use user-level permissions and HubSpot's MCP Server. Autopilot should be described in the listing as a lead-response product, not an AI connector (see HS-V3-INSTALLER-PERMISSION-AND-AI-LISTING).

  Installing users must be a Super Admin or have the App Marketplace Access permission.
- **Design consequence:** Flag the 25-install cap in DECISIONS.md and the README as a launch blocker beyond 25 paying portals. Build to the listing rules now:
  - dated OAuth endpoints;
  - the uninstall API on disconnect;
  - encrypted tokens;
  - an error rate under 5%, which means not hammering revoked portals.
- **Open risk:** The install-cap numbers, the May-2026 certification rules, the AI-connector rule and the 2026-11-02 platform floor all come from changelog search summaries or community sources. At WIRE_UP, re-check live: the `new-marketplace-distribution-app-install-limits` changelog, the `app-listing-and-app-certification-requirement-updates-for-may-2026` changelog, and the App Marketplace listing-requirements page.
- **Sources:**
  - https://developers.hubspot.com/changelog/new-marketplace-distribution-app-install-limits — official page via search summary — direct fetch blocked in sandbox — "Starting on September 22nd, 2025, apps that are created or migrated to version 2025.2 are capped at 25 installs until they are listed on the HubSpot Marketplace." Private distribution: 10 portals (100 in a Solutions Partner portal).
  - https://developers.hubspot.com/changelog/app-listing-and-app-certification-requirement-updates-for-may-2026 — official page via search summary — direct fetch blocked in sandbox — "all new app listings, certification submissions, and apps undergoing recertification must use the new OAuth v3 endpoints ... POST /oauth/2026-03/token ... /token/introspect ... /token/revoke"; "your app must use the Uninstall App API endpoint: DELETE /appinstalls/v3/external-install"; security questionnaire.
  - https://raw.githubusercontent.com/Namit2111/Agent-Jivus/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/usage-details/content.txt — community, non-authoritative (2024 scrape of developers.hubspot.com usage guidelines) — "Requests resulting in an error response shouldn't exceed 5% of your total daily requests. If you plan on listing your app in the HubSpot App Marketplace, it must stay under this 5% limit to be certified." / "For OAuth apps, each HubSpot account that installs your app is limited to 110 requests every 10 seconds. This excludes the Search API"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/App%20Uninstalls/Rollouts/209039/v3/appUninstalls.json — official OpenAPI spec — `"operationId": "delete-/appinstalls/v3/external-install", ... "deprecated": true, "security": []`
  - https://github.com/amp-labs/docs/blob/05be21240898856b6134363e7741dfe9d63cda3d/src/provider-guides/hubspot.mdx — community, non-authoritative — "New Project Apps are [limited to 25 installs](https://developers.hubspot.com/changelog/new-marketplace-distribution-app-install-limits), until the app is listed on the HubSpot Marketplace."
  - https://github.com/Mrjoel97/ProjectX/blob/53d96a263f055e14bbb1c6a1a35c6d7bb58c9652/docs/connectors/hubspot-suitability.md — community, non-authoritative — "if your app is an AI connector - an app that primarily connects HubSpot to external generative AI > tools - it must require user-level permissions and be built with HubSpot's MCP Server" / "From **2026-11-02**, listed/certified apps must be on developer platform v2025.2 or v2026.03; legacy and Projects 2023.2/2025.1 apps \"will be rejected for new listings\" (changelog 2026-05-07)."
  - https://github.com/SynthmindsLLC/SynthBrain/blob/b74b687714ee3991706775d1a59e14d6e687ab30/%F0%9F%9B%A0%20The%20Workshop/Tools%20Documentation/Notes%20%26%20API%20Docs/Hubspot%20API%20Documentation/api/working-with-oauth.md — community, non-authoritative (mirror of developers.hubspot.com working-with-oauth) — "users installing apps in their HubSpot account must either be a [super admin](...) or have [App Marketplace Access](...) permissions."
  - https://github.com/usertour/usertour/blob/ae33fbe63f77933129beb71e8fbdfbf2e35323d5/docs/adr/0013-crm-sync.md — community, non-authoritative — "Distribution ladder for an OAuth app: at most 10 allowlisted accounts while private; 25 installs once submitted for the App Marketplace; unlimited after listing approval."

### HS-SCOPES — Minimum read-only scope set: add `sales-email-read`
- **Brief:** §5.1: minimum scopes `oauth`, `crm.objects.contacts.read`, `forms`.
- **Resolves:** [VERIFY] §5.1 minimum scopes
- **Verdict:** Corrected — high confidence. The confidence rests on spec security blocks **plus** corroboration from the official changelog search summary, Airbyte's production connector and community findings, because the spec security blocks alone are not reliable.
- **Finding:** Read-only scopes for Autopilot, used both as `requiredScopes` and as the install-URL `scope` (space-separated): **`oauth crm.objects.contacts.read forms sales-email-read`**.
  - **`oauth`:** treat it as mandatory.
    - It is in `requiredScopes` in every official 2026.09 app template (oauth-marketplace, oauth-private, static-private).
    - The spec describes it as "Basic HubSpot account information".
    - It is the scope for `GET /account-info/2026-09/details` in rollout 144923, and for Airbyte's `account_details` stream.
    - The install URL must contain every required scope, and Prismatic documents `oauth` as "Required for all OAuth apps (cannot be removed)".
    - HubSpot's old legacy-app quickstart requested only `crm.objects.contacts.read`, but that does not apply on the developer platform.
  - **`crm.objects.contacts.read`:** covers these calls:
    - contacts list, get, batch-read and search (`/crm/objects/2026-09/contacts...`);
    - contact→email associations: `GET /crm/objects/2026-09/contacts/{id}/associations/emails` and `POST /crm/associations/2026-09/contacts/emails/batch/read` accept this scope alone;
    - contact webhooks.
  - **`forms`:** covers these calls:
    - `GET /marketing/v3/forms` (tier FREE). There is no GA dated version; the betas are `/marketing/forms/2026-09-beta` and `/marketing/forms/2027-03-beta`.
    - The legacy `GET /form-integrations/v1/submissions/forms/{formGuid}`. This is not in the spec collection; the scope comes from Airbyte (`required_scopes: forms`) and the legacy docs page.
  - **`sales-email-read`** (together with `crm.objects.contacts.read`): reads CRM email engagements (`/crm/objects/2026-09/emails`, `/search`, `/batch/read`).
    - Without it, email engagements are inaccessible (403 `MISSING_SCOPES`) or their details are redacted ("records with the EMAIL, INCOMING_EMAIL, or FORWARDED_EMAIL type redacted").
    - It is needed for §5.6 reply detection via logged `INCOMING_EMAIL`, the §5.7 inbox-logging check, the §5.8 baseline and the §5.9 "sends confirmed in HubSpot" line.
  - **Optional, only if owner data is needed:** `crm.objects.owners.read`. The owners endpoints also accept `automation`.

  **The brief's minimum set (`oauth`, `crm.objects.contacts.read`, `forms`) is insufficient for §5.6–5.9 and must add `sales-email-read`.** All four scopes are read-only, so law 2 holds.

  Caveat on the spec security blocks. Scopes inside one OpenAPI requirement object are ANDed, and separate objects are ORed. The emails spec in rollout 424/2026-09 has the AND group `[{"oauth2": ["crm.objects.contacts.read", "sales-email-read"]}]` on GET, search, batch-read and `{objectId}`. However, the security blocks are not a reliable statement of the minimum scope:
  - the 424 emails specs for v3, 2025-09 and 2026-03 have an empty security block (`[]`);
  - rollout 321895 lists 79 ORed alternatives for `GET /crm/objects/2026-09/contacts`, including unrelated scopes such as `crm.objects.deals.read` and `media_bridge.read`;
  - the generic CRM/Objects 424 spec lists `crm.objects.emails.read` for v3, 2025-09 and 2026-03 but drops it in 2026-09;
  - the repo README says the specs are "intended solely for HubSpot's internal use".

  The scope needed for the `contact.creation` webhook subscription is covered in the webhooks section, not here.
- **Design consequence:** A single `REQUIRED_SCOPES` constant drives the install URL, the `app-hsmeta.json` diff test and the post-install check, which compares against the token response `scopes`. If the email-read scope is not granted, the inbox-logging check, the baseline and the report must show "not enough data" (law 3) and never estimate.
- **Open risk:** Whether `sales-email-read` can actually be granted to a 2026.09 marketplace app is documented by community sources only (see HS-SCOPE-EMAIL-READ-RISK). The `forms` scope for form submissions comes from the legacy docs and Airbyte, not from the spec. At WIRE_UP, confirm both on a test install.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Contacts/Rollouts/424/2026-09/contacts.json — official OpenAPI spec — `POST /crm/objects/2026-09/{objectType}/search security: [{"oauth2": ["crm.objects.contacts.read"]}, {"private_apps": ["crm.objects.contacts.read"]}]`
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Emails/Rollouts/424/2026-09/emails.json — official OpenAPI spec — `GET /crm/objects/2026-09/{objectType}/{objectId} security: [{"oauth2": ["crm.objects.contacts.read", "sales-email-read"]}, {"private_apps": ["crm.objects.contacts.read", "sales-email-read"]}]`
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Emails/Rollouts/321895/2026-09/emails.json — official OpenAPI spec — "GET /crm/objects/2026-09/emails/{emailId}: 79 ORed oauth2 scopes including 'crm.objects.emails.read' and 'crm.objects.contacts.read'"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Associations/Rollouts/321895/2026-09/associations.json — official OpenAPI spec — "POST /crm/associations/2026-09/{fromObjectType}/{toObjectType}/batch/read: 79 ORed scopes incl. 'crm.objects.contacts.read'"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Marketing/Forms/Rollouts/144909/v3/forms.json — official OpenAPI spec — `GET /marketing/v3/forms security [{"oauth2": ["forms"]}]; product tier FREE`
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Account/Account%20Info/Rollouts/144923/2026-09/accountInfo.json — official OpenAPI spec — `GET /account-info/2026-09/details security: [{"oauth2": ["oauth"]}, {"private_apps": ["oauth"]}]; scopes: {"oauth": "Basic HubSpot account information"}`
  - https://developers.hubspot.com/changelog/announcement-new-scope-required-to-get-the-content-of-email-engagements — official page via search summary — direct fetch blocked in sandbox — "The new scope is named sales-email-read. This scope works with the existing contacts scope" ... "Requests ... without the sales-email-read scope will have the details of records with the EMAIL, INCOMING_EMAIL, or FORWARDED_EMAIL type redacted".
  - https://github.com/HubSpot/oauth-quickstart-nodejs/blob/master/index.js — official SDK source — "let SCOPES = ['crm.objects.contacts.read']; // Scopes for this app will default to `crm.objects.contacts.read`" (legacy quickstart; context for why `oauth` was once optional)
  - https://legacydocs.hubspot.com/docs/methods/forms/get-submissions-for-a-form — official page via search summary — direct fetch blocked in sandbox — "endpoint GET /form-integrations/v1/submissions/forms/{form_guid}; page has a 'Scope requirements' section (scope string not captured by search)."
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Emails/Rollouts/424/v3/emails.json — official OpenAPI spec — `GET /crm/v3/objects/emails ... "security": []` (same empty security in 424/2025-09 and 424/2026-03 emails specs)
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/README.md — official OpenAPI spec — "The specifications within this repository are intended solely for HubSpot's internal use, specifically for our Postman integration."
  - https://github.com/HubSpot/hubspot-project-components/blob/main/2026.09/components/app/oauth-private/src/app/app-hsmeta.json — official SDK source — `"requiredScopes": [ "oauth", "crm.objects.contacts.read", "crm.objects.contacts.write" ]`
  - https://github.com/prismatic-io/components/blob/ad372497f8e1f02e9e2f2fd55ae562b5b1d471bd/components/hubspot/documentation/connections/oauth2.mdx — community, non-authoritative — "| **Essential** | `oauth` | Required for all OAuth apps (cannot be removed) |"
  - https://github.com/airbytehq/airbyte/blob/master/airbyte-integrations/connectors/source-hubspot/manifest.yaml — community, non-authoritative — "engagements_emails: required_scopes: crm.objects.contacts.read, sales-email-read ... form_submissions path: \"/form-integrations/v1/submissions/forms/{{ stream_partition['form_id'][0] }}\" required_scopes: forms ... account_details path: /account-info/v3/details required_scopes: oauth"

### HS-SCOPE-EMAIL-READ-RISK — Can a 2026.09 marketplace app actually obtain email-engagement read access?
- **Brief:** not addressed.
- **Verdict:** Not officially documented — medium confidence. The best-supported answer rests on community evidence plus the current spec, because no official page could be fetched.
- **Finding:** A 2026.09 marketplace app can obtain read access to email engagements by putting **`sales-email-read`** (together with `crm.objects.contacts.read`) in `requiredScopes`.

  `crm.objects.emails.read` and `crm.schemas.emails.read` appear in the specs and in 403 bodies, but community threads (Apr 2025, Jul 2025, Nov 2025, Aug 2026) report that they are **not selectable** in app configuration. **Do not use them.**

  Evidence:
  - HubSpot staff resolved an Aug-2026 community case with exactly `crm.objects.contacts.read`, `crm.objects.contacts.write` and `sales-email-read`, reading `GET /crm/objects/2026-03/emails?limit=100` successfully.
  - A 2026-06-22 production log shows a 403 listing `requiredGranularScopes` `sales-email-read / crm.objects.emails.read`, then "Scope granted same day → went live".
  - A 403 test fixture has the shape `{status: 'error', category: 'MISSING_SCOPES', message: 'This app hasn't been granted all required scopes', errors: [{context: {requiredGranularScopes: ['sales-email-read']}}]}`.
  - Airbyte's production connector declares `crm.objects.contacts.read, sales-email-read` for email engagements.
  - The current spec (emails rollout 424/2026-09) requires `[crm.objects.contacts.read, sales-email-read]`.

  An Aug-2026 403 listing three acceptable granular scopes (`crm.schemas.emails.read`, `crm.objects.emails.read`, `sales-email-read`) is consistent with this: `sales-email-read` alone, plus contacts read, satisfies it. The claim that `sales-email-read` was "deprecated in Sep 2025 rollup" has no support in any source, and the evidence above contradicts it.

  Keep these safety nets:
  - detect the granted scopes from the token response `scopes`;
  - handle a 403 with `category` `MISSING_SCOPES` by reading `errors[].context.requiredGranularScopes`;
  - show "not enough data" (never estimate) when email reads are unavailable.
- **Design consequence:** Treat email-object reads as a capability detected at install. Feature-flag the inbox-logging check, the baseline and the confirmed-send figures on whether `sales-email-read` is in the granted `scopes`. Design reply and send detection to degrade to contact-level properties readable with `crm.objects.contacts.read` alone; which properties to use is in the reply-detection section.

  Add a WIRE_UP smoke test: after installing in a test account, call `GET /crm/objects/2026-09/emails?limit=1&properties=hs_timestamp,hs_email_direction` and expect 200. The original design note offered a last-resort fallback for a 403: switch to `crm.objects.emails.read` and re-install, but only if `hs project validate` and upload accept it. The final answer says not to rely on that.
- **Open risk:** If neither scope can be granted, the §5.7 inbox-logging check and the §5.8 baseline cannot be computed from email engagements. The smoke test above must run during WIRE_UP before launch.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Emails/Rollouts/424/2026-09/emails.json — official OpenAPI spec — `[{"oauth2": ["crm.objects.contacts.read", "sales-email-read"]}, ...]; securitySchemes scopes include "sales-email-read": ""`
  - https://community.hubspot.com/t5/APIs-Integrations/Hidden-scopes-crm-objects-emails-read-write-needed-for-app/td-p/1277654 — community, non-authoritative (search summary; direct fetch blocked) — "403 with category MISSING_SCOPES and requiredGranularScopes crm.schemas.emails.read, crm.objects.emails.read, sales-email-read; granular scopes not selectable in the app's Auth tab."
  - https://github.com/RhysEJF/flow-sales/blob/3c73f25a7e7a9ab24230f60898732c1755131c39/docs/research/hubspot-access.md — community, non-authoritative — "HubSpot staff resolved the Aug-2026 case with `crm.objects.contacts.read`, `crm.objects.contacts.write`, `sales-email-read`, reading `GET /crm/objects/2026-03/emails?limit=100` successfully"
  - https://github.com/TravisDFoster/claude-growth-engine/blob/9640600e96271b45f8e812c624003f57abcb9324/sales/sales-reporting/weekly-sales-report-process.md — community, non-authoritative — "both `/objects/emails/search` and `/properties/emails` still 403 (`requiredGranularScopes: sales-email-read / crm.objects.emails.read`; properties need `connected-email-data-access`) ... **Scope granted same day → went live.**"
  - https://github.com/vocion/vocion-core/blob/33a04d6a859f5498635554a2ce181b90b4cf1322/packages/core/src/libs/hubspot/client.test.ts — community, non-authoritative — "status: 'error', category: 'MISSING_SCOPES', message: 'This app hasn\'t been granted all required scopes', errors: [{ context: { requiredGranularScopes: ['sales-email-read'] } }],"
  - https://github.com/airbytehq/airbyte/blob/master/airbyte-integrations/connectors/source-hubspot/manifest.yaml — community, non-authoritative — "engagements_emails: required_scopes: crm.objects.contacts.read, sales-email-read"

### HS-OAUTH-AUTHORIZE-URL — Authorize URL and parameters
- **Brief:** §5.1/§4.1: "OAuth 2.0 install flow" (no details).
- **Verdict:** Confirmed — high confidence.
- **Finding:** The authorize URL is:

  `GET https://app.hubspot.com/oauth/authorize?client_id={CLIENT_ID}&scope={scopes}&redirect_uri={redirect URI}[&optional_scope={optional scopes}][&state={opaque CSRF token}]`

  Parameters:
  - `scope`: the required scopes, space-separated, plus any requested conditionally-required scopes. URL-encode it so spaces become `%20`.
  - `redirect_uri`: URL-encoded, and it must equal one of the `app-hsmeta` `redirectUrls`.
  - `optional_scope`: space-separated optional scopes.
  - `state`: an opaque CSRF token.

  The official Node SDK builds exactly these keys (`client_id`, `redirect_uri`, `scope`, `optional_scope`, `state`) with `querystring` encoding. The docs prose says `optional_scopes`, but the SDK parameter is `optional_scope`; use the SDK spelling. The CLI uses an account-preselected variant, `https://app.hubspot.com/oauth/{portalId}/authorize?...`, and its install URL omits `optional_scope`, which does not matter because Autopilot has no optional scopes.

  On approval, HubSpot redirects to `redirect_uri` with `?code=...(&state=...)`. The code is single-use and must be exchanged within a short window.

  PKCE is optional: the token endpoint accepts `code_verifier` (spec), which implies `code_challenge` support on authorize. The client-secret flow is the documented default.

  Encoding caveat (verifier): WHATWG `URLSearchParams` encodes spaces in `scope` as `+`, but HubSpot's SDK (`querystring`) and the CLI (`encodeURIComponent`) both emit `%20`. Build the URL with `encodeURIComponent` or `querystring` to match the official clients exactly.
- **Design consequence:** `GET /api/hubspot/install` generates `state` (32 random bytes, stored hashed with a 10-minute TTL and bound to the session) and redirects. The callback validates `state` before exchanging the code. Never log the code.
- **Open risk:** Users hosted in the EU may be bounced via `app-eu1.hubspot.com`. The generic `app.hubspot.com` authorize URL is the one HubSpot's own SDK and quickstart use. Confirm with an EU test portal if one is available.
- **Sources:**
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/src/discovery/oauth/OauthDiscovery.ts — official SDK source — "const params = { client_id: clientId, redirect_uri: redirectUri, scope, optional_scope: optionalScope, state } ... return `https://app.hubspot.com/oauth/authorize?${qs.stringify(params)}`"
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_authentication_manage-oauth-tokens.md — community, non-authoritative (verbatim scrape of https://developers.hubspot.com/docs/api-reference/legacy/authentication/manage-oauth-tokens, last modified 2026-03-30) — "install URL ... will include the `client_id`, `redirect_uri`, and `scopes` as query parameters. You may also include `optional_scopes` and `state`"; "Authorization code: a temporary, single-use code ... short window"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Auth/Oauth/Rollouts/279897/2026-09/oauth.json — official OpenAPI spec — `securitySchemes.oauth2.flows.authorizationCode.authorizationUrl: "https://app.hubspot.com/oauth/authorize"`; token request properties include `"code_verifier"`
  - local experiment: node v22.22.0 `node:querystring` — local experiment — `qs.stringify({client_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', redirect_uri:'https://autopilot.example.com/api/hubspot/oauth/callback', scope:'oauth crm.objects.contacts.read forms sales-email-read', state:'<random>'})` → `...&scope=oauth%20crm.objects.contacts.read%20forms%20sales-email-read&state=%3Crandom%3E`; "URLSearchParams gives scope=oauth+crm.objects.contacts.read+forms+sales-email-read"

### HS-OAUTH-TOKEN-ENDPOINT — Use `POST /oauth/2026-09/token`, form-encoded body; v1 stops working on 2027-02-16
- **Brief:** not addressed. The brief only names `BAD_REFRESH_TOKEN` / `invalid_grant`.
- **Verdict:** Corrected — high confidence.
- **Finding:** Use `POST https://api.hubapi.com/oauth/2026-09/token`. This is the latest date version, and its schema is identical to `/oauth/2026-03/token` and `/oauth/v3/token`.
  - Send `Content-Type: application/x-www-form-urlencoded`, with all parameters in the **body**.
  - Code exchange: `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret`.
  - Refresh: `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`.
  - The spec also allows `code_verifier`, `scope`, `client_assertion` and `client_assertion_type`. The `grant_type` enum is `authorization_code|client_credentials|refresh_token`.

  The v1 endpoints:
  - `/oauth/v1/token` is deprecated (announced 2026-05-12) and stops working on 2027-02-16.
  - v1 also accepted `client_secret` and `refresh_token` as query parameters. Never do this.
  - Nuance (verifier): the v1 spec flags only the metadata operations (`GET /oauth/v1/access-tokens/{token}`, `GET`/`DELETE /oauth/v1/refresh-tokens/{token}`) as `"deprecated": true`, not `POST /oauth/v1/token`. The 2027-02-16 cut-off comes from the changelog search summary, corroborated by community codebases.

  The v3 docs now live under "legacy". Since May 2026, Marketplace listing and certification require the date-versioned (2026-03 or later) OAuth endpoints.

  Use the host `api.hubapi.com`. The docs' curl examples use `api.hubspot.com`, but the spec `servers` entry is `https://api.hubapi.com`. Every spec's `securitySchemes.oauth2.flows.authorizationCode.tokenUrl`, including 2026-09, still says `https://api.hubapi.com/oauth/v1/token`. This is stale boilerplate, so do not derive the token URL from it.

  Refresh tokens issued via v1 refresh fine on `/oauth/2026-03/token` (community live test).
- **Design consequence:** An env variable `HUBSPOT_API_VERSION` (default `'2026-09'`) feeds every path, including `/oauth/{v}/token`. `HubSpotClient.refresh()` posts a `URLSearchParams` body. The client secret never appears in a URL or in logs.
- **Open risk:** The 2026-09 OAuth endpoints are new; the spec and docs exist. If anything misbehaves, 2026-03 is the minimum the listing rules require and has the identical shape. At WIRE_UP, confirm that the first live code exchange and refresh succeed on `/oauth/2026-09/token`.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Auth/Oauth/Rollouts/279897/2026-09/oauth.json — official OpenAPI spec — `"/oauth/2026-09/token": { "post": { "summary": "OAuth token endpoint", requestBody: { "application/x-www-form-urlencoded": { properties: client_assertion, client_assertion_type, client_id, client_secret, code, code_verifier, grant_type enum [authorization_code, client_credentials, refresh_token], redirect_uri, refresh_token, scope } } } }; servers: [{"url": "https://api.hubapi.com"}]` / (stale boilerplate, not to be used) `"authorizationCode": {"authorizationUrl": "https://app.hubspot.com/oauth/authorize", "tokenUrl": "https://api.hubapi.com/oauth/v1/token", "scopes": {}}`
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Auth/Oauth/Rollouts/155908/v1/oauth.json — official OpenAPI spec — "POST /oauth/v1/token parameters in query: client_secret, refresh_token; GET /oauth/v1/access-tokens/{token} \"deprecated\": true"
  - https://developers.hubspot.com/changelog/v1-oauth-api-deprecation — official page via search summary — direct fetch blocked in sandbox — "announced May 12, 2026; v1 endpoints POST /v1/token, GET /v1/access-tokens/{token}, GET/DELETE /v1/refresh-tokens/{token} 'will remain accessible until February 16th, 2027'; migrate to POST /oauth/2026-03/token, /token/introspect, /token/revoke."
  - https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens — official page via search summary — direct fetch blocked in sandbox — "Manage OAuth access tokens with the 2026-09 API" - "make a URL-form encoded POST request to /oauth/2026-09/token".
  - https://github.com/HubSpot/hubspot-sdk-typescript/blob/main/src/resources/auth/oauth.ts — official SDK source — "@hubspot/sdk 0.1.0-alpha.10: this._client.post('/oauth/2026-03/token', { body, headers: buildHeaders([{ 'Content-Type': 'application/x-www-form-urlencoded' }]) })"
  - https://github.com/usertour/usertour/blob/ae33fbe63f77933129beb71e8fbdfbf2e35323d5/apps/server/src/modules/integrations/sync/hubspot-api.ts — community, non-authoritative — "the * unversioned `/oauth/v1/*` endpoints also put secrets in the URL and are * sunset on 2027-02-16. ... export const HUBSPOT_API_VERSION = '2026-09';"
  - https://github.com/NangoHQ/nango/issues/7664 — community, non-authoritative — "A refresh token issued on v1 refreshes on 2026-03."; "Refresh on `/oauth/2026-03/token` | 200, refresh token unchanged | 200, refresh token unchanged"

### HS-OAUTH-TOKEN-RESPONSE — Token response fields, lifetimes, rotation and size
- **Brief:** not addressed.
- **Verdict:** Confirmed — high confidence. The schema comes from the spec. The 30-minute lifetime and the example come from a verbatim scrape of the official guide. Refresh-token non-expiry rests on a search summary of the official blog plus community agreement.
- **Finding:** `AccessTokenResponse` (spec, all versions):
  - required: `access_token` (string), `expires_in` (int64 seconds), `refresh_token` (string), `token_type` (string), `token_use` (`"access_token"`);
  - optional: `hub_id` (int32), `scopes` (string[]), `user_id` (int32), `id_token` (string).

  Docs example: `{"token_type":"bearer","refresh_token":"na1-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee","access_token":"xxx...","hub_id":1234567,"scopes":["oauth","crm.objects.contacts.write","crm.objects.contacts.read"],"expires_in":1800}`.

  Lifetimes:
  - **Access tokens expire after 30 minutes** (`expires_in` 1800).
  - **Refresh tokens do not expire** ("don't expire (for now)"). They stay valid until the app is uninstalled or the token is revoked.

  Rotation: HubSpot's blog says a refresh response gives a new access token "and potentially a new refresh token - always use the latest one". In a community test on 2026-03 (2026-09-25), the refresh token came back unchanged.

  Size: the docs say to allow tokens of up to 512 characters. The verifier notes that this guidance is explicitly about **access** tokens; the SDK docstring says 300. Store both tokens as unbounded text. `hub_id` and `user_id` are int32 in the spec, but store them as bigint.

  Refresh tokens are prefixed with the hublet (e.g. `na1-`).

  Usage guidelines: refresh based on the `expires_in` TTL. "Unauthorized (401) requests are not a valid indicator that a new access token must be retrieved." The official quickstart caches the access token for `expires_in*0.75`.
- **Design consequence:** Persist these fields, encrypted with AES-256-GCM:
  - `access_token`;
  - `expires_at` = now + `expires_in` − a 5-minute skew;
  - `refresh_token`, always overwritten with the response value when one is present.

  Use a single-flight refresh per portal (DB row lock or advisory lock) to avoid concurrent refreshes. Capture `hub_id` and `scopes` at install.
- **Open risk:** Refresh-token rotation is not formally specified, so the code must handle both rotation and non-rotation. Refresh-token non-expiry is backed by a blog search summary only.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Auth/Oauth/Rollouts/279897/2026-09/oauth.json — official OpenAPI spec — "AccessTokenResponse required: [access_token, expires_in, refresh_token, token_type, token_use]; properties hub_id, id_token, scopes, user_id; token_use enum [\"access_token\"]"
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_authentication_manage-oauth-tokens.md — community, non-authoritative (verbatim scrape of the official v3 guide) — "Access token ... expires after 30 minutes"; example response `{"token_type": "bearer", "refresh_token": "na1-aaaa-...", ... "hub_id": 1234567, "scopes": [...], "expires_in": 1800}`
  - https://developers.hubspot.com/blog/oauth-token-management-hubspot-integrations — official page via search summary — direct fetch blocked in sandbox — "Refresh tokens don't expire (for now) and stay valid indefinitely unless the user uninstalls your app or you revoke them manually"; "the response gives you a new access token (and potentially a new refresh token - always use the latest one)".
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_v1_guide.md — community, non-authoritative (verbatim scrape of https://developers.hubspot.com/docs/api-reference/legacy/authentication/oauth-tokens/v1/guide) — "**Please note:** HubSpot access tokens are expected to fluctuate in size over time, as updates will be made to the token’s encoded information. It’s recommended to allow for tokens to be up to 512 characters to account for any changes."
  - https://github.com/NangoHQ/nango/issues/7664 — community, non-authoritative — "Refresh on `/oauth/2026-03/token` | 200, refresh token unchanged"; "v1 and 2026-03 return the same fields: access_token, expires_in, hub_id, refresh_token, scopes, token_type, token_use. expires_in is 1800."
  - https://raw.githubusercontent.com/Namit2111/Agent-Jivus/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/usage-details/content.txt — community, non-authoritative (2024 scrape of official usage guidelines) — "Apps are responsible for storing time-to-live (TTL) data and refreshing user access tokens ... Unauthorized (401) requests are not a valid indicator that a new access token must be retrieved."

### HS-OAUTH-REFRESH-ERRORS — Exact refresh-failure shapes, and the revoked / config / transient classification
- **Brief:** §5.1: revoked or invalid tokens look like "`BAD_REFRESH_TOKEN` / `invalid_grant`"; transient failures are 429, 5xx and timeouts. §8 tests: token refresh, revoked vs transient.
- **Resolves:** [VERIFY] §5.1 exact error shapes (refresh handling)
- **Verdict:** Confirmed — high confidence for the revoked-token body. That body comes from verbatim third-party scrapes of HubSpot's v1 and v3 OAuth guides, a search summary of the official changelog and a community live test; no developers.hubspot.com page was fetched directly. The other statuses (`BAD_HUB`, `BAD_CLIENT_ID` and the rest) are community-documented only.
- **Finding:** A revoked, invalid or expired refresh token returns **HTTP 400** with this body. This covers an uninstalled app and a revoked token.
  ```json
  {"error":"invalid_grant","error_description":"refresh token is invalid, expired or revoked","status":"BAD_REFRESH_TOKEN","message":"refresh token is invalid, expired or revoked"}
  ```
  - The body is the same on `/oauth/v1/token`, `/oauth/v3/token` and `/oauth/2026-03/token`. The docs for v1 and v3 show it, and a community live test confirms identical error bodies and a 400 after revoke. 2026-09 shares the 2026-03 schema.
  - HubSpot's Jan-2026 changelog says OAuth errors now follow RFC 6749, and recommends branching on the standard `error` / `error_description` fields. The HubSpot `status` / `message` fields are kept for backward compatibility.
  - An older message variant also appears: `missing or invalid refresh token`.

  Other statuses seen in the community (not officially enumerated):
  - `BAD_AUTH_CODE`: the code expired or was reused.
  - `BAD_CLIENT_ID`, with `error` `invalid_client`.
  - `BAD_CLIENT_SECRET`.
  - `BAD_REDIRECT_URI`: appears in only one community map.
  - `BAD_GRANT_TYPE`: appears only in a community thread title.
  - `BAD_HUB`, with `error` `access_denied`, when the portal was deleted or disconnected. The exact body is HTTP 400 `{"status":"BAD_HUB","message":"missing or unknown hub id","error":"access_denied"}`.
  - `BAD_CODE_VERIFIER` and `BAD_SCOPES`: see HS-V2-AUTH-CODE-ERRORS.

  The spec's generic `default` Error schema (`{category, correlationId, message, subCategory, context, links, errors[]}`) applies to non-OAuth errors.

  **Classification:**
  - **REVOKED** (terminal): HTTP 4xx other than 429, **and** any of: `error == 'invalid_grant'`, `status` in {`BAD_REFRESH_TOKEN`, `BAD_HUB`}, or `error == 'access_denied'`.
  - **CONFIG** (alert; do **not** revoke the portal): `error` in {`invalid_client`, `unauthorized_client`, `unsupported_grant_type`, `invalid_request`}, or `status` in {`BAD_CLIENT_ID`, `BAD_CLIENT_SECRET`, `BAD_GRANT_TYPE`, `BAD_REDIRECT_URI`}. Two verifier additions also fall here:
    - a **401 from the token endpoint** is `config` unless its body carries `invalid_grant` / `BAD_REFRESH_TOKEN` / `BAD_HUB`. HubSpot documents no 401 for the token endpoint, and one community implementation treats any 401 as revoked.
    - **any unrecognised non-429 4xx** is `config`, so an unknown error can never mass-revoke portals.
  - **TRANSIENT:** 429; 5xx (including 502/503/504/521–524); 423; 477; network errors and timeouts; a non-JSON body with a 5xx.
- **Design consequence:** `classifyRefreshFailure(status, body)` returns `'revoked' | 'config' | 'transient'`, with unit tests on the exact fixtures in 02.y.
  - `config`: alert ops via Sentry once and keep connections active, so a rotated client secret does not mass-revoke every portal.
  - `revoked`: stop jobs, show the banner, send a single idempotent email, never retry.
- **Open risk:** The statuses other than `BAD_REFRESH_TOKEN` are documented by the community only. Classification keys on `error` first, so unknown statuses fall back safely. At WIRE_UP, re-check the body on `/oauth/2026-09/token` itself: the live test covered 2026-03 and v1, and 2026-09 is assumed identical by schema. To do that, uninstall the test app and refresh.
- **Sources:**
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_authentication_manage-oauth-tokens.md — community, non-authoritative (verbatim scrape of https://developers.hubspot.com/docs/api-reference/legacy/authentication/manage-oauth-tokens) — `{ "error": "invalid_grant", "error_description": "refresh token is invalid, expired or revoked", "status": "BAD_REFRESH_TOKEN", "message": "refresh token is invalid, expired or revoked" }` ... "HubSpot-specific status and message fields ... are still available for backwards compatibility."
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_v1_guide.md — community, non-authoritative (verbatim scrape of https://developers.hubspot.com/docs/api-reference/legacy/authentication/oauth-tokens/v1/guide) — identical error body for `/oauth/v1/token`.
  - https://developers.hubspot.com/changelog/new-oauth-v3-api-endpoints-and-standardized-error-responses — official page via search summary — direct fetch blocked in sandbox — (2026-01-27) "OAuth error responses are being updated to comply with RFC 6749 ... standard error and error_description fields"; "switch error handling to rely on the standard error and error_description fields".
  - https://github.com/NangoHQ/nango/issues/7664 — community, non-authoritative — "Refresh after revoke, 2026-03 and v1 | 400 `BAD_REFRESH_TOKEN` on both"; "The error body is identical across `/oauth/v1/token`, `/oauth/v3/token` and `/oauth/2026-03/token`: `status`, `message`, `error`, `error_description`."
  - https://github.com/PostHog/posthog/blob/dd11b919d0f09a3da5724b62c82f91e1997abed8/posthog/models/integration/refresh_tracking.py — community, non-authoritative — "HubSpot reports a grant whose portal (hub) was deleted or disconnected as `{\"status\": \"BAD_HUB\", \"error\": \"access_denied\", ...}` - no `invalid_grant` code"
  - https://github.com/PostHog/posthog/blob/ceeb956efb37065838b00d7b37bf9877cf650505/posthog/models/test/integration/test_oauth.py — community, non-authoritative — `"hubspot_dead_hub_shape", 400, {"status": "BAD_HUB", "message": "missing or unknown hub id", "error": "access_denied"}, "hubspot", "invalid_grant"`
  - https://github.com/PostHog/posthog/blob/ceeb956efb37065838b00d7b37bf9877cf650505/products/warehouse_sources/backend/temporal/data_imports/sources/hubspot/source.py — community, non-authoritative — `"missing or invalid refresh token": "Your HubSpot connection is invalid or expired. Please reconnect it.", "missing or unknown hub id": None,`
  - https://github.com/usertour/usertour/blob/ae33fbe63f77933129beb71e8fbdfbf2e35323d5/apps/server/src/modules/integrations/sync/hubspot-api.spec.ts — community, non-authoritative — "tokenFailure(400, { error: 'invalid_grant', status: 'BAD_REFRESH_TOKEN' }) ... expect(isHubspotGrantRevoked(tokenFailure(401, {}))).toBe(true); ... tokenFailure(400, { error: 'invalid_client', status: 'BAD_CLIENT_ID' })" (BAD_CLIENT_ID → not a revoked grant)
  - https://github.com/bagofwords1/bagofwords/blob/c56f60c8f6333b19ed8c5934debaf8b48d438552/docs/feedback-loops/hubspot-mcp-preset.md — community, non-authoritative — "exchange with `BAD_CODE_VERIFIER` (which, usefully, is a *different* error from `BAD_AUTH_CODE` — the code was recognised). ... - correct secret → `{\"status\":\"BAD_SCOPES\", ...}` — client auth passed - wrong secret → `{\"status\":\"BAD_CLIENT_SECRET\", ...}`"
  - https://github.com/onyx-dot-app/onyx/blob/c2e5be7996373ed120f770209ffe9a6c498fc4e6/backend/onyx/external_apps/providers/hubspot.py — community, non-authoritative — "# HubSpot's token endpoint returns a non-2xx with a machine-readable # `status` (e.g. `BAD_REFRESH_TOKEN`, `BAD_AUTH_CODE`) rather than the # OAuth `error` field the generic helper looks for."

### HS-HTTP-ERROR-CODES — Transient vs terminal statuses for regular API calls
- **Brief:** §5.1: transient failures are 429, 5xx and timeouts.
- **Resolves:** [VERIFY] §5.1 exact error shapes (transient side)
- **Verdict:** Extended — high confidence. This rests on a verbatim third-party scrape of HubSpot's official error-handling page (last modified 2026-03-30); the page was not fetched directly.
- **Finding:** Statuses on the official error-handling page:

  | Status | Meaning and handling |
  |---|---|
  | 401 Unauthorized | Invalid authentication. |
  | 403 Forbidden | The token lacks a scope. Terminal for that feature, not for the connection. |
  | 414 | URI too long. A terminal client error (verifier). |
  | 423 Locked | Locks last 2 seconds; wait at least 2 s. |
  | 429 | Too many requests. |
  | 477 Migration in Progress | The account is moving its data-hosting location. HubSpot returns a `Retry-After` header **in seconds**, typically up to 24 hours. |
  | 502 / 504 | Timeouts. Pause a few seconds, then retry. |
  | 503 | Temporarily unavailable. |
  | 521 | Server down. |
  | 522 | Connection timed out. |
  | 523 | Origin unreachable. |
  | 524 | Timeout (more than 100 s). |
  | 525 / 526 | SSL issues. |

  For 522 and 525/526 the page says to contact HubSpot support, so keep them in the retry set but always alert.

  The only "Retry-After in milliseconds" statement on that page concerns HubSpot **workflow** webhooks calling *your* endpoint. Do not apply it to API responses.

  Error JSON example: `{"status":"error","message":"...","errors":[{"message":"...","code":"INVALID_INTEGER","context":{...}}],"category":"VALIDATION_ERROR","correlationId":"..."}`. The page says the fields "should all be treated as optional in any error parsing".

  On an API 401: refresh once. If the refresh fails with `invalid_grant`, the connection is revoked; otherwise treat the 401 as transient.
- **Design consequence:** The transient set is {423, 429, 477, 5xx, network errors and timeouts}.
  - Honour `Retry-After` (seconds) when it is present.
  - Cap backoff at 5 attempts, as the brief says, then alert Sentry.
  - For 477, reschedule the job instead of burning attempts.
- **Open risk:** Re-check the live error-handling page at WIRE_UP, since it was read only through a third-party scrape.
- **Sources:**
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_-reference_error-handling.md — community, non-authoritative (verbatim scrape of https://developers.hubspot.com/docs/api-reference/error-handling) — "`477 Migration in Progress`| ... HubSpot will return a Retry-After response header indicating how many seconds to wait before retrying the request (typically up to 24 hours)." "`423 Locked`| ... Locks will last for 2 seconds" / "`522 connection timed out`| ... please reach out to [HubSpot support] for assistance." "Workflows **will not** retry after receiving 4XX series response status codes. One exception to this rule is 429 rate limit errors; ... Note that the `Retry-After` value is in milliseconds."

### HS-TOKEN-METADATA — Introspect and revoke endpoints; legacy v1 metadata endpoints
- **Brief:** not addressed.
- **Verdict:** Extended — high confidence.
- **Finding:** **Legacy endpoints** (deprecated in the spec; removed on 2027-02-16):
  - `GET /oauth/v1/access-tokens/{token}` returns `{token, user, hub_domain, scopes[], signed_access_token{...}, hub_id, app_id, expires_in, user_id, token_type, is_private_distribution}`.
  - `GET /oauth/v1/refresh-tokens/{token}` returns `{token, user, hub_domain, scopes[], hub_id, client_id, user_id, token_type}`.
  - `DELETE /oauth/v1/refresh-tokens/{token}` returns 204. It does **not** delete issued access tokens and does **not** uninstall the app.

  **Current endpoints:**
  - `POST /oauth/2026-09/token/introspect`. Send it `x-www-form-urlencoded` with `client_id`, `client_secret`, `token`, and `token_type_hint` = `access_token|refresh_token`; the spec gives `token_type_hint` no enum. It returns one of two shapes (oneOf):
    - `PublicAccessTokenInfoResponse` `{active, token, hub_id, user_id, client_id, app_id, user (installer email), hub_domain, scopes[], signed_access_token{expiresAt, scopes, hubId, userId, appId, appInstallId, audience, installingUserId, signature, scopeToScopeGroupPks, newSignature, hublet, trialScopes, trialScopeToScopeGroupPks, isUserLevel, isPrivateDistribution, isServiceAccount}, expires_in, is_private_distribution, token_use:'access_token', token_type:'Bearer'}`
    - `PublicRefreshTokenInfoResponse` `{active, token, hub_id, user_id, client_id, app_id, user, hub_domain, scopes[], token_use:'refresh_token', token_type}`

    A revoked token returns `{"active": false}`. HubSpot's Postman collection documents the introspect 200 body as `{"active": "<boolean>"}`.
  - `POST /oauth/2026-09/token/revoke` (form: `client_id`, `client_secret`, `token`, `token_type_hint`) revokes a refresh token. The spec declares only a `default` Error response; a community live test got HTTP 200.

  Docs/spec discrepancy: the v3 guide's prose says to send `refresh_token` / `access_token` fields, but the spec and the official `@hubspot/sdk` send `token`. Use `token`.

  Revoking a refresh token does **not** invalidate an access token that was already issued (see HS-V1-REVOKE-RESPONSE).
- **Design consequence:** The install callback exchanges the code, which yields `hub_id` and `scopes`. It can optionally introspect the access token to get `user` (the installer's email, useful as the default owner email) and `app_id`. No v1 metadata calls are needed. On disconnect, call the uninstall API, then revoke the refresh token, then delete the local tokens.
- **Open risk:** The revoke response status (200) is community-observed only.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Auth/Oauth/Rollouts/279897/2026-09/oauth.json — official OpenAPI spec — "\"/oauth/2026-09/token/introspect\" requestBody properties: client_id, client_secret, token, token_type_hint; responses 200 TokenInfoResponseBaseIF oneOf [PublicAccessTokenInfoResponse, PublicRefreshTokenInfoResponse]; \"/oauth/2026-09/token/revoke\" 'Deletes/Revokes provided Refresh Token'"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Auth/Oauth/Rollouts/155908/v1/oauth.json — official OpenAPI spec — "GET /oauth/v1/access-tokens/{token} ... \"deprecated\": true; AccessTokenInfoResponse required [app_id, expires_in, hub_id, scopes, token, token_type, user_id]; RefreshTokenInfoResponse required [client_id, hub_id, scopes, token, token_type, user_id]"
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_authentication_manage-oauth-tokens.md — community, non-authoritative (verbatim scrape of the official v3 guide) — access token metadata example `{"active": true, ... "hub_id": 1234567, "user_id": 222222, "client_id": "...", "app_id": 1234444, "user": "jdoe@hubspot.com", "hub_domain": "example.com", ... "signed_access_token": {... "hublet": "na1" ...}, "expires_in": 1789, "is_private_distribution": true, "token_use": "access_token", "token_type": "Bearer"}`
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/codegen/oauth/apis/RefreshTokensApi.ts — official SDK source — "Delete a refresh token, typically after a user uninstalls your app. Access tokens generated with the refresh token will not be affected.  This will not uninstall the application from HubSpot or inhibit data syncing between an account and the app."
  - https://github.com/HubSpot/hubspot-sdk-typescript/blob/main/src/resources/auth/oauth.ts — official SDK source — "export interface OAuthIntrospectTokenParams { token?: string; client_id?: string; client_secret?: string; token_type_hint?: string; }"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Auth/Oauth/Rollouts/279897/v3 — official OpenAPI spec (Postman collection in the spec repo) — "'Token introspection endpoint' POST {{baseUrl}}/oauth/v3/token/introspect body urlencoded client_id, client_secret, token, token_type_hint; response 200 OK { \"active\": \"<boolean>\" }"
  - https://github.com/NangoHQ/nango/issues/7664 — community, non-authoritative — "Revoke on 2026-03 (form body) | 200 | 200"; "Introspect after revoke | `active: false`"
  - https://github.com/Mrjoel97/ProjectX/blob/53d96a263f055e14bbb1c6a1a35c6d7bb58c9652/docs/connectors/hubspot-suitability.md — community, non-authoritative — "**Revocation did not cascade:** the access credential worked before AND after the refresh-grant revoke. `upstream: confirmed`, `cascaded: false`"

### HS-ACCOUNT-DETAILS — Account timezone: endpoint, response fields and scope
- **Brief:** §5.1: "Store portal ID, hub domain and timezone"; §4.2.4: "Portal timezone is auto-detected"; §5.9: Monday 08:00 local time.
- **Resolves:** [VERIFY endpoint and scope for account timezone] (§5.1)
- **Verdict:** Confirmed — medium confidence. The endpoint and schema are certain. The required scope is ambiguous across spec rollouts.
- **Finding:** `GET https://api.hubapi.com/account-info/2026-09/details`. The same shape is served at `/account-info/2026-03/details`, `/2025-09/details` and `/v3/details`, on tier FREE.

  The response is `PortalInformationResponse`. Required fields:

  | Field | Type and example |
  |---|---|
  | `portalId` | int32 |
  | `accountType` | `STANDARD`, `DEVELOPER_TEST`, `SANDBOX` or `APP_DEVELOPER` |
  | `timeZone` | string, e.g. `"US/Eastern"` |
  | `companyCurrency` | string |
  | `additionalCurrencies` | array |
  | `utcOffset` | e.g. `"-05:00"` |
  | `utcOffsetMilliseconds` | int64, e.g. `-18000000` |
  | `uiDomain` | e.g. `"app.hubspot.com"`, `"app-eu1.hubspot.com"` |
  | `dataHostingLocation` | e.g. `"na1"`, `"eu1"` |

  The 2026-09 rollout 318954 adds the optional fields `portalName` and `createdAt` (ms).

  Docs example: `{"portalId":123456,"accountType":"STANDARD","timeZone":"US/Eastern","companyCurrency":"USD","additionalCurrencies":["EUR"],"utcOffset":"-05:00","utcOffsetMilliseconds":-18000000,"uiDomain":"app.hubspot.com","dataHostingLocation":"na1"}`.

  **Scope:** the spec rollouts disagree.
  - Rollout 144923/2026-09 has security `[{"oauth2":["oauth"]},{"private_apps":["oauth"]}]`; rollout 136890/v3 uses `oauth` (legacy scheme names); 318954/2026-09-beta uses `oauth`.
  - Rollouts 144923/v3, /2025-09 and /2026-03, and 318954/2026-09, list `[{"oauth2":["external-settings-access"]}]`. That scope appears in no developer docs or scope list found. It does appear in HubSpot's 2026-03 Account Info Postman collection, inside a combined auth string `critical-actions-access external-settings-access login-audit-access user-action-audits-read`. This suggests it belongs to the audit-log/security family of the same Account API and was attached to `/details` when the collection was generated.
  - Airbyte's production connector reads `/account-info/v3/details` with `required_scopes: oauth`, and the official `@hubspot/sdk` calls `/account-info/2026-03/details`.

  **Best-supported answer: requesting `oauth` is sufficient.** It is the scope HubSpot's templates always include.
- **Design consequence:** Fetch account details at install and daily, because owners can change the portal timezone. Store `time_zone`, `utc_offset_ms`, `ui_domain`, `data_hosting_location` and `account_type`.

  Quiet hours and the Monday 08:00 report use the IANA name. `"US/Eastern"` is a valid IANA backward-compatible link. Validate it with `Intl.DateTimeFormat(undefined,{timeZone})`, and fall back to the fixed offset if it is invalid. Optionally refuse or flag `DEVELOPER_TEST` / `SANDBOX` accounts for billing.
- **Open risk:** If the live endpoint enforces `external-settings-access` and that scope cannot be granted, the timezone must fall back to one the owner selects during onboarding (the brief says "auto-detected"). Smoke-test `GET /account-info/2026-09/details` with only the four required scopes in WIRE_UP step 9.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Account/Account%20Info/Rollouts/144923/2026-09/accountInfo.json — official OpenAPI spec — "GET /account-info/2026-09/details 'Retrieve account details such as the account type, time zone, currencies, and data hosting location.' security: [{\"oauth2\": [\"oauth\"]}, {\"private_apps\": [\"oauth\"]}]; PortalInformationResponse required [accountType, additionalCurrencies, companyCurrency, dataHostingLocation, portalId, timeZone, uiDomain, utcOffset, utcOffsetMilliseconds]"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Account/Account%20Info/Rollouts/318954/2026-09/accountInfo.json — official OpenAPI spec — "GET /account-info/2026-09/details security: [{\"oauth2\": [\"external-settings-access\"]}]; PortalInformationResponseSeptember2026 adds createdAt, portalName"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Account/Account%20Info/Rollouts/144923/v3/accountInfo.json — official OpenAPI spec — `example: {"createdAt": 1648840584303, "dataHostingLocation": "eu1", "portalId": 12345678, "portalName": "Acme Inc", "timeZone": "US/Eastern", "uiDomain": "app-eu1.hubspot.com", "utcOffset": "-04:00", "utcOffsetMilliseconds": -14400000}`
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_account-information_guide_2.md — community, non-authoritative (verbatim scrape of https://developers.hubspot.com/docs/api-reference/latest/account/account-information/guide) — "make a GET request to /account-info/2026-03/details" ... "`timeZone`| String| The name of the account's configured timezone (e.g., \"US/Eastern\")" "`uiDomain`| String| The domain used to log in to the main HubSpot user interface."
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Account/Account%20Info/Rollouts/144923/2026-03/Collection_Directory%20Account%20API%202026-03/Account%20-%20Account%20Info%20API%20Collection%202026-03.json — official OpenAPI spec (Postman collection in the spec repo) — `"key": "scope", "value": "critical-actions-access external-settings-access login-audit-access user-action-audits-read", "type": "string"`
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Account/Account%20Info/Rollouts/318954/2026-09-beta/accountInfo.json — official OpenAPI spec — "GET /account-info/2026-09-beta/details security: [{'oauth2': ['oauth']}]"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Account/Account%20Info/Rollouts/136890/v3/accountInfo.json — official OpenAPI spec — "GET /account-info/v3/details security: [{'private_apps_legacy': ['oauth']}, {'oauth2_legacy': ['oauth']}]"
  - https://github.com/airbytehq/airbyte/blob/master/airbyte-integrations/connectors/source-hubspot/manifest.yaml — community, non-authoritative — "path: /account-info/v3/details ... $parameters: name: account_details path: /account-info/v3/details required_scopes: oauth"

### HS-UNINSTALL-NOTIFY — Uninstall is visible only through the pull-based Webhooks Journal or a failed refresh
- **Brief:** §5.1: "Uninstall or disconnect: stop all processing immediately and purge the portal's data after 30 days"; whether HubSpot notifies apps is unknown. §5.14: retention purge.
- **Resolves:** [VERIFY whether HubSpot notifies apps of uninstall] (§5.1)
- **Verdict:** Extended — medium confidence. The subscription, event-ID and journal-response schemas come from the official spec. The client-credentials scopes, the field names inside `journalEvents`, and the 3-day retention rest on docs search summaries plus a community codebase verified against the live API.
- **Finding:** HubSpot exposes an uninstall **only through the pull-based Webhooks Journal**. There is **no push webhook**: neither the `app-webhooks` `eventType` enum (2026-09 and 2027-03-beta) nor the `webhooks-hsmeta.json` subscriptions (`crmObjects`, `legacyCrmObjects`, `hubEvents`) include app install or uninstall.

  Setup, done once per app:
  1. Get a client-credentials token: `POST https://api.hubapi.com/oauth/2026-09/token` (`x-www-form-urlencoded`) with `grant_type=client_credentials&client_id=...&client_secret=...&scope=developer.webhooks_journal.read developer.webhooks_journal.subscriptions.read developer.webhooks_journal.subscriptions.write`. It returns `ClientCredentialsTokenResponse` `{access_token, expires_in, token_type, token_use:'client_credentials'}`. A production codebase uses exactly these scopes and does **not** list them in `app-hsmeta.json` `requiredScopes`.
  2. Subscribe: `POST https://api.hubapi.com/webhooks-journal/subscriptions/2026-09` with JSON `{"subscriptionType":"APP_LIFECYCLE_EVENT","eventTypeId":"4-1916193","properties":[]}`.
     - `AppLifecycleEventSubscriptionUpsertRequest` has only the properties `eventTypeId`, `properties` and `subscriptionType`, with enum `['APP_LIFECYCLE_EVENT']`.
     - The subscription is app-level, with no `portalId`. OBJECT subscriptions, by contrast, require `portalId`.
     - `4-1909196` = app install; `4-1916193` = app uninstall. These IDs are in the Webhooks/Webhooks 147891/2026-09 (and 2026-03) spec and the Webhooks Journal 334885/2027-03-beta spec, but not in the 284944/2026-09 journal spec itself.

  Polling:
  - `GET /webhooks-journal/journal/2026-09/earliest`, `/latest` or `/offset/{offset}/next` (optional `?installPortalId=`). These return 200 `{currentOffset (uuid), expiresAt (date-time), url}`, or **204** when there is nothing new.
  - `GET` the presigned `url` without auth. It returns `{offset, journalEvents:[{type:'app_lifecycle_event', action:'APP_UNINSTALL'|'APP_INSTALL', portalId, occurredAt, eventTypeId, properties:{hs_app_id, hs_app_install_level, hs_initiating_user_id, hs_user_id}}], publishedAt}`. The `actions` enum includes `APP_INSTALL` and `APP_UNINSTALL`.
  - The field names inside `journalEvents` come from the docs search summary and community code, so parse them with a tolerant Zod schema.
  - The journal operations are exempt from the daily and ten-secondly rate limits (`"x-hubspot-rate-limit-exemptions": ["daily", "ten-secondly"]`).
  - Retention is reportedly **3 days**, so persist `currentOffset` and poll at least daily. The 5-minute cron is fine.

  **Authoritative fallback:** a refresh classified `revoked` (400 `invalid_grant` / `BAD_REFRESH_TOKEN`, or `BAD_HUB` / `access_denied`) marks the connection uninstalled.

  There is **no documented admin email for user-initiated uninstalls**. An admin email is documented only for a developer-initiated uninstall via `DELETE /appinstalls/.../external-install` (HS-UNINSTALL-API).
- **Design consequence:** Detect uninstalls in two layers:
  1. A best-effort journal poll for `APP_UNINSTALL` inside the 5-minute cron. It is feature-flagged, and needs a client-credentials token plus the journal subscription, created once by a setup script.
  2. The authoritative fallback: a refresh failure classified `revoked`, or an API 401 that survives a refresh. Mark the connection revoked/uninstalled, cancel jobs, and set `purge_at = now + 30 days`.

  Store the journal offset in the DB, and dedupe on (`portalId`, `occurredAt`, `action`).
- **Open risk:** Community reports say the `developer.webhooks_journal.*` scopes were not selectable in some developer accounts, so journal access may require adding a webhooks-journal component or scopes to the app config. Verify this in WIRE_UP. At WIRE_UP, also verify:
  - the client-credentials token grant;
  - the 204/`{url, expiresAt, currentOffset}` and `{offset, journalEvents, publishedAt}` shapes;
  - the 3-day retention;
  - a real `APP_UNINSTALL` entry, by uninstalling from a test portal.

  A third-party blog (Lefthook, 2026-02) says push lifecycle webhooks are "coming soon".
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/147891/2026-09/webhooks.json — official OpenAPI spec — "AppLifecycleEventSubscriptionUpsertRequest: required [eventTypeId, properties, subscriptionType]; eventTypeId description '4-1909196: App install event\n4-1916193: App uninstall event'; subscriptionType enum [\"APP_LIFECYCLE_EVENT\"]; app-webhooks SubscriptionCreateRequest.eventType enum contains only contact./company./deal./ticket./object./conversation./product./line_item./event.completed events (no app install/uninstall)"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks%20Journal/Webhooks%20Journal/Rollouts/284944/2026-09/webhooksJournal.json — official OpenAPI spec — "POST /webhooks-journal/subscriptions/2026-09 'Upsert subscription' ...; GET /webhooks-journal/journal/2026-09/latest 'installPortalId' query; JournalFetchResponse required [currentOffset, expiresAt, url]; \"x-hubspot-rate-limit-exemptions\": [\"daily\", \"ten-secondly\"]" / "AppLifecycleEventSubscriptionUpsertRequest properties: ['eventTypeId', 'properties', 'subscriptionType'] (no portalId); ObjectSubscriptionUpsertRequest required: ['actions', 'objectIds', 'objectTypeId', 'portalId', 'properties', 'subscriptionType']; actions enum [..., 'APP_INSTALL', 'APP_UNINSTALL', ...]"
  - https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/guide — official page via search summary — direct fetch blocked in sandbox — "The webhooks journal API uses a client credentials token"; scopes developer.webhooks_journal.read, developer.webhooks_journal.subscriptions.read/.write, developer.webhooks_journal.snapshots.read/.write; example curl to /oauth/2026-09/token with grant_type=client_credentials.
  - https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/guide — official page via search summary — direct fetch blocked in sandbox — "To subscribe to app install or app uninstall events, use your client credentials token to make a POST request to /webhooks-journal/subscriptions/2026-03"; payload fields type 'app_lifecycle_event', action, occurredAt, portalId, eventTypeId, properties hs_app_id, hs_app_install_level, hs_initiating_user_id, hs_user_id.
  - https://github.com/HubSpot/hubspot-project-components/blob/main/2026.09/components/webhooks/src/app/webhooks/webhooks-hsmeta.json — official SDK source — subscriptions keys: `crmObjects`, `legacyCrmObjects`, `hubEvents` (no app lifecycle)
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Auth/Oauth/Rollouts/279897/2026-09/oauth.json — official OpenAPI spec — "ClientCredentialsTokenResponse required ['access_token', 'expires_in', 'token_type', 'token_use']; token_use enum ['client_credentials']"
  - https://github.com/usertour/usertour/blob/ae33fbe63f77933129beb71e8fbdfbf2e35323d5/apps/server/src/modules/integrations/sync/hubspot-journal-api.ts — community, non-authoritative — "Verified against the live API on 2026-09-03: `earliest` / `latest` / `offset/{offset}/next` answer `{ url, expiresAt, currentOffset }` (204 when there is nothing), and the page at `url` is `{ offset, journalEvents: [...], publishedAt }`. ... export const HUBSPOT_JOURNAL_SCOPES = 'developer.webhooks_journal.read developer.webhooks_journal.subscriptions.read developer.webhooks_journal.subscriptions.write'; ... grant_type: 'client_credentials'"
  - https://github.com/usertour/usertour/blob/ae33fbe63f77933129beb71e8fbdfbf2e35323d5/integrations/hubspot/src/app/app-hsmeta.json — community, non-authoritative — `requiredScopes: ["oauth", "crm.objects.contacts.read", ... "timeline.write"]` (no developer.webhooks_journal.* scopes)
  - https://github.com/usertour/usertour/blob/ae33fbe63f77933129beb71e8fbdfbf2e35323d5/docs/adr/0013-crm-sync.md — community, non-authoritative — "the **webhooks journal API** (date-versioned) instead lets the app create per-installed-account subscriptions with a `properties` filter and pulls changes from a journal (3-day retention). Verified reachable for this app with a client-credentials token."

### HS-UNINSTALL-API — `DELETE /appinstalls/2026-09/external-install` for "Disconnect HubSpot"
- **Brief:** §5.1: on disconnect, stop processing and purge after 30 days. §5.11: "disconnect HubSpot" setting.
- **Verdict:** Extended — high confidence.
- **Finding:** `DELETE https://api.hubapi.com/appinstalls/2026-09/external-install`. The same operation exists at `/appinstalls/2026-03/...`, and at `/appinstalls/v3/...`, which the spec marks `"deprecated": true`.
  - It takes no parameters and no body.
  - Authenticate with the installed portal's OAuth access token. The spec's `security` is `[]`, so this requirement is inferred from HubSpot's Postman collection (auth `oauth2`, scope `oauth`).
  - On success it returns **204 No Content**. HubSpot uninstalls the app from that customer account and emails the account's admins.

  Spec description: "Use this endpoint to uninstall your app from a customer's HubSpot account. If successful, this endpoint will return a 204 and the customer will receive an email notification..." The spec intro adds: "Successful requests will receive a 204 response which also sends a notification email to account's Admins."

  Since May 2026, certification requires apps to use the Uninstall App API. The rule names `DELETE /appinstalls/v3/external-install`; meet it with the dated path. Whether this call immediately invalidates outstanding tokens is undocumented.
- **Design consequence:** Settings > "Disconnect HubSpot" runs these steps:
  1. `DELETE /appinstalls/2026-09/external-install` with the current access token, refreshing first if needed.
  2. `POST /oauth/2026-09/token/revoke` for the refresh token (best effort).
  3. Delete both tokens locally, mark the connection disconnected, cancel the QStash jobs, and set `purge_at = now + 30d`.

  The fake implements both HubSpot calls.
- **Open risk:** The auth requirement is inferred from the Postman collection, not the spec `security` block. Confirm the 204 and the admin email against a test portal at WIRE_UP.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/App%20Uninstalls/Rollouts/209039/2026-09/appUninstalls.json — official OpenAPI spec — "\"/appinstalls/2026-09/external-install\": { \"delete\": { \"summary\": \"Uninstall app\", \"description\": \"Use this endpoint to uninstall your app from a customer's HubSpot account. If successful, this endpoint will return a 204 and the customer will receive an email notification...\", \"responses\": {\"204\": ...}, \"security\": [] } }; x-hubspot-api-use-case 'Ideal when a customer has off-boarded from your platform but the integration remains installed'"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/App%20Uninstalls/Rollouts/209039/v3/App%20Uninstall%20API%20Collection%20Directory/App%20Management%20-%20Uninstall%20API%20Collection.json — official OpenAPI spec (Postman collection in the spec repo) — "Postman request 'Uninstall app' DELETE {{baseUrl}}/appinstalls/v3/external-install auth: {\"type\": \"oauth2\", \"oauth2\": [{\"key\": \"scope\", \"value\": \"oauth\"}, ...]}"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/App%20Uninstalls/Rollouts/209039/v3/appUninstalls.json — official OpenAPI spec — `"operationId": "delete-/appinstalls/v3/external-install", ... "deprecated": true, "security": []`

### HS-UNINSTALL-TOKENS — What happens to existing tokens on uninstall
- **Brief:** not addressed.
- **Resolves:** [VERIFY whether HubSpot notifies apps of uninstall] (§5.1), the token-side consequence
- **Verdict:** Not officially documented — medium confidence. The refresh-token behaviour comes from an official-blog search summary and community implementations. The behaviour of the access token after an uninstall is undocumented.
- **Finding:**
  - **Refresh token:** invalidated on uninstall. HubSpot's blog says refresh tokens stay valid "unless the user uninstalls your app or you revoke them". The next refresh returns HTTP 400 `invalid_grant` / `BAD_REFRESH_TOKEN`; `BAD_HUB` / `access_denied` is seen when the portal itself is deleted. Every community implementation found treats a post-uninstall refresh this way. The legacy v1 guide tells developers "If a user uninstalls your app, you can delete the refresh token", which suggests HubSpot itself does not promise to purge it.
  - **Access token already issued:** its behaviour after an uninstall is **not officially documented**. For a manual refresh-token deletion, HubSpot states that issued access tokens are not affected; they expire within 30 minutes or less. A 2026-09-30 live test found that revoking the refresh token did not invalidate an issued access token.
  - **Webhooks:** the community has reported in the past that webhook deliveries continue for an uninstalled app. Ignore events for portals that are not active.
- **Design consequence:** The webhook handler looks up the portal and drops events (200 OK, no processing) for portals whose connection is revoked or disconnected. Jobs re-check the connection status before calling HubSpot.
- **Open risk:** Everything in this finding is community-observed or inferred. At WIRE_UP, uninstall the app from a test portal, then confirm the refresh error body and check whether the old access token still works.
- **Sources:**
  - https://developers.hubspot.com/blog/oauth-token-management-hubspot-integrations — official page via search summary — direct fetch blocked in sandbox — "Refresh tokens don't expire (for now) and stay valid indefinitely unless the user uninstalls your app or you revoke them manually."
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/codegen/oauth/apis/RefreshTokensApi.ts — official SDK source — "Delete a refresh token, typically after a user uninstalls your app. Access tokens generated with the refresh token will not be affected."
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_v1_guide.md — community, non-authoritative (verbatim scrape of the official v1 guide) — "If a user uninstalls your app, you can delete the refresh token by making a `DELETE` request to `/oauth/v1/refresh-tokens/{token}`. This will only delete the refresh token. Access tokens generated with the refresh token will not be deleted."
  - https://github.com/Mrjoel97/ProjectX/blob/53d96a263f055e14bbb1c6a1a35c6d7bb58c9652/docs/connectors/hubspot-suitability.md — community, non-authoritative — "**Revocation did not cascade:** the access credential worked before AND after the refresh-grant revoke."
  - https://github.com/usertour/usertour/blob/ae33fbe63f77933129beb71e8fbdfbf2e35323d5/docs/adr/0013-crm-sync.md — community, non-authoritative — "a revoked grant (app uninstalled, authorizing user removed; a 401, or a 400 `invalid_grant`) is definitive and switches the integration off at once"

### HS-API-VERSIONING — Date-based API versions; avoid v4 and (where possible) v1–v3
- **Brief:** not addressed (all HubSpot calls in §5).
- **Verdict:** Corrected — medium confidence. The versioning rules and deadlines come from search summaries of official changelog and versioning pages, plus a verbatim scrape and community trackers. The Forms exception comes from the official spec.
- **Finding:** Date-based versioning was introduced with the 2026-03 release.
  - **Path format:** `/{api-name}/{YYYY-MM}/{resource}` on `https://api.hubapi.com`, with no version header. Examples:
    - `POST /oauth/2026-09/token`
    - `GET /account-info/2026-09/details`
    - `POST /crm/objects/2026-09/contacts/search`
    - `GET /crm/objects/2026-09/contacts/{id}/associations/emails`
    - `POST /crm/associations/2026-09/{from}/{to}/batch/read`
    - `DELETE /appinstalls/2026-09/external-install`
    - `POST /webhooks-journal/subscriptions/2026-09`
  - **Release cycle:** new GA versions ship each March and September. Each version is "Current" for 6 months, then "Supported", and becomes unsupported 18 months after GA (2026-09 → about March 2028).
  - **Betas** are named for the next release (`/2027-03-beta/`).
  - **Latest GA on 2026-10-01:** `2026-09`. HubSpot: "For new integrations, always use the latest date version."

  **Legacy deadlines:**
  - OAuth v1 endpoints stop working on **2027-02-16**.
  - **v4 APIs** (e.g. `/crm/v4/...`) become unsupported on **2027-03-30** (changelog `deprecating-support-for-hubspot-v4-apis`, announced 2026-05-21).
  - **v1–v3** become unsupported with **September 2027** enforcement (no day published).

  One community skill says "v1–v4 end of support March 30, 2027", which conflicts on v1–v3. The safe reading is therefore: **no v4 calls at all, and no v1–v3 calls** except the forms list and submissions endpoints, which have no dated replacement. Marketplace apps on unsupported versions risk losing certification. HubSpot also says: "Do not use v3 or v4 as an intermediate step."

  This matters for the reply-detection design. Instead of `GET /crm/v4/objects/contacts/{id}/associations/emails`, use `GET /crm/objects/2026-09/contacts/{contactId}/associations/emails` or `POST /crm/associations/2026-09/contacts/emails/batch/read`.

  **Exceptions with no GA dated path:**
  - Marketing Forms: use `/marketing/v3/forms` with a TODO. The spec has only rollouts `144909/v3`, `144909/2026-09-beta` and `144909/2027-03-beta`.
  - Form submissions: `/form-integrations/v1/submissions/forms/{guid}`.

  Use a single path builder driven by `HUBSPOT_API_VERSION='2026-09'`, and make no `/v4/` calls.
- **Design consequence:** `HUBSPOT_API_VERSION='2026-09'` drives one path builder. The forms list uses `/marketing/v3/forms` behind `HubSpotClient`, with a TODO to move to the GA dated forms path when it ships. Plan a version bump before about March 2028, when 2026-09 reaches end of life.
- **Open risk:** The 2026-09 end-of-life date is inferred from the 18-month rule (about March 2028). The v4 and v1–v3 deadlines rest on changelog search summaries and community trackers; re-check the changelog pages live. The forms list and submissions endpoints stay on legacy paths that go unsupported in September 2027, so they need a migration path before then.
- **Sources:**
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_latest_overview.md — community, non-authoritative (verbatim scrape of https://developers.hubspot.com/docs/api-reference/latest/overview) — "All endpoints in this section follow the pattern: /api-name/2026-03/resource" "GET /crm/objects/2026-03/contacts" "When a new date version is released, the previous version continues to work until its end-of-life date ... For new integrations, always use the latest date version."
  - https://developers.hubspot.com/changelog/introducing-date-based-api-versioning — official page via search summary — direct fetch blocked in sandbox — "announced March 30, 2026; /YYYY-MM/ format; releases in March and September; 18 months of support; 'beta APIs use version /2026-09-beta/'; legacy semantic versions still available at previous URLs."
  - https://developers.hubspot.com/docs/developer-tooling/platform/versioning — official page via search summary — direct fetch blocked in sandbox — "Each new version is considered \"Current\" for 6 months ... then transitions to \"Supported\" ... finally becomes \"Unsupported\" 18 months after its original GA release."
  - https://developers.hubspot.com/changelog/legacy-apis-and-legacy-apps-whats-going-unsupported-and-when — official page via search summary — direct fetch blocked in sandbox — "v1-v3 unsupported, September 2027 enforcement; 'Using unsupported API versions (v1-v4) after September 2027: your app loses its certification status'; 'Do not use v3 or v4 as an intermediate step.'"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Marketing/Forms/Rollouts/144909/2026-09-beta/forms.json — official OpenAPI spec — "Only Forms rollouts present: 144909/v3, 144909/2026-09-beta, 144909/2027-03-beta; paths GET /marketing/forms/2026-09-beta"
  - https://github.com/jameskomo/docswatcher/blob/71d48dbf8cd4fcb842e489b2076e5469792944f2/knowledge/providers/hubspot/changes/hubspot-v4-apis-unsupported-2027.yaml — community, non-authoritative — "On March 30, 2027 HubSpot's v4 APIs (for example /crm/v4/) move to an unsupported state, as part of the move to date-based API versioning. ... announced: 2026-05-21 effective: 2027-03-30 sources: - kind: changelog url: https://developers.hubspot.com/changelog/deprecating-support-for-hubspot-v4-apis"
  - https://github.com/jameskomo/docswatcher/blob/71d48dbf8cd4fcb842e489b2076e5469792944f2/knowledge/providers/hubspot/changes/hubspot-v1-v3-apis-unsupported-2027.yaml — community, non-authoritative — "observed: 2026-09-24 note: \"Enforcement: September 2027; no day is published.\""
  - https://github.com/usertour/usertour/blob/ae33fbe63f77933129beb71e8fbdfbf2e35323d5/apps/server/src/modules/integrations/sync/hubspot-api.ts — community, non-authoritative — "The legacy paths go * unsupported on 2027-03-30 (`/v4`) and in 2027-09 (`/v1`–`/v3`); the * unversioned `/oauth/v1/*` endpoints also put secrets in the URL and are * sunset on 2027-02-16."

### HS-SDK-CHOICE — Do not use HubSpot's Node SDKs; use plain fetch with Zod
- **Brief:** not addressed (§3 stack; §8 fakes).
- **Verdict:** Extended — high confidence.
- **Finding:** Neither official SDK is a good fit:
  - **`@hubspot/api-client` 14.0.1** (published 2026-07-01, Node >= 22) still targets **legacy paths**: `TokensApi` uses `localVarPath` `'/oauth/v1/token'`, and CRM calls use v3. It is not date-versioned.
  - **`@hubspot/sdk`**, HubSpot's new official TypeScript SDK, is **alpha**: 0.1.0-alpha.10, which npm records as published 2026-05-27T09:53:29Z. It targets the 2026-03 release (`'/oauth/2026-03/token'`, `'/account-info/2026-03/details'`, `'/appinstalls/2026-03/external-install'`, `'/crm/objects/2026-03/contacts/search'`). It retries 408/409/429/>=500, honouring `retry-after-ms` and `retry-after`.
- **Design consequence:** Implement `HubSpotClient` with plain `fetch` and Zod. The surface is small: token, introspect, revoke, account details, contacts get/search, forms list, submissions, emails/associations, and uninstall. This avoids both an alpha dependency and a legacy-path SDK, and keeps the fake trivial.
- **Sources:**
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/codegen/oauth/apis/TokensApi.ts — official SDK source — "const localVarPath = '/oauth/v1/token';"
  - https://github.com/HubSpot/hubspot-sdk-typescript/blob/main/README.md — official SDK source — "This library provides convenient access to HubSpot's date-versioned REST API (`2026-03` release)"; package @hubspot/sdk 0.1.0-alpha.10
  - https://registry.npmjs.org/@hubspot/sdk — official SDK source — `npm view @hubspot/sdk time: "0.1.0-alpha.10": "2026-05-27T09:53:29.739Z"; npm view @hubspot/api-client time: "14.0.1": "2026-07-01T20:43:02.091Z"`

### HS-RATE-LIMITS — 110 requests per 10 s per portal; CRM Search at 5 requests/s
- **Brief:** not addressed (§5.2 poller; §5.6; §5.8).
- **Verdict:** Extended — medium confidence. The limits come from a search summary of the official usage-guidelines page, verbatim scrapes of the official search and usage pages, and the official SDK constants. Platform 2026.09 is not named explicitly in any limits text.
- **Finding:**
  - **General limit:** OAuth apps distributed through the marketplace (legacy public apps and platform 2025.2/2026.03 apps) get **110 requests per 10 seconds per installing HubSpot account**.
    - This excludes the CRM Search API.
    - The API Limit Increase add-on does not raise it.
    - OAuth requests get no daily-limit headers, and no daily cap is published for OAuth apps.
  - **CRM Search endpoints:**
    - **5 requests/second per account**. The latest docs say per account; older docs said per authentication token.
    - At most **200 records per page**, and at most **10,000 total results per query**; paging beyond that returns 400.
    - At most 5 `filterGroups` × 6 filters, 18 filters in total.
    - Archived CRM objects do not appear in search results.
    - A query can contain at most **3,000 characters**, or it returns 400.
    - Newly created or updated objects can take a few moments to appear in search.
    - Search responses include **no** rate-limit headers.
  - **Batch read endpoints:** 100 records per request.
  - **Error budget:** keep error responses under 5% of daily requests (a certification requirement).
  - **Official Node SDK client-side defaults:** general limiter `minTime 1000/9 ms`, `maxConcurrent 6`; search limiter `minTime 550 ms`, `maxConcurrent 3`.
  - Privately distributed apps get different limits; see HS-V4-PRIVATE-DISTRIBUTION-LIMITS.
- **Design consequence:** Use a per-portal limiter: at most 9 requests/s in general and 2–4 requests/s for search, implemented as a DB- or Redis-backed token bucket or a serialized queue per portal. The poller's cursor on `recent_conversion_date` must overlap previous runs (e.g. re-query the last 10 minutes) because search indexing lags. Dedupe on (contact ID, submission timestamp), as the brief says. Keep the search filter body small, well under 3,000 characters.
- **Open risk:** Platform 2026.09 is not explicitly named in the 110/10 s statement; the search summary lists 2025.2 and 2026.03. Assume the same limit, and re-check the usage-guidelines page live at WIRE_UP.
- **Sources:**
  - https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines — official page via search summary — direct fetch blocked in sandbox — "For legacy public apps and apps on the latest versions of the developer platform (2025.2 and 2026.03) using OAuth authentication distributed via the HubSpot marketplace, each HubSpot account that installs your app is limited to 110 requests every 10 seconds. This limit excludes the CRM Search API."
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_crm_search-the-crm_2.md — community, non-authoritative (verbatim scrape of https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm) — "The search endpoints are rate limited to five requests per second per account." "limited to 10,000 total results for any given query. Attempting to page beyond 10,000 will result in a 400 error." "It may take a few moments for newly created or updated CRM objects to appear in search results." / "Archived CRM objects won’t appear in any search results." "The maximum number of supported objects per page is 200." "A query can contain a maximum of 3,000 characters. If the body of your request exceeds 3,000 characters, a 400 error will be returned."
  - https://raw.githubusercontent.com/Namit2111/Agent-Jivus/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/usage-details/content.txt — community, non-authoritative (2024 scrape of the official usage guidelines) — "X-HubSpot-RateLimit-Daily ... Note that this header is not included in the response to API requests authorized using OAuth." "Responses from the search API endpoints will not include any of the rate limit headers" "Batch requests to CRM object endpoints are limited to 100 records per request." / "For OAuth apps, each HubSpot account that installs your app is limited to 110 requests every 10 seconds. This excludes the Search API"
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/src/configuration/constants.ts — official SDK source — "DEFAULT_LIMITER_OPTIONS = { minTime: 1000 / 9, maxConcurrent: 6 }; SEARCH_LIMITER_OPTIONS = { minTime: 550, maxConcurrent: 3 }"

### HS-429-SHAPE — 429 body, rate-limit headers and retry policy
- **Brief:** §5.1: 429 is transient.
- **Resolves:** [VERIFY] §5.1 exact error shapes (429 side)
- **Verdict:** Extended — medium confidence. The policy names and messages come from the official SDK source. The example body comes from a verbatim 2024 scrape of the official usage guidelines and from real responses.
- **Finding:** Example 429 body:
  ```json
  {"status":"error","message":"You have reached your daily limit.","errorType":"RATE_LIMIT","correlationId":"c033cdaa-2c40-4a64-ae48-b4cec88dad24","policyName":"DAILY","requestId":"3d3e35b7-0dae-4b9f-a6e3-9c230cbcf8dd"}
  ```
  - `message` and `policyName` indicate which limit was hit: `DAILY` or `TEN_SECONDLY_ROLLING`.
    - The ten-secondly message is `You have reached your ten_secondly_rolling limit.`
    - The search message is `You have reached your secondly limit.`
  - Real ten-secondly bodies also carry `correlationId` and an extra `groupName` field (e.g. `publicapi:private_app-api-calls-ten-secondly:1512050:26892217`).
  - The daily limit resets at midnight in the account's time zone. OAuth apps have no daily cap, so a `DAILY` 429 should not normally happen for Autopilot; keep the handling anyway.

  Rate-limit headers on normal responses:
  - present: `X-HubSpot-RateLimit-Interval-Milliseconds`, `X-HubSpot-RateLimit-Max`, `X-HubSpot-RateLimit-Remaining`;
  - absent for OAuth: `X-HubSpot-RateLimit-Daily`, `X-HubSpot-RateLimit-Daily-Remaining`;
  - deprecated: `X-HubSpot-RateLimit-Secondly`, `X-HubSpot-RateLimit-Secondly-Remaining`.

  `Retry-After` is officially documented only for 477 Migration in Progress (in seconds). It is **not** documented for 429, although the community claims it exists. Honour it if present; otherwise back off.

  Retry behaviour of the official Node SDK:
  - 5xx: wait 200 ms × attempt;
  - 429 with `body.policyName` `TEN_SECONDLY_ROLLING`: wait 10 s × attempt;
  - 429 with `body.message` `You have reached your secondly limit.`: wait 1 s × attempt;
  - any other 429 (e.g. `DAILY`): no retry.
- **Design consequence:** Backoff rules:
  - if `Retry-After` is present, use it;
  - otherwise `TEN_SECONDLY_ROLLING` waits 10 s, and the search secondly limit waits 1 s;
  - `DAILY` defers the job to the next local midnight plus jitter, without burning the 5 attempts.

  The Zod schema makes every field optional, `groupName` included.
- **Open risk:** Whether a 429 carries `Retry-After` is undocumented. Observe it in production logs.
- **Sources:**
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/src/services/decorators/RetryDecorator.ts — official SDK source — "public readonly tenSecondlyRolling = 'TEN_SECONDLY_ROLLING'; public readonly secondlyLimitMessage = 'You have reached your secondly limit.'; retryTimeout = { INTERNAL_SERVER_ERROR: 200, TOO_MANY_REQUESTS: 10 * 1000, TOO_MANY_SEARCH_REQUESTS: 1000 }"
  - https://raw.githubusercontent.com/Namit2111/Agent-Jivus/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/usage-details/content.txt — community, non-authoritative (2024 scrape of the official usage guidelines) — "\"status\": \"error\", \"message\": \"You have reached your daily limit.\", \"errorType\": \"RATE_LIMIT\", \"correlationId\": \"c033cdaa-...\", \"policyName\": \"DAILY\", \"requestId\": \"3d3e35b7-...\"" "The daily limit resets at midnight based on your time zone setting."
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_-reference_error-handling.md — community, non-authoritative (verbatim scrape of the official error-handling page) — Retry-After mentioned only for "477 Migration in Progress" ("how many seconds to wait").
  - https://github.com/hubspotdev/devslackarchive/blob/9b76cf5a6943d98f0c8b5ff3bab6e60956619d4a/channel_api/2023/03/2023-03-27.json — community, non-authoritative — `{"status":"error","message":"You have reached your ten_secondly_rolling limit.","errorType":"RATE_LIMIT","correlationId":"20f98dfa-05b6-4d27-8d96-ecfde54ca211","policyName":"TEN_SECONDLY_ROLLING","groupName":"publicapi:private_app-api-calls-ten-secondly:1512050:26892217"}`

### HS-RECORD-URL — Contact record link format for the Monday report
- **Brief:** §5.9: list leads with no confirmed reply, "with HubSpot record links" (format not specified).
- **Verdict:** Confirmed — high confidence. HubSpot's own plugin repo endorses the format, but it is not an API contract.
- **Finding:** The contact record link is **`https://{uiDomain}/contacts/{portalId}/record/0-1/{contactId}`**.
  - HubSpot also uses an equivalent form, `https://{uiDomain}/contacts/{portalId}/contact/{contactId}`. Its Sales skills use `/contact/[id]`, and its Partner skill uses `/record/0-145/[objectId]`.
  - `uiDomain` and `portalId` come from `GET /account-info/2026-09/details` (e.g. `'app.hubspot.com'`, `'app-eu1.hubspot.com'`). HubSpot's own guidance says never to hardcode `uiDomain`.
  - `0-1` is the contacts `objectTypeId`.
  - Do **not** derive the host from `hub_domain`, which is the customer's website domain.
  - When `uiDomain` is unknown, fall back to `app.hubspot.com`.

  Keep the format in one `buildContactUrl()` helper with a unit test, e.g. `{uiDomain:'app-eu1.hubspot.com', portalId:12345678, contactId:51}` → `https://app-eu1.hubspot.com/contacts/12345678/record/0-1/51`.
- **Design consequence:** The `buildContactUrl({uiDomain, portalId, contactId})` helper has a unit test. Store `ui_domain` per portal at install. Links appear only in owner emails and the report, with no tracking.
- **Open risk:** The UI URL scheme is not part of any API contract. Keeping it in one helper means it can change in one place.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/147891/2026-09/webhooks.json — official OpenAPI spec — "ObjectSubscriptionUpsertRequest.objectTypeId: 'A string that identifies the type of object ... For example \"0-1\" for contacts.'"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Account/Account%20Info/Rollouts/136890/v3/accountInfo.json — official OpenAPI spec — `example ... "uiDomain": "app-eu1.hubspot.com", "dataHostingLocation": "eu1"`
  - https://community.hubspot.com/t5/CRM/record-0-1-in-URL/m-p/814077 — community, non-authoritative (search summary; direct fetch blocked) — "A contact's URL in HubSpot looks like this: https://app.hubspot.com/contacts/PORTALID/record/0-1/RECORDID"; old '/contact/' form changed to '/record/0-1/'.
  - https://github.com/HubSpot/hubspot-mcp-plugins/blob/a0c59600fc1ddcf03ceca71aebf0c28aa55f49e3/HubSpot-Sales/skills/hubspot/SKILL.md — official SDK source — "On success, store `portalId` and `uiDomain`. Build record links as: `https://[uiDomain]/contacts/[portalId]/[objectType]/[id]` The `uiDomain` is account-specific (e.g. `app.hubspot.com` or `app-euX.hubspot.com`) — never hardcode it."
  - https://github.com/HubSpot/hubspot-mcp-plugins/blob/a0c59600fc1ddcf03ceca71aebf0c28aa55f49e3/HubSpot-Sales/skills/daily-brief/SKILL.md — official SDK source — "Link each contact and deal name to their HubSpot record: `[Name](https://[uiDomain]/contacts/[portalId]/contact/[id])`."
  - https://github.com/HubSpot/hubspot-mcp-plugins/blob/a0c59600fc1ddcf03ceca71aebf0c28aa55f49e3/HubSpot-Partner/skills/book-pulse/SKILL.md — official SDK source — "render its name as a **clickable markdown link** to its record: `[Client name](https://[uiDomain]/contacts/[portalId]/record/0-145/[objectId])`."

### HS-HUB-DOMAIN-SEMANTICS — "Hub domain" is the customer's website domain; what to store per portal
- **Brief:** §5.1: "Store portal ID, hub domain and timezone".
- **Resolves:** [VERIFY endpoint and scope for account timezone] (§5.1): the "portal ID, hub domain" half of the same bullet
- **Verdict:** Corrected — medium confidence.
- **Finding:** The token-metadata field `hub_domain` is the portal's **own website domain** (docs examples: `example.com`, `meowmix.com`). It is not the HubSpot UI host.
  - **Portal ID** = `hub_id` from the token response, which equals `portalId` in the account details.
  - **Hublet** (`na1`, `eu1`) is in `signed_access_token.hublet` and in the refresh-token prefix. `dataHostingLocation` in the account details gives the same information.
  - The API host `api.hubapi.com` routes to the right hublet automatically. This is not explicitly documented, but every spec `servers` entry is `https://api.hubapi.com`, and HubSpot's CLI and SDKs use it for all accounts.

  **Store:** `hub_id`/`portal_id`, `ui_domain`, `data_hosting_location`, `time_zone`, `utc_offset_ms`, `account_type`, the granted scopes, and the installing user/`user_id`. `hub_domain` is optional and for display only.
- **Design consequence:** `hubspot_connections` columns:
  - `portal_id` (unique), `ui_domain`, `data_hosting_location`, `time_zone`, `utc_offset_ms`, `account_type`;
  - `scopes text[]`;
  - `installer_email` (subject to the privacy decision);
  - `status`;
  - the token fields, encrypted.
- **Open risk:** Low. Automatic hublet routing via `api.hubapi.com` is inferred from the specs and the official clients, not stated in the docs.
- **Sources:**
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_v1_guide.md — community, non-authoritative (verbatim scrape of the official v1 guide) — access-token metadata example: "\"user\": \"user@domain.com\", \"hub_domain\": \"meowmix.com\", ... \"hublet\": \"na1\""
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Auth/Oauth/Rollouts/279897/2026-09/oauth.json — official OpenAPI spec — "hub_domain: 'A string representing the domain of the HubSpot account associated with the token.'; SignedAccessToken.hublet: 'A string indicating the specific HubSpot region or cluster.'"

### 02.x Verifier-added items

#### HS-V1-REVOKE-RESPONSE — What `POST /oauth/{v}/token/revoke` returns; revocation does not cascade
- **Brief:** not addressed (§5.1 disconnect).
- **Verdict:** Not officially documented — medium confidence. The spec declares only a `default` Error response. The behaviour comes from two community live tests plus the legacy guide.
- **Finding:** The spec declares only a `default` Error response for `/oauth/2026-09/token/revoke` ("Deletes/Revokes provided Refresh Token").

  A community live test on 2026-09-25 observed:
  - HTTP **200** for a form-body revoke;
  - then 400 `BAD_REFRESH_TOKEN` on refresh;
  - and `{active:false}` on introspect.

  Revocation does **not** cascade:
  - a separate live test on 2026-09-30 found "the access credential worked before AND after the refresh-grant revoke";
  - the legacy v1 guide says "Access tokens generated with the refresh token will not be deleted."
- **Design consequence:** On disconnect, run these steps in order:
  1. Call `DELETE /appinstalls/2026-09/external-install` with the current access token.
  2. Revoke the refresh token.
  3. Delete both tokens locally and cancel jobs.

  Assume the old access token can stay valid for up to 30 minutes (`expires_in` 1800), and never use it again.
- **Open risk:** The revoke status code and the non-cascading behaviour are community-observed only. Re-check both on a test portal at WIRE_UP.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Auth/Oauth/Rollouts/279897/2026-09/oauth.json — official OpenAPI spec — `"/oauth/2026-09/token/revoke": { "post": { "summary": "Token Revocation endpoint", "description": "Deletes/Revokes provided Refresh Token", ... "responses": { "default": { "description": "", "$ref": "#/components/responses/Error" } } } }`
  - https://github.com/NangoHQ/nango/issues/7664 — community, non-authoritative — "Revoke on 2026-03 (form body) | 200 | 200"; "Refresh after revoke, 2026-03 and v1 | 400 `BAD_REFRESH_TOKEN` on both"; "Introspect after revoke | `active: false`"
  - https://github.com/Mrjoel97/ProjectX/blob/53d96a263f055e14bbb1c6a1a35c6d7bb58c9652/docs/connectors/hubspot-suitability.md — community, non-authoritative — "**Revocation did not cascade:** the access credential worked before AND after the refresh-grant revoke. `upstream: confirmed`, `cascaded: false`"
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_v1_guide.md — community, non-authoritative (verbatim scrape of the official v1 guide) — "This will only delete the refresh token. Access tokens generated with the refresh token will not be deleted."

#### HS-V2-AUTH-CODE-ERRORS — Error statuses for the authorization-code exchange (callback leg)
- **Brief:** not addressed. §5.1 covers only refresh failures.
- **Resolves:** [VERIFY] §5.1 exact error shapes (install-callback side)
- **Verdict:** Not officially documented — medium confidence. No official enumeration exists; the statuses come from several independent community codebases.
- **Finding:** On the token endpoint, these errors return HTTP 400. The body carries HubSpot's `status` and `message`, and newer endpoints also send the RFC 6749 `error` / `error_description`. Statuses seen in the wild:
  - `BAD_AUTH_CODE`: the code expired, was reused or is unknown. The docs say the code is single-use with a short exchange window.
  - `BAD_CODE_VERIFIER`: PKCE mismatch.
  - `BAD_REDIRECT_URI`: `redirect_uri` does not equal the configured URL.
  - `BAD_CLIENT_ID` / `BAD_CLIENT_SECRET`, with `error` `invalid_client`.
  - `BAD_SCOPES`.

  Callback handling: any of these is terminal for that install attempt. Show "Install failed — please try again" and log the status and correlation id. Never retry the same code. `BAD_CLIENT_*` and `BAD_REDIRECT_URI` also alert ops, because they indicate a configuration error.
- **Design consequence:** The callback handler maps every token-endpoint failure to a terminal install-failed page. Configuration-class statuses also raise one Sentry alert. The same `classifyRefreshFailure` key order applies: `error` first, then `status`.
- **Open risk:** These statuses are community-only. At WIRE_UP, deliberately replay a used code against `/oauth/2026-09/token` to capture the real body.
- **Sources:**
  - https://github.com/onyx-dot-app/onyx/blob/c2e5be7996373ed120f770209ffe9a6c498fc4e6/backend/onyx/external_apps/providers/hubspot.py — community, non-authoritative — "# HubSpot's token endpoint returns a non-2xx with a machine-readable # `status` (e.g. `BAD_REFRESH_TOKEN`, `BAD_AUTH_CODE`) rather than the # OAuth `error` field the generic helper looks for."
  - https://github.com/bagofwords1/bagofwords/blob/c56f60c8f6333b19ed8c5934debaf8b48d438552/docs/feedback-loops/hubspot-mcp-preset.md — community, non-authoritative — "exchange with `BAD_CODE_VERIFIER` (which, usefully, is a *different* error from `BAD_AUTH_CODE` — the code was recognised). ... - correct secret → `{\"status\":\"BAD_SCOPES\", ...}` — client auth passed - wrong secret → `{\"status\":\"BAD_CLIENT_SECRET\", ...}`"
  - https://github.com/usertour/usertour/blob/ae33fbe63f77933129beb71e8fbdfbf2e35323d5/apps/server/src/modules/integrations/sync/hubspot-api.spec.ts — community, non-authoritative — "tokenFailure(400, { error: 'invalid_client', status: 'BAD_CLIENT_ID' })"
  - https://github.com/relayaa/RELAYA/blob/cf19a5816d51ffa6e10a9e1fc09705fe15502460/backend/internal/connect/client.go — community, non-authoritative — `"BAD_REFRESH_TOKEN": true, "BAD_AUTH_CODE": true, "BAD_CLIENT_ID": true, "BAD_REDIRECT_URI": true, // HubSpot`
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_authentication_manage-oauth-tokens.md — community, non-authoritative (verbatim scrape of the official v3 guide) — "Authorization code: a temporary, single-use code ... Your app then has a short window to exchange it for an access token and a refresh token, after which the authorization code cannot be reused."

#### HS-V3-INSTALLER-PERMISSION-AND-AI-LISTING — Who may install, and the "AI connector" listing rule
- **Brief:** §4.1: "Install with HubSpot"; §11: marketplace listing out of scope.
- **Verdict:** Not officially documented — medium confidence. The evidence is a community mirror of the official OAuth page and third-party quotes of the listing requirements.
- **Finding:** **Installing users must be a Super Admin or have the "App Marketplace Access" permission**; otherwise the consent screen blocks them. WIRE_UP and the onboarding copy should say this.

  HubSpot's App Marketplace listing requirements, as quoted by third parties, say an "AI connector" must use user-level permissions and HubSpot's MCP Server. An AI connector is an app that "primarily connects HubSpot to external generative AI tools", or in the requirements' definition, apps "that primarily connect HubSpot directly to general-purpose generative AI assistants or agents".

  Autopilot drafts replies with an LLM, but it is a lead-response workflow product, not a connector to a general-purpose assistant. The classification is HubSpot's call at review time, so record it in DECISIONS.md and describe the app that way in the eventual listing.
- **Design consequence:** Show an "you need Super Admin or App Marketplace Access" hint on the install page and in WIRE_UP. Note the AI-connector positioning in DECISIONS.md for the eventual listing.
- **Open risk:** At WIRE_UP or before listing, re-check the live listing-requirements page and the working-with-OAuth page.
- **Sources:**
  - https://github.com/SynthmindsLLC/SynthBrain/blob/b74b687714ee3991706775d1a59e14d6e687ab30/%F0%9F%9B%A0%20The%20Workshop/Tools%20Documentation/Notes%20%26%20API%20Docs/Hubspot%20API%20Documentation/api/working-with-oauth.md — community, non-authoritative (mirror of developers.hubspot.com working-with-oauth) — "users installing apps in their HubSpot account must either be a [super admin](...) or have [App Marketplace Access](...) permissions."
  - https://github.com/Mrjoel97/ProjectX/blob/53d96a263f055e14bbb1c6a1a35c6d7bb58c9652/docs/connectors/hubspot-suitability.md — community, non-authoritative — "if your app is an AI connector - an app that primarily connects HubSpot to external generative AI > tools - it must require user-level permissions and be built with HubSpot's MCP Server" ... "AI connectors are defined as apps that primarily connect HubSpot directly to general-purpose > generative AI assistants or agents"
  - https://github.com/swapnilskumbhar/howitworks/blob/e5ab30db74e7159ba3cd10ce9bbe7211eeda7ad6/temp.md — community, non-authoritative — "HubSpot now requires AI connectors to use user-level permissions and its MCP Server ... ([developers.hubspot.com](https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/app-marketplace-listing-requirements?utm_source=openai))"

#### HS-V4-PRIVATE-DISTRIBUTION-LIMITS — Rate limits if the app is first distributed privately
- **Brief:** not addressed.
- **Verdict:** Not officially documented — medium confidence. The evidence is a 2024 scrape of the official usage guidelines plus a community restatement.
- **Finding:** Private distribution does **not** get the flat OAuth limit of 110 requests per 10 s per account.
  - **Burst limit:** HubSpot's usage guidelines give private apps 100 requests per 10 s per app on Free/Starter, or 190 on Professional/Enterprise. With the API Limit Increase add-on the limit is 250.
  - **Daily limit:** 250,000 / 625,000 / 1,000,000 per account, shared across all apps in the account. It resets at midnight in the account's timezone, so a `DAILY` 429 is then possible.
  - **Search:** stays at 5 requests/s per account.

  A per-portal limiter at about 9 requests/s general and 2–4 requests/s search fits both models. Choose marketplace distribution in `app-hsmeta.json` from day one: changing distribution later means a new config upload, and private distribution caps out at 10 accounts.
- **Design consequence:** Keep `distribution: "marketplace"` from the first upload. The same limiter settings work under either distribution model.
- **Open risk:** These numbers come from a 2024 scrape and from community sources. Re-check the live usage-guidelines page if a private pilot is ever used.
- **Sources:**
  - https://raw.githubusercontent.com/Namit2111/Agent-Jivus/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/usage-details/content.txt — community, non-authoritative (2024 scrape of developers.hubspot.com usage guidelines) — "Free and Starter 100 / private app 250,000 / account ... Professional 190 / private app 625,000 / account ... Enterprise 190 / private app 1,000,000 / account" ... "The daily limit resets at midnight based on your time zone setting."
  - https://github.com/Mrjoel97/ProjectX/blob/53d96a263f055e14bbb1c6a1a35c6d7bb58c9652/docs/connectors/hubspot-suitability.md — community, non-authoritative — "Private distribution is tiered per installing account: Free/Starter 100/app per 10s + 250,000/account daily; Professional 190/app + 625,000; Enterprise 190/app + 1,000,000; API Limit Increase add-on 250/app + 1,000,000 on top of base. Burst is per app; the daily cap \"is shared across all apps within the same HubSpot account\"."

### 02.y Test vectors

This cluster has no cryptographic vectors. Every fixture was re-derived from its sources during verification. Provenance falls into three groups:
- **Published by the vendor:** HubSpot docs examples (read via verbatim scrape) and HubSpot spec examples or schemas.
- **Observed by the community:** live tests and production fixtures.
- **Generated locally:** with Node v22 `node:querystring`, the encoding method the official SDK uses.

The vectors are copied verbatim from the research output below; each `source` field is part of the vector. Verifier corrections follow the vectors.

**`token_success_2026_09`.** Vendor-published: docs example (v3 guide), with the spec-required `token_use` added.
```json
{
  "request": "POST https://api.hubapi.com/oauth/2026-09/token  Content-Type: application/x-www-form-urlencoded  body: grant_type=refresh_token&client_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&client_secret=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&refresh_token=na1-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "status": 200,
  "body": {
    "token_type": "bearer",
    "refresh_token": "na1-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "access_token": "CIrToaiiMhIHAAEAQAAAARiO1ooBIOP0sgEokuLtAEaOaTFnToZ3VjUbtl46MAAAAEAAAAAgAAAAAAAAAAAACAAAAAAAOABAAAAAAAAAAAAAAAQAkIUVrptEzQ4hQHP89Eoahkq-p7dVIAWgBgAA",
    "hub_id": 1234567,
    "scopes": [
      "oauth",
      "crm.objects.contacts.read",
      "forms",
      "sales-email-read"
    ],
    "token_use": "access_token",
    "expires_in": 1800
  },
  "source": "docs example (v3 guide) + spec required token_use"
}
```

**`refresh_revoked`.** Vendor-published body: verbatim in the official v1 and v3 guides. The HTTP 400 status was observed by the community (live test).
```json
{
  "status": 400,
  "body": {
    "error": "invalid_grant",
    "error_description": "refresh token is invalid, expired or revoked",
    "status": "BAD_REFRESH_TOKEN",
    "message": "refresh token is invalid, expired or revoked"
  },
  "expected_classification": "revoked",
  "source": "official v1 + v3 guides (verbatim); status 400 per community live test"
}
```

**`refresh_bad_hub`.** Community-observed (PostHog). This original vector is superseded by the verifier-corrected body below.
```json
{
  "status": 400,
  "body": {
    "status": "BAD_HUB",
    "error": "access_denied",
    "message": "<varies>"
  },
  "expected_classification": "revoked",
  "source": "community (PostHog) - message text not known"
}
```

**`refresh_bad_client`.** Community-observed (usertour test). The verifier confirmed it at HTTP 400.
```json
{
  "status": 400,
  "body": {
    "error": "invalid_client",
    "status": "BAD_CLIENT_ID",
    "message": "<varies>"
  },
  "expected_classification": "config",
  "source": "community (usertour test)"
}
```

**`rate_limited_daily`.** Vendor-published: official usage-guidelines example, verbatim via scrape.
```json
{
  "status": 429,
  "body": {
    "status": "error",
    "message": "You have reached your daily limit.",
    "errorType": "RATE_LIMIT",
    "correlationId": "c033cdaa-2c40-4a64-ae48-b4cec88dad24",
    "policyName": "DAILY",
    "requestId": "3d3e35b7-0dae-4b9f-a6e3-9c230cbcf8dd"
  },
  "expected_classification": "transient",
  "source": "official usage guidelines example (verbatim)"
}
```

**`rate_limited_ten_secondly`.** `policyName` is from the official SDK; the message text was observed by the community.
```json
{
  "status": 429,
  "body": {
    "status": "error",
    "message": "You have reached your ten_secondly_rolling limit.",
    "errorType": "RATE_LIMIT",
    "policyName": "TEN_SECONDLY_ROLLING"
  },
  "expected_classification": "transient",
  "source": "policyName from official SDK RetryDecorator; message text community"
}
```

**`rate_limited_search_secondly`.** The message string is from the official SDK source.
```json
{
  "status": 429,
  "body": {
    "status": "error",
    "message": "You have reached your secondly limit.",
    "errorType": "RATE_LIMIT"
  },
  "expected_classification": "transient",
  "source": "message string from official SDK RetryDecorator"
}
```

**`migration_in_progress`.** Vendor-published behaviour: the official error-handling page documents `Retry-After` in seconds. The value `3600` is an illustrative fixture value.
```json
{
  "status": 477,
  "headers": {
    "Retry-After": "3600"
  },
  "expected_classification": "transient",
  "source": "official error-handling page"
}
```

**`account_details`.** Vendor-published: official docs example (`body`) and spec 144923/v3 example (`body_eu_example`).
```json
{
  "request": "GET https://api.hubapi.com/account-info/2026-09/details  Authorization: Bearer <access_token>",
  "status": 200,
  "body": {
    "portalId": 123456,
    "accountType": "STANDARD",
    "timeZone": "US/Eastern",
    "companyCurrency": "USD",
    "additionalCurrencies": [
      "EUR"
    ],
    "utcOffset": "-05:00",
    "utcOffsetMilliseconds": -18000000,
    "uiDomain": "app.hubspot.com",
    "dataHostingLocation": "na1"
  },
  "body_eu_example": {
    "additionalCurrencies": [
      "NZD",
      "AUD",
      "EUR"
    ],
    "companyCurrency": "USD",
    "createdAt": 1648840584303,
    "dataHostingLocation": "eu1",
    "portalId": 12345678,
    "portalName": "Acme Inc",
    "timeZone": "US/Eastern",
    "uiDomain": "app-eu1.hubspot.com",
    "utcOffset": "-04:00",
    "utcOffsetMilliseconds": -14400000
  },
  "source": "official docs example + spec example"
}
```

**`introspect_refresh_token`.** Vendor-published: official v3 guide example. `after_revoke_body` was observed by the community (live test) and matches HubSpot's Postman 200 example `{active:<boolean>}`.
```json
{
  "request": "POST https://api.hubapi.com/oauth/2026-09/token/introspect  form: client_id, client_secret, token=na1-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee, token_type_hint=refresh_token",
  "status": 200,
  "body": {
    "active": true,
    "token": "na1-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "hub_id": 1234567,
    "user_id": 222222,
    "client_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "app_id": 1234444,
    "user": "jdoe@hubspot.com",
    "hub_domain": "example.com",
    "scopes": [
      "crm.objects.contacts.write",
      "oauth",
      "crm.objects.contacts.read"
    ],
    "token_use": "refresh_token",
    "token_type": "Bearer"
  },
  "after_revoke_body": {
    "active": false
  },
  "source": "official v3 guide example; active:false per community live test"
}
```

**`uninstall`.** Vendor-published: spec.
```json
{
  "request": "DELETE https://api.hubapi.com/appinstalls/2026-09/external-install  Authorization: Bearer <access_token>",
  "status": 204,
  "source": "spec"
}
```

**`journal_subscription_uninstall`.** Vendor-published: spec. The event-type IDs come from the Webhooks/Webhooks 2026-09 spec, not from the journal 2026-09 spec.
```json
{
  "request": "POST https://api.hubapi.com/webhooks-journal/subscriptions/2026-09  Authorization: Bearer <client_credentials_token>  Content-Type: application/json",
  "body": {
    "subscriptionType": "APP_LIFECYCLE_EVENT",
    "eventTypeId": "4-1916193",
    "properties": []
  },
  "source": "spec (event type IDs 4-1909196 install, 4-1916193 uninstall)"
}
```

**`authorize_url`.** Generated locally with Node v22 `querystring.stringify`, the official SDK's method. It reproduces byte-for-byte, except that the literal placeholder `<random>` would itself be encoded as `%3Crandom%3E`. WHATWG `URLSearchParams` would encode the spaces in `scope` as `+` instead of `%20`.
```text
https://app.hubspot.com/oauth/authorize?client_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&redirect_uri=https%3A%2F%2Fautopilot.example.com%2Fapi%2Fhubspot%2Foauth%2Fcallback&scope=oauth%20crm.objects.contacts.read%20forms%20sales-email-read&state=<random>
```

**`contact_record_url`.** Generated locally by the `https://{uiDomain}/contacts/{portalId}/record/0-1/{contactId}` rule. The input is `{uiDomain:'app-eu1.hubspot.com', portalId:12345678, contactId:51}`; the verifier recomputed it and it matches.
```text
https://app-eu1.hubspot.com/contacts/12345678/record/0-1/51
```

**Verifier corrections and additions.** Use these in the test suite.

1. `refresh_bad_hub`: **correct the body** to the PostHog test fixture (community-observed). It stays HTTP 400, `expected_classification` `revoked`:
   ```json
   {"status":"BAD_HUB","message":"missing or unknown hub id","error":"access_denied"}
   ```
2. `rate_limited_ten_secondly`: the message was verified in real responses, and real bodies also include `correlationId` and `groupName`. Make `groupName` optional in the Zod schema. Real observed body (community, HubSpot developer-Slack archive, 2023; a private-app response):
   ```json
   {"status":"error","message":"You have reached your ten_secondly_rolling limit.","errorType":"RATE_LIMIT","correlationId":"20f98dfa-05b6-4d27-8d96-ecfde54ca211","policyName":"TEN_SECONDLY_ROLLING","groupName":"publicapi:private_app-api-calls-ten-secondly:1512050:26892217"}
   ```
3. Add a revoke fixture (community-observed):
   ```text
   POST /oauth/2026-09/token/revoke (form: client_id, client_secret, token, token_type_hint=refresh_token) -> 200
   ```
4. Re-checks with no change:
   - `refresh_revoked`: verbatim in the v1 and v3 guide scrapes; the HTTP 400 is confirmed by the re-fetched Nango issue.
   - `refresh_bad_client`: confirmed at 400 in usertour's spec test.
   - `rate_limited_daily`: verbatim.
   - `account_details` / `body_eu_example`: verbatim from the docs scrape and the spec 144923/v3 example.
   - `introspect_refresh_token`: verbatim from the v3 guide.
   - `uninstall`: 204 verified against the spec.
   - `journal_subscription_uninstall`: verified against the spec.
   - `token_success_2026_09`: consistent with the docs and the spec.
