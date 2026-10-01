# Decisions log

Every place where official documentation overrides the brief, and every choice made where the brief is silent, is recorded here (brief §0.1, §0.5). Evidence for each decision is in `docs/RESEARCH.md` under the finding IDs quoted in brackets, e.g. [HS-SCOPES].

- **Type A** = the docs contradict or extend the brief, so the docs win (§0.1).
- **Type B** = the brief is silent, so this is the simplest option that satisfies it (§0.5).

Status of every entry: **proposed**, pending the owner's `approve` of `docs/PLAN.md`.

---

## A. Corrections from official documentation (docs win)

### D-01 · Next.js 16, not Next.js 14 (Type A)
- **Decision:** Pin `next@16.3.8` (current stable) with `react@19.x`. Use `src/proxy.ts` (the Next 16 name for middleware) and keep `src/instrumentation.ts`.
- **Why:**
  - 14.2.35 is the final 14.x release and receives no further security fixes [NX-SUPPORT-STATUS].
  - The npm advisory database lists 23 open GitHub advisories against 14.2.35, including 2 critical (RCE in the image optimiser; RCE on Windows hosts) and 8 high. Several of them affect every App Router app, and one specifically affects the nonce-based CSP pattern that §7 needs [NX14-ADVISORIES].
  - 15.x is not a durable fallback: per community tracking it reaches end of life on 2026-10-21 [NX-RECOMMENDATION].
- **Brief rules that still hold:**
  - `instrumentation.ts` must live in `src/` when the app uses `src/app` [NX14-INSTR-LOCATION].
  - TypeScript strict, Tailwind and the App Router are unchanged.
- **Consequences:**
  - No `experimental.instrumentationHook` flag.
  - `export const onRequestError = Sentry.captureRequestError` in `src/instrumentation.ts`.
  - `headers()` and `cookies()` are async.
  - `next lint` is removed in Next 16, so we use the ESLint 9 flat-config CLI.
  - Turbopack is the default for dev and build.
- **If the owner rejects this:** fall back to 14.2.35 with the mitigations in [NX14-ADVISORIES]:
  - `images.unoptimized: true`;
  - no Server Actions;
  - strip inbound CSP request headers on every route;
  - `experimental.instrumentationHook: true` in `next.config.mjs`.

### D-02 · The HubSpot app is a developer-platform project, not a legacy public app (Type A)
- **Decision:**
  - The app config lives in the repo under `hubspot-app/`: `hsproject.json` with `platformVersion: "2026.09"`, `src/app/app-hsmeta.json` with `distribution: "marketplace"` and `auth.type: "oauth"`, and `src/app/webhooks/webhooks-hsmeta.json`.
  - It is created and uploaded with the HubSpot CLI (`hs project upload`).
- **Why:** HubSpot permanently disabled creating legacy public apps in mid-2026 [HS-APP-PLATFORM]. The CLI/project flow is the only way to create a new OAuth app [HS-APP-HSMETA-CONFIG, HS-CLI-WORKFLOW].
- **Impact:** WIRE_UP step 1 becomes a CLI flow. A unit test diff-checks the requested scopes against `app-hsmeta.json`.

### D-03 · Add the read-only scope `sales-email-read` (Type A)
- **Decision:** `requiredScopes` = `oauth crm.objects.contacts.read forms sales-email-read`.
- **Why:**
  - The brief's minimum set (`oauth`, `crm.objects.contacts.read`, `forms`) is enough for intake.
  - It is not enough for anything that reads logged one-to-one emails: §5.6 reply detection, §5.7 inbox check, §5.8 baseline and §5.9 confirmed sends.
  - The current Emails spec requires `crm.objects.contacts.read` AND `sales-email-read` [HS-SCOPES, HS-EMAIL-SCOPES, HS-SCOPE-EMAIL-READ-RISK].
- **Law 2 still holds:** every scope is read-only.
- **Law 4 (data minimisation) is enforced in code:**
  - Every email request uses a fixed metadata allow-list (`hs_timestamp`, `hs_email_direction`, `hs_email_status`, `hs_email_from_email`, `hs_email_to_email`).
  - A unit test fails if a content property (subject, text, html, headers) ever appears in a request [HS-EMAIL-DATA-MINIMISATION].
  - Addresses are compared in memory and never stored.
  - The privacy page and the install screen copy say plainly that HubSpot will show "read email" access, and that Autopilot reads only dates and directions.
- **Fallback:** if `sales-email-read` is not in the granted scopes (the token response `scopes`, or a 403 `MISSING_SCOPES`), the email-dependent features show "Not enough data". We never estimate.

### D-04 · Use HubSpot's date-versioned APIs (2026-09) (Type A)
- **Decision:**
  - Every HubSpot path is built from `HUBSPOT_API_VERSION` (default `2026-09`, e.g. `/crm/objects/2026-09/contacts/search`, `/oauth/2026-09/token`, `/account-info/2026-09/details`, `/appinstalls/2026-09/external-install`).
  - There are no `/v4/` calls.
