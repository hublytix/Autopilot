# Decisions log

Every place where official documentation overrides the brief, and every choice made where the brief is silent, is recorded here (brief §0.1, §0.5). Evidence for each decision is in `docs/RESEARCH.md` under the finding IDs in brackets, e.g. [HS-SCOPES]. The full evidence for each finding is in `docs/research/NN-*.md`.

- **Type A:** the official docs contradict or extend the brief, so the docs win (§0.1).
- **Type B:** the brief is silent, so we chose the simplest option that satisfies it (§0.5).
- **Brief change:** we changed something the brief states outright, for the reason given. These are also listed in PLAN §1.1.

Status: every entry is **proposed**, pending the owner's `approve` of `docs/PLAN.md`. This is revision 5, after four plan-review rounds.

---

## Needs your explicit sign-off

These six entries change something the brief states outright, or interpret one of its product laws. Each involves a judgment call. They are approved together with the plan unless you say otherwise. PLAN §1.1 lists every other change to the brief.

1. **D-01:** Next.js 16 instead of 14. 14.x is out of security support, with 23 open advisories (2 critical).
2. **D-03:** the extra HubSpot scope `sales-email-read`. It is read-only, but HubSpot's consent screen will say it allows reading the **content** of all logged emails in the portal. Autopilot requests only five metadata properties (dates, direction, status, from/to addresses) and never reads subjects or bodies, and `/privacy` says so. HubSpot's `forms` scope also technically permits edits. Autopilot never makes any, and a code allow-list enforces that.
3. **D-31 (Law 4):** we read "the lead's form message" as the lead's submitted message plus first name, last name, company and email. Any missing value is filled from the same-named HubSpot contact property (the fallback in brief §5.2). Nothing else is stored, and it is all purged at 30 days. The compose links need the address and name.
4. **D-13:** brief §5.5 says "302 to the compose URL". On phones and for the "Other" mail client, we instead show a page that opens the mail app automatically, because a 302 to `mailto:` leaves a blank tab. That should stay one tap. If a browser blocks the automatic open, the owner taps the button (two taps); PLAN §17 #5 checks this.
5. **D-18:** the checkout guard blocks on `authenticated`, `active`, `pending`, `halted` and `paused`, and never on `created`. Processing also runs while `authenticated` (a trial-start subscription) and while `pending` within the 3-day grace. The brief said to block only on `active`/`halted`, and to process only while `active` (plus 3 days' grace).
6. **D-49 (Law 4):** we read "never log tokens" as applying to the logs and error reports we write, which never contain them. Vercel's own platform request logs record request paths, so they include the action token in `/a/{token}/…` links. We add no log drains, keep the shortest retention, and tokens expire after 7 days.

---

## A. Corrections from official documentation (docs win)

### D-01 · Next.js 16, not Next.js 14 (Type A, sign-off)
- **Decision:** pin `next@16.3.8` with `react@19.x`.
  - Middleware is now `src/proxy.ts` (Node runtime).
  - `src/instrumentation.ts` stays in `src/`, beside `src/app` [NX14-INSTR-LOCATION].
- **Why:**
  - 14.2.35 is the last 14.x release and gets no more security fixes [NX-SUPPORT-STATUS].
  - The npm advisory database lists 23 open GitHub advisories against it. Two are critical: remote code execution in the image optimiser, and remote code execution on Windows hosts [NX14-ADVISORIES].
  - 15.x reaches end of life on 2026-10-21, per community tracking [NX-RECOMMENDATION].
- **Consequences:**
  - No `experimental.instrumentationHook` setting.
  - `onRequestError = Sentry.captureRequestError` is exported.
  - `params`, `searchParams`, `headers()` and `cookies()` are async.
  - `next lint` is gone, so we use the ESLint 9 flat config.
  - Turbopack is the default build.
  - `next typegen` runs before `tsc`.
  - `global-error.tsx` is required.
- **If you reject this:** use 14.2.35 with the [NX14-ADVISORIES] mitigations: `images.unoptimized: true`; no Server Actions; strip inbound CSP request headers on every route; `experimental.instrumentationHook: true` in `next.config.mjs`.

### D-02 · The HubSpot app is a developer-platform project (Type A)
- **Decision:** `hubspot-app/` holds three files, uploaded with the HubSpot CLI (`hs project upload`):
  - `hsproject.json` (`platformVersion: "2026.09"`);
  - `src/app/app-hsmeta.json` (`distribution: "marketplace"`, `auth.type: "oauth"`);
  - `src/app/webhooks/webhooks-hsmeta.json`.
- **Why:** HubSpot permanently disabled creating legacy public apps in mid-2026 [HS-APP-PLATFORM, HS-APP-HSMETA-CONFIG, HS-CLI-WORKFLOW].
- **Tests:** one checks that `REQUIRED_SCOPES` matches `requiredScopes`; another checks that `targetUrl` equals `HUBSPOT_WEBHOOK_TARGET_URL`'s expected value.

### D-03 · Scopes, and enforcing read-only in code (Type A, sign-off)
- **Decision:** `requiredScopes` = `oauth crm.objects.contacts.read forms sales-email-read`.
  - The brief's three scopes cover intake.
  - Reading logged one-to-one emails (confirmed sends, reply detection, the inbox check, the baseline, the Monday report) also needs `sales-email-read` [HS-SCOPES, HS-EMAIL-SCOPES].
  - `sales-email-read` grants read access to the **content** of logged emails. Our code limits what we read (below).
- **`forms` also permits writes.** HubSpot has no read-only forms scope [HS-SCOPES], so Law 2 holds by behaviour:
  - `HubSpotHttp` accepts only an allow-list of method and path patterns, and anything else throws before any network call.
    - GET for forms, submissions, contacts, associations and account-info.
    - POST only for `…/search`, `…/batch/read`, and the `/oauth/{v}/token` endpoints (`/token`, `/token/introspect`, `/token/revoke`).
    - DELETE only for `/appinstalls/{v}/external-install`.
  - A unit test enumerates the list.
  - Copy: "Autopilot never changes your HubSpot data. HubSpot's 'forms' permission would also allow edits; Autopilot never makes any. Disconnecting uninstalls the app."
- **Data minimisation (law 4):** every email request uses a fixed metadata allow-list: `hs_timestamp`, `hs_email_direction`, `hs_email_status`, `hs_email_from_email`, `hs_email_to_email` [HS-EMAIL-DATA-MINIMISATION].
  - Addresses are compared in memory and never stored.
  - A test fails if any content property is ever requested.
- **If the email scope is unavailable (decided at WIRE_UP):** HubSpot blocks install on any scope mismatch, so there is no runtime fallback [HS-SCOPE-EMAIL-READ-RISK].
  - (a) Try `crm.objects.emails.read` only if WIRE_UP step 1's scope picker actually offers it. Research says it is reportedly not selectable and not to rely on it.
  - (b) The expected fallback: remove the scope from `REQUIRED_SCOPES` and from `app-hsmeta.json`. Every email-based feature then shows "Not enough data". A FakeHubSpot variant returning 403 `MISSING_SCOPES` covers path (b).

### D-04 · HubSpot's date-versioned APIs (2026-09) (Type A)
- **Decision:** every HubSpot path comes from `HUBSPOT_API_VERSION` (default `2026-09`). No `/v4/` calls.
- **Exceptions (no dated version exists):**
  - forms list `GET /marketing/v3/forms`;
  - submissions `GET /form-integrations/v1/submissions/forms/{formGuid}` [HS-API-VERSIONING, HS-API-VERSIONING-PATHS].
- **Fallback:** `2026-03`, if the smoke test fails.
- **Associations:** `GET /crm/objects/2026-09/contacts/{id}/associations/emails` and `POST /crm/associations/2026-09/contacts/emails/batch/read`.

### D-05 · Webhook and event idempotency keys (Type A, brief change)
- **HubSpot:** `dedupe_key = portalId:subscriptionType:objectId:eventId:occurredAt`, unique per provider. Brief §6 said "`eventId` unique", but HubSpot documents `eventId` as "not guaranteed to be unique" [HS-WH-IDEMPOTENCY].
- **Razorpay:** `dedupe_key` = the `x-razorpay-event-id` header, or `sha256:<raw body hash>` when the header is missing. There is also a partial unique index on `body_sha256` (D-19).
- **Leads:** `UNIQUE(account_id, hubspot_contact_id, submitted_at)` (the brief's dedupe) and `UNIQUE(account_id, form_id, submission_key)`.

### D-06 · Webhook subscriptions and handling (Type A)
- **Subscriptions:**
  - `crmObjects: object.creation` for `objectType contact`;
  - `hubEvents: contact.privacyDeletion` [HS-WH-SUBTYPE-CONTACT-CREATION, HS-WH-GDPR-PRIVACY-DELETION].
  - The handler also accepts the classic `contact.creation`.
- **Rejected events:** any event whose `appId` isn't `HUBSPOT_APP_ID` is dropped with a 200.
- **Privacy deletion:**
  - It is processed for **every known portal**, whatever its status.
  - It is recorded and handed to a durable `privacy_delete` job, which:
    - deletes `lead_messages`;
    - nulls draft `subject` and `body` and empties `flags` (`'{}'`: the column is NOT NULL, PLAN §9.10 step 2; see D-53);
    - replaces `submission_key` with a random value;
    - revokes the leads' action tokens;
    - cancels jobs;
    - sets `stop_reason='privacy_deletion'`.
- **Not subscribed:** deletion, merge and opt-out. They are re-read from the contact before every send.

### D-07 · Lead intake through the Forms submissions API (Type A, brief change)
- **Source of truth:** for each selected form, `GET /form-integrations/v1/submissions/forms/{formGuid}?limit=50`.
  - We page newest-first with a **60-minute overlap** below the per-form cursor. That lets a submission whose contact isn't visible yet be retried for an hour.
  - Only submissions with `submittedAt > intake_floor_at` are processed. The floor is set when the form is selected, and whenever the account (re)enters `active` (D-48), so no historical lead is ever ingested.
- **Contact lookup:** `GET contacts/{email}?idProperty=email` resolves the contact. Missing name, company or message fields fall back to that contact's properties (brief §5.2).
- **Webhook role:** `object.creation` only triggers polls, one immediately and one at +90 s, because the submission may lag behind the contact.
- **Why:**
  - There is no form-submission webhook [HS-WH-FORM-SUBMISSION-EVENT].
  - Contact conversion properties carry no form GUID and only show the latest conversion [HS-INTAKE-CONVERSION-PROPS].
  - CRM search on `recent_conversion_date` works [HS-INTAKE-SEARCH-RECENT-CONVERSION], but it lags and collapses repeat submissions, so it is kept only as a documented fallback.
- **Brief's rationale corrected:** HubSpot does not document that calculated properties can't be subscribed [HS-WH-CALC-PROPS].
- **Form types:**
  - `hubspot` and `flow` (pop-ups) are listed, using repeated `formTypes` params with `archived=false&limit=100` and paging.
  - `captured` (non-HubSpot) forms are excluded in v1, because submissions-API behaviour for them is undocumented. They return to the list once WIRE_UP check #2 passes.

### D-08 · Confirmed sends and replies (Type A)
- **Confirmed send:** an email engagement associated with the contact where all of these hold [HS-CONFIRMED-SEND]:
  - `hs_email_direction = EMAIL`;
  - `hs_timestamp ≥ first_notified_at − 60 s`;
  - status is absent or `SENT`;
  - the lead's email (or one of `hs_additional_emails`) is among the recipients in `hs_email_to_email`.
- **Confirmed reply:** an engagement associated with the contact where all of these hold [HS-REPLY-SIGNAL]:
  - direction `INCOMING_EMAIL` or `FORWARDED_EMAIL`;
  - `hs_timestamp > GREATEST(first_notified_at, COALESCE(replies_ignored_before, '-infinity'))`;
  - `hs_email_from_email` is the lead's address.
- **Positive-only fallback:** `hs_sales_email_last_replied`, held to the same time rule [HS-CONTACT-ACTIVITY-PROPS].
- **Never used as reply evidence:** `notes_last_contacted`, `hs_last_sales_activity_timestamp`, `num_contacted_notes`, `hs_email_last_reply_date`.
- **Stored times are HubSpot's event times:**
  - `send_confirmed_at` and `replied_at` = the earliest qualifying `hs_timestamp`, written monotonically (`LEAST`);
  - `signals_checked_at` records when we looked.
- **Reads:** the contact `GET … &associations=emails`, following `paging.next` through the dated associations endpoint, then `emails/batch/read` in chunks of 100 [HS-EMAIL-BY-CONTACT].
- **One `markReplied()`** (`UPDATE … WHERE replied_at IS NULL RETURNING`): the caller that wins cancels the remaining follow-ups. If follow-ups were still scheduled (the caller is a follow-up job, or it cancelled at least one), it also sends "{Name} replied — follow-ups stopped"; a reply found after follow-ups finished only updates the status. The update, the follow-up cancellations and the `reply_detected` reservation (`sending`) are **one transaction**; the email is sent after commit, and a lost send is resumed (D-45). Any later caller gets no row back and does nothing.
- **Test leads** (`is_test`) are excluded from every signal refresh, from `applySignals` and from `markReplied`.

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
  - (2) a daily `POST /oauth/2026-09/token/introspect` probe on the refresh token, run for every active connection whatever its pause or billing state. `{"active": false}` counts as revoked [HS-TOKEN-METADATA].
- **Revoked means**, all in one transaction with the revoke compare-and-set (PLAN §9.1 step 3):
  - tokens are wiped;
  - `purge_after = now + 30 d` (brief §5.1);
  - jobs are cancelled and action tokens revoked;
  - the reconnect email is reserved. It is sent after commit, and resumed by the sweeper if lost (D-45).
- **Owner Disconnect is best effort and always completes locally:**
  - try `DELETE /appinstalls/2026-09/external-install`, then `POST /oauth/2026-09/token/revoke` [HS-UNINSTALL-API];
  - then always wipe tokens, set `purge_after`, cancel jobs and revoke action tokens.
- **Webhooks Journal polling:** designed but disabled (`HUBSPOT_JOURNAL_ENABLED=false`).

### D-11 · Classifying HubSpot errors; retries (Type A)
`classifyRefreshFailure()` [HS-OAUTH-REFRESH-ERRORS, HS-HTTP-ERROR-CODES, HS-429-SHAPE]:

| Class | Matches | Action |
|---|---|---|
| `revoked` | 4xx other than 429, with `error=invalid_grant`, or `status ∈ {BAD_REFRESH_TOKEN, BAD_HUB}`, or `error=access_denied` | terminal |
| `config` | `invalid_client`, `unauthorized_client`, `invalid_request`, `unsupported_grant_type`, `BAD_CLIENT_ID`, `BAD_CLIENT_SECRET`, `BAD_REDIRECT_URI`, `BAD_GRANT_TYPE` | Sentry once; portals stay active |
| `transient` | 423, 429, 477, 5xx, timeouts | the job returns 5xx so QStash retries it |

- **Brief §5.1's "exponential backoff (max 5 attempts), then a Sentry alert":** jobs are published with `Upstash-Retries: 4` and `Upstash-Retry-Delay: pow(2, retried) * 10000`. That is 5 deliveries, waiting 10, 20, 40 and 80 s between them. The failure callback raises the Sentry alert, and the connection stays active.
- **Long waits:** a 477, or any `Retry-After` over 60 s, re-schedules the job (`notBefore = now + Retry-After`). A daily-limit 429 defers to the next local midnight.
- **API 401:** refresh once. If that refresh is classified `revoked`, mark the connection revoked; otherwise treat it as transient.
- **Inline callers** (the poll cron, the lead-page refresh) have no QStash backoff. Only they increment `transient_failures` and set `next_refresh_attempt_at = now + min(2^(n−1) × 5 min, 30 min)`; jobs rely on QStash's backoff and the failure callback's alert. The poll cron skips a portal only while its token needs a refresh and `now < next_refresh_attempt_at`. The fifth consecutive inline failure raises one Sentry alert. Any successful refresh or API call, from any caller, resets both fields. The connection stays active.

### D-12 · Account timezone, UI domain, hub domain (Type A)
- **Source:** `GET /account-info/2026-09/details` (scope `oauth`), read at install and in each account's daily job. It provides `timeZone`, `utcOffsetMilliseconds`, `uiDomain` and `dataHostingLocation` [HS-ACCOUNT-DETAILS].
- **Fallbacks:** a non-IANA zone uses the fixed offset. If the call fails, onboarding asks the owner.
- **Hub domain:** `hub_domain` (the portal's own website domain) comes from token introspection [HS-HUB-DOMAIN-SEMANTICS].
- **Record links:** `https://{uiDomain}/contacts/{portalId}/record/0-1/{contactId}` [HS-RECORD-URL].

### D-13 · Compose links (Type A where vendor docs are missing; sign-off for the interstitial; brief change)
- **Mail clients:** `mail_client ∈ {gmail, outlook_work, outlook_personal, other}`. The brief's single "Outlook" option becomes work vs personal, because the hosts differ.
- **Gmail:** default form `https://mail.google.com/mail/u/{0|<email>}/?to=…&cc=…&bcc=…&su=…&body=…&tf=cm`. BCC was confirmed first-hand on this form [CMP-GMAIL-WEB-URL, CMP-BUILDER-SPEC]. `COMPOSE_GMAIL_FORM=view` switches to `?view=cm&fs=1…`.
- **Outlook:** `{base}?mailtouri=<RFC 6068 mailto>` [CMP-OUTLOOK-PARAMS-BCC, CMP-OUTLOOK-HOSTS].
  - Work base: `https://outlook.cloud.microsoft/mail/deeplink/compose`.
  - Personal base: `https://outlook.live.com/mail/deeplink/compose`.
  - Configurable: `COMPOSE_OUTLOOK_MODE` (`mailtouri|params`), `COMPOSE_OUTLOOK_WORK_BASE`, `COMPOSE_OUTLOOK_PERSONAL_BASE`.
- **Phone user agent or client "Other":** a 200 interstitial whose nonce'd script opens the `mailto:` URL on load, with a button and "Copy your reply" as fallbacks [CMP-REDIRECT-IMPLEMENTATION, CMP-GMAIL-MOBILE].
- **Desktop Gmail/Outlook:** a 302 (`NextResponse.redirect(url, 302)`; the default would be 307).
- **Length check:** if the final URL is over `COMPOSE_URL_LIMIT=1800` characters, show the copy-reply page instead. The check runs per client [CMP-URL-LENGTH-LIMITS].
- **"Edit first":** the form POST returns a 200 page with the compose link as a button, never a 302. A CSP `form-action` would otherwise block the Google or Microsoft sign-in redirect for signed-out owners. CSP `form-action` therefore stays `'self'`.
- **Encoding:** `encodeURIComponent` on `toWellFormed()` strings, plus `!'()*`. Never `URLSearchParams` [CMP-ENCODING-PLUS-SPACE].
- **Recipients** are validated as single bare addresses [CMP-RECIPIENT-SAFETY].
- **Every three-button email** also has an "Open in default mail app" link (`/a/{t}/send?via=mailto`).

### D-14 · BCC logging and the inbox-logging check (Type A, brief change)
- **What gets logged:** BCC logs sends, not replies [HS-BCC-LOGGING]. Replies are logged automatically only with a connected inbox using "Log all emails to/from known contacts". That rule applies to **existing** contacts only [HS-CONNECTED-INBOX, HS-INBOX-LOGGING-CHECK-DESIGN].
- **History:** two `emails/search` counts (outbound vs inbound, last 30 days).
- **Live test, send leg:**
  - Autopilot emails the **owner** a three-button notification for a test lead whose address is the owner's other address.
  - The owner taps "Send from my email" and sends it from their own mailbox.
  - We wait up to 10 min for an `EMAIL` to that address.
  - Before sending, we call `GET contacts/{testEmail}?idProperty=email`. On a 404 with no BCC saved, we ask the owner either to add their BCC address or to submit one of their own forms with the test address.
  - The check row (with `test_address_hmac`) is created as soon as the owner enters the test address, before the contact lookup.
  - Intake **skips** any submission whose email HMAC equals the `test_address_hmac` of a check on that account with `check.created_at − 1 h ≤ submittedAt < check.created_at + 24 h`, and counts it as processed for the cursor. The window is tested against `submittedAt`, not the current time, so the skip never lapses for that submission. This holds on an active account too, where the check can be re-run from the dashboard.
- **Live test, reply leg:** the owner replies from the test address, and we wait up to 10 min for an `INCOMING_EMAIL` from it.
- **Runs in the background:** an `inbox_check` job re-checks every 60 s until each leg resolves or its 10-minute window ends, whatever the account's state.
  - The owner can "Continue — we'll keep checking" or "Skip for now" (`logging_mode=unknown`, with a dashboard reminder). Skip, or a check still without deadlines 24 h after creation, closes the check with its open legs `skipped`.
  - The legs' own check writes only `inbox_checks` and `logging_mode`. It never calls `markReplied`.
- **Test leads** never get follow-up jobs, never supersede and never count in metrics (signals: D-08).
- **Logging mode:** `logging_mode ∈ {unknown, log_all, sends_only, none}`. Follow-up emails carry a plain warning when replies can't be detected, and the Monday report says "Not enough data" (D-37).
- **Fix-step copy** distinguishes "test contact missing" from "not logged". KB-derived claims are re-checked in WIRE_UP check #4.
- **Brief change:** brief §5.7 has one live test; we add the reply leg, because BCC never logs replies.

### D-15 · QStash semantics, durable jobs (Type A, brief change)
- **Every job is a `scheduled_jobs` row,** inserted in the **same transaction** as the state that needs it (an outbox). It is published after commit, and `external_id` is stored.
- **Claiming a job:**
  - `status='running'`, plus `attempt_id` and `lease_until = now + 6 min`.
  - A claim succeeds when `status='scheduled'`, or when `status='running'` with an expired lease.
  - Later updates are conditional on the same `attempt_id`.
- **Responses:**
  - transient error → back to `scheduled` and return 5xx;
  - permanent error → the failure path runs inline, then `failed` and 489 + `Upstash-NonRetryable-Error`;
  - transient error on the final delivery (`Upstash-Retried` = 4) → the failure path runs inline, then `failed` and 200;
  - live lease held by another attempt → 503 with `Retry-After`;
  - done, cancelled, skipped or failed → 200.
- **Re-publishing** (hop, re-target, long wait, sweeper):
  - a compare-and-set to `status='scheduled'`, the new `run_at`, `lease_until=NULL`, `hops+1`;
  - then publish with the fresh dedupe id `{key}:h{hops}`;
  - a `deduplicated:true` response to a re-publish is an error.
- **Sweeper** (poll cron) re-publishes:
  - unpublished rows (`created_at < now − 2 min`);
  - missed rows (`run_at` over 30 min in the past);
  - expired leases;
  - `weekly_report` jobs that `failed` while `weekly_reports.attempts < 3` and before local Tuesday 00:00 (the compare-and-set resets the job's claim count).
  - Any other row whose `scheduled_jobs.attempts ≥ 6` gets the failure path instead of a re-publish.
  - It also resumes `notifications_sent` rows still `sending` 10 min after `reserved_at` (D-45).
- **Failure callback:** `/api/jobs/failed` acts only through a compare-and-set: `UPDATE … SET status='failed' WHERE id=$1 AND external_id=$sourceMessageId AND (status='scheduled' OR (status='running' AND lease_until < $now)) RETURNING`. A job that a live attempt still holds is left alone. Only that winner runs the failure path:
  - Sentry alert;
  - for `lead_process`, the "needs your touch" email;
  - for `followup`, a lead-page note and no email.
- **Scheduling:**
  - Publish with `notBefore` only [QS-DELAY-HEADERS].
  - "Hop" when the target is beyond `QSTASH_MAX_DELAY_SECONDS`, and check for an early hop **before** claiming [QS-DELAY-MAX-PER-PLAN].
- **Cancel:** by message id only; 404 counts as success; never a bulk or filter cancel [QS-CANCEL].
- **Verification:** `Receiver.verify` with `url`, `clockTolerance: 5`, `devMode: false`. Boot fails if `QSTASH_DEV` is set in live mode [QS-RECEIVER-API, QS-DEVMODE-KEY-OVERRIDE].
- **Brief change:** the follow-up dedupe ID `lead:{id}:fu:{n}` (§5.6) becomes `{ENV_NAMESPACE}:lead:{id}:fu:{n}:s{followup_stream}`, re-published as `…:h{hops}`.
  - The stream suffix lets "Resume follow-ups" reschedule.
  - The environment prefix keeps preview and production apart in a shared QStash.
  - The QStash dedupe window is only 10 minutes [QS-DEDUPLICATION], so durable idempotency is the job row.

### D-16 · Periodic triggers (Type A)
- **Auth:** each periodic route accepts either a Vercel Cron GET with `Authorization: Bearer ${CRON_SECRET}` (constant-time compare) or a signed QStash schedule POST [VC-CRON-SECRET-UA, QS-SCHEDULES-ALTERNATIVE].
- **WIRE_UP default:** Vercel **Pro** with `vercel.json` crons. Hobby limits are unverified [VC-CRON-PLAN-LIMITS]; `scripts/qstash-schedules.ts` is the alternative.
- **Leases and cursors:**
  - the poll cron takes a global lease (TTL 6 min, longer than `maxDuration`);
  - `pollPortal` takes a per-account lease;
  - cursors move only forward (`GREATEST`).

### D-17 · Monday report: due-check, window, who gets one (Type A + B, brief change)
- **Due-check:** local time ≥ Monday 08:00 of the current ISO week, before Tuesday 00:00 local, and no `weekly_reports` row for that week [VC-CRON-MONDAY-DUE].
  - The timezone used is stored on the row.
  - Failed reports are re-enqueued by the sweeper (D-15), never by the due-check.
- **Period:** `[Mon 08:00 local minus 1 week (Luxon, in the portal zone), Mon 08:00 local)`, half-open.
- **Two kinds of metric:**
  - **cohort** metrics cover leads submitted in the period;
  - **event** metrics cover replies and follow-ups by their event time in the period.
- **Order:** signals are refreshed first, so job ordering can't change the numbers.
- **Who gets one:** only accounts with onboarding complete and `processing_state = active`. **Brief change:** the core loop says "every Monday"; paused, inactive, revoked and disconnected accounts get none.

### D-18 · Razorpay checkout guard, entitlement, resume (Type A, sign-off, brief change)
- **Guard:**
  - **block** on `authenticated`, `active`, `pending`, `halted`, `paused`;
  - **allow** when there is no subscription, or it is `created`, `expired`, `cancelled`, `completed` or `stale` [RZP-SUB-DECLINED-CREATED-GUARD].
  - **Never block on `created`:** reuse its `short_url` while `expire_by > now` and (`start_at` is null or `start_at > now`).
  - A `created` row that can't be reused is first re-fetched from Razorpay, and a status other than `created` is applied. If Razorpay still says `created` (it documents no expiry at `expire_by`), or the fetch fails, the row is marked `stale` locally (excluded from the one-`created` partial index). Past `expire_by` the customer can no longer authorise it, and the second-live-subscription rule below covers anything unexpected. Only then is a new subscription created, so a declined or abandoned checkout can never lock the owner out.
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
  - "Current subscription" means the row with the latest logical `created_at`.

### D-19 · Razorpay webhooks (Type A)
- **Verification:** HMAC hex over the raw body with the webhook secret, compared timing-safe. An empty secret is refused. `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` is supported during rotation [RZP-WH-SIGNATURE].
- **No timestamp header**, so instead we require `created_at` to be at most 5 min in the future and no more than 16 days old [RZP-WH-REPLAY-TIMESTAMP].
- **Dedupe:** per D-05.
- **Applying changes:**
  - The event is only a trigger: we `GET /v1/subscriptions/{id}` and apply that state, but only if it is newer (`last_synced_at`).
  - Each account's daily job reconciles non-terminal subscriptions.
  - Webhooks for purged accounts hit a content-free tombstone. We fetch the subscription: `authenticated`/`active` → cancel (`cancel_at_cycle_end: false`) and alert the admin to refund; terminal → mark the tombstone resolved. Then 200. The daily cron reconciles unresolved tombstones the same way (D-48). A webhook for an unknown subscription (no row, no tombstone) gets a 200 and an admin warning.

### D-20 · Razorpay hosted checkout, trial, USD, cancel (Type A, brief change)
- **Subscription link:** `POST /v1/subscriptions` with `{plan_id, total_count: 120, quantity: 1, customer_notify: true, expire_by, notes: {autopilot_account_id}}`, then a 303 to `short_url` [RZP-CHECKOUT-HOSTED, RZP-SUB-CREATE-FIELDS].
  - There is no return URL, so the billing page polls our DB.
- **Trial:** if more than 1 day of trial remains, send `start_at = trial_end` and `expire_by = min(now + 7 d, start_at − 60 s)` [RZP-TRIAL-START-AT]. Otherwise omit `start_at` and use `expire_by = now + 7 d`.
- **Cancel:**
  - `authenticated` → `cancel_at_cycle_end: false`, immediately; the trial still runs to its end;
  - `active` → `true`, at the end of the cycle.
  - We call the REST API with `fetch`, not the SDK [RZP-SDK-PACKAGE].
- **USD:** needs International Cards plus refund/cancellation and shipping policy pages [RZP-USD-INTERNATIONAL]. **Brief change:** we add `/refunds` and `/shipping` (`TODO: legal review`) to brief §5.13's `/privacy` and `/terms`.
- **"Fails silently" (brief §10.7):** server-side failures from a mismatched key pair are loud. We keep the same-generation rule plus a `GET /v1/plans/{id}` smoke test [RZP-API-KEYS].

### D-21 · Supabase keys, grants, RLS, Auth settings (Type A, brief change)
- **Keys:** the new `sb_publishable_…` and `sb_secret_…` keys, both server-only. The brief's "service-role key" is now the **secret key**. There are no `NEXT_PUBLIC_SUPABASE_*` variables [SB-KEYS-MODEL].
- **Every table:**
  - `enable row level security`;
  - `revoke all … from anon, authenticated`;
  - `grant select, insert, update, delete … to service_role` [SB-RLS-NOT-DEFAULT, SB-DATA-API-GRANTS-2026].
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
  - `type=email` works for both new and existing users [SB-MAGICLINK-TEMPLATES-NEWUSER, SB-MAGICLINK-FLOW].
- **Login intent:** each link has a server-side `login_intents` row, keyed by `sha256(hashed_token)`, holding `purpose` (`login|onboarding`), `account_id`, `next` and `expires_at` (1 h, the link's validity).
- **Confirming:**
  - `GET /auth/confirm` shows a "Sign in" button.
  - A nonce'd script copies the fragment into a same-origin POST.
  - The POST is rate-limited. It calls `verifyOtp({token_hash, type})`, accepting only `email`, `magiclink` or `signup`.
  - It then reads the login intent and, for `onboarding`, binds the owner (D-35) in the same request.
  - Link scanners can't consume it [SB-EMAIL-PREFETCH].
- **`next` destination:** parsed with `new URL(next, APP_URL)`. It must be same-origin and its pathname must match `^/(dashboard|onboarding|admin)(/|$)`; the query string is kept (e.g. `/dashboard?reconnect=1`). Otherwise `/dashboard`.
- **/login:** always shows the same neutral response, takes ~800 ms whichever branch runs (so timing doesn't reveal whether an account exists), and is rate-limited.
- **Fallback:** Supabase SMTP (Resend) is configured for any email Supabase sends itself [SB-SMTP-RESEND, SB-AUTH-EMAIL-LIMITS].

### D-23 · Sentry v11, restrictive (Type A)
- **Pin:** `@sentry/nextjs@11.2.0`.
- **One shared options module, `src/shared/observability/sentry-options.ts`:**
  - no `server-only` import;
  - all `dataCollection` options false or empty;
  - no tracing;
  - `tracePropagationTargets: []`;
  - the `Anthropic_AI` and `Console` integrations removed;
  - `beforeSend`/`beforeBreadcrumb` scrubbers rewrite request URL, query string and transaction (including `/a/{token}`), and delete request data, cookies and headers [SENTRY-V11-DATA-DEFAULTS, SENTRY-GENAI-ANTHROPIC, SENTRY-HOOKS-STREAMING, SENTRY-URL-QUERY-LEAK, SENTRY-RECOMMENDED-CONFIG].
- **No browser Sentry** on `/a/*` or `/auth/*`.
- **Server actions** are wrapped without `formData` or headers, with `recordResponse: false`.
- **Proof:** a scrubber golden test, plus an envelope test using the real `@sentry/node` and an in-memory transport, with fixtures for a DB error, a Server Action and an AI error [SENTRY-SCRUBBER-TEST].

### D-24 · Anthropic: call pattern, errors, fallbacks (Type A)
- **Call:** `messages.create` with `output_config.format = {type:'json_schema', schema: toClaudeJsonSchema(zod)}`.
  - The project helper keeps `enum` [AI-SO-TS-ENUM, AI-SO-PARSE-SEMANTICS].
  - Enum strings are lowercased before Zod parsing [AI-SO-SCHEMA-LIMITS].
  - Limits the schema can't express (FAQs ≤ 8, word limits) are enforced in code.
  - `flags` is a **closed enum**: `asks_pricing`, `urgent`, `non_english`, `missing_info`, `possible_spam`, `sensitive_topic`, `other`.
- **Per-model parameters** (`buildModelParams`) [AI-MODEL-CAPABILITY-MAP, AI-SONNET55-REQUEST, AI-HAIKU45-REQUEST, AI-REQUEST-RECOMMENDATIONS]:

| Model / purpose | thinking | effort | max_tokens | Notes |
|---|---|---|---|---|
| Sonnet 5.5, drafts | `ANTHROPIC_DRAFT_THINKING` (`between_tools`) | `ANTHROPIC_DRAFT_EFFORT` (`medium`) | `ANTHROPIC_DRAFT_MAX_TOKENS` (1024) | |
| Sonnet 5.5, brief | adaptive | `ANTHROPIC_BRIEF_EFFORT` (`high`) | 16000 | Per call: `{timeout: remainingMs, signal: AbortSignal.timeout(remainingMs)}`. Any delivery after the first (`brief_jobs.attempts`, read before this delivery increments it, is ≥ 1, or a previous attempt aborted) uses `between_tools`/`high`/4096. After the final delivery the job fails and the owner gets the empty editable form |
| Sonnet 5.5, classification (if the fast model is swapped) | `between_tools` | `low` | 256 | |
| Haiku 4.5, classification | omitted | omitted | 256 | |

  - Never sent: sampling parameters, prefill, `tool_choice`.
- **Errors** [AI-SDK-ERRORS-RETRIES]:
  - **TRANSIENT:** `APIConnectionError`/`Timeout`, `APIUserAbortError`, `InternalServerError`, `ConflictError`, and `RateLimitError` with `retry-after`. The job returns 5xx.
  - **FATAL-CONFIG:** 400, 401, 403, 404, 402, 413, and the spend-cap 429. "Needs your touch" goes out at once, plus an admin alert.
- **Output-level failures:**
  - `refusal` → no retry, needs-touch;
  - `max_tokens` → counts as the one retry.
- **Classification never blocks a lead.** Any classification failure becomes `unclear`, which gets a draft.
- **Never silent:** if `lead_process` fails on its final delivery (`Upstash-Retried` = 4, D-11), or the failure callback wins (D-15), the owner gets "needs your touch", built from the minimal safe template, which needs no LLM.
- **Briefs:** `allow_pricing` from the model is ignored; generated briefs always start with `false`. A refused brief opens an empty, editable form.
- **Logging:** SDK `logLevel: 'warn'`. SDK error messages are never logged [AI-SDK-LOGGING-PRIVACY].
- **Server-side fallbacks:** off [AI-SERVER-FALLBACK].

### D-25 · Haiku 4.5 retirement exposure (Type A)
- **Fact:** retirement is not sooner than 2026-10-15, with at least 60 days' notice [AI-MODEL-HAIKU45].
- **Decision:** `ANTHROPIC_MODEL_FAST=claude-sonnet-5-5` works with no code change.
- **Monitoring:** a retired-model 404 alerts the admin. Costs are keyed by `response.model` [AI-PRICING-COST].

### D-26 · Email link scanners (Type A, brief change)
- **Dismiss:** `GET /a/{t}/dismiss` shows a confirmation page; only the POST dismisses [SB-EMAIL-PREFETCH]. **Brief change:** §5.5 has dismiss "mark the lead dismissed" directly.
- **What counts as a click:** not a `HEAD`, not a scanner user agent, and either at least 60 s after the email was sent or a nonce'd beacon from the interstitial or edit page. **Brief change:** §5.5 says `/send` "records the click"; a scanner-like early hit is not recorded.
- **Copy:** "Send link opened (not confirmed)". Clicks are never confirmed sends (law 3).
- **Tracking:** Resend click and open tracking stay off.

---

## B. Choices where the brief is silent (and law readings)

### D-27 · Owner-facing emails: Reply-To and the "not monitored" line
- **Reply-To:**
  - Owner emails about leads (new lead, needs touch, follow-up, reply detected, inbox test) set Reply-To to the **owner's own address**.
  - They never use the lead's address (that would hand the lead our tokens) or our support inbox.
  - `EMAIL_REPLY_TO` is used only for magic-link and billing emails.
- **Templates:** each lead template opens with "This email isn't monitored. To answer the lead, tap 'Send from my email'."

### D-28 · Data access layer
- **Approach:** a thin `Db` interface with SQL repositories.
  - **Live:** Postgres.js on the Supabase transaction pooler (`:6543`, `{max:1, prepare:false, ssl:'require'}`) [SB-DB-ACCESS-LAYER].
  - **Tests and fake mode:** PGlite, running the same SQL.
- **Rules:**
  - (1) queries run one at a time per client, never concurrently;
  - (2) `Db.tx(fn)` passes a `tx` handle; the root handle throws if used while a transaction is open in the same async context (`AsyncLocalStorage`);
  - (3) **no transaction is ever held across network I/O**;
  - (4) concurrency control is single-statement compare-and-set or lease updates only, because PGlite's sequential tests can prove those;
  - (5) every logical timestamp, including the `created_at` columns that drive behaviour (`accounts`, `subscriptions`, `brief_jobs`, `scheduled_jobs`, `login_intents`) and `accounts.last_install_at`, is bound from `Clock` as `$now`.
    - `default now()` is allowed only on audit-only columns (`audit_log.at`, `webhook_events.received_at`), which are on a scan allow-list.
    - Lint bans `Date.now()`, argument-less `new Date()` and `DateTime.now()` outside `SystemClock`.
  - (6) drivers are normalised: `int8 → string`, `bytea` is never used (hex `text`);
  - (7) driver errors are rethrown as `DbError{sqlstate, constraint, table, column}`, never carrying `detail`, query text or parameters.

### D-29 · Extra ports and fake-mode safety
- **Extra ports:** `Clock` and `AuthProvider` join the brief's six ports. `AuthProvider` includes `refreshSession` for the proxy.
- **`APP_MODE`** is required (no default).
  - `fake` is refused when `VERCEL_ENV ∈ {production, preview}` unless `ALLOW_FAKE_ON_VERCEL=1`.
  - Fake mode uses fixed, documented fake secrets, and live mode rejects them.
  - `/dev/*` routes need fake mode.
- **Fake mode is complete without credentials:**
  - `/dev/fake-hubspot/authorize`;
  - `/dev` actions (submit lead, log owner send, log lead reply, revoke token, opt out contact, advance clock, run due jobs);
  - a 10 s dev job ticker;
  - a `fake.dev_outbox` table;
  - fake state and the clock offset persisted in PGlite.
- **The `fake` schema** holds `_migrations` and `dev_outbox`, kept out of `public`. The migration test covers only `public` tables created by `supabase/migrations`.
- **PGlite** lives in a lazy `globalThis` singleton (`serverExternalPackages`) and is never opened at import time or from `proxy`/`instrumentation`.

### D-30 · Extra tables and columns beyond brief §6
- **Extra tables:**
  - `baselines`
  - `inbox_checks`
  - `ai_calls`
  - `rate_limits`
  - `leases`
  - `login_intents`
  - `brief_jobs`
  - `portal_history` (content-free tombstone: portal id + first trial start, so a purge and reinstall can't restart the trial)
  - `billing_tombstones`
- **Columns added to brief tables:** `paused_at` and `processing_state` on `accounts`, cursor and floor on `selected_forms`, lease and hop fields on `scheduled_jobs` and `hubspot_connections`, reservation status on `notifications_sent`, and more. PLAN §5 has the full list.

### D-31 · Law 4: which lead fields count as "form message" (sign-off)
- **Stored in `lead_messages`:** the lead's submitted message, first name, last name, company and email. When a value is missing from the submission, the same-named HubSpot contact property fills it (brief §5.2's fallback). Nothing else.
- **Retention:** `purge_at = submitted_at + 30 d` (test leads: + 24 h).
- **Why:** the compose links need the address and name.
- **After the purge:** the UI shows "Contact #123 (details removed after 30 days)" with a HubSpot link.
- **`leads` keeps only IDs, timestamps and statuses.**
  - `submission_key` = HubSpot `conversionId`, else `HMAC(K_dedupe, formId|submittedAt|lower(email))`.
  - It is nulled when the content is purged.

### D-32 · Lead status shown to the owner (brief change: two extra states)
`deriveLeadStatus(lead, now)` is a pure function; the result is never stored. Precedence:

1. `dismissed`
2. `replied` (`replied_at IS NOT NULL`)
3. `filtered` (filtered class, not overridden)
4. `not processed` (failed / skipped / deferred)
5. `no reply` (labelled "No reply from lead (none logged)"; follow-ups finished or off, and at least 2 days since the last owner email)
6. `send confirmed`
7. `send clicked` (labelled "Send link opened")
8. `drafted`
9. `processing`

- **Brief change:** "not processed" and "processing" extend brief §5.11's list.
- `leads.processing_state ∈ {new, processing, notified, filtered, deferred, failed, skipped}` is the only stored lifecycle field.

### D-33 · Quiet hours and the follow-up schedule
- **Scope:** quiet hours apply to follow-ups only; the first "new lead" email is immediate.
- **Defaults:** 19:00–08:00, skip weekends = on.
- **Constraints:**
  - hours are 0–23;
  - `start = end` means no quiet hours;
  - settings with no allowed hour in a week are rejected.
- **Targets:** `shiftToAllowed(T0.plus({days: n}) in portal zone)` moves the time to the next whole allowed hour, searching at most 8 days.
  - A deterministic per-account offset of 0–10 min is added only when the time was shifted.
- **At fire time:** if the current settings forbid "now", the job is re-targeted (D-15).

### D-34 · Honest notes on follow-ups
- **Every follow-up email to the owner states:**
  - when HubSpot hasn't confirmed the first send: "We couldn't confirm in HubSpot that your first reply was sent";
  - when replies aren't logged: "HubSpot isn't logging replies for you, so check your inbox before sending".

### D-35 · Owner binding, reconnect, reinstall
- **Email step:** `/onboarding/email` requires the signed `pending_install` cookie (24 h).
  - It is pre-filled with the installer's email from token introspection.
  - It stores `accounts.pending_owner_email` and `pending_owner_expires_at` (+24 h), creates or reuses the auth user (kept in `pending_owner_auth_user_id`; if the stored id differs from the user for the new email, the previous user is deleted only if no `users` row has that `auth_user_id` and no other account lists it as `pending_owner_auth_user_id`), and sends the magic link with an `onboarding` login intent.
  - If the email already owns another Autopilot account, it says so (one owner per account).
- **Bind:** in the `/auth/confirm` POST, in **any** browser, after `verifyOtp`, as **one statement**:
  - `WITH b AS (UPDATE accounts SET owner_user_id=$u, pending_owner_email=NULL, pending_owner_expires_at=NULL, pending_owner_auth_user_id=NULL WHERE id=$intent.account_id AND owner_user_id IS NULL AND lower(pending_owner_email)=$verifiedEmail AND pending_owner_expires_at > $now RETURNING id) INSERT INTO users (auth_user_id, account_id, email) SELECT $u, b.id, $verifiedEmail FROM b`;
  - on a unique violation nothing is bound, the losing account's `pending_owner_*` fields are cleared, and the page says "This email already owns an Autopilot account".
  - No cookie or nonce is needed. A login-CSRF can't bind a stranger, because the verified email must equal the pending email.
  - `users` has a unique `lower(email)`.
- **OAuth callback branches:**
  - (a) **New portal:** create the account with `last_install_at = now`. The trial comes from `portal_history` if present, else now + 14 d. Issue `pending_install` → `/onboarding/email`.
  - (b) **Existing, never bound** (`owner_user_id IS NULL`, not purged): store the fresh tokens, set the connection active, set `last_install_at = now` (restarting the orphan clock), reset `pending_owner_email` and `pending_owner_expires_at` (keeping `pending_owner_auth_user_id` for the guarded delete), keep the trial, issue a new `pending_install` → `/onboarding/email`.
  - (c) **Existing, owned, with the owner's session:** reactivate. Connection active; clear `purge_after`, `disconnected_at`, `status_reason` and `reconnect_email_sent_at`; then `applyProcessingState` (floors move forward).
  - (d) **Existing, owned, without the owner's session:** change nothing.
    - If the introspected installer email equals the owner's email, show "Sign in to finish reconnecting" and email a magic link (next `/dashboard?reconnect=1`).
    - Otherwise show "This HubSpot account is already connected to Autopilot by another user", and email the owner: "Someone in your HubSpot account tried to connect Autopilot. Nothing changed. If this was you, sign in and tap Reconnect."
- **Install permission:** installing needs a Super Admin or "App Marketplace Access". This is stated under the Install button and on the install-failed page.

### D-36 · Rate limits and per-account caps
- **Rate limits:** Postgres fixed-window counters keyed by HMAC(IP/route).
  - `/a/*`: 30/min per IP, 20/min per token.
  - `/login` and `/onboarding/email`: 5/15 min per IP, 3/15 min per email, at most 3 distinct emails per pending install.
  - `POST /auth/confirm`: 10/15 min per IP.
  - `/api/hubspot/install`: 20/min per IP.
  - Brief generation: 5 per account per day, 1 at a time.
- **Per-account caps:**
  - `MAX_DRAFTED_LEADS_PER_DAY=50`, counted **after** classification, so spam is still filtered. Overflow leads become `deferred` with no draft call. One "lead limit reached" email per day links to the dashboard.
  - Global `AI_DAILY_BUDGET_USD` (default 25): a breaker that stops drafting and alerts the admin, bounding classification floods too. While it is tripped, leads get the needs-touch email with the minimal safe template, so nothing is silent.
- **HubSpot per-portal limiter:** ≤ 9 req/s general and ≤ 4 req/s search, stored in Postgres [HS-RATE-LIMITS].
- **Resend:** `rate_limit_exceeded`, `concurrent_idempotent_requests`, `application_error`, `internal_server_error`, any status ≥ 500 and a null status (network) are transient. `daily_quota_exceeded` and `monthly_quota_exceeded` are transient too, with one admin alert. Everything else (`validation_error`, key or domain errors) is permanent. Report publishes are staggered.

### D-37 · Monday report wording and honesty
- **Wording rule:** an unqualified "reply"/"replied" always means **the lead's** reply: lead statuses, "Replies from leads", "{Name} replied — follow-ups stopped". Anything the owner sends is always qualified with "you", "your" or "from you": "your reply is ready" (brief subject), "your first reply", "Copy your reply", "% with no logged reply from you".
- **Labels:**
  - "Leads in"
  - "Filtered (spam etc.)"
  - "Drafts emailed to you"
  - "Your sends confirmed in HubSpot"
  - "Send link opened, not confirmed"
  - "Median time to your first reply (logged in HubSpot)" (n ≥ 3, else "Not enough data")
  - "Leads still waiting for your reply (nothing logged in HubSpot)", with record links (first 20 + "and N more")
  - "Replies from leads"
  - "Follow-ups drafted"
  - "Compared with your baseline"
- **Comparison population:** non-test cohort leads whose effective class is `lead`/`unclear` (or overridden) and that are not dismissed. "% with no logged reply from you" = those with no `send_confirmed_at` before the period end, divided by that population.
- **Honesty rules:** a count over 0 is always shown. A 0 becomes "Not enough data" when:
  - (replies) `logging_mode ≠ log_all`, or the email scope is missing;
  - (sends) `logging_mode ∈ {none, unknown}`, or the email scope is missing.
- **When sends aren't logged,** the waiting list is replaced by "We can't confirm your sends in HubSpot for your account".
- **Medians:** for an even n, the median is the mean of the two middle values.

### D-38 · Baseline population and sufficiency
- **Population:** the baseline uses the **same population** as the weekly comparison. The 30 days of historical submissions are classified with the fast model **in memory**: nothing is stored, at most 500 submissions (above that, "Not enough data"). Only `lead`/`unclear` count.
- **Figures:** lead count; median time to the first logged email **to** the lead (n ≥ 3); and the number of leads with none, with that as a % of the lead count (only if the portal has any logged `EMAIL` in 30 days, and the email scope is granted).
- **Otherwise** show "Not enough logged history".

### D-39 · Simulation calendar
- **Owner settings:** portal timezone `America/New_York`; quiet hours 19:00–08:00; **weekends allowed**; 1 notify email; Gmail; BCC on. Day 5 therefore runs the brief's literal "job fires → reply detected" path. Weekend shifting is covered by unit tests.
- **Calendar:**
  - Pre-run: owner foreground steps Tue 2026-10-06 09:00–09:04:30 (≤ 5 min, brief §4.2), background finishing by 09:06.
  - Day 0: Tue 10:00.
  - Day 2: Thu.
  - Day 3: Fri, the lead replies.
  - Day 5: Sun.
  - Monday 2026-10-12 08:00: the report.
  - Wednesday 10-14 12:00: final statuses.
- **Time:** time travel steps through every job and cron tick in order, with events before ticks at the same instant. The run is repeated with the system clock set to 2030.

### D-40 · HubSpot client
- **Approach:** plain `fetch` + Zod over about 14 endpoints, with the D-03 request allow-list and the D-36 limiter.
- **Why:** `@hubspot/api-client` uses legacy paths, and `@hubspot/sdk` is alpha [HS-SDK-CHOICE].

### D-41 · Tooling
- **Runtime:** Node `>=22.12`.
- **Language:** TypeScript 5.9 (TypeScript 7 isn't supported by `typescript-eslint`).
- **Lint:** ESLint 9 flat config (`eslint-config-next@16`, `typescript-eslint`, boundary rules with `allowTypeImports`).
- **Libraries:** Vitest 4.1, Tailwind 4, Zod 4, Luxon, `react-email` 6.
- **Explicit dev dependencies:** `@sentry/node`, `@sentry/core`, `jose`.
- **`server-only` under Vitest and tsx:** aliased to an empty stub.
- **Every milestone gate** runs `APP_MODE=fake next build` plus a smoke `next start`.

### D-42 · Pause, override, resume follow-ups
- **Pause all** sets `accounts.paused_at` (the owner's intent); Resume clears it.
  - `processing_state` is always **derived** by `applyProcessingState` (D-48). A pause therefore survives revoke, reconnect and billing changes.
  - While paused, the poller skips the account. On resume, intake floors move to now, so leads that arrived while paused are not drafted. The dashboard says so.
  - This is not a Razorpay pause.
- **"This is a real lead":** `process_rev + 1`, then the job is re-enqueued with dedupe `…:process:r{rev}`.
- **"Resume follow-ups"** (e.g. after an out-of-office auto-reply), in one transaction:
  - record the old `replied_at` in `audit_log` (timestamp only);
  - `replied_at = NULL`;
  - `stop_reason = NULL` if it was `replied`;
  - `replies_ignored_before = now`;
  - `followup_stream + 1`;
  - reschedule only the follow-ups not yet sent, at `shiftToAllowed(max(T0 + n days, now + 1 h))`.
  - A later real reply is recorded normally (D-08) and stops follow-ups.

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

### D-45 · Action tokens (brief §5.5 kept)
- **Format:** `apt_` + base64url(**32 random bytes**) (brief §5.5). Only `sha256(token)` is stored, with its purpose, lead and draft, expiring after 7 days.
- **Committed before send:** tokens are minted when the notification is reserved, and their hashes are **committed before** `Mailer.send`.
  - A retry after a crash re-mints tokens. If Resend then answers 409 `invalid_idempotent_request` for our reserved key, the email already went out with the first, committed tokens, so we mark it sent.
- **Reuse:** send and edit tokens are reusable until expiry and counted. A dismiss token is single-use.
- **Takeover and resume:** a reservation still `sending` can be taken over by the paired kind (new_lead↔needs_touch, follow_up↔needs_touch share a key) through a compare-and-set on its kind; only `sent` blocks. The takeover re-checks the new kind's predicates (PLAN §8.4). The sweeper resumes `sending` reservations at doubling intervals (10 min up to 2 h) until 23 h after the first reservation (inside Resend's 24 h idempotency window); job deliveries don't count against this. Older rows become `failed` with an admin alert. A send error that D-36 classifies as permanent marks the row `failed` at once, with one alert. `reconnect` and `billing_inactive` re-check that the connection is still revoked, or the account still inactive, before a resumed send. `magic_link` rows can't be re-rendered (the hashed token isn't stored) and are marked `failed`; the owner asks for a new link.
- **Revocation:** tokens are revoked on revoke, disconnect and privacy deletion. Token checks also reject accounts that are disconnected or pending purge.

### D-46 · Notification addresses and BCC changes
- **Verification:** every notify address other than the owner's verified login email gets a confirmation link (`verify_notify` token, 7 days). It receives nothing until confirmed.
- **Change alerts:** changes to the notify addresses or the BCC address **after onboarding is complete** trigger an alert email to the owner's address. The first save during onboarding never does.
- **BCC check:** the BCC address is soft-checked against `@bcc.*hubspot.com` and `@forward.*hubspot.com`, and is shown on the send, copy and edit pages.

### D-47 · Defending against lead-controlled text
- **The subject's first name is sanitised:**
  - no control characters or newlines;
  - at most 40 characters;
  - if it contains a URL, `@` or mostly digits, the subject falls back to "New lead — your reply is ready".
- **Display:** the lead's message is shown under "Message from the lead (unverified)", with URLs defanged. This applies in emails, the edit page and the dashboard.
- **Extra validator codes:**
  - `url_not_allowed`: any URL or domain other than the booking link and the brief's site host;
  - `contact_not_allowed`: email addresses or phone numbers not in the brief;
  - `addresses_owner`: "note to owner/assistant/AI", "ignore previous", and similar;
  - `echoes_lead`: 12 or more consecutive words copied from the lead.
- **Brief builder (brief §5.3 plus hardening):**
  - homepage plus up to 8 same-site internal links, ranked by keywords in the path or link text (services|pricing|about|contact|faq);
  - `robots.txt` honoured;
  - a 10 s timeout per page, inside a 60 s total budget, with at most 4 fetches at once;
  - stripped before extraction: `nav`, `header`, `footer`, `script`, `style`, `noscript`, `svg`, `iframe`, and hidden DOM (`display:none`, `hidden`, `aria-hidden`, `template`, comments);
  - `booking_link` must be https and appear in the fetched pages, and the editor shows its host and asks the owner to confirm it.

### D-48 · Account lifecycle and purge (brief change: orphan uninstall)
- **One function:** `applyProcessingState(accountId, $now)` recomputes `processing_state` from `(account incl. paused_at and onboarding_completed_at, connection, current subscription)`, in this order: disconnected, revoked, onboarding, paused, inactive, active.
  - Every writer calls it: actions, the OAuth callback, the token manager, disconnect, billing, onboarding completion and the poll cron.
  - The new state is applied by compare-and-set **in one transaction with all of the transition's database side effects** (no network I/O inside, D-28). One-shot emails are reserved (`sending`) in that transaction and sent after commit; QStash cancels also run after commit. Only the caller that wins acts:
    - → active: floors move to now, and purge fields are cleared;
    - → inactive (from any state): one billing email, keyed `billing-inactive:{acct}:{entitlement_lost_at}`. `accounts.entitlement_lost_at` is set the first time `applyProcessingState` finds the account not entitled (in any state, paused included) and cleared when it is entitled again, so pause → trial ends → resume, or `pending` → `halted`, still send it once per non-entitled period;
    - → revoked or disconnected: `purge_after = now + 30 d`; jobs cancelled; action tokens revoked.
- **Onboarding complete** requires all of:
  - an owner-saved brief (`brief_versions.source='owner'`, `booking_link_choice ≠ unset`);
  - at least one selected form;
  - saved preferences with at least one notify address.
  - The inbox check and baseline may finish in the background.
- **Orphan installs:** an install with no bound owner, `last_install_at` more than 7 days ago and no unexpired pending owner gets the uninstall API call, the token wipe, the connection set `disconnected`, and an immediate purge that deletes the pending auth user only if no `users` row has that `auth_user_id` and no other account lists it as `pending_owner_auth_user_id`. A branch-(b) reinstall restarts the clock. HubSpot emails the portal's admins about the uninstall.
- **Purge:**
  - the guard re-checks that no connection is active;
  - it cancels a live `authenticated`/`active` subscription first (`cancel_at_cycle_end: false`);
  - `paused`, `pending` and `halted` can't be cancelled through the API: the purge still runs at 30 days (brief §5.14), and the admin is alerted to cancel the subscription in the Razorpay dashboard;
  - the Disconnect dialog explains those states;
  - after the purge, tombstones (`billing_tombstones` keeps every subscription's id, last status and `expire_by`; terminal ones are resolved at once) keep late webhooks harmless. The webhook route and a daily reconcile in the daily cron (which needs no account; 50 rows a run, least recently checked first) fetch unresolved tombstoned subscriptions: `authenticated`/`active` → cancelled at once and the admin alerted to refund any charge; terminal, or `created` past `expire_by` → resolved; `pending`/`halted`/`paused` stay open and are re-checked in rotation.

### D-49 · Where content can live, and for how long (sign-off for the Law 4 reading)
- **Retention runs hourly as well as daily,** so content never outlives 30 d + 1 h.
- **Stores and retention:**
  - `lead_messages`: 30 d
  - `drafts` (subject, body and flags): 30 d
  - test-lead content: 24 h
  - `inbox_checks.test_address`: 24 h
  - `fake.dev_outbox`: fake mode only
  - Resend and Anthropic: per their policies; WIRE_UP check #10; ≤ 30 days chosen where configurable, or a deviation recorded here
  - Supabase backups/PITR: the backup window, disclosed
  - QStash payloads: ids only
  - Sentry/logs: scrubbed
  - Vercel request logs: may contain action-token paths; no log drains, shortest retention
  - the owner's mailbox: owner-controlled
- **Law 4 reading (sign-off):** "never log tokens" applies to the logs and error reports we write (logger, Sentry), which never contain tokens. Vercel's platform request logs record request paths, so they include the action token in `/a/{token}/…` links. We add no log drains and keep the shortest retention; tokens expire after 7 days and are revoked on disconnect.
- **/privacy** gives day counts only for stores we control. Sub-processors are named and their policies linked.
- **Pages showing personal data** send `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`.

### D-50 · Milestones regrouped (brief §9 order kept; brief change)
- **M1:** placeholder `/` and `/login` pages and `GET /api/health`, so the build-and-smoke gate passes.
- **M2:** `entitled()`, `applyProcessingState`, `renderEmail` and the reconnect template; the `privacy_delete` handler (its webhook arrives in M2). FakeLLM's parameter assertion. A simulation seed helper that creates an active account (M3 replaces it with the real onboarding).
- **M3:** action tokens, `/a/{t}/send|copy|verify-notify`, the compose builders, and the magic-link, inbox-test and verify-notify templates, which login, preferences and the inbox check need.
- **M4:** `shiftToAllowed`, follow-up scheduling and `deriveLeadStatus`.
- **M5:** follow-up jobs.
- **Simulation:** grows a stage per milestone, and CI runs it from M1.

### D-51 · Keys and rotation
- **Ciphertext format:** `v1.<kid>.<iv>.<ct>.<tag>`, where kid = the first 8 hex characters of sha256(key). The AAD binds each ciphertext to its connection and field.
- **Rotation:**
  - a daily job re-encrypts rows that don't use the current kid;
  - `TOKEN_ENCRYPTION_KEY_PREVIOUS` is used for decryption only;
  - `HUBSPOT_CLIENT_SECRET_PREVIOUS` is used for webhook verification only.
- **Per-purpose keys:** derived with HKDF-SHA256(`APP_SECRET`, empty salt, info `hublytix-autopilot/v1/<purpose>`) for `state`, `pending`, `ratelimit`, `dedupe` and `fake-session`. The versioned info lets a future key schedule move to `/v2/`. There is no `action` key: action tokens are random and stored as plain sha256 hashes (D-45).
- **`env.ts` asserts:**
  - each key decodes to 32 bytes;
  - current ≠ previous;
  - no fake or default values in live mode.

### D-52 · REVIEW verdicts: PASS / PARTIAL / FAIL (brief change)
- **Decision:** REVIEW reports each Definition-of-Done line as PASS, PARTIAL or FAIL. PARTIAL means the line rests on evidence that is only community- or knowledge-base-level, and it names the PLAN §17 live check that will settle it.
- **Why:** brief §0.1 asks for "pass/fail per line", but some facts can only be confirmed against live accounts, which this sandbox has none of (brief §0.3). Reporting them as PASS would overstate (law 3).

### D-53 · M1 review fixes: build choices and recorded discrepancies
- **Discrepancies settled:**
  - PLAN §5 said draft `flags` are nulled at purge, PLAN §9.10 step 2 and the schema empty them (`flags='{}'`, NOT NULL). §9.10 wins; PLAN §5 and D-06 now say "emptied", and the M2 checklist carries it for the `privacy_delete` handler.
  - The M1 build had an `action` HKDF purpose that D-51 does not list; it was removed (action tokens are unkeyed sha256 hashes, D-45). The HKDF info gained an app and version prefix (D-51).
  - `vercel.json` (PLAN §3, §8.1) lands in M1 with the three cron schedules; the routes arrive in M2, M6 and M7.
- **Boundaries:** the PLAN §3 rules are enforced twice: the regex `no-restricted-imports` rules on the raw specifier, and a local rule (`autopilot/import-boundaries`, in `eslint.config.mjs`) that resolves `@/`, `./`, `../` and inner `..` to a repo path, checks `import()`, `require()` and re-exports, and refuses non-canonical specifiers. `import type` stays allowed everywhere. `src/proxy.ts` may import only `next/server`, the CSP builder, the AuthProvider adapters and `shared/`. Disabling a guard inline is refused by a test.
- **Time (D-28):** lint also bans `Date` as a bare value, `performance.now()`/`timeOrigin` and the Luxon calls that fill in "now". Every container points Luxon's `Settings.now` at its Clock; Vitest pins it to a fixed year-2000 instant (`test/setup/luxon-clock.ts`), so an implicit "now" never depends on the day the suite runs. The SQL scan also flags `'today'`/`'tomorrow'`/`'yesterday'` and one-argument `age()`, and covers `scripts/`.
- **Fake mode clock:** dev runs on `DevClock`: the wall clock plus an offset persisted in `fake.state` (`clock_offset_ms`), so a restart keeps the simulated time. Persisting the fake portal and billing snapshots arrives with OAuth token storage in M2.
- **Fake mode reachable by others** (a Vercel production/preview deployment, or an `APP_URL` that is not loopback): `APP_SECRET` and `TOKEN_ENCRYPTION_KEY` must be set to real, non-fake values, because the fake ones are public and the fake session cookie key derives from `APP_SECRET`. The `/dev` routes must then also sit behind Vercel deployment protection.
- **Live-mode refusals added:** the public QStash dev token, `QSTASH_REGION` and any region-prefixed QStash variable (the SDK would pick unvalidated keys per request), `SENTRY_SPOTLIGHT` and `SENTRY_DEBUG`.
- **PGlite shim:** a fresh database starts like a pre-2026 Supabase project, with the legacy default grants to `anon`, `authenticated` and `service_role` in `public` (SB-DATA-API-GRANTS-2026), applied only while the migration ledger is empty. The migration test therefore proves the migration's revokes do the work, with mutation tests showing each kind of revoke is needed.
- **Settings constraints:** `notify_emails` holds 1–3 addresses once `preferences_saved_at` is set (empty only before), and `notify_emails_verified ⊆ notify_emails` (D-46).
- **Sentry:** exception values and breadcrumb messages survive only as snake_case error codes that `redact()` leaves unchanged; `server_name` is dropped; `spotlight`, `debug`, `includeServerName` and `enhanceFetchErrorMessages` are pinned off; the session and Spotlight integrations are removed (session envelopes bypass `beforeSend`).
- **Crypto:** `encrypt`/`decrypt` refuse an AAD that is not `<table>:<row id>:<column>` (`crypto_bad_aad`); a fixed IV source exists only in `createTokenCipherForTest`, refused outside `NODE_ENV=test`. Signed cookies are compared as canonical base64url text.
- **Fakes match vendor rules more closely:** FakeMailer answers an overlapping send with the same key with Resend's transient 409 `concurrent_idempotent_requests`; FakeScheduler reads `Retry-After`/`X-RateLimit-Reset*` as seconds, an RFC 1123 date (relative to the Clock) or a duration, capped at one day (QS-RETRIES-SUCCESS); every `HubSpotClient` network method takes an optional `AbortSignal` (an aborted call is `TransientError('hubspot_timeout')`).
- **Bundle check:** `npm run check:bundle` also scans the prerendered HTML/RSC payloads under `.next/server` and the secret values in the `.env*` files `next build` reads.
- **Simulation:** `summary.json` names leads by stable refs (`L1`…), never by `leads.id`, and the outbox files follow, so repeated runs are identical.

### D-54 · M2 build choices (HubSpot OAuth, connections, intake, jobs, classification) and recorded discrepancies
Choices made where PLAN and the earlier decisions are silent (Type B). Each names the module it lives in.

- **Processing state (`services/accounts`):**
  - → `active` moves `intake_floor_at` to `$now` and `cursor_submitted_at` to `greatest(cursor, $now)` for every `selected_forms` row; → `disconnected` also sets `accounts.disconnected_at` (coalesce); every → `revoked`/`disconnected` sets `purge_after = $now + 30 d`, so revoked → disconnected restarts the 30 days, as PLAN §6.1 literally says.
  - A missing connection row counts as `disconnected`. A tie on the current subscription's `created_at` goes to the larger id.
  - Account emails (reconnect, billing_inactive, owner_alert) go to the bound owner's login email (`users.email`); an account without a bound owner gets none. Reply-To only on billing_inactive (D-27). The reconnect subject is "Reconnect HubSpot to keep Autopilot running"; its body states the purge date in the account timezone and the button starts the install again. Owner alert for a reconnect attempt: key `alert:{acct}:reconnect_attempt:{local date}` (at most one a day).
- **Token manager (`services/hubspot`):**
  - A lease loser that sees the lease released without a new `token_version` throws `TransientError('hubspot_refresh_failed_elsewhere')` (no second HTTP call); after 10 s `hubspot_refresh_lease_wait_timeout`. A refresh whose compare-and-set loses to a reconnect keeps the stored tokens and returns its own still-valid access token; a revoked refresh whose revoke compare-and-set finds newer active tokens throws `hubspot_refresh_superseded`.
  - Config refresh failures alert once per episode per connection (`status_reason='oauth_config'`, cleared by a success). Revocations set `status_reason` `refresh_revoked` / `introspection_inactive`. Inline callers inside `next_refresh_attempt_at` get `TransientError('hubspot_refresh_backoff')` without a HubSpot call; the alert fires at exactly the 5th consecutive inline failure.
  - Per-portal limiter (D-36): one-second fixed windows in Postgres (`rate_limits`, HMAC key), over the limit → wait for the next window, at most 30 waits, then `hubspot_portal_rate_limited`. `listForms` counts as one slot although it follows pages. It wraps the client on the services side (`forAccount`), because the port methods carry no portal id.
- **HubSpot client (`adapters/live/hubspot`, `hubspot/`):** the request allow-list is stricter than D-03's wording (GET forms is the list path only; contacts and emails are the only object types; POST/DELETE refuse a query string; id segments stay one segment). `exchangeCode`: `BAD_AUTH_CODE` or a revoked-class body → `PermanentError('hubspot_bad_auth_code')`, config-class → `ConfigError`. `introspect`/`revoke`: a revoked-class 4xx means inactive / already revoked. `refresh`: an unreadable 2xx or a 3xx is `TransientError('hubspot_invalid_response')`. 429 or 423 without `Retry-After` carries no `retryAfterMs`. The forms list tolerates undocumented shapes, drops captured/archived/blog forms, and refuses a repeated cursor or more than 50 pages. `hubspot-app/` placeholders use `autopilot.example.com` (replaced at WIRE_UP); only the production redirect URL is listed; `maxConcurrentRequests` 10.
- **Install (`services/install`, `http/hubspot-*`):** `/api/hubspot/install` answers 302 to the consent URL and sets `ap_hs_state` (Path `/api/hubspot/oauth/callback`, 10 min; a 32-byte nonce that is also HubSpot's `state`). `ap_pending_install` is Path `/`, 24 h. Both are `Secure` except on a plain-http loopback `APP_URL`. Install rate limit: 20/min per client IP (`x-real-ip`, else the first `x-forwarded-for` hop; only its HMAC is stored), 429 with `Retry-After`. The callback answers 303 with `no-store` and `no-referrer`; failures go to `/install/failed?reason=state|denied|bad_code|missing_scopes|config|unavailable` (`config` raises `hubspot_install_oauth_config`). Granted scopes = the token response's `scopes`, else introspection's; any missing `REQUIRED_SCOPE` fails the install; introspection `active:false` → `unavailable`. Branches (b) and (c) bump `token_version`, clear `status_reason`, the lease and the inline failure counters; only (c) clears `reconnect_email_sent_at`. The HubSpot timezone is refreshed on reinstall unless `timezone_source='owner'`; a non-IANA zone is stored as Luxon's fixed-offset name. A new-portal insert that loses the unique race retries once as an existing portal.
- **Jobs and notifications (`jobs/`, `services/notifications`):**
  - `scheduled_jobs.dedupe_key` and `notifications_sent.dedupe_key` store the key **without** the `ENV_NAMESPACE` prefix; only the QStash dedupe id and the Resend idempotency key carry it (the init migration's column comment was corrected to say so; a comment-only edit, nothing has been deployed).
  - Live-lease 503: `Retry-After = min(remaining lease + 1 s, 60 s)`. D-11 long waits (`Retry-After` > 60 s) are re-targeted centrally by the dispatcher while attempts < 6. Inline failure path order follows PLAN §8.3 step 4; a throwing failure path is alerted (`job_failure_path_error`) and the job is still marked failed. A stale copy of an earlier QStash message that arrives before the target answers 200 without hopping again.
  - `reserveInTx` takes `now` and optional predicates. The weekly-report sweeper rule joins `weekly_reports` through `report:{acct}:{week_start}` and also requires `weekly_reports.status <> 'sent'` (M6 must keep the key).
  - QStash cancel uses the SDK's single-id `messages.delete(id)`; SDK network retries are off (an unpublished row is the sweeper's to retry). Resend classification (D-36): named transient codes, then any 5xx → transient; known permanent names → permanent even with a null status; an unknown name with a null status → transient; anything else → `PermanentError('resend_unknown_error')`.
  - `jobs/handlers.ts` is the one wiring point: M2 registers `portal_poll`, `privacy_delete` (intake), `lead_process` + its failure path, and the `reconnect`/`billing_inactive`/`owner_alert` resumers.
- **Intake (`services/intake`, `services/privacy`):**
  - A contact 404 within 60 min of `submittedAt` is retried by later polls without moving the cursor; after that one `audit_log` row (`intake.contact_not_found`, no content) plus an alert, and it counts as processed. Candidates are submissions newer than `max(intake_floor_at, cursor − 60 min)`; stored `submission_key`s count as processed without a contact lookup. A submission without an email field is skipped. The lead insert is guarded by `processing_state='active'` in the same statement.
  - `portal_poll`: a busy per-account lease, a non-active account or a revoked connection → `skipped`; the job polls with `inline=false` (only the cron counts refresh failures). Debounce: compare-and-set `poll_requested_at` < the start of the current UTC minute; jobs at `$now` (`:a`) and `$now + 90 s` (`:b`).
  - Webhook: a "known portal" is any `accounts` row with that portal id. Other apps' events are dropped before anything is recorded; every other well-formed event is recorded in `webhook_events` with an outcome. Malformed entries are dropped one by one; a body that is not an array of ≤ 100 entries → 200 `webhook_body_ignored`; over 512 KiB → 413; a database failure → 500. `object.creation` counts only with `objectTypeId '0-1'`.
  - `privacy_delete` also sets drafts' `purged_at = coalesce(purged_at, $now)` and empties `flags` (D-53); `stop_reason` is overwritten; the new `submission_key` is 32 random bytes in hex.
  - Poll cron: least recently polled first; the ~240 s budget covers the whole run; portals left when it is spent are counted `deferredByBudget`. Skip rule: the token needs a refresh and `$now < next_refresh_attempt_at`. A selected form HubSpot answers 404 for is logged and skipped. The 20-page cap and the contact-not-found give-up use the error-level `raiseAlert` (PLAN says "Sentry warning"; there is no warning-level alert helper).
- **`lead_process` (M2 part, `services/leads/process.ts`):** skipped (job `skipped`, lead `skipped`) when dismissed, privacy-deleted, the account is not active, the lead is a test lead, or its content is gone; a job older than the lead's `process_rev` is skipped and leaves the lead alone. "Overridden" = `process_rev > 0 or classification_override is not null`: never filtered and re-processed from any state but `notified`. The class is asked once (a redelivery reuses `leads.classification`). The failure path sets `failed` from `new`/`processing`/`failed` (and, for an overridden lead, from `filtered`/`deferred`/`skipped`), never from `notified`, guarded by the job's revision. The dedupe key helper `leadProcessDedupeKey` lives there only; intake imports it.
- **AI (`ai/`, `adapters/live/anthropic-llm.ts`, `services/classification`):** `buildModelParams` covers exactly the D-24 table (Sonnet 5.5; Haiku 4.5 dated id and alias); any other model id is `ConfigError('anthropic_model_not_supported')` → FATAL-CONFIG with no request. A draft retry after `max_tokens` doubles `ANTHROPIC_DRAFT_MAX_TOKENS` (cap 16000). 422 and other 4xx → FATAL-CONFIG; 408 → TRANSIENT; a 429 without `retry-after` → FATAL-CONFIG; `model_context_window_exceeded` → `max_tokens`; any other stop reason → `invalid_output`. Classification output has a closed `reason_code` enum. `toClaudeJsonSchema` refuses unsupported keywords at module load. Lead text is XML-escaped inside `<untrusted_input field="…">` and cut to a budget (message 4000, form name 200, first name 100, company 200 characters). Cache writes are priced at the 5-minute rate. `env.ts` refuses `ANTHROPIC_DRAFT_THINKING=between_tools` with `ANTHROPIC_DRAFT_EFFORT` `xhigh`/`max` at boot (the API answers 400), and live mode refuses `ANTHROPIC_CUSTOM_HEADERS` (the SDK adds it to every request). An unsupported model id is still caught at the first call (FATAL-CONFIG) and by the FakeLLM assertion, not at boot: `env.ts` cannot import the model table without an import cycle.
- **Fake mode (`adapters/fake`, `services/fake-state`, `http/dev`, `container.ts`):** the container wires the FakeScheduler to the job dispatcher through `jobs/bridge.ts`, FakeHubSpot to the real refresh classifier, and FakeLLM to `modelParamsConfig(env)` (the parameter assertion is always on). Fake state keys in `fake.state`: `hubspot_snapshot`, `billing_snapshot` (with `clock_offset_ms`); every method call on a persisted fake marks it changed, writes are debounced 200 ms, serialised, skipped when unchanged, and flushed on close; an unreadable snapshot is ignored with a warning. The consent decision route is `POST /dev/fake-hubspot/authorize/decision` (Approve → 303 `redirect_uri?code&state`, Cancel → `?error=access_denied&state`), refusing any client id or redirect URI but the configured ones; outside fake mode every `/dev` path is a 404. The live adapters (HubSpot, Anthropic, Resend, QStash) are imported only when the live container is built.
- **QStash schedules (`npm run qstash:schedules`):** ids `{ENV_NAMESPACE}-cron-poll|weekly-report|daily`, POST with an empty body to `{APP_URL}/api/cron/*`, the same UTC crons as `vercel.json`; retries 0 for the poll and 3 for the others. A real run needs `APP_MODE=live` and an https non-loopback `APP_URL`; `--dry-run` prints the plan. Production runs only one of Vercel Cron and QStash schedules.
- **Simulation (`scripts/simulation`):** `advanceTo(t)` stops at every external event, FakeScheduler delivery (to `runJob` through the bridge, with QStash's retries and failure callback) and cron tick (poll every 5 min via `GET /api/cron/poll` with the cron secret; the hourly due-check and the 03:17 UTC daily tick are recorded no-ops until M6/M7); at one instant the order is events, then jobs, then ticks, so a webhook's own poll runs before the cron poll of the same minute. The M2 seed installs through `/api/hubspot/install` → the fake consent → the real callback (branch a), then binds the owner, selects the two enquiry forms, saves the D-39 preferences and completes onboarding by direct inserts at the PLAN §13 times (M3 replaces them). Leads are named by their scenario number (`L5` is submission #5, which arrives after #6); #5 is fixture contact 105 (Lena Fischer). M2 stops Day 0 at 10:41.
- **Discrepancies recorded (PLAN wins where it is explicit):**
  - PLAN §3 puts the refresh classifier and the AI params/JSON-schema helper in `domain/`, and names `security/hubspot-signature.test.ts`; they live in `src/server/hubspot/` and `src/server/ai/` because they read env defaults and SDK error classes, which `domain/` may not import. The generic fixed-window counter sits in `services/hubspot/fixed-window.ts` until M3/M7 add their rate limits and move it to `security/`.
  - PLAN §5 makes `ai_calls.cost_micro_usd` NOT NULL; an unknown serving model's cost is stored as 0 plus the admin alert `ai_price_unknown_model`. A later migration may make it nullable so "unknown" is distinguishable from "free".
  - Research TV3 has `sign_off_name` nullable; the port (`BriefDraft`) has a string, so the schema asks for `""` when no name is found.
  - PLAN §9.1 (d) "email a magic link" needs M3's login intents: M2 leaves `sendReconnectMagicLink` as a logged hook and the page does not claim a link was sent.
  - PLAN §9.3 step 1 lists "dismissed or account no longer active → skipped"; M2 also skips privacy-deleted leads, test leads and leads whose content is gone.
