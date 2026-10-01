# Decisions log

Every place where official documentation overrides the brief, and every choice made where the brief is silent, is recorded here (brief §0.1, §0.5). Evidence for each decision is in `docs/RESEARCH.md` under the finding IDs in brackets, e.g. [HS-SCOPES]. The full evidence for each finding is in `docs/research/NN-*.md`.

- **Type A**: the official docs contradict or extend the brief, so the docs win (§0.1).
- **Type B**: the brief is silent, so we chose the simplest option that satisfies it (§0.5).

Status: every entry is **proposed**, pending the owner's `approve` of `docs/PLAN.md`. Revision 2 includes the fixes from the five-lens plan review.

---

## Needs your explicit sign-off

These four entries change something the brief states outright, or how one of its laws is read. They are approved together with the plan unless you say otherwise.

1. **D-01** Next.js 16 instead of 14. 14.x is out of security support.
2. **D-03** The extra HubSpot scope `sales-email-read` (read-only). Also, HubSpot's `forms` scope permits edits as well as reads; we enforce "read-only" in code instead.
3. **D-31** Law 4: we read "the lead's form message" as all the lead's submitted fields (message, name, company, email). They are needed to build the compose links. They are purged at 30 days together with the message.
4. **D-13** Brief §5.5 says "302 to the compose URL". For phones and the "Other" mail client, we instead show a page that opens the mail app automatically, because a 302 to `mailto:` leaves a blank tab. It is still one tap, and the button stays as a fallback.

---

## A. Corrections from official documentation (docs win)

### D-01 · Next.js 16, not Next.js 14 (Type A — sign-off)
- **Decision:** pin `next@16.3.8` with `react@19.x`.
  - Middleware is now `src/proxy.ts` (Node runtime).
  - `src/instrumentation.ts` stays in `src/`, beside `src/app` [NX14-INSTR-LOCATION].
- **Why:**
  - 14.2.35 is the last 14.x release and gets no more security fixes [NX-SUPPORT-STATUS].
  - The npm advisory database lists 23 open GitHub advisories for it. Two are critical: remote code execution in the image optimiser, and remote code execution on Windows hosts [NX14-ADVISORIES].
  - 15.x reaches end of life on 2026-10-21 according to community tracking [NX-RECOMMENDATION].
- **Consequences:**
  - No `experimental.instrumentationHook` setting.
  - `onRequestError = Sentry.captureRequestError` is exported.
  - `params`, `searchParams`, `headers()` and `cookies()` are async.
  - `next lint` is gone, so we use the ESLint 9 flat config.
  - Turbopack is the default; `next typegen` runs before `tsc`.
  - `global-error.tsx` is required.
- **If rejected:** use 14.2.35 with the [NX14-ADVISORIES] mitigations:
  - `images.unoptimized: true`;
  - no Server Actions;
  - strip inbound CSP request headers on every route;
  - `experimental.instrumentationHook: true` in `next.config.mjs`.

### D-02 · The HubSpot app is a developer-platform project (Type A)
- **Decision:** `hubspot-app/` holds three files, uploaded with the HubSpot CLI (`hs project upload`):
  - `hsproject.json` (`platformVersion: "2026.09"`);
  - `src/app/app-hsmeta.json` (`distribution: "marketplace"`, `auth.type: "oauth"`);
  - `src/app/webhooks/webhooks-hsmeta.json`.
- **Why:** HubSpot permanently disabled creating legacy public apps in mid-2026 [HS-APP-PLATFORM, HS-APP-HSMETA-CONFIG, HS-CLI-WORKFLOW].
- **Tests:** one checks that `REQUIRED_SCOPES` matches `requiredScopes`; another checks that `targetUrl` matches the expected webhook URL.

### D-03 · Scopes, and enforcing read-only in code (Type A — sign-off)
- **Decision:** `requiredScopes` = `oauth crm.objects.contacts.read forms sales-email-read`.
  - The brief's three scopes cover intake.
  - Reading logged one-to-one emails also needs `sales-email-read`. That powers confirmed sends, reply detection, the inbox check, the baseline and the Monday report [HS-SCOPES, HS-EMAIL-SCOPES].
- **`forms` also permits writes.** HubSpot has no read-only forms scope; every Forms API operation uses `forms` [HS-SCOPES]. So Law 2 holds by behaviour:
  - `HubSpotHttp` accepts only an allow-list of method and path patterns, and anything else throws before any network call.
    - GET for forms, submissions, contacts, associations and account-info.
    - POST only for `…/search`, `…/batch/read`, and the `/oauth/{v}/token` endpoints (`/token`, `/token/introspect`, `/token/revoke`).
    - DELETE only for `/appinstalls/{v}/external-install`.
  - A unit test enumerates the list.
  - Customer-facing copy: "Autopilot only reads from HubSpot. HubSpot's 'forms' permission would also allow edits; Autopilot never makes any."
- **Data minimisation (law 4):** every email request uses a fixed metadata allow-list: `hs_timestamp`, `hs_email_direction`, `hs_email_status`, `hs_email_from_email`, `hs_email_to_email` [HS-EMAIL-DATA-MINIMISATION].
  - Addresses are compared in memory and never stored.
  - A test fails if any content property is ever requested.
- **If the email scope is unavailable (decided at WIRE_UP):** HubSpot blocks install on any scope mismatch, so a runtime fallback can't be reached [HS-SCOPE-EMAIL-READ-RISK].
  - (a) If `hs project upload` or a test install rejects `sales-email-read`, try `crm.objects.emails.read`.
  - (b) If neither works, remove it from the single `REQUIRED_SCOPES` constant and from `app-hsmeta.json`. Every email-based feature then shows "Not enough data". A FakeHubSpot variant returning 403 `MISSING_SCOPES` covers path (b).

### D-04 · HubSpot's date-versioned APIs (2026-09) (Type A)
- **Decision:** every HubSpot path comes from `HUBSPOT_API_VERSION` (default `2026-09`). No `/v4/` calls.
- **Exceptions (no dated version exists):**
  - forms list `GET /marketing/v3/forms`;
  - submissions `GET /form-integrations/v1/submissions/forms/{formGuid}` [HS-API-VERSIONING, HS-API-VERSIONING-PATHS].
- **Fallback:** `2026-03`, if the smoke test fails.
- **Associations:** `GET /crm/objects/2026-09/contacts/{id}/associations/emails` and `POST /crm/associations/2026-09/contacts/emails/batch/read`.