- **Exceptions (no dated version exists):**
  - forms list `GET /marketing/v3/forms`;
  - form submissions `GET /form-integrations/v1/submissions/forms/{formGuid}` [HS-API-VERSIONING, HS-API-VERSIONING-PATHS].
- **Why:** HubSpot tells new integrations to use the latest date version. OAuth v1 stops working on 2027-02-16. v4 APIs become unsupported on 2027-03-30, and v1–v3 in September 2027.
- **Fallback:** `HUBSPOT_API_VERSION=2026-03` changes it in one place if the WIRE_UP smoke test finds a problem.

### D-05 · Webhook idempotency key is composite, not `eventId` alone (Type A)
- **Decision:** `webhook_events` is unique on `(provider, portal_id, subscription_type, object_id, event_id, occurred_at)` for HubSpot, and on `(provider, event_id)` for Razorpay.
  - Lead-level idempotency is separate: `UNIQUE(account_id, hubspot_contact_id, submitted_at)` and `UNIQUE(account_id, form_id, submission_key)`.
- **Why:** HubSpot documents `eventId` as "not guaranteed to be unique", and says notifications may be duplicated and arrive out of order [HS-WH-IDEMPOTENCY].
- **Brief §6** said "`eventId` unique". The replay test still proves that one event yields one lead.

### D-06 · Webhook subscriptions (Type A)
- **Decision:**
  - `crmObjects`: `{"subscriptionType":"object.creation","objectType":"contact"}` (the platform's new format).
  - `hubEvents`: `contact.privacyDeletion`.
  - The handler also accepts the classic `contact.creation` shape.
- **Why:** The new developer platform's format is `object.creation` with `objectTypeId "0-1"` [HS-WH-SUBTYPE-CONTACT-CREATION, HS-WH-HSMETA-CONFIG]. Subscribing to privacy deletion lets us purge a deleted contact's content immediately [HS-WH-GDPR-PRIVACY-DELETION].
- **Not subscribed:** deletion, merge and opt-out. They are re-checked from the contact record whenever a job runs.

### D-07 · Lead intake: the Forms submissions API is the source of truth (Type A)
- **Decision:**
  - Every 5 minutes, for each selected form, read `GET /form-integrations/v1/submissions/forms/{formGuid}?limit=50` with a per-form cursor (minus a 15-minute overlap). Page until a page has nothing newer than the cursor, or the page cap is hit.
  - Resolve each new submission to its contact with `GET /crm/objects/2026-09/contacts/{email}?idProperty=email`.
  - The `object.creation` webhook does not try to identify the form. It only triggers an immediate, debounced poll of that portal's selected forms.
- **Why:**
  - No webhook exists for form submissions [HS-WH-FORM-SUBMISSION-EVENT].
  - Contact conversion properties give only `"Page title: Form name"` text and the latest conversion; they carry no form GUID [HS-INTAKE-CONVERSION-PROPS].
  - The submissions API returns the form GUID, `submittedAt`, `conversionId` and the submitted values (name, email, company, message) [HS-INTAKE-SUBMISSIONS-API, HS-INTAKE-SUBMISSION-CONTACT-MATCH].
  - CRM search on `recent_conversion_date` is supported [HS-INTAKE-SEARCH-RECENT-CONVERSION], but it shows only the latest conversion per contact and suffers index lag, so it is not used.
- **Brief's rationale corrected:** HubSpot does not document that calculated properties can't be subscribed. It only excludes `num_unique_conversion_events` and `hs_lastmodifieddate` [HS-WH-CALC-PROPS, HS-INTAKE-WEBHOOK-CALC-PROPS]. The conclusion that a poller is needed still stands.
- **Risk:** the submissions endpoint is legacy v1. It sits behind a `LeadSource` boundary so it can be replaced.

### D-08 · Reply detection and "confirmed send" signals (Type A)
- **Confirmed send:** an email engagement associated with the lead's contact, with `hs_email_direction = EMAIL`, `hs_timestamp` after the notification time minus 60 s of skew, and status absent or `SENT` [HS-CONFIRMED-SEND].
  - Its definition, shown in the UI copy: "an outbound email to this lead was logged in HubSpot after we sent you the draft". We cannot prove it was our draft without reading content, which law 4 forbids.
- **Confirmed reply:** an email engagement associated with the contact, with direction `INCOMING_EMAIL` or `FORWARDED_EMAIL`, `hs_timestamp` after the first notification, and `hs_email_from_email` equal to the lead's email or one of `hs_additional_emails`.
  - Positive-only fallback: `hs_sales_email_last_replied` > first notification [HS-REPLY-SIGNAL, HS-CONTACT-ACTIVITY-PROPS].
  - Otherwise the status is "no confirmed reply", never "no reply".
- **Never used as reply evidence:** `notes_last_contacted`, `hs_last_sales_activity_timestamp`, `num_contacted_notes`, `hs_email_last_reply_date`. They would overstate replies (law 3).
- **Read pattern:** read the contact with `associations=emails`, then batch-read the associated emails with metadata only. This avoids search index lag [HS-EMAIL-BY-CONTACT].

### D-09 · Follow-up hard stops read from the contact record (Type A)
- **Stop when any of these holds:**
  - `hs_email_optout == "true"`;
  - `hs_email_hard_bounce_reason_enum` is non-empty;
  - `hs_email_bad_address == "true"`;
  - the contact `GET` returns 404 (deleted/archived).
- **Merges:** a 200 with a different `id` is a merge, so we re-map the contact ID and continue [HS-OPTOUT, HS-BOUNCE-BADADDRESS, HS-CONTACT-DELETED-MERGED].
- **Never requested:**
  - `communication_preferences.read_write`, which is write-capable;
  - the batch status scopes, which need Marketing Hub Enterprise and would block Free/Starter installs.

### D-10 · How uninstall is detected (Type A)
- **Decision:**
  - The authoritative signal is a token refresh classified `revoked`. It sets the connection to `revoked`, stops processing and starts the 30-day purge clock.
  - Owner-initiated disconnect calls `DELETE /appinstalls/2026-09/external-install` and then `POST /oauth/2026-09/token/revoke`, then wipes tokens locally [HS-UNINSTALL-API].
  - Polling the Webhooks Journal `APP_LIFECYCLE_EVENT` stream is designed for but ships disabled (`HUBSPOT_JOURNAL_ENABLED=false`) until it has been tested on a real developer account.
- **Why:** HubSpot sends no push webhook on uninstall. Uninstall is visible only through the pull-based Webhooks Journal, or through the next failed refresh [HS-UNINSTALL-NOTIFY, HS-WH-UNINSTALL-EVENT, HS-UNINSTALL-TOKENS].
- **Webhook events** for portals that are not active are acknowledged with 200 and dropped.

### D-11 · Classifying refresh failures (Type A)
`classifyRefreshFailure()` returns one of three classes [HS-OAUTH-REFRESH-ERRORS, HS-HTTP-ERROR-CODES, HS-429-SHAPE]:

| Class | When | Action |
|---|---|---|
| `revoked` | HTTP 4xx other than 429, and `error = invalid_grant`, or `status ∈ {BAD_REFRESH_TOKEN, BAD_HUB}`, or `error = access_denied` | Terminal: stop jobs, show the banner, send one email. |
| `config` | `invalid_client`, `unauthorized_client`, `invalid_request`, `unsupported_grant_type`, or `BAD_CLIENT_ID`, `BAD_CLIENT_SECRET`, `BAD_REDIRECT_URI`, `BAD_GRANT_TYPE` | Sentry alert once; portals stay active. A rotated client secret must never mass-revoke every portal. |
| `transient` | 423, 429, 477, 5xx, timeouts | Exponential backoff, at most 5 attempts, then a Sentry alert. A daily 429 defers the job to the next local midnight instead of spending attempts. |

### D-12 · Account timezone source (Type A, confirms the brief)
- **Source:** `GET /account-info/2026-09/details` (scope `oauth`) returns `timeZone`, `utcOffsetMilliseconds`, `uiDomain` and `dataHostingLocation` [HS-ACCOUNT-DETAILS].
- **Refresh:** at install and daily.
- **Fallback:** if the zone isn't a valid IANA name, use the fixed offset. If the call fails, onboarding asks the owner for their timezone.
- **Record links** use `https://{uiDomain}/contacts/{portalId}/record/0-1/{contactId}` [HS-RECORD-URL].

### D-13 · Compose links (Type A, where vendor documentation is missing)
- **Decision:** `mail_client ∈ {gmail, outlook_work, outlook_personal, other}`.

| Client / case | Link | Source |
|---|---|---|
| Gmail | `https://mail.google.com/mail/?view=cm&fs=1&to=…&cc=…&bcc=…&su=…&body=…` (`su`, not `subject`) | [CMP-GMAIL-WEB-URL] |
| Outlook work | `https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=<encoded RFC 6068 mailto>` | [CMP-OUTLOOK-HOSTS] |
| Outlook personal | `https://outlook.live.com/mail/deeplink/compose?mailtouri=…` | [CMP-OUTLOOK-PARAMS-BCC] |
| Other, or any phone user agent | a `mailto:` interstitial page with a button | [CMP-GMAIL-MOBILE, CMP-REDIRECT-IMPLEMENTATION] |

- **Length check:** if the final URL is longer than `COMPOSE_URL_LIMIT=1800` characters, use the copy-reply page instead. The check runs per client on the exact encoded string, because Outlook URLs are about 30% longer [CMP-URL-LENGTH-LIMITS].
- **Encoding:** one encoder for all clients: `encodeURIComponent` on a well-formed string, plus `!'()*` escaped. Never `URLSearchParams`, which turns spaces into `+` [CMP-ENCODING-PLUS-SPACE, CMP-BUILDER-SPEC].
- **Safety:** recipients are validated as a single bare address [CMP-RECIPIENT-SAFETY].
- **Caveat:** Google and Microsoft do not document these formats. Hosts and modes live in config, and WIRE_UP includes a manual check on real accounts (including BCC on Outlook).
- **Redirect:** a 302 for the web clients. `NextResponse.redirect` defaults to 307, so 302 is passed explicitly.

### D-14 · BCC logging and the inbox check (Type A)
- **What BCC logs:** a send (`EMAIL`), not the lead's reply [HS-BCC-LOGGING].
- **What logs replies automatically:** a connected inbox with "Log all emails to/from known contacts" [HS-CONNECTED-INBOX, HS-REPLY-SIGNAL].
- **Decision:** the onboarding inbox check measures two legs:
  - **send leg:** an `EMAIL` engagement to the test address;
  - **reply leg:** the owner replies from the test address, giving an `INCOMING_EMAIL`.
- **Logging mode:** we store `logging_mode ∈ {log_all, sends_only, none, unknown}` per account.
- **When replies can't be detected:** follow-ups stay on (the brief's core loop), but every follow-up email to the owner carries a plain warning: "HubSpot isn't logging replies for you, so check your inbox before sending".
- **Contacts created by the test:** BCC logging may create the test contact. Intake ignores it because it has no form submission.
- **Caveat:** tier availability and the settings paths come from knowledge-base search summaries only, so WIRE_UP re-checks them on a Free and a Starter portal.