### D-05 · Webhook and event idempotency keys (Type A)
- **HubSpot:** `dedupe_key = portalId:subscriptionType:objectId:eventId:occurredAt`, unique per provider. HubSpot documents `eventId` as "not guaranteed to be unique" [HS-WH-IDEMPOTENCY].
- **Razorpay:** `dedupe_key` = the `x-razorpay-event-id` header, or `sha256:<raw body hash>` when the header is missing. There is also a partial unique index on `body_sha256` (D-19).
- **Lead-level idempotency is separate:**
  - `UNIQUE(account_id, hubspot_contact_id, submitted_at)` (the brief's dedupe);
  - `UNIQUE(account_id, form_id, submission_key)`.

### D-06 · Webhook subscriptions and handling (Type A)
- **Subscriptions:**
  - `crmObjects: object.creation` for `objectType contact`;
  - `hubEvents: contact.privacyDeletion` [HS-WH-SUBTYPE-CONTACT-CREATION, HS-WH-GDPR-PRIVACY-DELETION].
  - The handler also accepts the classic `contact.creation`.
- **Rejected events:** any event whose `appId` isn't `HUBSPOT_APP_ID` is dropped with a 200.
- **Privacy deletion:**
  - It is processed for **every known portal**, whatever its status (paused, inactive, revoked, awaiting purge).
  - It is recorded and handed to a durable `privacy_delete` job, which:
    - deletes `lead_messages`;
    - nulls draft `subject`, `body` and `flags`;
    - replaces `submission_key` with a random value;
    - revokes the leads' action tokens;
    - cancels jobs;
    - sets `stop_reason='privacy_deletion'`.
- **Not subscribed:** deletion, merge and opt-out. They are re-read from the contact before every send.

### D-07 · Lead intake through the Forms submissions API (Type A)
- **Source of truth:** for each selected form, `GET /form-integrations/v1/submissions/forms/{formGuid}?limit=50`.
  - A per-form cursor with a 15-minute overlap is used for paging.
  - Only submissions with `submittedAt > intake_floor_at` are processed. The floor is set when the form is selected, when onboarding completes, and whenever processing resumes (D-42, D-48), so no historical lead is ever ingested.
- **Contact lookup:** `GET contacts/{email}?idProperty=email` resolves the contact. Missing name, company or message fields fall back to that contact's properties (brief §5.2).
- **Webhook role:** `object.creation` only triggers polls, one immediately and one at +90 s, because the submission may lag the contact.
- **Why:**
  - There is no form-submission webhook [HS-WH-FORM-SUBMISSION-EVENT].
  - Contact conversion properties carry no form GUID and only show the latest conversion [HS-INTAKE-CONVERSION-PROPS].
  - Search on `recent_conversion_date` works [HS-INTAKE-SEARCH-RECENT-CONVERSION] but lags and collapses repeat submissions, so it is kept only as a documented fallback.
- **Brief's rationale corrected:** HubSpot does not document that calculated properties can't be subscribed [HS-WH-CALC-PROPS, HS-INTAKE-WEBHOOK-CALC-PROPS].
- **Form types:**
  - `hubspot` and `flow` (pop-ups) are listed, using repeated `formTypes` params with `archived=false&limit=100` and paging.
  - `captured` (non-HubSpot) forms are excluded in v1, because submissions-API behaviour for them is undocumented [HS-INTAKE-SUBMISSIONS-API]. They return to the list once a WIRE_UP check passes.

### D-08 · Confirmed sends and replies (Type A)
- **Confirmed send:** an email engagement associated with the contact where all of these hold:
  - `hs_email_direction = EMAIL`;
  - `hs_timestamp ≥ notified_at − 60 s`;
  - status is absent or `SENT`;
  - the lead's email (or one of `hs_additional_emails`) is among the recipients in `hs_email_to_email` [HS-CONFIRMED-SEND].
- **Confirmed reply:** an engagement associated with the contact where all of these hold [HS-REPLY-SIGNAL]:
  - direction `INCOMING_EMAIL` or `FORWARDED_EMAIL`;
  - `hs_timestamp > first_notified_at` (and > `replies_ignored_before`);
  - `hs_email_from_email` is the lead's address.
- **Positive-only fallback:** `hs_sales_email_last_replied` [HS-CONTACT-ACTIVITY-PROPS].
- **Never used as reply evidence:** `notes_last_contacted`, `hs_last_sales_activity_timestamp`, `num_contacted_notes`, `hs_email_last_reply_date`.
- **Stored times are HubSpot's event times:**
  - `send_confirmed_at` and `replied_at` = the earliest qualifying `hs_timestamp`, written monotonically (`LEAST`);
  - `signals_checked_at` records when we looked.
- **Reads:** the contact `GET … &associations=emails`, following `paging.next` through the dated associations endpoint, then `emails/batch/read` in chunks of 100 [HS-EMAIL-BY-CONTACT].
- **One `markReplied()`:** the first caller to set `replied_at` cancels the remaining follow-ups and sends "{Name} replied — follow-ups stopped". Any later caller gets no row back and does nothing.

### D-09 · Follow-up hard stops read from the contact (Type A)
- **Stop when any of these holds:**
  - `hs_email_optout == "true"`;
  - `hs_email_hard_bounce_reason_enum` is non-empty;
  - `hs_email_bad_address == "true"`;
  - the contact returns 404.
- **Merge:** a 200 with a different `id` means the contact was merged, so we re-map it and continue [HS-OPTOUT, HS-BOUNCE-BADADDRESS, HS-CONTACT-DELETED-MERGED].
- **Never requested:** `communication_preferences.read_write`, and the Enterprise-only batch scopes.

### D-10 · Uninstall detection (Type A)
- **Signals:** HubSpot sends no push uninstall event [HS-UNINSTALL-NOTIFY, HS-WH-UNINSTALL-EVENT]. Two signals mark a connection `revoked`:
  - (1) a refresh classified `revoked`;
  - (2) a **daily probe**, `POST /oauth/2026-09/token/introspect` on the refresh token, run for **every** active connection whatever its pause or billing state. `{"active": false}` counts as revoked [HS-TOKEN-METADATA].
- **Revoked means:**
  - tokens are wiped;
  - `purge_after = now + 30 d` (brief §5.1);
  - one reconnect email is sent, by whichever caller wins the state change.
- **Owner Disconnect is best effort and always completes locally:**
  - try `DELETE /appinstalls/2026-09/external-install`, then `POST /oauth/2026-09/token/revoke` [HS-UNINSTALL-API];
  - then always wipe tokens, set `purge_after`, cancel jobs and revoke action tokens.
- **Webhooks Journal (`APP_LIFECYCLE_EVENT`) polling:** designed but disabled (`HUBSPOT_JOURNAL_ENABLED=false`).

### D-11 · Classifying HubSpot errors (Type A)
`classifyRefreshFailure()` [HS-OAUTH-REFRESH-ERRORS, HS-HTTP-ERROR-CODES, HS-429-SHAPE]:

| Class | Matches | Action |
|---|---|---|
| `revoked` | 4xx other than 429, with `error=invalid_grant`, or `status ∈ {BAD_REFRESH_TOKEN, BAD_HUB}`, or `error=access_denied` | terminal |
| `config` | `invalid_client`, `unauthorized_client`, `invalid_request`, `unsupported_grant_type`, `BAD_CLIENT_ID`, `BAD_CLIENT_SECRET`, `BAD_REDIRECT_URI`, `BAD_GRANT_TYPE` | Sentry once; portals stay active |
| `transient` | 423, 429, 477, 5xx, timeouts | the job returns 5xx so QStash handles backoff |

- **Long waits:** a 477, or any `Retry-After` over 60 s, re-schedules the job with `notBefore = now + Retry-After`. A daily-limit 429 defers to the next local midnight.
- **API 401:** refresh once. If that refresh is classified `revoked`, mark the connection revoked; otherwise treat it as transient.
- **Alerting:** after 5 transient failures in a row, a Sentry alert is raised; the connection stays active.

### D-12 · Account timezone, UI domain, hub domain (Type A)
- **Source:** `GET /account-info/2026-09/details` (scope `oauth`), read at install and in each account's daily job. It provides `timeZone`, `utcOffsetMilliseconds`, `uiDomain` and `dataHostingLocation` [HS-ACCOUNT-DETAILS].
- **Fallbacks:** a non-IANA zone uses the fixed offset. If the call fails, onboarding asks the owner.
- **Hub domain:** `hub_domain` comes from token introspection and is stored as the brief asks [HS-HUB-DOMAIN-SEMANTICS].
- **Record links:** `https://{uiDomain}/contacts/{portalId}/record/0-1/{contactId}` [HS-RECORD-URL].

### D-13 · Compose links (Type A where vendor docs are missing — sign-off for the interstitial)
- **Mail clients:** `mail_client ∈ {gmail, outlook_work, outlook_personal, other}`.
- **Gmail:** default form is `https://mail.google.com/mail/u/{0|<email>}/?to=…&cc=…&bcc=…&su=…&body=…&tf=cm`. BCC was confirmed first-hand on this form [CMP-GMAIL-WEB-URL, CMP-BUILDER-SPEC]. `COMPOSE_GMAIL_FORM=view` switches to `?view=cm&fs=1…`.
- **Outlook:** `{base}?mailtouri=<RFC 6068 mailto>` [CMP-OUTLOOK-PARAMS-BCC, CMP-OUTLOOK-HOSTS].
  - Work base: `https://outlook.cloud.microsoft/mail/deeplink/compose`.
  - Personal base: `https://outlook.live.com/mail/deeplink/compose`.
  - Configurable: `COMPOSE_OUTLOOK_MODE` (`mailtouri|params`), `COMPOSE_OUTLOOK_WORK_BASE`, `COMPOSE_OUTLOOK_PERSONAL_BASE`.
- **Phone user agent or client "Other":** a 200 interstitial whose nonce'd script opens the `mailto:` URL on load, with a button and "Copy reply" as fallbacks. A bare 302 to `mailto:` leaves a blank tab [CMP-REDIRECT-IMPLEMENTATION, CMP-GMAIL-MOBILE]. **This deviates from brief §5.5's "302".**
- **Desktop Gmail/Outlook:** a 302 (`NextResponse.redirect(url, 302)`; the default would be 307).
- **Length check:** if the final URL is over `COMPOSE_URL_LIMIT=1800` characters, show the copy-reply page instead. The check runs per client [CMP-URL-LENGTH-LIMITS].
- **"Edit first":** the form POST returns a 200 page with the compose link as a button, never a 302. A CSP `form-action` would otherwise block the Google or Microsoft sign-in redirect for signed-out owners. CSP `form-action` therefore stays `'self'`.
- **Encoding:** `encodeURIComponent` on `toWellFormed()` strings, plus `!'()*`. Never `URLSearchParams` [CMP-ENCODING-PLUS-SPACE].
- **Recipients** are validated as single bare addresses [CMP-RECIPIENT-SAFETY].
- **Every three-button email** also has an "Open in default mail app" link (`/a/{t}/send?via=mailto`).

### D-14 · BCC logging and the inbox-logging check (Type A)
- **What gets logged:** BCC logs sends, not replies [HS-BCC-LOGGING]. Replies are logged automatically only with a connected inbox using "Log all emails to/from known contacts". That rule applies to **existing** contacts only [HS-CONNECTED-INBOX, HS-INBOX-LOGGING-CHECK-DESIGN].
- **History:** two `emails/search` counts (outbound vs inbound, last 30 days).
- **Live test, send leg:** our test email from Autopilot (the test lead) is sent to the owner's other address.
  - Before it, `GET contacts/{testEmail}?idProperty=email`.
  - On a 404 with no BCC saved, ask the owner either to add their BCC address or to submit one of their own forms with the test address.
  - While a check is open, intake marks any submission whose email equals the hashed test address as `is_test` (no draft, no follow-ups, not counted).
- **Live test, reply leg:** the owner replies from the test address, and we wait for an `INCOMING_EMAIL` from it.
- **Not blocking:** "Continue — we'll keep checking" and "Skip for now" (`logging_mode=unknown`, plus a dashboard reminder). Results land on the dashboard when they arrive.
- **Logging mode:** `logging_mode ∈ {unknown, log_all, sends_only, none}`.
  - Follow-up emails carry a plain warning when replies can't be detected.
  - The Monday report shows "Not enough data" for replies in those modes (D-37).
- **Fix-step copy** distinguishes "test contact missing" from "not logged". KB-derived claims are re-checked in WIRE_UP on Free and Starter portals.

### D-15 · QStash semantics, durable jobs (Type A)
- **Every job is a `scheduled_jobs` row,** inserted in the **same transaction** as the state that needs it (an outbox). It is published after commit, and `external_id` is stored.
- **Claiming a job:**
  - `status='running'`, plus `attempt_id` and `lease_until = now + 6 min`.
  - A claim succeeds when `status='scheduled'`, or when `status='running'` with an expired lease.
  - Later updates are conditional on the same `attempt_id`.
- **Responses:**
  - transient error → back to `scheduled` and return 5xx;
  - permanent error → `failed` and 489 + `Upstash-NonRetryable-Error`;
  - live lease held by another attempt → 503 with `Retry-After`;
  - done, cancelled, skipped or failed → 200.
- **Sweeper** (poll cron) re-publishes, with dedupe id `{key}:r{attempts}`:
  - unpublished rows older than 2 min;
  - missed rows (`run_at` over 30 min past);
  - expired leases.
- **Scheduling:** publish with `notBefore` only [QS-DELAY-HEADERS]. "Hop" when the target is beyond `QSTASH_MAX_DELAY_SECONDS`, and check for an early hop **before** claiming [QS-DELAY-MAX-PER-PLAN].
- **Cancel:** by message id only; 404 counts as success; never a bulk or filter cancel [QS-CANCEL].
- **Verification:** `Receiver.verify` with `url`, `clockTolerance: 5`, `devMode: false`. Boot fails if `QSTASH_DEV` is set in live mode [QS-RECEIVER-API, QS-DEVMODE-KEY-OVERRIDE].
- **Failure callback:** `/api/jobs/failed` marks the job failed, and for `lead_process` and `followup` sends the "needs your touch" email (D-24).

### D-16 · Periodic triggers (Type A)
- **Auth:** each periodic route accepts either a Vercel Cron GET with `Authorization: Bearer ${CRON_SECRET}` (constant-time compare) or a signed QStash schedule POST [VC-CRON-SECRET-UA, QS-SCHEDULES-ALTERNATIVE].
- **WIRE_UP default:** Vercel **Pro** with `vercel.json` crons. Hobby limits are unverified [VC-CRON-PLAN-LIMITS]; `scripts/qstash-schedules.ts` is the alternative.
- **Leases:**
  - the poll cron takes a global lease (TTL 6 min, longer than `maxDuration`);
  - `pollPortal` takes a per-account lease;
  - cursors move only forward (`GREATEST`).

### D-17 · Monday report: due-check, window, who gets one (Type A + B)
- **Due-check:** local time ≥ Monday 08:00 of the current ISO week, before Tuesday 00:00 local, and no `weekly_reports` row for that week [VC-CRON-MONDAY-DUE].
  - The timezone used is stored on the row.
  - `pending` and `failed` rows are re-enqueued until Tuesday 00:00 local, with a bounded number of attempts.
- **Period:** `[Mon 08:00 local minus 1 week (Luxon, in the portal zone), Mon 08:00 local)`, half-open and stored as UTC instants.
- **Two kinds of metric:**
  - **cohort** metrics cover leads submitted in the period (not test leads);
  - **event** metrics (replies, follow-ups drafted) are counted by HubSpot or notification time within the period.
- **Order:** signals are refreshed first, through `applySignals`/`markReplied`. Job ordering can't change the numbers.
- **Who gets one:** accounts with onboarding complete and `processing_state = active`. Paused, inactive, revoked and disconnected accounts get none.

### D-18 · Razorpay checkout guard, entitlement, resume (Type A)
- **Guard:**
  - **block** on `authenticated`, `active`, `pending`, `halted`, `paused`;
  - **allow** when there is no subscription, or it is `created`, `expired`, `cancelled` or `completed`;
  - **never block on `created`:** reuse its `short_url` while `expire_by > now` and (`start_at` is null or `start_at > now`) [RZP-SUB-DECLINED-CREATED-GUARD].
- **Billing page actions:**
  - `pending`/`halted`: "Update payment method" (the stored `short_url`);
  - `paused`: "Resume subscription" (`POST /v1/subscriptions/{id}/resume {"resume_at":"now"}`) [RZP-SUB-CANCEL-PAUSE-RESUME-FETCH].
- **Checkout races:**
  - serialised with `accounts.checkout_lock_until` (30 s compare-and-set);
  - a partial unique index allows one `created` subscription per account;
  - if a second live subscription activates for the same account, the newer one is cancelled immediately and the admin is alerted.
- **Entitlement:** `trialing` OR `authenticated` OR `active` OR (`pending` AND `now < grace_until`).
  - `grace_until = payment_failed_at + 3 d`, where `payment_failed_at` is the first `pending` event's `created_at`. Both are cleared when the status returns to `active`.
  - `halted`, `paused`, `cancelled`, `completed` and `expired` are inactive. Unknown statuses are inactive and alert the admin. `resumed` maps to `active` [RZP-SUB-STATUSES, RZP-STATUS-MAPPING].
  - "Current subscription" means the row with the latest `created_at`.

### D-19 · Razorpay webhooks (Type A)
- **Verification:** HMAC hex over the raw body with the webhook secret, compared timing-safe. An empty secret is refused. `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` is supported during rotation [RZP-WH-SIGNATURE].
- **No timestamp header**, so instead we require `created_at` to be at most 5 min in the future and no more than 16 days old [RZP-WH-REPLAY-TIMESTAMP].
- **Dedupe:** per D-05.
- **Applying changes:**
  - The event is only a trigger: we `GET /v1/subscriptions/{id}` and apply that state.
  - A change is applied only if it is newer: `… WHERE last_synced_at IS NULL OR last_synced_at < $fetched_at`.
  - Each account's daily job reconciles non-terminal subscriptions, because some transitions fire no webhook.
  - Webhooks for purged accounts hit a content-free tombstone and get a 200.

### D-20 · Razorpay hosted checkout, trial, USD, cancel (Type A)
- **Subscription link:** `POST /v1/subscriptions` with `{plan_id, total_count: 120, quantity: 1, customer_notify: true, expire_by, notes: {autopilot_account_id}}`, then a 303 to `short_url` [RZP-CHECKOUT-HOSTED, RZP-SUB-CREATE-FIELDS].
  - There is no return URL, so the billing page polls our DB.
- **Trial:** if more than 1 day of trial remains, send `start_at = trial_end` and `expire_by = min(now + 7 d, start_at − 60 s)` [RZP-TRIAL-START-AT]. Otherwise omit `start_at` and use `expire_by = now + 7 d`.
- **Cancel:**
  - `authenticated` → `cancel_at_cycle_end: false`, immediately; the trial still runs to its end;
  - `active` → `true`, at the end of the cycle.
  - We call the REST API with `fetch`, not the SDK. The SDK's `cancel(id, {…false})` actually cancels at cycle end [RZP-SDK-PACKAGE].
- **USD:** needs International Cards plus refund/cancellation and shipping policy pages [RZP-USD-INTERNATIONAL]. So `/refunds` and `/shipping` exist (`TODO: legal review`).
- **"Fails silently" (brief §10.7):** server-side failures from a mismatched key pair are loud. We keep the same-generation rule plus a `GET /v1/plans/{id}` smoke test [RZP-API-KEYS].

### D-21 · Supabase keys, grants, RLS, Auth settings (Type A)
- **Keys:** the new `sb_publishable_…` and `sb_secret_…` keys, both **server-only**. No `NEXT_PUBLIC_SUPABASE_*` variables; there is no browser Supabase client [SB-KEYS-MODEL].
- **Every table:**
  - `enable row level security`;
  - `revoke all … from anon, authenticated`;
  - `grant select, insert, update, delete … to service_role` (projects created after 2026-05-30 no longer auto-grant) [SB-RLS-NOT-DEFAULT, SB-DATA-API-GRANTS-2026].
  - No policies.
- **The migration also runs** `alter default privileges in schema public revoke execute on functions from public, anon, authenticated;`.
- **WIRE_UP:**
  - turn off "Allow new users to sign up";
  - remove `public` from the Data API's exposed schemas;
  - set Site URL and Redirect URLs.

### D-22 · Magic links (Type A)
- **Generating links:** `auth.admin.generateLink` (secret key) is called only for:
  - (a) a bound owner's email;
  - (b) an account's `pending_owner_email` during onboarding;
  - (c) an `ADMIN_EMAILS` address.
  - Users are created first with `admin.createUser`.
- **The link:** `${APP_URL}/auth/confirm#th=<hashed_token>&type=email`.
  - The token sits in the URL **fragment**, so it never reaches server or Vercel logs.
  - `type=email` works for both new and existing users; `magiclink` fails for new users [SB-MAGICLINK-TEMPLATES-NEWUSER, SB-MAGICLINK-FLOW].
- **Confirming:**
  - `GET /auth/confirm` shows a "Sign in" button.
  - A nonce'd script copies the fragment into a same-origin POST.
  - The POST calls `verifyOtp({token_hash, type})`, accepting only `email`, `magiclink` or `signup`.
  - Link scanners can't consume it [SB-EMAIL-PREFETCH].
- **`next` destination:** stored server-side, not in the URL. It must match `^/(dashboard|onboarding|admin)(/|$)`; otherwise `/dashboard`.
- **/login:** always shows the same neutral response, takes ~800 ms whichever branch runs (so timing doesn't reveal whether an account exists), and is rate-limited.
- **Fallback:** Supabase SMTP (Resend) is configured for any email Supabase sends itself [SB-SMTP-RESEND, SB-AUTH-EMAIL-LIMITS].

### D-23 · Sentry v11, restrictive (Type A)
- **Pin:** `@sentry/nextjs@11.2.0`.
- **One shared options module, `src/shared/observability/sentry-options.ts`:**
  - no `server-only` import, so the client init can import it;
  - all `dataCollection` options false or empty;
  - no tracing;
  - `tracePropagationTargets: []`;
  - the `Anthropic_AI` and `Console` integrations removed;
  - `beforeSend`/`beforeBreadcrumb` scrubbers rewrite request URL, query string and transaction (including `/a/{token}`), and delete request data, cookies and headers [SENTRY-V11-DATA-DEFAULTS, SENTRY-GENAI-ANTHROPIC, SENTRY-HOOKS-STREAMING, SENTRY-URL-QUERY-LEAK, SENTRY-RECOMMENDED-CONFIG].
- **No browser Sentry** on `/a/*` or `/auth/*`.
- **Server actions** are wrapped without `formData` or headers, with `recordResponse: false`.
- **Proof:**
  - a pure-scrubber golden test;
  - an envelope test using the real `@sentry/node` and an in-memory transport [SENTRY-SCRUBBER-TEST];
  - the fixtures include a real PGlite NOT NULL violation and a throwing Server Action.

### D-24 · Anthropic: call pattern, errors, fallbacks (Type A)
- **Call:** `messages.create` with `output_config.format = {type:'json_schema', schema: toClaudeJsonSchema(zod)}`.
  - The project helper keeps `enum`; the SDK helper strips it [AI-SO-TS-ENUM, AI-SO-PARSE-SEMANTICS].
  - Enum strings are lowercased before Zod parsing (casing isn't guaranteed) [AI-SO-SCHEMA-LIMITS].
  - Limits the schema can't express (FAQs ≤ 8, word limits) are enforced in code.
  - `flags` is a **closed enum**: `asks_pricing`, `urgent`, `non_english`, `missing_info`, `possible_spam`, `sensitive_topic`, `other`.
- **Per-model parameters** (`buildModelParams`) [AI-MODEL-CAPABILITY-MAP, AI-SONNET55-REQUEST, AI-HAIKU45-REQUEST, AI-REQUEST-RECOMMENDATIONS]:

| Model / purpose | thinking | effort | max_tokens |
|---|---|---|---|
| Sonnet 5.5, drafts | `ANTHROPIC_DRAFT_THINKING` (default `between_tools`) | `ANTHROPIC_DRAFT_EFFORT` (default `medium`) | `ANTHROPIC_DRAFT_MAX_TOKENS` (default 1024) |
| Sonnet 5.5, brief | adaptive | `high` | 16000; fallback `between_tools`/`high`/4096 if the time budget binds |
| Sonnet 5.5, classification (if the fast model is swapped) | `between_tools` | `low` | 256 |
| Haiku 4.5, classification | omitted | omitted | 256 |

  - Never sent: sampling parameters, prefill, `tool_choice`.
- **Errors** [AI-SDK-ERRORS-RETRIES]:
  - **TRANSIENT:** `APIConnectionError`/`Timeout`, `APIUserAbortError`, `InternalServerError`, `ConflictError`, and `RateLimitError` with `retry-after`. The job returns 5xx.
  - **FATAL-CONFIG:** 400, 401, 403, 404, 402, 413, and the spend-cap 429. "Needs your touch" goes out at once, plus an admin alert.
- **Output-level failures:**
  - `refusal` → no retry, needs-touch;
  - `max_tokens` → counts as the one retry.
- **Classification never blocks a lead.** Any classification failure becomes `unclear`, which gets a draft.
- **Never silent:**
  - On the final QStash delivery of `lead_process` or `followup` (`Upstash-Retried` = retries), and in its failure callback, the owner gets the "needs your touch" email built from the minimal safe template, which needs no LLM.
  - `allow_pricing` from the model is ignored: generated briefs always start with `false`.
  - A refused brief opens an empty editable form.
  - SDK `logLevel: 'warn'`. SDK error messages are never logged [AI-SDK-LOGGING-PRIVACY].
  - Server-side fallbacks are off [AI-SERVER-FALLBACK].

### D-25 · Haiku 4.5 retirement exposure (Type A)
- **Fact:** retirement is not sooner than 2026-10-15, with at least 60 days' notice [AI-MODEL-HAIKU45].
- **Decision:** `ANTHROPIC_MODEL_FAST=claude-sonnet-5-5` works with no code change (D-24 row).
- **Monitoring:** a retired-model 404 alerts the admin. Costs are keyed by `response.model` [AI-PRICING-COST].

### D-26 · Email link scanners (Type A)
- **Dismiss:** `GET /a/{t}/dismiss` shows a confirmation page; only the POST dismisses [SB-EMAIL-PREFETCH].
- **What counts as a click:** not a `HEAD`, not a scanner user agent, and either at least 60 s after the email was sent or a nonce'd beacon from the interstitial or edit page.
- **Copy:** "opened the send link (not confirmed)". Clicks are never confirmed sends (law 3).
- **Tracking:** Resend click and open tracking stay off.

---

## B. Choices where the brief is silent

### D-27 · Owner-facing emails: Reply-To and the "don't reply" line
- **Reply-To:**
  - Owner emails about leads (new lead, needs touch, follow-up, reply detected, inbox test) set Reply-To to the **owner's own address**.
  - They never use the lead's address (that would hand the lead our tokens) or our support inbox.
  - `EMAIL_REPLY_TO` is used only for magic-link and billing emails.
- **Templates:** each lead template opens with "Don't reply to this email. Tap 'Send from my email'."

### D-28 · Data access layer
- **Approach:** a thin `Db` interface with SQL repositories.
  - **Live:** Postgres.js on the Supabase transaction pooler (`:6543`, `{max:1, prepare:false, ssl:'require'}`) [SB-DB-ACCESS-LAYER].
  - **Tests and fake mode:** PGlite, running the same SQL.
- **Rules:**
  - (1) queries run one at a time per client, never concurrently;
  - (2) `Db.tx(fn)` passes a `tx` handle; the root handle throws if used while a transaction is open in the same async context (`AsyncLocalStorage`);
  - (3) **no transaction is ever held across network I/O**;
  - (4) concurrency control is single-statement compare-and-set or lease updates only, because PGlite's sequential tests can prove those;
  - (5) every logical timestamp and time comparison uses a bound `$now` from `Clock`. `now()` and `default now()` are allowed only for audit-only `created_at`. A test scans the SQL; lint bans `Date.now()`, argument-less `new Date()` and `DateTime.now()` outside `SystemClock`.
  - (6) drivers are normalised: `int8 → string`, `bytea` is never used (hex `text`);
  - (7) driver errors are rethrown as `DbError{sqlstate, constraint, table, column}`, never carrying `detail`, query text or parameters.

### D-29 · Extra ports and fake-mode safety
- **Extra ports:** `Clock` and `AuthProvider` join the brief's six ports.
- **`APP_MODE`** is required (no default).
  - `fake` is refused when `VERCEL_ENV ∈ {production, preview}` unless `ALLOW_FAKE_ON_VERCEL=1`.
  - Fake mode uses fixed, documented fake secrets, and live mode rejects them.
  - `/dev/*` routes need fake mode.
- **Fake mode is complete without credentials:**
  - `/dev/fake-hubspot/authorize` (consent);
  - `/dev` actions: submit lead, log owner send, log lead reply, revoke token, opt out contact, advance clock, run due jobs;
  - a dev job ticker every 10 s;
  - a `dev_outbox` table;
  - fake state and the clock offset persisted in PGlite.
- **PGlite** lives in a lazy `globalThis` singleton (`serverExternalPackages`) and is never opened at import time or from `proxy`/`instrumentation`.

### D-30 · Extra tables and columns beyond brief §6
- **Extra tables:**
  - `baselines`
  - `inbox_checks`
  - `ai_calls`
  - `rate_limits`
  - `leases`
  - `portal_history` (content-free tombstone: portal id + first trial start, so a purge and reinstall can't restart the trial)
  - `billing_tombstones` (purged subscription ids)
  - `dev_outbox` (fake mode only)
  - `_migrations` (ledger)
- **Columns added to brief tables:** `processing_state` on `accounts` and on `leads`, cursor and floor on `selected_forms`, leases on `scheduled_jobs` and `hubspot_connections`, reservation status on `notifications_sent`, and more. PLAN §5 has the full list.

### D-31 · Law 4: which lead fields count as "form message" (sign-off)
- **Stored in `lead_messages`:** what the lead typed into the form, and nothing else: message, first name, last name, company, email.
- **Retention:** `purge_at = submitted_at + 30 d` (test leads: + 24 h).
- **Why:** the compose links need the address and name.
- **After the purge:** the UI shows "Contact #123 (details removed after 30 days)" with a HubSpot link.
- **`leads` keeps only IDs, timestamps and statuses.**
  - `submission_key` = HubSpot `conversionId`, else `HMAC(K_dedupe, formId|submittedAt|lower(email))`.
  - It is nulled when the content is purged.

### D-32 · Lead status shown to the owner
`deriveLeadStatus(lead, now)` is a pure function; the result is never stored. Precedence:

1. `dismissed`
2. `replied` (`replied_at > replies_ignored_before`)
3. `filtered` (filtered class, not overridden)
4. `not processed` (failed / skipped / deferred)
5. `no reply` (labelled "No reply from lead (none logged)"; follow-ups finished or off, and at least 2 days since the last owner email)
6. `send confirmed`
7. `send clicked` (labelled "opened the send link")
8. `drafted`
9. `processing`

`leads.processing_state ∈ {new, processing, notified, filtered, deferred, failed, skipped}` is the only stored lifecycle field.

### D-33 · Quiet hours and the follow-up schedule
- **Scope:** quiet hours apply to follow-ups only; the first "new lead" email is immediate.
- **Defaults:** 19:00–08:00, skip weekends = on.
- **Constraints:**
  - hours are 0–23;
  - `start = end` means no quiet hours;
  - settings with no allowed hour in a week are rejected.
- **Targets:** `shiftToAllowed(T0.plus({days: n}) in portal zone)` moves the time to the next whole allowed hour, searching at most 8 days.
  - A deterministic per-account offset of 0–10 min is added only when the time was shifted, so Monday bursts are spread out.
- **At fire time:** if the current settings forbid "now", the job is re-targeted (hop) rather than sent.

### D-34 · Honest notes on follow-ups
- **Every follow-up email to the owner states:**
  - when HubSpot hasn't confirmed the first send: "We couldn't confirm in HubSpot that your first reply was sent";
  - when replies aren't logged: "HubSpot isn't logging replies for you, so check your inbox before sending".

### D-35 · Owner binding, reconnect, reinstall
- **Binding at the email step:**
  - `/onboarding/email` requires the signed `pending_install` cookie.
  - It is pre-filled with the installer's email from token introspection.
  - It stores `accounts.pending_owner_email`, a nonce hash and an expiry (+30 min), then sends the magic link.
- **Binding after login:**
  - After login in **any** browser, `POST /onboarding/bind` binds the owner only if the verified session email equals `pending_owner_email`, the nonce matches, and an atomic `UPDATE … WHERE owner_user_id IS NULL AND pending_owner_expires_at > $now` succeeds.
  - Cross-device works; login CSRF can't bind a stranger.
  - `users` has a unique `lower(email)`.
- **Reinstall into an owned portal:**
  - **With** the owner's session: reactivate (status active; clear `purge_after`, `disconnected_at`, `status_reason` and `reconnect_email_sent_at`; floors move to now).
  - **Without** it: no account changes. The page says "Sign in as the owner to reconnect" (`/login`, with `next` stored server-side). The owner is emailed "HubSpot was reconnected by another user".
- **Install permission:** installing needs a Super Admin or "App Marketplace Access". This is stated under the Install button and on the install-failed page.

### D-36 · Rate limits and per-account caps
- **Rate limits:** Postgres fixed-window counters keyed by HMAC(IP/route).
  - `/a/*`: 30/min per IP, 20/min per token.
  - `/login`, `/onboarding/email`: 5/15 min per IP, 3/15 min per email, at most 3 distinct emails per pending install.
  - `/api/hubspot/install`: 20/min per IP.
  - Brief generation: 5 per account per day, 1 at a time.
- **Per-account caps** (env):
  - `MAX_DRAFTED_LEADS_PER_DAY=50`: overflow leads become `deferred`, with no LLM call. One "lead limit reached" email per day links to the dashboard.
  - Global `AI_DAILY_BUDGET_USD`: a breaker that stops drafting and alerts.
- **HubSpot per-portal limiter:** ≤ 9 req/s general and ≤ 4 req/s search, stored in Postgres [HS-RATE-LIMITS].
- **Resend:** `rate_limit_exceeded`, `concurrent_idempotent_requests` and `application_error` are transient. Report publishes are staggered (`notBefore + i s`).

### D-37 · Monday report wording and honesty
- **Labels:**
  - "Leads in"
  - "Filtered (spam etc.)"
  - "Drafts emailed to you"
  - "Sends confirmed in HubSpot"
  - "Opened the send link (not confirmed)"
  - "Median time to your first logged reply email" (n ≥ 3, else "Not enough data")
  - "Leads you haven't replied to (no send logged in HubSpot)", with record links (first 20 + "and N more")
  - "Replies from leads"
  - "Follow-ups drafted"
  - "Compared with your baseline" (only when both sides are sufficient)
- **"Reply" means only the lead's reply,** everywhere.
- **Honesty rules:** a count over 0 is always shown (it is confirmed). A 0 is shown as "Not enough data" when:
  - (replies) `logging_mode ≠ log_all`, or the email scope is missing;
  - (sends) `logging_mode ∈ {none, unknown}`, or the email scope is missing.
- **The list** "leads you haven't replied to" is replaced by "We can't confirm sends in HubSpot for your account" when sends aren't logged.

### D-38 · When the baseline is "not enough logged history"
- **If the portal has no logged `EMAIL` at all in 30 days, or the scope is missing:** show the lead count only, with "Not enough logged history" for the other two figures.
- **Median:** shown only when at least 3 leads have a logged outbound email.
- **Outbound email** counts only when the lead is a recipient.

### D-39 · Simulation calendar
- **Owner settings:** portal timezone `America/New_York`; quiet hours 19:00–08:00; **weekends allowed** (the owner works weekends); 1 notify email; Gmail; BCC on.
  - Day 5 therefore runs the brief's literal "job fires → reply detected" path.
  - Weekend shifting is covered by unit tests.
- **Calendar:**
  - Pre-run: Tue 2026-10-06, 09:00–09:30.
  - Day 0: Tue 10:00.
  - Day 2: Thu.
  - Day 3: Fri, the lead replies.
  - Day 5: Sun.
  - Monday 2026-10-12 08:00: the report.
  - Wednesday 10-14 12:00: final statuses.
- **Time:** time travel steps through every job and cron tick in order. The run is repeated with the system clock set to 2030, and must give the same result.

### D-40 · HubSpot client
- **Approach:** plain `fetch` + Zod over about 14 endpoints, with the D-03 request allow-list and the D-36 limiter.
- **Why:** `@hubspot/api-client` uses legacy paths, and `@hubspot/sdk` is alpha [HS-SDK-CHOICE].

### D-41 · Tooling
- **Runtime:** Node `>=22.12`.
- **Language:** TypeScript 5.9 (TypeScript 7 isn't supported by `typescript-eslint`).
- **Lint:** ESLint 9 flat config (`eslint-config-next@16`, `typescript-eslint`, boundary rules with `allowTypeImports`).
- **Libraries:** Vitest 4.1, Tailwind 4, Zod 4, Luxon, `react-email` 6.
- **Explicit dev dependencies:** `@sentry/node`, `@sentry/core`, `jose`.
- **`server-only` under Vitest and tsx:** aliased to an empty stub (`vitest.config` alias; `tsconfig.scripts.json` paths).
- **Every milestone gate** runs `APP_MODE=fake next build` plus a smoke `next start`.

### D-42 · Override, resume, pause
- **"This is a real lead":** `process_rev + 1`, then the job is re-enqueued with dedupe `…:process:r{rev}`.
- **"Resume follow-ups"** (e.g. after an out-of-office auto-reply):
  - `replies_ignored_before = now`;
  - `followup_stream + 1`;
  - only the follow-ups not yet sent are rescheduled, at `shiftToAllowed(max(T0 + n days, now + 1 h))`.
- **Pause all** is `accounts.processing_state = paused`, an internal state and not a Razorpay pause.
  - While paused, the poller skips the account.
  - On resume or reactivation, intake floors move to now, so leads that arrived while paused are not drafted. The dashboard says so.

### D-43 · Marketplace install cap
- **Fact:** 25 installs until the app is listed [HS-MARKETPLACE-INSTALL-CAP].
- **Decision:** listing assets stay out of scope (§11), and the cap is a documented launch limit.
- **We build to the listing rules now:**
  - dated OAuth endpoints;
  - the uninstall API on disconnect;
  - encrypted tokens;
  - less than 5% error responses;
  - described as a lead-response product, not an "AI connector".

### D-44 · A newer lead supersedes an older one for the same contact
- **Rule:** supersede is a **dynamic** stop, checked before every follow-up send. A lead is superseded when a newer, non-test lead for the same contact has already been notified.
- **Effect:** a filtered newer lead never cancels a real older one.

### D-45 · Action tokens
- **Format:** `apt_` + base64url(HMAC-SHA256(K_action, `notificationKey|purpose`)).
  - Tokens are deterministic per notification, so a retried email renders byte-identically and Resend idempotency holds.
  - Only `sha256(token)` is stored, with its purpose, lead and draft, expiring after 7 days.
- **Reuse:** send and edit tokens are reusable until expiry and counted. A dismiss token is single-use.
- **Revocation:** tokens are revoked on disconnect and on privacy deletion. Token checks also reject accounts that are disconnected or pending purge.

### D-46 · Notification addresses and BCC changes
- **Verification:** every notify address other than the owner's verified login email gets a confirmation link (`verify_notify` token, 7 days). It receives nothing until confirmed.
- **Change alerts:** any change to the notify addresses or the BCC address triggers an alert email to the owner's address.
- **BCC check:** the BCC address is soft-checked against `@bcc.*hubspot.com` and `@forward.*hubspot.com`, and is shown on the send, copy and edit pages.

### D-47 · Defending against lead-controlled text
- **The subject's first name is sanitised:**
  - no control characters or newlines;
  - at most 40 characters;
  - if it contains a URL, `@` or mostly digits, the subject falls back to "New lead — your reply is ready".
- **Display:** the lead's message is shown under "Message from the lead (unverified)", with URLs defanged (`example[.]com`). This applies in emails, the edit page and the dashboard.
- **Extra validator codes:**
  - `url_not_allowed`: any URL or domain other than the booking link and the brief's site host;
  - `contact_not_allowed`: email addresses or phone numbers not in the brief;
  - `addresses_owner`: "note to owner/assistant/AI", "ignore previous", and similar;
  - `echoes_lead`: 12 or more consecutive words copied from the lead.
- **Brief builder:**
  - drops hidden DOM (`display:none`, `hidden`, `aria-hidden`, `template`, comments);
  - `booking_link` must be https and appear in the fetched pages;
  - the editor shows its host and asks the owner to confirm it.

### D-48 · Account lifecycle and purge
- **States:** `accounts.processing_state ∈ {onboarding, active, paused, inactive, revoked, disconnected}`, computed by a pure function.
  - Transitions are applied by compare-and-set; only the caller that wins acts:
    - → active: floors move to now, and purge fields are cleared;
    - active → inactive: one billing email, keyed by the transition time;
    - → revoked or disconnected: `purge_after = now + 30 d`.
- **Orphan installs:** an install with no bound owner after 7 days gets the uninstall API call, the token wipe and an immediate purge.
- **The purge guard re-checks** that no connection is active.
- **Billing on purge:**
  - It cancels any live Razorpay subscription first (`cancel_at_cycle_end: false`; `pending`/`halted` → skip and alert).
  - Disconnect asks whether to cancel billing too.
  - After the purge, a tombstone keeps late webhooks harmless.

### D-49 · Where content can live, and for how long
- **Retention runs hourly as well as daily,** so content never outlives 30 d + 1 h.
- **Content stores and retention:**
  - `lead_messages`: 30 d
  - `drafts` (subject, body and flags): 30 d
  - test-lead content: 24 h
  - `inbox_checks.test_address`: 24 h
  - `dev_outbox`: fake mode only, git-ignored
  - Resend: retention per plan, to be checked in WIRE_UP; we choose ≤ 30 days or record a deviation
  - Anthropic API: per its commercial policy, re-checked in WIRE_UP
  - Supabase backups/PITR: the backup window, disclosed
  - QStash payloads: ids only
  - Sentry/logs: scrubbed, no content
  - Vercel request logs: may contain action-token paths; no log drains, shortest retention
  - the owner's mailbox: owner-controlled
- **Pages showing personal data** (`/a/*`, `/auth/*`, `/onboarding/*`, `/dashboard/*`, `/admin`) send `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`.

### D-50 · Milestones regrouped (brief §9 order kept)
Each milestone ships the pieces it needs:
- M2 gets `entitled()`, `processing_state`, `renderEmail` and the reconnect template.
- M3 gets action tokens, `/a/{t}/send|copy`, the compose builders, and the magic-link and inbox-test templates, all needed by login and the inbox check.
- M4 gets `shiftToAllowed` and follow-up scheduling.
- M5 runs follow-up jobs.
- The simulation grows a stage per milestone, and CI runs it from M1.

### D-51 · Keys and rotation
- **Ciphertext format:** `v1.<kid>.<iv>.<ct>.<tag>`, where kid = the first 8 hex characters of sha256(key). The AAD binds each ciphertext to its connection and field.
- **Rotation:**
  - a daily job re-encrypts rows that don't use the current kid, and `/admin` shows how many remain;
  - `TOKEN_ENCRYPTION_KEY_PREVIOUS` is used for decryption only;
  - `HUBSPOT_CLIENT_SECRET_PREVIOUS` is used for webhook verification only.
- **Per-purpose keys:** derived with HKDF(`APP_SECRET`) for `state`, `pending`, `ratelimit`, `dedupe`, `action` and `fake-session`.
- **`env.ts` asserts:**
  - each key decodes to 32 bytes;
  - current ≠ previous;
  - no fake or default values in live mode.