### D-15 · QStash delivery semantics (Type A)
- **Publish with an absolute time:** `notBefore` (unix seconds), computed in app code from quiet hours and timezone [QS-DELAY-HEADERS].
- **Hop scheduling:** the Free plan's maximum delay is 7 days, and a weekend/quiet-hours shift can push the +5-day job past it. Jobs further out than `QSTASH_MAX_DELAY_SECONDS` (default 601200 s = 7 days − 1 h) are published as a "hop" that re-publishes on arrival [QS-DELAY-MAX-PER-PLAN].
- **Dedupe:** `Upstash-Deduplication-Id` is kept (`lead:{id}:fu:{n}`, prefixed per environment), but it only covers 10 minutes. Durable idempotency lives in Postgres: unique job rows and atomic `scheduled → running` claims [QS-DEDUPLICATION, QS-AT-LEAST-ONCE].
- **Cancel:** by message id only, with a 404 treated as success. Bulk/filter cancel is never used; an empty filter cancels every message in the account [QS-CANCEL].
- **Verify deliveries:**
  - `Receiver.verify({signature, body: rawText, url: <configured URL>, clockTolerance: 5})`;
  - always construct with `devMode: false`;
  - at boot, assert `QSTASH_DEV` is unset in live mode [QS-RECEIVER-API, QS-DEVMODE-KEY-OVERRIDE].
- **Handler status codes:**
  - 200 for done or no-op;
  - 489 + `Upstash-NonRetryable-Error: true` for permanent errors (including a revoked portal);
  - 5xx for transient errors [QS-RETRIES-SUCCESS].
- **Failure callback:** `/api/jobs/failed` records jobs that land in the DLQ, for the admin page [QS-FAILURE-CALLBACK-DLQ].

### D-16 · Periodic triggers work with either transport (Type A)
- **Decision:** each periodic route accepts either:
  - a Vercel Cron `GET` with `Authorization: Bearer ${CRON_SECRET}` (constant-time compare); or
  - a signed QStash schedule `POST` [VC-CRON-SECRET-UA, QS-SCHEDULES-ALTERNATIVE].
- **Default in WIRE_UP:** Vercel Cron via `vercel.json` on a **Pro** plan.
- **Why Pro:** Hobby very likely allows only daily crons. The Vercel page could not be fetched [VC-CRON-PLAN-LIMITS], so WIRE_UP re-checks this and documents QStash schedules as the Hobby alternative.
- **Crons run only on production, are UTC-only, and are not retried.** Handlers are therefore idempotent, take a lease, and are written as "due" checks [VC-CRON-CONFIG, VC-CRON-RETRY-OVERLAP].

### D-17 · Monday report uses a "due" check, not exact equality (Type A)
- **Rule:** a report is due when local time ≥ Monday 08:00 of the current ISO week, local time is before Tuesday 00:00, and no `weekly_reports` row exists for (account, week).
- **Why not equality:** an hourly UTC cron is never exactly 08:00 local in half-hour or 45-minute zones, and a missed run must catch up [VC-CRON-MONDAY-DUE].
- **Write order:** insert the row first, then send.

### D-18 · Razorpay checkout guard and entitlement (Type A)
- **Checkout guard (brief: block on active and halted):**
  - **Block** when the latest subscription is `authenticated`, `active`, `pending`, `halted` or `paused`. These are all live mandates, so a second checkout would create a second mandate.
    - For `pending` and `halted`, show "Update payment method", linking the stored `short_url`.
  - **Allow** when there is no subscription, or its status is `created`, `expired`, `cancelled` or `completed`.
  - **Never block on `created`:** reuse its stored `short_url` while `expire_by` is in the future [RZP-SUB-DECLINED-CREATED-GUARD].
- **Entitlement:** processing runs while `trialing`, or while the status is `authenticated`, `active` or `pending`.
  - `pending` is Razorpay's own retry window (T+1..T+3), which is the brief's 3-day grace. It is capped by `grace_until` = first failure + 3 days.
  - `halted`, `paused`, `cancelled`, `completed` and `expired` are inactive [RZP-SUB-STATUSES, RZP-SUB-PENDING-HALTED-RETRY, RZP-STATUS-MAPPING].
  - An unknown status is treated as inactive and raises an admin alert. A stray `resumed` maps to `active`.

### D-19 · Razorpay webhook replay protection (Type A)
- **Why a different scheme:** Razorpay signs only the body and sends no timestamp header. Retries arrive for up to 24 hours, and manual replays for up to 15 days [RZP-WH-REPLAY-TIMESTAMP].
- **Decision:**
  - Verify the HMAC with `timingSafeEqual` on the raw body.
  - Refuse to run with an empty secret.
  - Support an optional previous secret, for rotation.
  - Reject events whose `created_at` is more than 5 minutes in the future or more than 16 days old.
  - Dedupe on the `x-razorpay-event-id` header and, because that header is unsigned, also on `sha256(raw body)`.
  - Treat every event as a trigger: fetch `GET /v1/subscriptions/{id}` and apply that status. This makes out-of-order events harmless [RZP-WH-IDEMPOTENCY-EVENT-ID, RZP-WH-SIGNATURE].
- **Daily reconcile:** the job also fetches non-terminal subscriptions, because some transitions (`expired`, failed authentication) fire no webhook.

### D-20 · Razorpay hosted checkout, trial and USD (Type A)
- **Hosted checkout:**
  - "Hosted checkout" means a Subscription Link: `POST /v1/subscriptions` returns a `short_url` and we redirect with 303.
  - The request body is `{plan_id, total_count: 120, quantity: 1, customer_notify: true, expire_by: now+7d, notes: {autopilot_account_id}}` [RZP-CHECKOUT-HOSTED, RZP-SUB-CREATE-FIELDS].
  - Razorpay offers no return URL, so the billing page polls our database until a webhook or the reconcile job updates the status.
- **Trial:** if the owner subscribes with more than a day of trial left, we pass `start_at = trial_end` so the free days are honoured [RZP-TRIAL-START-AT].
- **USD:** charging $49 needs International Cards activated, which requires refund/cancellation and shipping policy pages [RZP-USD-INTERNATIONAL]. So `/refunds` and `/shipping` are added as `TODO: legal review` placeholders; the brief listed only `/privacy` and `/terms`.
- **Cancel:** `POST /v1/subscriptions/{id}/cancel {"cancel_at_cycle_end": true}`. Access lasts to `current_end`.
  - We call the Razorpay REST API with `fetch` rather than the SDK. The SDK's `cancel(id, {cancel_at_cycle_end:false})` silently cancels at cycle end [RZP-SUB-CANCEL-PAUSE-RESUME-FETCH, RZP-SDK-PACKAGE].
- **"Fails silently" (brief §10.7):** a mismatched key id/secret fails loudly for server-side calls. The same-generation rule is still kept in WIRE_UP, with a `GET /v1/plans/{RAZORPAY_PLAN_ID}` smoke test [RZP-API-KEYS].

### D-21 · Supabase keys, grants and RLS (Type A)
- **Keys:**
  - Use the new `sb_publishable_…` and `sb_secret_…` keys. Supabase is deprecating the legacy `anon`/`service_role` keys by the end of 2026 [SB-KEYS-MODEL].
  - "Service-role key" in the brief becomes "secret key" (`SUPABASE_SECRET_KEY`, server only).
- **Every migration creating a table also:**
  - runs `alter table … enable row level security;`;
  - runs `revoke all … from anon, authenticated;`;
  - runs `grant select, insert, update, delete … to service_role;`.
- **Why the explicit grants:** projects created after 2026-05-30 no longer auto-grant table privileges [SB-RLS-NOT-DEFAULT, SB-DATA-API-GRANTS-2026].
- **No RLS policies are defined.** All data access is server-side; RLS with no policies is default-deny for the Data API [SB-RLS-PATTERNS].
- **The migration test asserts:**
  - every public table has `relrowsecurity`;
  - `anon` has no privileges;
  - `service_role` has CRUD.

### D-22 · Magic links: token-hash flow, sent by our own mailer, safe against link scanners (Type A)
- **Generate:** `auth.admin.generateLink({type:'magiclink', email})`, with the secret key, server-side.
  - Only for emails that already belong to an owner row, or for the onboarding step that sets the owner's email.
  - Send `${APP_URL}/auth/confirm?token_hash=…&type=magiclink` through our `Mailer` (Resend live, outbox in fake mode).
- **Confirm:**
  - `GET /auth/confirm` renders a "Sign in" button.
  - The `POST` calls `verifyOtp({ token_hash, type })`.
  - This works across devices (desktop request, phone click) and survives Safe Links-style scanners that pre-click links [SB-MAGICLINK-FLOW, SB-EMAIL-PREFETCH].
- **Login form:** `/login` always shows the same neutral response, to avoid revealing which emails have accounts [SB verifier note on `otp_disabled`].
- **Fallback:** Supabase custom SMTP (Resend) is still configured in WIRE_UP for any email Supabase sends itself [SB-SMTP-RESEND, SB-AUTH-EMAIL-LIMITS].

### D-23 · Sentry v11 restrictive configuration (Type A)
- **Pin:** `@sentry/nextjs` 11.2.0 (exact). v11's defaults collect everything: bodies, headers, cookies, query strings and GenAI inputs/outputs [SENTRY-V11-DATA-DEFAULTS].
- **Every `Sentry.init` uses one shared options object:**
  - `dataCollection` set entirely to false/empty;
  - no tracing at all (no `tracesSampleRate`, and `SENTRY_TRACES_SAMPLE_RATE` must stay unset);
  - `tracePropagationTargets: []`;
  - integrations filtered to remove `Anthropic_AI` and `Console`;
  - one pure scrubber in `beforeSend` and `beforeBreadcrumb` that rewrites `request.url`, `query_string` and `transaction` (including `/a/{token}/…`), and deletes request data, cookies and headers [SENTRY-GENAI-ANTHROPIC, SENTRY-HOOKS-STREAMING, SENTRY-URL-QUERY-LEAK, SENTRY-RECOMMENDED-CONFIG].
- **Proof:** a pure-scrubber golden test, plus an envelope test that runs the real SDK through an in-memory transport [SENTRY-SCRUBBER-TEST].
- **No `tunnelRoute`** and no Session Replay [SENTRY-TUNNEL-CSP].

### D-24 · Anthropic call pattern (Type A)
- **Call:** `messages.create` with `output_config.format = {type:'json_schema', schema}`.
  - The schema comes from our own `toClaudeJsonSchema(zodSchema)`, which keeps `enum` and `additionalProperties:false` and moves unsupported keywords into descriptions.
  - The response is validated with Zod and then with the deterministic validator.
- **Why not `messages.parse` + `zodOutputFormat`:** the SDK helper moves `enum` into the description, so values are not constrained. `parse()` also throws on invalid output and loses `usage` [AI-SO-TS-ENUM, AI-SO-PARSE-SEMANTICS, AI-SDK-STRUCTURED-CALL-PATTERN].
- **Schema limits:** `maxItems`, `minLength` and min/max are not supported in structured-output schemas. So `faqs ≤ 8` and the word limits are enforced in code [AI-SO-SCHEMA-LIMITS].
- **Fields:** every field is required, and nullable where needed.
- **Per-model parameters** come from `buildModelParams(model, purpose)` [AI-MODEL-CAPABILITY-MAP, AI-SONNET55-REQUEST, AI-HAIKU45-REQUEST, AI-REQUEST-RECOMMENDATIONS]:

| Model | Purpose | thinking | effort | max_tokens |
|---|---|---|---|---|
| `claude-sonnet-5-5` | drafts and follow-ups | `between_tools` | `medium` (env) | 1024 |
| `claude-sonnet-5-5` | business brief | adaptive | `high` | 16000 |
| `claude-haiku-4-5-20251001` | classification | omitted | omitted | 256 |

- **Never sent:** sampling parameters, assistant prefill, `tool_choice`.
- **Stop reasons:** `refusal` → no retry, "needs your touch". `max_tokens` → a failed attempt.
- **Server-side fallbacks:** not enabled [AI-SERVER-FALLBACK].
- **Logging:** the SDK runs with `logLevel: 'warn'`, and SDK error messages are never logged, because they can contain model output [AI-SDK-LOGGING-PRIVACY].

### D-25 · Haiku 4.5 retirement exposure (Type A)
- **Fact:** Haiku 4.5's retirement floor is "not sooner than 2026-10-15" [AI-MODEL-HAIKU45]. Anthropic gives at least 60 days' notice.
- **Decision:** `ANTHROPIC_MODEL_FAST` can be switched to `claude-sonnet-5-5` with no code change, because the parameter builder handles both models.
- **Cost tracking** uses a rate table keyed by `response.model` [AI-PRICING-COST].

### D-26 · Email link scanners (Type A)
- **Dismiss:** `GET /a/{token}/dismiss` shows a confirmation page; only the `POST` dismisses. Corporate scanners pre-click links in emails [SB-EMAIL-PREFETCH].
- **Send:**
  - `GET /a/{token}/send` records the click but ignores `HEAD` requests and requests whose user agent matches a known scanner.
  - A click never counts as a confirmed send (law 3).
- **Tracking:** Resend click and open tracking stay off.

---

## B. Choices where the brief is silent

### D-27 · Data access layer
- **Decision:** a thin `Db` interface with hand-written SQL repositories.
  - **Live:** `postgres` (Postgres.js) on Supabase's **transaction pooler** (port 6543), `{ max: 1, prepare: false, ssl: 'require' }`, created once at module scope. This is Supabase's documented serverless setting.
  - **Tests and fake mode:** PGlite runs the same SQL.
- **Why:** the brief wants PGlite tests, and supabase-js `.from()` cannot run on PGlite. Real SQL coverage of the purge, idempotency and report queries is worth more than fake repositories.
- **Pipelining safeguard:** Supabase warns that pipelining on the transaction pooler can return mismatched rows. So the `Db` wrapper serialises every query on a client, and multi-statement work runs inside a single transaction [SB-DB-ACCESS-LAYER].

### D-28 · Extra ports for zero-credential runs
- **Decision:** add `Clock` (needed for time travel in the simulation) and `AuthProvider` (magic links go to the outbox in fake mode) to the brief's six ports.
- **Switch:** `APP_MODE=fake|live` selects every adapter. Fake mode runs PGlite, persisted under `./.data/pglite` for `npm run dev`, or in memory for tests and simulation.

### D-29 · Extra tables beyond brief §6
- **Decision:** add these tables. All are RLS-enabled with the same grants; the only content is the owner's test address, cleared after 24 h.
  - `baselines`
  - `inbox_checks`
  - `ai_calls` (token and cost per LLM call, no content)
  - `rate_limits` (salted hashes only)
  - `leases` (stops overlapping cron runs, because session advisory locks don't survive the transaction pooler)
- **Columns added to brief tables:**
  - per-form intake cursors on `selected_forms`;
  - the debounce marker and journal offset on `hubspot_connections`;
  - `short_url`, `grace_until` and sync timestamps on `subscriptions`.
- **Every job kind** is a row in `scheduled_jobs` (the admin page's "failed jobs").

### D-30 · What "form message" covers (law 4)
- **Decision:** `lead_messages` holds the content the lead typed into the form: message, first name, last name, company, email. It has `purge_at = submitted_at + 30 days`.
- **What stays in `leads`:** HubSpot IDs, the form ID, timestamps, statuses and classification only.
- **Why:** the compose links need the lead's address and name.
- **After the purge:** the UI shows "Contact #123 (details removed after 30 days)" with a HubSpot link.

### D-31 · Lead status: one value shown, with a precedence rule
- **Shown status:** `dismissed` > `replied` > `filtered` > `no_reply` > `send_confirmed` > `send_clicked` > `drafted`.
  - Internal states also exist: `new`, `processing`, `needs_touch` (shown as `drafted` with a "needs your touch" badge).
  - `no_reply` is labelled "No confirmed reply". It is set when the last follow-up step has run with no confirmed reply, or 7 days after notification if follow-ups are off.
- **The weekly report** counts from timeline timestamps, not from the shown status, so clicked and confirmed are never merged.

### D-32 · Quiet hours apply to follow-ups only
- **Decision:** the first "new lead" email goes out immediately (core loop: "within about a minute").
- **Quiet hours (default 19:00–08:00) and skipped weekends (default on)** apply to scheduling the follow-up jobs. A job that would fall in quiet time moves to the next allowed whole hour in the portal's timezone.

### D-33 · Follow-ups when the first send isn't confirmed
- **Decision:** the follow-up is still drafted (brief §1.4).
- **The owner email says so honestly:** "We couldn't confirm in HubSpot that your first reply was sent". The draft is written as a gentle nudge that doesn't assume the first email arrived.

### D-34 · One account per portal, one owner
- **Decision:** a HubSpot portal maps to exactly one account with one owner user (multi-user teams are out of scope).
- **Binding the owner:** the OAuth callback sets a signed, httpOnly `pending_install` cookie (account id, 30 minutes). The first magic-link login on that browser binds the owner.
  - Reinstalling into a portal that already has an owner requires that owner's session.
  - Otherwise the page says the portal is already connected and shows the owner's email masked.

### D-35 · Rate limiting without Redis
- **Decision:** Postgres fixed-window counters in `rate_limits`, keyed by a salted hash of the IP and route.
  - `/a/*`: 30/min per IP and 20/min per token.
  - `/login`: 5 per 15 min per IP and 3 per 15 min per email.
  - `/api/hubspot/install`: 20/min per IP.
- **Why:** no Redis in the stack; the counters are pruned daily.

### D-36 · "Lead to first reply" in the Monday report
- **Interpretation:**
  - "Median time from lead to confirmed first reply" = submission → the owner's first **confirmed send**.
  - "Leads with no confirmed reply" = leads whose owner reply is not confirmed in HubSpot. That is the actionable list.
  - "Replies confirmed" = the **lead's** replies detected.
- **Minimum sample:** medians are shown only when n ≥ 3; otherwise "Not enough data".

### D-37 · When the baseline is "not enough logged history"
- **No logged emails at all:** if the portal has zero logged `EMAIL` engagements in the last 30 days, or the email scope is missing, show the lead count only and "Not enough logged history" for the median and for "no logged outbound".
  - Otherwise every lead would look unanswered.
- **Median:** shown only when at least 3 leads have a logged outbound email.

### D-38 · Simulation calendar
- **Setup:** portal timezone `America/New_York`, quiet hours 19:00–08:00, weekends skipped.
- **Timeline:**
  - Day 0 = Tuesday 2026-10-06, 10:00.
  - Day 2 = Thursday, follow-up 1.
  - Day 3 = Friday, the lead replies.
  - Day 5 = Sunday: follow-up 2 is due but weekends are skipped, so it moves to Monday 08:00.
  - Monday 2026-10-12, 08:00: follow-up 2 jobs run first, then the Monday report.
- **Why:** this shows the weekend rule and keeps the brief's day 0 / 2 / 5 / Monday order.

### D-39 · HubSpot client written from scratch
- **Decision:** plain `fetch` plus Zod over the ~12 endpoints we use.
- **Why:** `@hubspot/api-client` 14 targets legacy paths, and `@hubspot/sdk` is alpha [HS-SDK-CHOICE].
- **Rate limiting:** a per-portal limiter keeps general calls at ≤ 9/s and search at ≤ 4/s [HS-RATE-LIMITS].

### D-40 · Node, TypeScript, lint and test tooling
- **Node:** 22 LTS (`>=22.12`). This satisfies Next 16, Sentry v11 and supabase-js 2.117. The sandbox has 22.22. Vercel runs 22.x or 24.x.
- **TypeScript:** 5.9.x. TypeScript 7 is the native compiler and is not yet supported by `typescript-eslint` (needs `<6.1`).
- **Lint:** ESLint 9 flat config with `eslint-config-next@16` and `typescript-eslint`. `no-restricted-imports` enforces module boundaries.
- **Tests:** Vitest 4.1.x.
- **Styling:** Tailwind 4.
- **Validation:** Zod 4.
- **Dates:** Luxon for timezones.
- **Email templates:** `react-email` 6 (single package) for templates and rendering.

### D-41 · Owner override and "pause all"
- **Filtered lead:** the owner can mark it "This is a real lead". That re-runs drafting and notification and sets `classification_override=true`.
- **Pause all:** an internal flag (`accounts.paused_at`). It stops intake processing, notifications and follow-ups. It is **not** a Razorpay pause.
- **What happens to leads while paused:** the poller skips the account entirely, so no HubSpot reads happen.
  - On resume, or when billing becomes active again, the form cursors move to "now". Leads that arrived while paused are not drafted after the fact.
  - The dashboard says so plainly: "Leads that arrived while Autopilot was paused were not processed."

### D-42 · Marketplace install cap
- **Fact:** apps with marketplace distribution are capped at 25 installs until listed on the HubSpot Marketplace [HS-MARKETPLACE-INSTALL-CAP].
- **Decision:** listing assets stay out of scope (§11). Paid growth beyond 25 portals is blocked until the listing is approved, so this goes in README and RISKS.
- **Built to listing rules from day one:** OAuth only, dated OAuth endpoints, the uninstall API on disconnect, encrypted tokens, and less than 5% error responses.
- **Listing description:** describe the app as a lead-response product, not an "AI connector".

### D-43 · A newer lead supersedes an older one for the same contact
- **Decision:** when a new lead is created for a contact that already has an open lead with pending follow-ups, the older lead's follow-ups are cancelled (`stop_reason = 'superseded'`).
- **Why:** the same person never receives two parallel follow-up streams. The new lead gets its own draft and follow-ups.

### D-44 · Action tokens are reusable until they expire, except dismiss
- **Decision:**
  - Send and edit tokens can be used repeatedly within their 7 days, because the owner may tap "Send" twice. Each use is counted.
  - A dismiss token is single-use.
  - Every notification email mints its own three tokens, bound to that email's draft.
- **Token format:** `apt_` + base64url(32 random bytes). The prefix lets the log and Sentry scrubbers recognise tokens. Only the SHA-256 hash is stored.
