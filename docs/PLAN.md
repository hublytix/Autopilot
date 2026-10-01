# Hublytix Autopilot v1: build plan

Status: **PLAN (revision 2, after a five-lens review), awaiting approval.** Reply `approve` to start EXECUTE at M1.

Inputs:
- `docs/BUILD_BRIEF.md`: the specification.
- `docs/RESEARCH.md`: the verified facts. Finding IDs in [brackets] point there; full evidence is in `docs/research/*.md`.
- `docs/DECISIONS.md`: D-01…D-51, every deviation from the brief and every choice where the brief is silent.

---

## 1. What you are approving

### 1.1 Changes to things the brief states (docs win; evidence in RESEARCH)
| # | Brief | Plan | Decision |
|---|---|---|---|
| 1 | Next.js 14 | **Next.js 16.3.8** (React 19). Middleware becomes `src/proxy.ts`; `src/instrumentation.ts` stays in `src/` | D-01 (sign-off) |
| 2 | "Create the HubSpot public app" | Developer-platform **project** in `hubspot-app/`, platform `2026.09`, uploaded with the HubSpot CLI | D-02 |
| 3 | Scopes `oauth`, `crm.objects.contacts.read`, `forms` | Adds **`sales-email-read`** (read-only). `forms` also permits edits, so "read-only" is enforced by a request allow-list in code | D-03 (sign-off) |
| 4 | `eventId` unique | Composite webhook dedupe key | D-05 |
| 5 | Poller searches `recent_conversion_date` | Poller reads the **Forms submissions API** per selected form; the webhook only triggers polls | D-07 |
| 6 | Checkout blocked only on `active`/`halted` | Blocked on `authenticated`/`active`/`pending`/`halted`/`paused`; **never on `created`**. Adds Resume for `paused` | D-18 |
| 7 | `/privacy`, `/terms` | Also `/refunds` and `/shipping` (Razorpay requires them to accept USD) | D-20 |
| 8 | "Service-role key" | Supabase **secret key**, explicit grants in migrations, public sign-ups off | D-21 |
| 9 | Inbox check = one live test | Two legs (send logged, reply logged), non-blocking, skippable | D-14 |
| 10 | Vercel Cron | Vercel Cron on **Pro**, or QStash schedules; every periodic route accepts both | D-16 |
| 11 | `/a/{token}/send` → 302 | 302 on desktop Gmail/Outlook; on phones and "Other", a page that opens the mail app automatically (still one tap) | D-13 (sign-off) |

### 1.2 Behaviour choices where the brief is silent (what the owner will see)
| Choice | What the owner will see | Decision |
|---|---|---|
| Lead contact fields stored with the message | The lead's name, email and company are kept with the message for 30 days, then purged | D-31 (sign-off) |
| Dismiss needs a confirmation tap | "Not a real lead" opens a page with one confirm button, so link scanners can't dismiss leads | D-26 |
| Quiet hours apply to follow-ups only | New-lead emails arrive immediately, at any hour | D-33 |
| Pause, or billing lapse, skips leads | A lead that arrives while paused, inactive or revoked is never drafted; the dashboard says so | D-42, D-48 |
| A newer lead supersedes an older one | One follow-up stream per contact | D-44 |
| "Reply" always means the lead's reply | The report's "Leads you haven't replied to" is about **your** logged sends; "Replies from leads" is about **theirs** | D-37 |
| Honest "not enough data" | When HubSpot isn't logging replies or sends, the report says so instead of showing 0 | D-37, D-38 |
| Caps | At most 50 drafted leads per day per account (configurable); overflow is listed, not drafted | D-36 |
| Extra notify addresses must confirm | Addresses other than your login email get a confirmation link first | D-46 |
| `captured` (non-HubSpot) forms not offered in v1 | Only HubSpot forms and pop-ups appear in the form list | D-07 |
| Reply-To on lead emails = your own address | Tapping "Reply" by mistake writes to yourself, not to us or the lead | D-27 |
| Milestones regrouped slightly | Same brief order; each milestone ships what it depends on | D-50 |

---

## 2. Stack and pinned versions

| Area | Choice (exact pins in `package.json`) |
|---|---|
| Runtime | Node `>=22.12` (`.nvmrc` 22); Vercel Node 22.x or 24.x |
| Framework | `next@16.3.8`, `react@19.x`, `react-dom@19.x`; App Router, `src/` layout |
| Language | `typescript@5.9.3` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Styling | `tailwindcss@4.3.x` + `@tailwindcss/postcss`; mobile-first |
| Lint | `eslint@9.39.x` flat config + `eslint-config-next@16.3.8` + `typescript-eslint@8.x` (boundary rules and time-API bans) |
| Tests | `vitest@4.1.x`; `@electric-sql/pglite@0.5.8`; `jose`; `@sentry/node` and `@sentry/core` pinned to the versions `@sentry/nextjs@11.2.0` uses |
| Validation | `zod@4.x` |
| Time zones | `luxon@3.7.x` (in fake mode `Settings.now` is driven by `Clock`) |
| DB driver (live) | `postgres@3.4.x` on the Supabase transaction pooler `{max:1, prepare:false, ssl:'require'}` (D-28) |
| Auth | `@supabase/supabase-js@2.117.x` (admin) + `@supabase/ssr@0.12.7` (server-side session cookies only) |
| Jobs | `@upstash/qstash@2.12.0` (Client + Receiver, `devMode:false`) |
| Email | `resend@6.31.x`, `react-email@6.11.0` |
| AI | `@anthropic-ai/sdk@0.131.0` (exact) |
| Billing | Razorpay REST via `fetch` |
| Monitoring | `@sentry/nextjs@11.2.0` (errors only) |
| HTML extraction | `cheerio@1.2.x` |
| Scripts | `tsx` with `tsconfig.scripts.json` |

---

## 3. Repository layout and module boundaries

```
.
├── CLAUDE.md  README.md  .env.example  .gitignore  .nvmrc
├── .github/workflows/ci.yml            # typecheck · lint · test · build+smoke · simulate
├── eslint.config.mjs  next.config.ts  postcss.config.mjs  tsconfig.json  tsconfig.scripts.json
├── vitest.config.ts  vercel.json
├── docs/        BUILD_BRIEF · RESEARCH (+ research/*) · PLAN · ARCHITECTURE · DECISIONS · WIRE_UP
├── hubspot-app/ hsproject.json · src/app/app-hsmeta.json · src/app/webhooks/webhooks-hsmeta.json
├── supabase/    config.toml · migrations/20261001000001_init.sql (+ later timestamped files)
├── scripts/     simulate.ts · qstash-schedules.ts
├── test/        db/harness.ts (+ globalSetup) · stubs/empty.ts · fixtures/{hubspot-signature-v3.json,
│                razorpay/*.body, compose-vectors.json, site/**, hubspot-portal.json}
└── src/
    ├── instrumentation.ts            # register(): runtime-gated Sentry init; onRequestError
    ├── instrumentation-client.ts     # browser Sentry (shared options; disabled on /a/* and /auth/*)
    ├── sentry.server.config.ts  sentry.edge.config.ts
    ├── proxy.ts                      # CSP nonce, strips inbound CSP request headers, session refresh on app paths
    ├── app/                          # thin route files; global-error.tsx
    ├── components/                   # client-safe UI
    ├── emails/                       # React Email templates (presentational)
    ├── shared/                       # client-safe and server-safe: observability/sentry-options.ts (redact, scrubbers), types
    └── server/                       # every module imports 'server-only' (aliased to a stub in Vitest and tsx)
        ├── env.ts                    # Zod env; APP_MODE required; fake-mode refusals; key checks
        ├── container.ts              # Deps factory + lazy globalThis singleton
        ├── ports/                    # interfaces
        ├── adapters/live/  adapters/fake/
        ├── db/                       # Db (Postgres.js | PGlite), tx guard, migrate (+ _migrations ledger),
        │                             #   fake-shim.sql (roles/auth for PGlite), repos/* (OwnerScope-scoped for owner data)
        ├── domain/                   # pure: validator, quiet hours, stops, lead status, processing state, entitlement,
        │                             #   checkout guard, compose, newsletter detect, metrics, refresh classifier,
        │                             #   AI params + JSON-schema helper, signals
        ├── security/                 # crypto (AES-GCM + kid), HKDF keys, action tokens, signatures, same-origin,
        │                             #   rate limit, CSP builder, SSRF guard, cron auth, HubSpot request allow-list
        ├── services/                 # orchestration
        ├── jobs/                     # dispatcher, claim/lease, outbox publisher, sweeper
        ├── http/                     # route handlers (req, deps) → Response; read cookies/headers only from Request
        ├── views/                    # read models for Server Components (take OwnerScope)
        ├── actions/                  # Server Action bodies (each calls requireOwner())
        └── obs/                      # logger (uses shared redact())
```

**Boundary rules.** These are enforced by ESLint `no-restricted-imports` with `allowTypeImports`, plus a test.
- `domain/` is pure: it imports only `domain/`, `zod` and `luxon`. `ports/` contains types only.
- `adapters/*` implement ports and never import `services/`.
- `services/` take a `Deps` object and never import adapters.
- `src/app/**` may import `server/http`, `server/views`, `server/actions`, `server/container`, `shared/` and `components/`. It may import types from anywhere.
- Owner-facing repos take `OwnerScope {accountId, userId}` as a required first argument. Only `requireOwner()` creates one, from a verified session. No repo method that serves owner pages accepts a bare lead or draft id.
- Client components never import `src/server/**`. The build fails otherwise, because of `server-only`.
- There are **no** `NEXT_PUBLIC_*` secrets. The only public variables are `NEXT_PUBLIC_PRODUCT_NAME` and `NEXT_PUBLIC_SENTRY_DSN`.

---

## 4. Ports, fakes and fake mode

`APP_MODE=fake|live` is **required** (D-29). Fake mode runs with zero credentials, using fixed documented fake secrets that live mode rejects. Fake mode is refused on Vercel production/preview unless `ALLOW_FAKE_ON_VERCEL=1`.

| Port | Key methods | Fake |
|---|---|---|
| `Clock` | `now()` | Settable and advanceable; offset persisted in fake mode; drives Luxon and the scheduler |
| `HubSpotClient` | `authorizeUrl`, `exchangeCode`, `refresh`, `introspect`, `revoke`, `accountDetails`, `listForms`, `listSubmissions`, `getContact(idOrEmail,{idProperty,properties,associations})`, `listContactEmailIds`, `batchReadEmails`, `searchEmailsCount`, `uninstallApp` | In-memory portal loaded from `test/fixtures/hubspot-portal.json`: forms, contacts, submissions (newest first, 50 per page, optional visibility delay), more than 100 associations with paging, emails with logging modes (`log_all`/`sends_only`/`none`), refresh modes (`ok`/`revoked`/`transient×N`/`config`/`477`), 404, merge, 403 `MISSING_SCOPES` variant, v3-signed webhook bodies. Consent page `/dev/fake-hubspot/authorize` |
| `LLM` | `classify`, `generateBrief`, `draft`, `draftFollowUp`, each returning `{value, usage, stopReason, model}` or a typed failure | Deterministic keyword classifier; validator-passing templated drafts; fault injection (`invalid`/`refusal`/`max_tokens`/`transient`/`fatal`); asserts `buildModelParams` validity |
| `Mailer` | `send({to, replyTo, subject, html, text, tags, idempotencyKey})` | Persists to `dev_outbox` (dev), memory (tests) or `./outbox` (simulate). Same idempotency semantics as Resend (same key + same payload = original; different payload = 409) |
| `Scheduler` | `publish({jobId, kind, runAt, dedupeId})` → `{messageId}`; `cancel(messageId)` | Ordered queue; `runDue(now)` calls an **injected** dispatch callback; simulates redelivery and crashes |
| `Billing` | `createSubscription`, `fetchSubscription`, `cancelSubscription(id, atCycleEnd)`, `resumeSubscription`, `fetchPlan` | Fake subscriptions; `short_url` → `/dev/fake-checkout/{id}`, which emits signed fake webhooks |
| `WebFetcher` | `fetch(url, {deadline, maxBytes})` | Fixture website (`test/fixtures/site`) including `robots.txt`, hidden DOM and an injection sample |
| `AuthProvider` | `createUser`, `generateLink(email)`, `verify(tokenHash, type)`, `getVerifiedUser(req)`, `signOut` | Links written to the outbox; signed `ap_session` cookie; rejects a wrong `type` for new users, as Supabase does |

**Dev affordances (fake mode only):**
- `/dev` actions: submit a lead, log an owner send, log a lead reply, revoke a token, opt out a contact, advance the clock, run due jobs, view the outbox.
- A dev job ticker runs due fake jobs every 10 s.
- PGlite lives in a lazy `globalThis.__autopilot` singleton, listed in `serverExternalPackages`, and is never opened at import time.

---

## 5. Data model

The first migration is `supabase/migrations/20261001000001_init.sql`. Later milestones add their own timestamped files.

**Rules applied to every table:**
- `enable row level security`, `revoke all … from anon, authenticated`, and `grant select, insert, update, delete … to service_role`. No policies.
- `alter default privileges in schema public revoke execute on functions from public, anon, authenticated` (D-21).
- Statuses are `text` + `check`.
- IDs are `uuid default gen_random_uuid()`, except log tables, which use `bigint generated always as identity` (no sequence grants needed).
- HubSpot IDs are `text`.
- No `bytea`; hashes are stored as hex `text`.
- Every logical timestamp is **bound from `Clock`** (`$now`). `default now()` is allowed only on audit-only `created_at` (D-28).

**Cascades:** account-scoped tables use `on delete cascade` from `accounts`. The exceptions are the tombstones, which are deliberately outside the cascade.

| Table | Columns (key ones) | Content? |
|---|---|---|
| `accounts` | `hubspot_portal_id text unique`, `processing_state (onboarding\|active\|paused\|inactive\|revoked\|disconnected)`, `processing_state_changed_at`, `onboarding_completed_at`, `trial_started_at`, `trial_ends_at`, `timezone`, `timezone_source`, `logging_mode (unknown\|log_all\|sends_only\|none)`, `owner_user_id` (nullable), `pending_owner_email`, `pending_owner_nonce_hash`, `pending_owner_expires_at`, `disconnected_at`, `purge_after`, `checkout_lock_until`, `created_at` | owner email (pending), cleared on bind |
| `users` | `auth_user_id unique`, `account_id unique`, `email`; **unique `lower(email)`** | owner email |
| `settings` | `account_id pk`, `notify_emails text[]` (1–3), `notify_emails_verified text[]`, `mail_client (gmail\|outlook_work\|outlook_personal\|other)`, `gmail_account_email`, `quiet_start_hour`, `quiet_end_hour` (0–23; equal means none), `skip_weekends`, `followups_enabled`, `bcc_address` | owner config |
| `hubspot_connections` | `account_id unique`, `portal_id unique`, `hub_domain`, `ui_domain`, `data_hosting_location`, `account_type`, `scopes text[]`, `access_token_enc`, `refresh_token_enc` (format `v1.kid.iv.ct.tag`), `access_expires_at`, `token_version int`, `refresh_lease_id`, `refresh_lease_until`, `status (active\|revoked\|disconnected)`, `status_changed_at`, `status_reason`, `reconnect_email_sent_at`, `transient_failures`, `last_refresh_at`, `last_webhook_at`, `last_polled_at`, `poll_requested_at`, `journal_offset` | encrypted tokens |
| `portal_history` | `hubspot_portal_id pk`, `first_trial_started_at` (tombstone, outside the cascade) | none |
| `briefs` / `brief_versions` | brief JSON (business info), `source_url`, `booking_link_choice (unset\|link\|none)`, `booking_link_confirmed`, `version`, `source (generated\|owner)` | business info |
| `brief_jobs` | `account_id`, `status (queued\|running\|done\|failed)`, `error_code`, `created_at` (rate limit 5/day) | none |
| `selected_forms` | pk `(account_id, form_id)`, `form_name`, `form_type`, `selected`, `newsletter_detected`, `intake_floor_at not null`, `cursor_submitted_at not null` | none |
| `leads` | `account_id`, `hubspot_contact_id text` (`check (is_test or hubspot_contact_id is not null)`), `form_id`, `submitted_at`, `conversion_id`, `submission_key` (HMAC; nulled at purge), `source (poller\|test)`, `is_test`, `classification`, `classification_override`, `processing_state (new\|processing\|notified\|filtered\|deferred\|failed\|skipped)`, `process_rev`, `followup_stream`, `needs_touch`, `stop_reason`, `replies_ignored_before`. Timeline: `received_at`, `classified_at`, `first_notified_at`, `first_send_clicked_at`, `send_confirmed_at` (HubSpot time), `replied_at` (HubSpot time), `dismissed_at`, `fu1_notified_at`, `fu2_notified_at`, `signals_checked_at`. **Unique** `(account_id, hubspot_contact_id, submitted_at)` and `(account_id, form_id, submission_key)` | none |
| `lead_messages` | `lead_id pk`, `account_id`, `message`, `first_name`, `last_name`, `company`, `email`, `purge_at` (+30 d; test lead +24 h). Inserted only in a CTE chained to the lead insert | **yes** |
| `drafts` | `lead_id`, `kind (initial\|fu1\|fu2)`, `subject`, `body`, `flags` (closed-enum `text[]`), `used_booking_link`, `validation_ok`, `validation_errors` (codes), `attempts`, `needs_touch`, `model`, token totals, `cost_micro_usd`, `purge_at` (= lead `purge_at`), `purged_at`; unique `(lead_id, kind)` | **yes** (subject, body and flags nulled at purge) |
| `action_tokens` | `token_hash text unique` (sha256 hex), `account_id`, `lead_id`, `draft_id`, `notification_key`, `purpose (send\|edit\|dismiss\|verify_notify)`, `expires_at`, `first_used_at`, `use_count`, `revoked_at` | none |
| `scheduled_jobs` | `account_id`, `lead_id`, `kind (portal_poll\|lead_process\|followup\|weekly_report\|baseline\|brief_generate\|privacy_delete\|account_daily)`, `seq`, `dedupe_key unique`, `payload jsonb` (ids only), `run_at`, `status (scheduled\|running\|done\|cancelled\|skipped\|failed)`, `external_id`, `published_at`, `attempts`, `attempt_id`, `lease_until`, `last_error_code`, `cancel_reason`, `finished_at` | none |
| `notifications_sent` | `dedupe_key unique`, `account_id`, `lead_id`, `kind`, `status (sending\|sent\|failed)`, `provider_message_id`, `recipients_count`, `reserved_at`, `sent_at` | none |
| `weekly_reports` | `account_id`, `week_start date`, `timezone`, `period_start`, `period_end`, `metrics jsonb`, `status (pending\|sent\|failed)`, `attempts`; unique `(account_id, week_start)` | none |
| `subscriptions` | `account_id`, `provider_subscription_id unique`, `plan_id`, `status`, `short_url`, `start_at`, `expire_by`, `current_start`, `current_end`, `payment_failed_at`, `grace_until`, `cancel_at_cycle_end`, `last_synced_at`, `created_at`; **partial unique** `(account_id) where status='created'` | none |
| `billing_tombstones` | `provider_subscription_id pk`, `purged_at` | none |
| `webhook_events` | `provider`, `dedupe_key`, `body_sha256`, `portal_id`, `account_id`, `event_type`, `occurred_at`, `received_at`, `outcome`; unique `(provider, dedupe_key)`; partial unique `(provider, body_sha256) where provider='razorpay'` | none |
| `audit_log` | `account_id`, `at`, `actor`, `action`, `level`, `meta jsonb` (allow-listed keys) | none |
| `baselines` | `status (ok\|insufficient\|unavailable)`, counts, `median_seconds_to_first_outbound` | none |
| `inbox_checks` | `test_address` (24 h), `test_address_hmac`, `test_lead_id`, history counts, `send_leg`, `reply_leg`, timestamps, `skipped` | test address (24 h) |
| `ai_calls` | `purpose`, `attempt`, `model`, `request_id`, `stop_reason`, `refusal_category`, token counts, `cost_micro_usd`, `latency_ms`, `outcome` | none |
| `rate_limits` | pk `(key_hash, window_start)`, `count` | none |
| `leases` | `name pk`, `holder`, `expires_at` | none |
| `dev_outbox` | fake mode only (created by the fake shim, not by migrations) | dev only |
| `_migrations` | `version pk` (ledger used by fake-mode/PGlite migrate) | none |

**Indexes:**
- `leads(account_id, received_at desc) where not is_test`
- `leads(account_id, hubspot_contact_id, submitted_at desc)`
- `lead_messages(purge_at)`
- `drafts(purge_at) where purged_at is null`
- `scheduled_jobs(status, run_at)`
- `scheduled_jobs(status, lease_until)`
- `action_tokens(expires_at)`
- `webhook_events(portal_id, received_at desc)`
- `accounts(purge_after) where purge_after is not null`

**Migration test (DoD):**
1. No `public` table has `relrowsecurity = false`.
2. `anon` and `authenticated` have no privileges on tables, sequences or functions.
3. `service_role` has CRUD on every table.
4. A persisted PGlite directory boots twice; the ledger prevents re-applying.
5. A scan finds no `now()`, `current_timestamp` or `clock_timestamp` outside the allow-list.

---

## 6. State machines

### 6.1 Account `processing_state` (D-48)
`computeProcessingState(account, connection, subscription, now)` is a pure function. It checks these conditions in order and returns the first that matches:

1. `disconnected`, if the connection is disconnected;
2. `revoked`, if the connection is revoked;
3. `onboarding`, if onboarding is not complete;
4. `paused`, if the owner paused;
5. `inactive`, if the account is not entitled (D-18);
6. otherwise `active`.

The poll cron evaluates every non-purged account. The new state is applied with a compare-and-set, and only the caller that wins acts:

| Transition | Side effects |
|---|---|
| → `active` | Move every `intake_floor_at` and `cursor_submitted_at` to `$now`; clear `purge_after` and `disconnected_at` |
| `active` → `inactive` | One billing-inactive email, key `billing-inactive/{account}/{changed_at}` |
| → `revoked` / `disconnected` | `purge_after = $now + 30 d`; cancel jobs; revoke action tokens |
| → `paused` | Cancel nothing (follow-ups no-op at send time); resume moves the floors forward |

Only `active` accounts are polled, processed and reported.

### 6.2 Lead lifecycle
```
submission (submittedAt > intake_floor_at, not the test address) ─tx─► lead(new) + lead_messages + job(lead_process)
lead_process: classify (failure → unclear) ─► filtered? ─yes─► FILTERED (owner override → process_rev+1)
                                           └─no─► daily cap reached? → DEFERRED (listed, no LLM)
                                                   draft (+1 retry) → needs_touch? → reserve notification (+stop predicates)
                                                   → send "New lead" → notified (+ follow-up jobs in the same tx)
follow-up n (n=1,2 at T0+2d / T0+5d, shifted): stops → contact + signals → markReplied? → REPLIED (+ email)
                                           else → follow-up draft → reserve (+stops) → send
send link clicked (heuristic) → first_send_clicked_at;  logged EMAIL to lead → send_confirmed_at (HubSpot time)
dismiss POST → dismissed_at, jobs cancelled
```
- Displayed status: `deriveLeadStatus(lead, now)` (D-32).
- Hard stops (`evaluateStops`, table-tested):

| Stop | Source |
|---|---|
| more than 2 follow-ups | brief |
| dismissed | brief |
| replied | brief |
| account not `active` (paused, inactive/expired, revoked, disconnected) | brief |
| follow-ups off | brief |
| contact 404 | brief, D-09 |
| opted out | brief, D-09 |
| bounced / bad address | D-09 |
| superseded (dynamic) | D-44 |
| privacy deletion | D-06 |
| test lead | §9.6 |

- The stops are evaluated twice: at job start, and again inside the **notification-reservation SQL** right before the send (§8.4), so a dismiss, pause or disconnect during drafting is respected.

---

## 7. Routes

### 7.1 Legend
| Mark | Meaning |
|---|---|
| **sig** | Signature verified on the raw body |
| **owner** | `requireOwner()`: verified session + owner `users` row |
| **admin** | Verified session email ∈ `ADMIN_EMAILS` |
| **token** | Hashed action token with the right purpose; not expired or revoked; account not disconnected or pending purge |
| **cron** | Bearer `CRON_SECRET` or a QStash signature |
| **origin** | `assertSameOrigin` (`Origin`, or `Sec-Fetch-Site: same-origin`) on every POST route handler; Server Actions have it built in |

### 7.2 Public
| Route | Notes |
|---|---|
| `/` | One-liner; three steps; "$49/month after a 14-day free trial"; Install button + "needs a Super Admin or App Marketplace Access" |
| `/privacy`, `/terms`, `/refunds`, `/shipping` | `TODO: legal review`. `/privacy` lists sub-processors and each one's retention, and states the HubSpot read-only/email-metadata disclosure (D-03, D-49) |
| `/login` | Server Action → neutral response, ~800 ms latency floor, rate limits; links only for owner/pending-owner/admin emails (D-22) |
| `/auth/confirm` | GET: button + nonce'd script that reads `#th`/`type` from the fragment. POST (origin): `verifyOtp` → stored `next` (allow-listed) |
| `/auth/signout` | POST (origin) |

### 7.3 HubSpot, jobs, cron, billing
| Route | Auth | Behaviour |
|---|---|---|
| `GET /api/hubspot/install` | rate limit | HKDF-signed `state` cookie (10 min) → authorize URL with exactly `REQUIRED_SCOPES` (fake: `/dev/fake-hubspot/authorize`) |
| `GET /api/hubspot/oauth/callback` | state | Exchange the code → check granted scopes → introspect (`hub_domain`, installer email) → account details. **New portal:** create the account (trial from `portal_history` if present, otherwise now + 14 d), connection, `pending_install` cookie → `/onboarding/email`. **Existing portal with the owner's session:** reactivate (D-35). **Existing portal without it:** change nothing; "sign in as the owner" page; alert the owner. Failures: neutral page with the permission note; the code is never logged |
| `POST /api/hubspot/webhooks` | sig (v3, ±5 min, against `HUBSPOT_WEBHOOK_TARGET_URL`; current or previous secret) | Zod (≤100 events) → drop when `appId ≠ HUBSPOT_APP_ID` → insert `webhook_events` (ON CONFLICT DO NOTHING). `contact.privacyDeletion` for **any known portal** → `privacy_delete` job. `object.creation`/`contact.creation` for an active portal, debounced to once a minute via `poll_requested_at` → two `portal_poll` jobs (now, +90 s). Always a quick 200 |
| `POST /api/jobs/run` | sig (QStash) | `{jobId}` → hop check → claim (§8.3) → dispatch → 200 / 5xx / 489 / 503. `maxDuration = 300` |
| `POST /api/jobs/failed` | sig (QStash) | Mark the job failed; for `lead_process` or `followup`, send the "needs your touch" fallback email (D-24) |
| `GET\|POST /api/cron/poll` | cron | `*/5`. Global lease → evaluate `processing_state` for all accounts → per active account with onboarding complete: `pollPortal` (per-account lease, ~240 s total budget) → sweeper (§8.3) → hourly-equivalent retention guard (D-49) |
| `GET\|POST /api/cron/weekly-report` | cron | `0 * * * *`. Due-check (D-17) → insert the report row + job in one transaction (staggered `notBefore`) |
| `GET\|POST /api/cron/daily` | cron | `17 3 * * *`. DB-local steps (retention, prunes) + one `account_daily` job per account: introspect probe, account details/timezone, Razorpay reconcile, re-encrypt old kids, orphan and purge handling, and a signal refresh for leads whose follow-ups are finished or off and that were notified in the last 14 days. Leads with pending follow-ups are checked by their own jobs |
| `POST /api/razorpay/webhook` | sig + `created_at` window | Dedupe → fetch the subscription → apply if newer (D-19); tombstone → 200 |
| `POST /api/billing/checkout` | owner + origin | Checkout lock → guard → reuse `created` or create → 303 `short_url` (D-18, D-20) |
| `POST /api/billing/resume`, `/api/billing/cancel` | owner + origin | D-18, D-20 |
| `GET /api/onboarding/status` | owner | Brief job, baseline job and inbox-check legs (HubSpot checks rate-limited: one per 20 s per account) |
| `GET /api/health` | — | `{ok, mode}` |

### 7.4 Owner action links (no login, mobile-first, `no-store`, `noindex`, no browser Sentry)
| Route | Auth | Behaviour |
|---|---|---|
| `GET /a/[token]/send[?via=mailto]` | token(send) + rate limit | Record the click (heuristic, D-26). Desktop Gmail/Outlook and URL ≤ 1,800 chars → **302**. Phone UA, "Other" or `via=mailto` → **200 interstitial** that opens `mailto:` on load, with a button and "Copy reply" fallback (D-13). Too long → copy page. Content purged → "This draft has expired" |
| `GET /a/[token]/copy` | token(send) | Recipient, subject, body and BCC address, each with a copy button |
| `GET /a/[token]/edit` | token(edit) | Editable subject and body; lead message shown as "unverified" with links defanged |
| `POST /a/[token]/edit` | token(edit) + origin | Validate → record the click → **200** page with "Send from my email" (link), "Open in default mail app" and "Copy reply". The edited text is never stored |
| `GET /a/[token]/dismiss` → `POST` | token(dismiss) (+origin) | Confirmation page → dismiss (single use) |
| `GET /a/[token]/verify-notify` → `POST` | token(verify_notify) | Confirm an extra notify address (D-46) |

### 7.5 App (owner unless marked; `no-store`, `noindex`)
| Route | Content |
|---|---|
| `/onboarding/email` | Needs the `pending_install` cookie; pre-filled with the installer's email; stores the pending owner; sends the magic link (D-35) |
| `/onboarding/bind` (POST) | Atomic bind if the verified email equals `pending_owner_email` and the nonce matches |
| `/onboarding/brief` | URL → `brief_generate` job (poll for status); the owner can continue to forms meanwhile. Brief form with booking-link confirm/none; `allow_pricing` defaults off |
| `/onboarding/forms` | `hubspot` + `flow` forms, newsletter-like forms unticked; ticking sets `intake_floor_at = $now` |
| `/onboarding/preferences` | Mail client (4), notify emails (owner email pre-verified; extras need confirmation), quiet hours, skip weekends, detected timezone, optional BCC |
| `/onboarding/inbox` | One-sentence "why", history counts, two-leg live test, **"Continue, we'll keep checking"** and **"Skip for now"** |
| `/onboarding/baseline` | Baseline job + status; completing this step sets `onboarding_completed_at` and floors → `active` |
| `/dashboard` | Status card: trial days left, active/paused/revoked/inactive, banners (reconnect within 30 days, billing, logging warnings, inbox check pending, caps). Recent leads with one status each; HubSpot record links |
| `/dashboard/leads/[id]` | Timeline; draft until purged; "This is a real lead"; "Resume follow-ups"; signal refresh on view (rate-limited) |
| `/dashboard/brief` | Editor (saves create `brief_versions`) |
| `/dashboard/settings` | Notify emails, mail client, forms, quiet hours/weekends, follow-ups on/off, pause/resume, BCC, disconnect (with a "also cancel billing" choice). Changes to notify or BCC alert the owner |
| `/dashboard/billing` | Status; Subscribe / Update payment method / Resume / Cancel |
| `/admin` | **admin**: portals, processing states, trial/billing, last webhook received, failed jobs, error counts (7 d), refusals, AI cost, re-encryption backlog. No content; views audited; 404 for everyone else |

### 7.6 Dev (fake mode only; 404 otherwise)
| Route | Purpose |
|---|---|
| `/dev` | Dev tools (§4) |
| `/dev/fake-hubspot/authorize` | Fake HubSpot consent page |
| `/dev/fake-checkout/[id]` | Fake Razorpay checkout |

### 7.7 Proxy scope (`src/proxy.ts`)
- **Every HTML response:** nonce CSP, with any inbound CSP request headers stripped first.
- **Session refresh and the login redirect:** only on `/dashboard/*`, `/onboarding/*` (except `/onboarding/email`), `/admin` and `/api/billing/*`.
- **Never redirected:** `/api/hubspot/*`, `/api/razorpay/*`, `/api/jobs/*`, `/api/cron/*`, `/api/health`, `/a/*`.
- **The proxy never touches the database:** it imports only the CSP builder and a stateless cookie verifier.
- **Unit tests:** one per path class.

---

## 8. Jobs, scheduling and idempotency

### 8.1 Periodic triggers (UTC)
| Name | Schedule | Notes |
|---|---|---|
| Poller + state evaluation + sweeper + retention guard | `*/5 * * * *` | `/api/cron/poll` |
| Monday report due-check | `0 * * * *` | `/api/cron/weekly-report` |
| Daily maintenance | `17 3 * * *` | `/api/cron/daily` → per-account `account_daily` jobs |

`vercel.json` declares these for Vercel Pro. `scripts/qstash-schedules.ts` creates the same schedules in QStash (D-16).

### 8.2 Job kinds
| Kind | Created by (in the same transaction as) | Dedupe key (env-prefixed) |
|---|---|---|
| `portal_poll` | webhook (debounced) | `poll:{acct}:{minute}:{a\|b}` |
| `lead_process` | lead insert | `lead:{id}:process:r{process_rev}` |
| `followup` | the "notified" transition | `lead:{id}:fu:{n}:s{followup_stream}` |
| `weekly_report` | report row insert | `report:{acct}:{week_start}` |
| `baseline` | onboarding step | `baseline:{acct}:{date}` |
| `brief_generate` | onboarding/brief editor | `brief:{acct}:{brief_job_id}` |
| `privacy_delete` | webhook | `privacy:{portal}:{contact}:{occurredAt}` |
| `account_daily` | daily cron | `daily:{acct}:{localDate}` |

### 8.3 Outbox, claim, lease, sweeper (D-15)
1. **Insert.** The job row (`status='scheduled'`, `external_id` null) is inserted in the same transaction as the state change that needs it. After commit, `Scheduler.publish` runs and `external_id`/`published_at` are stored.
2. **Hop check first.** If `payload.targetAt − now > 60 s`, re-publish for later and return 200, without claiming. Re-publishing at the maximum delay this way also covers targets beyond `QSTASH_MAX_DELAY_SECONDS`.
3. **Claim.** This is the only lock:
   ```sql
   UPDATE scheduled_jobs
   SET status='running', attempt_id=$a, lease_until=$now+'6 min', attempts=attempts+1
   WHERE id=$1 AND (status='scheduled' OR (status='running' AND lease_until<$now))
   RETURNING *
   ```
4. **Outcomes.** Every write is guarded by `attempt_id=$a`.
   - success → `done`;
   - transient error → `scheduled`, lease cleared, return 5xx (QStash backs off);
   - permanent error → `failed`, return 489;
   - a live lease held by another attempt → 503 + `Retry-After`;
   - already `done`, `cancelled`, `skipped` or `failed` → 200.
5. **Sweeper** (poll cron) re-publishes with dedupe `{key}:r{attempts}` when any of these holds:
   - `scheduled` and `external_id` null for more than 2 min;
   - `scheduled` with `run_at` more than 30 min in the past;
   - `running` with an expired lease;
   - `weekly_reports` that are `pending` or `failed` before local Tuesday 00:00.
6. **Cancel.** Mark the row `cancelled`, then `Scheduler.cancel(external_id)` by id. A 404 counts as success. There is never a bulk cancel.

### 8.4 Notification reservation (exactly-once owner emails)
For every owner email:

1. **Reserve.** An `INSERT INTO notifications_sent (dedupe_key, status='sending') SELECT … WHERE <stop predicates> ON CONFLICT DO NOTHING RETURNING id`. The predicates check, for lead emails:
   - the lead is not dismissed;
   - it has not replied;
   - `stop_reason` is null;
   - it is not superseded;
   - the account is `active`;
   - the connection is `active`;
   - follow-ups are enabled (for follow-ups).
2. **No row returned** → skip, if the predicate failed, or resume if the existing row is `sending` (a retry).
3. **Tokens** are derived deterministically from `dedupe_key` (D-45). The draft is reused (`unique(lead_id, kind)`), so the HTML is byte-identical on a retry.
4. **Send.** `Mailer.send` with `idempotencyKey = dedupe_key`. A Resend 409 `invalid_idempotent_request` on our own reserved key counts as already sent.
5. **Commit.** In one transaction: `status='sent'` + the lead timestamp + (for the first notification) the follow-up job rows.

### 8.5 Follow-up timing (D-33)
- **Target:** `shiftToAllowed(T0.setZone(tz).plus({days: n}))`.
  - T0 is `first_notified_at`.
  - The search is limited to 8 days.
  - A per-account offset of 0–10 min is added only when the time was shifted.
- **At fire time:** if the current settings forbid "now", re-target with a hop.
- **Tests cover:**
  - `America/New_York` (both DST changes)
  - `Asia/Kolkata`
  - `Asia/Kathmandu`
  - `Pacific/Auckland`
  - `Europe/London`
  - wrapping and non-wrapping quiet windows
  - quiet start equal to quiet end
  - skip weekends on and off
  - the Sunday-night case that exceeds 7 days (hop)

---

## 9. Main flows

### 9.1 Install, tokens, reconnect, disconnect
1. **Install.** Covered in §7.3. Callback and reconnect rules are in D-35.
2. **Token manager** (`getAccessToken`, D-11, D-28):
   - If `access_expires_at − 5 min > $now`, use the stored token.
   - Otherwise take a refresh lease with a compare-and-set (`refresh_lease_until`, 20 s). The loser re-reads the row, polling every 250 ms for up to 10 s.
   - The winner makes **one** HTTP call (8 s timeout), with no transaction open.
   - Success: a conditional update that bumps `token_version` and always stores the newest refresh token.
   - `revoked`: a compare-and-set on `status='active' AND token_version=$v` sets `revoked` and wipes tokens. `purge_after = +30 d` is set in the same transaction. The winner sends the reconnect email (key `reconnect/{conn}/{status_changed_at}`).
   - `transient`: release the lease, throw `TransientError`, and let QStash back off.
   - A 401 from an API call triggers one refresh (D-11).
3. **Daily probe** (`account_daily`): introspect the refresh token for every active connection; `active:false` → the revoked path (D-10). The same job refreshes account details and timezone (D-12).
4. **Disconnect** (owner, best effort, D-10):
   - Optionally cancel the Razorpay subscription.
   - Try the uninstall API, then revoke the token.
   - Then **always**: wipe tokens, set state `disconnected` (→ `purge_after`), cancel jobs, revoke action tokens.
5. **Orphans:** an install with no bound owner after 7 days → uninstall, wipe tokens, purge (D-48).

### 9.2 Intake (D-07)
`pollPortal(account)` runs under the per-account lease, for `active` accounts only.
1. For each selected form:
   - Page through submissions (limit 50) until a page has nothing newer than `cursor − 15 min`, or until 20 pages, with a Sentry warning at that cap.
   - Keep only submissions where `submittedAt > intake_floor_at`, and drop any submission from an open inbox check's test address.
2. For each new submission, in ascending order:
   - Resolve the contact with `GET contacts/{email}?idProperty=email&properties=firstname,lastname,company,message,email`. On a 404, retry on later polls for up to 60 min.
   - Fill missing fields from the contact.
   - Insert in **one transaction**: the lead (ON CONFLICT on both keys) → `lead_messages` (CTE on RETURNING) → the `lead_process` job.
3. Set the cursor with `GREATEST(cursor, max processed)`.
4. After commit, publish (the outbox, §8.3).

### 9.3 Process → draft → notify
`lead_process`:
1. Claim the job (§8.3).
2. Daily cap check (D-36).
3. **Classify** (Haiku; message + form name + first name + company inside untrusted-input delimiters). Any failure → `unclear`.
4. Filtered classes → `filtered`, then stop.
5. **Draft** (Sonnet 5.5) → Zod (with enums lowercased) → validator (§9.4).
   - On failure: one retry carrying the error codes (a fresh single-turn request).
   - Then, or on a refusal, or on a FATAL-CONFIG error: `needs_touch` with the minimal safe template.
   - A transient error → 5xx (retry). On the final delivery, or in the failure callback, send the needs-touch fallback (D-24).
   - Record `ai_calls` for each attempt.
6. **Notify** (§8.4):
   - Subject `New lead: {safe first name} — your reply is ready`, with a fallback (D-47).
   - The email contains the lead's name, company, email and quoted message (defanged), the draft, three buttons and the "Open in default mail app" link.
   - Reply-To is the owner (D-27).
   - On commit: `first_notified_at`, `processing_state=notified`, and two `followup` job rows (unless follow-ups are off or this is a test lead).

### 9.4 Draft validator (pure; ≥40 golden cases)
Every check returns an error **code** only, never text.

| Code | Rule |
|---|---|
| `too_long` | ≤120 words (follow-ups ≤70) |
| `not_plain_text` | No HTML or markdown |
| `placeholder` | No `[Name]`, `{{x}}`, `{first_name}`, `<NAME>`, `XXX` |
| `missing_first_name` | The first name appears when known |
| `missing_booking_link` | The booking link appears verbatim when the brief has one |
| `currency` | No currency amounts (symbols, ISO codes or words next to numbers) unless `allow_pricing` |
| `never_promise` | No `never_promise` phrase (normalised) |
| `bad_subject` | The subject is a single line, ≤120 chars |
| `url_not_allowed` | D-47 |
| `contact_not_allowed` | D-47 |
| `addresses_owner` | D-47 |
| `echoes_lead` | D-47 |

### 9.5 Follow-up job (D-08, D-09, D-44)
1. Hop check, then claim.
2. Run `evaluateStops` on the database state. If the current settings forbid "now", re-target.
3. Read `GET contact/{id}?properties=email,hs_additional_emails,hs_email_optout,hs_email_bad_address,hs_email_hard_bounce_reason_enum,hs_sales_email_last_replied&associations=emails`, paging the associations and batch-reading in chunks of 100. Handle 404 and merges.
4. Run `applySignals` (monotonic HubSpot times; `markReplied` winner → cancel jobs + "{Name} replied — follow-ups stopped").
5. If not stopped:
   - draft the follow-up (≤70 words, referencing the original subject/body while that content still exists);
   - run the validator, retry, needs-touch as for initial drafts;
   - reserve and send, with the honest notes from D-34.
6. Mark the job done.

### 9.6 Onboarding: brief, inbox check, baseline (D-14, D-38, D-47)
- **Brief generation (`brief_generate` job):**
  - At most 4 pages are fetched in parallel within a 60 s crawl budget (SSRF guard, §10.4). Hidden DOM is dropped.
  - Sonnet runs with adaptive thinking at high effort under a remaining-time `AbortSignal`, falling back to `between_tools`/`high`/4096.
  - Post-processing: `faqs` capped at 8; `allow_pricing=false`; `booking_link` must be https and present in the fetched pages.
  - A refusal leaves an empty, editable form.
- **Inbox check:**
  - **History:** two count searches.
  - **Live test:**
    1. Check that the test contact exists. If it doesn't, ask the owner to add their BCC address or to submit their own form.
    2. Create a test lead (`is_test`, template draft, content purged after 24 h) and send the three-button test email.
    3. Send leg: wait up to 10 min for an `EMAIL` to the test address.
    4. Reply leg: wait up to 10 min for an `INCOMING_EMAIL` from it.
    5. The owner can "Continue" (the check runs in the background and its result lands on the dashboard) or "Skip". The result is stored in `logging_mode`.
  - Test leads never get follow-ups, never supersede, and never count.
- **Baseline (job):**
  - Read the last 30 days of submissions on the selected forms, then each contact's associated emails, and take the first `EMAIL` sent **to** the lead after `submittedAt`.
  - Report the lead count, the median (n ≥ 3), and the number of leads with no logged outbound email (only if the portal has any logged outbound email); otherwise "Not enough logged history".

### 9.7 Monday report (D-17, D-37)
1. Claim the job.
2. Period `[Mon 08:00 local − 1 week, Mon 08:00 local)`.
3. Refresh signals for the cohort and for leads with events in the period (`applySignals`, rate-limited).
4. `computeWeeklyMetrics(rows, baseline, loggingMode, scopes, period)`, pure:
   - **Cohort**, over leads submitted in the period that are not test leads:
     - leads in; filtered (not overridden);
     - drafts emailed (`first_notified_at`);
     - sends confirmed (`send_confirmed_at < end`);
     - opened the send link without a confirmed send;
     - median submission → confirmed send (n ≥ 3);
     - "leads you haven't replied to": notified, not dismissed, not confirmed, with record links (first 20 + "and N more").
   - **Events** in the period: replies from leads (`replied_at`); follow-ups drafted (`fu1_notified_at` and `fu2_notified_at`).
   - **Honesty rules** (D-37) and the baseline comparison (median and % without a logged send).
5. Render and send (§8.4). Store the metrics.

### 9.8 Billing (D-18 to D-20)
- **Trial:** 14 days from the first install of the portal (`portal_history`).
- **Entitlement:** pure and table-tested over all 9 statuses, plus `created`, none, unknown and `resumed`, and the grace boundaries.
- **Checkout:** lock → guard → reuse or create (`start_at` if more than 1 day of trial is left; `expire_by` rule) → 303.
- **Webhook and reconcile:** fetch-and-apply, applied only when newer.
- **Second live subscription:** cancel the newer one and alert.
- **Cancel:** immediate when `authenticated`, at cycle end when `active`. **Resume** for `paused`.

### 9.9 Retention and purge (D-49)
Every query binds `$now`. The DB-local steps also run from the 5-minute cron through a cheap guard, so content never outlives 30 d + 1 h.
1. `delete from lead_messages where purge_at < $now`.
2. `update drafts set subject=null, body=null, flags='{}', purged_at=$now where purge_at < $now and purged_at is null`.
3. `update leads set submission_key=null where …` for leads whose content was purged.
4. Clear `inbox_checks.test_address` after 24 h.
5. **Account purge** (`account_daily`), when `purge_after < $now` **and** no connection is active, re-checked right before the auth-user delete:
   - cancel any live subscription first (D-48);
   - write the tombstones;
   - delete the Supabase auth user;
   - `delete from accounts`.
6. Prune `webhook_events` older than 30 d, expired tokens, `rate_limits` and `ai_calls` older than 13 months.
7. Retention test: every content column is null or deleted for leads older than 30 d + 1 h, for revoked accounts, and for test leads after 24 h.

---

## 10. Security and privacy (brief §2, §7)

1. **Signatures.** Each is tested against the vectors in RESEARCH:
   - HubSpot v3: base64 HMAC-SHA256 of `method + uri + rawBody + timestamp`; timestamp must match `/^\d{13}$/`; accepted within ±300 000 ms; timing-safe compare; current or previous client secret.
   - QStash: `Receiver.verify` with `url`, `clockTolerance: 5`, `devMode: false`. A token signed with the dev key is rejected.
   - Razorpay: hex HMAC with the webhook secret, timing-safe, empty secret refused, previous secret accepted, `created_at` window.
2. **Crypto and keys (D-51):**
   - AES-256-GCM with a kid and AAD.
   - HKDF per-purpose keys.
   - Deterministic action tokens; only their hashes are stored.
   - All cookies are HMAC-signed, `httpOnly`, `Secure`, `SameSite=Lax`.
3. **Auth (D-22, D-35):**
   - token in the URL fragment;
   - `type=email`;
   - `next` allow-list;
   - binding at the email step, by email and nonce;
   - same-origin checks;
   - latency floor;
   - public Supabase sign-ups off.
4. **SSRF guard:**
   - Checks happen when the socket opens: an undici `Agent` with a guarded `lookup` that rejects any disallowed address and connects only to the vetted IP.
   - Ports 80 and 443 only.
   - Blocked ranges, IPv4 and IPv6: private, loopback, link-local, CGNAT, `0.0.0.0/8`, `fc00::/7`, `::ffff:0:0/96`, `64:ff9b::/96`, 6to4, and metadata addresses. IP-literal and single-label hosts are refused.
   - The same agent is used for `robots.txt` and for each of at most 3 redirects.
   - Limits: 2 MB per page after decompression; 9 pages, 10 MB and 60 s in total.
   - Only `text/html` and `text/plain` are read; no cookies or auth headers are sent.
   - Our own user agent, and `robots.txt` is respected.
5. **Lead-controlled text (D-47):** sanitised subject, defanged message, validator injection codes, hidden DOM dropped from briefs, booking-link confirmation.
6. **CSRF:**
   - Server Actions use their built-in Origin check.
   - Route-handler POSTs call `assertSameOrigin`.
   - CSP `form-action 'self'`.
7. **Headers:**
   - Nonce CSP from `buildCsp({nonce, dev})`; `'unsafe-eval'` only in development.
   - `connect-src 'self'` plus the Sentry ingest origin.
   - `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`.
   - HSTS, `nosniff`, `Referrer-Policy: no-referrer`, and a `Permissions-Policy`.
   - `no-store` + `noindex` on personal-data pages.
   - `poweredByHeader: false`.
8. **Tenant isolation:** `requireOwner()` → `OwnerScope`-typed repos; DTOs only to client components; `cross-tenant.test.ts` runs every owner page and action with another account's IDs.
9. **Read-only HubSpot:** the request allow-list (D-03), plus a scope test.
10. **Logging and Sentry:**
    - One shared `redact()`.
    - Every DB error goes through `DbError`; AI and SDK error messages are dropped.
    - Compose URLs, tokens and content are never logged.
11. **Abuse limits:** rate limits, daily drafted-lead cap, AI budget breaker, brief-generation limit, notify-address verification (D-36, D-46).
12. **Fake mode can't reach production** (D-29).
13. **No secrets in client bundles:** a CI step greps `.next/static` for secret-like strings and the names of server-only environment variables.

---

## 11. Observability

**Logger.** `src/server/obs/log.ts` writes JSON lines:
- `msg` is always a static string;
- `event`, ids and codes come from an allow-list;
- values pass through `redact()` from `src/shared/observability`.

**Sentry.** One shared options object for all three init files (D-23). Without a DSN, Sentry is a no-op.

**Proof tests:**
- `scrubber.test.ts`: golden events containing tokens, content and emails in the URL, path, query, body, extra, breadcrumbs and exception values.
- `sentry-envelope.test.ts`:
  - runs the real `@sentry/node` with the shared options and an in-memory transport;
  - fixtures: a real PGlite NOT NULL violation on `lead_messages`, a throwing Server Action whose input contains fixture text, and an Anthropic `APIError` whose message contains fixture text;
  - asserts the fixture strings are absent.
- `logger.test.ts`: the same check for the logger.

---

## 12. Testing

**Infrastructure:**
- **PGlite harness.**
  - Vitest `globalSetup` migrates one database (fake shim + migrations) and calls `dumpDataDir()`.
  - Each test file loads the dump once; between tests it runs `TRUNCATE … RESTART IDENTITY CASCADE`.
  - `hookTimeout` 30 s; DB test workers are capped.
- **Stubs and time.** `server-only` is aliased to a stub. The system time is set to 2030 in the time-sensitive suites, to prove nothing reads the wall clock.
- **Route tests** call `src/server/http/*` with real `Request` objects.
- **Locking and race semantics** are tested as **sequential replays**: crash after claim, duplicate delivery, compare-and-set loser paths. PGlite has a single connection.

**Brief §8 required tests:**
| Required test | Where |
|---|---|
| Validator golden cases | `domain/validator.test.ts` (≥40, including injection payloads) |
| Signatures with known vectors | `security/hubspot-signature.test.ts` (5 vectors + negatives incl. the 300000/300001 boundary), `razorpay-signature.test.ts` (A–C + negatives), `qstash-signature.test.ts` (`jose`-signed tokens, fake timers, dev-key rejection) |
| Token refresh: revoked vs transient | `services/token-manager.test.ts` with exact HubSpot error fixtures (`invalid_grant`/`BAD_REFRESH_TOKEN`, `BAD_HUB`, `invalid_client`, 429 `TEN_SECONDLY_ROLLING`/`DAILY`, 477 + `Retry-After`, 502, timeout), lease loser, version compare-and-set |
| Follow-up stop rules | `domain/stops.test.ts` + `services/followups.test.ts` (including stops arriving between claim and send) |
| Quiet hours across timezones | `domain/quiet-hours.test.ts` (§8.5) |
| Checkout guard | `domain/checkout-guard.test.ts` + `entitlement.test.ts` + checkout lock and second-subscription tests |
| Retention purge | `services/retention.test.ts` (30 d + 1 h, revoked-then-reconnected not purged, orphan at 7 d, live subscription blocks the purge, test lead at 24 h) |
| Idempotent webhook replay | `http/hubspot-webhook.test.ts` (same body twice; `attemptNumber` 0/1; webhook + poller → one lead; `appId` mismatch) + Razorpay replays (same id; missing header → body hash; old `created_at`) |

**Further tests:**
- **Migrations and data:** migrations/RLS/grants/functions; driver normaliser; no `now()` in SQL; DB-error sanitising.
- **Jobs and email:** job claim/crash/redelivery/sweeper per kind; notification reservation (crash after send → no duplicate; dismiss during drafting → no send).
- **HubSpot client:** request allow-list; email metadata allow-list; `REQUIRED_SCOPES` vs `app-hsmeta.json`; forms list query string; associations paging/chunking.
- **Signals and domain:** signal computation (to-address rule, from-address rule, `replies_ignored_before`); compose vectors (TV1–TV3, lone surrogate, IDN, `+`, `&`, CRLF); newsletter detection; due-check (Kolkata, Kathmandu); weekly metrics and honesty by logging mode; `deriveLeadStatus`; `computeProcessingState` transitions.
- **AI:** `toClaudeJsonSchema` snapshots; `buildModelParams`; AI error classification.
- **Security:** SSRF (rebinding resolver, IPv6 forms, redirects); robots parser; CSP builder (dev and prod); proxy scope; cross-tenant isolation; magic-link `type` and `next` handling; bind CSRF/mismatch/cross-device; env refusals; crypto (kid, rotation, tamper).
- **Observability:** scrubber, envelope, logger.
- **Layout and app smoke:** `src/instrumentation.ts` exists; no root `app/`, `instrumentation.ts`, `middleware.ts` or `proxy.ts`. A fake-mode end-to-end fetch smoke test covers install → magic link → onboarding → dashboard → fake checkout.

---

## 13. Simulation (`npm run simulate`, D-39)

**Setup**
- Fakes, PGlite in memory, `FakeClock`. The time-sensitive check suite is repeated with the system time set to 2030.
- Portal `1234567`, timezone `America/New_York`, `uiDomain app.hubspot.com`, logging mode `log_all`.
- Three forms:
  - **Contact us:** name, email, company, message.
  - **Request a quote:** name, email, company, message.
  - **Newsletter signup:** email only, lifecycle `subscriber`. It is auto-detected and unticked.
- Baseline fixture: 5 submissions between 2026-09-10 and 09-30. Four have a logged outbound email after 30 m, 2 h, 5 h and 26 h (median **3 h 30 m**); one has none.

**Pre-run, Tue 2026-10-06, 09:00–09:30 local:**
1. Install (fake consent) → magic link (outbox #1) → bind.
2. Brief job from the fixture site.
3. Forms selected (newsletter unticked); floors at 09:10.
4. Preferences: Gmail, one notify email (the owner's), quiet hours 19–08, weekends allowed, BCC on.
5. Inbox check: test email (outbox #2); both legs pass; `logging_mode=log_all`.
6. Baseline computed.
7. Onboarding complete at 09:30. Historical submissions produce **no** leads.

**Calendar.** `advanceTo` steps through every job and cron tick in order: polls every 5 min, the hourly due-check, daily at 03:17 UTC. Every tick is recorded in `summary.timeline`.

| Step | Local time | Events → expected |
|---|---|---|
| Day 0 | Tue 10:00–10:40 | Submissions: **#1** normal (10:00, new contact), **#2** no message (10:05), **#3** spam (10:10), **#4** vendor pitch (10:15), **#6** future replier (10:20). Each fires a webhook → polls. **#5** is a repeat submission by an existing contact at 10:30, with **no webhook**; the 10:35 cron poll picks it up (`source=poller`). Classification: #3 spam, #4 vendor_pitch → filtered. Emails: `new_lead` ×4 (#1, #2, #5, #6). Owner: taps Send on #1 at 10:12 (logged at 10:13), on #2 at 10:30 (never logged), and on #6 at 10:40 (logged at 10:41) |
| Day 1 | Wed 10:00 | Owner sends #5's reply (logged at 10:01) |
| Day 2 | Thu ~10:01–10:36 | `follow_up` ×4 (fu1 for #1, #2, #5, #6) |
| Day 3 | Fri 14:00 | #6 replies (`INCOMING_EMAIL` from #6's address, `hs_timestamp` Fri 14:00). Nothing is sent |
| Day 5 | Sun ~10:01–10:36 | fu2 jobs: #1, #2 and #5 → `follow_up` ×3; #6 → reply detected by the job → `reply_detected` ×1, follow-ups stopped |
| Monday | Mon 2026-10-12 08:00 | `weekly_report` ×1, covering `[Mon 10-05 08:00, Mon 10-12 08:00)` |
| Wednesday | Wed 10-14 12:00 | No emails. Final statuses are checked |

**Expected outbox: 15 emails.**

| When | Emails |
|---|---|
| Pre-run | magic link, inbox test |
| Day 0 | 4 |
| Day 2 | 4 |
| Day 5 | 4 |
| Monday | 1 |

**Expected weekly metrics** (the full JSON is asserted):

| Metric | Value |
|---|---|
| Leads in | 6 |
| Filtered | 2 |
| Drafts emailed | 4 |
| Sends confirmed | 3 (#1, #5, #6) |
| Opened the send link, not confirmed | 1 (#2) |
| Median time to first logged reply email | 21 min (13 m, 21 m, 23 h 31 m) |
| Leads you haven't replied to | [#2] with its record link |
| Replies from leads | 1 |
| Follow-ups drafted | 7 |
| Baseline comparison | median 3 h 30 m → 21 m; without a logged send 20% → 25% |

**Expected final statuses (Wednesday):**

| Lead | Status | Notes |
|---|---|---|
| #1 | no reply | send confirmed |
| #2 | no reply | send link opened, never confirmed |
| #3 | filtered | spam |
| #4 | filtered | vendor pitch |
| #5 | no reply | send confirmed; `source=poller` |
| #6 | replied | |

The test lead is absent from every list and metric, and has no `scheduled_jobs`.

**Output:** `./outbox/NNN-<kind>-<lead>.html` (+`.txt`) and `./outbox/summary.json`, with fields `{scenario, timeline[], emails[], leads[], weeklyReport, checks[], ok}`. The script exits non-zero if any check fails. CI runs it at every milestone, with the checks that milestone has enabled (D-50).

---

## 14. Environment variables

Every variable is listed in `.env.example` with a one-line comment.

| Group | Variables |
|---|---|
| App | `APP_MODE` (required: `fake`\|`live`), `ALLOW_FAKE_ON_VERCEL`, `APP_URL`, `PRODUCT_NAME`, `NEXT_PUBLIC_PRODUCT_NAME`, `APP_SECRET` (HKDF root), `TOKEN_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY_PREVIOUS`, `ADMIN_EMAILS`, `ENV_NAMESPACE`, `COMPOSE_URL_LIMIT`, `COMPOSE_GMAIL_FORM`, `COMPOSE_OUTLOOK_MODE`, `COMPOSE_OUTLOOK_WORK_BASE`, `COMPOSE_OUTLOOK_PERSONAL_BASE`, `MAX_DRAFTED_LEADS_PER_DAY`, `AI_DAILY_BUDGET_USD`, `FAKE_DB_DIR` |
| Database / auth | `DATABASE_URL` (transaction pooler :6543), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (all server-only) |
| HubSpot | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_CLIENT_SECRET_PREVIOUS`, `HUBSPOT_APP_ID`, `HUBSPOT_REDIRECT_URI`, `HUBSPOT_WEBHOOK_TARGET_URL`, `HUBSPOT_API_VERSION` (`2026-09`), `HUBSPOT_JOURNAL_ENABLED` (`false`) |
| QStash / cron | `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_MAX_DELAY_SECONDS` (601200), `CRON_SECRET` |
| Email | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` (magic-link and billing emails only) |
| AI | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_DRAFT`, `ANTHROPIC_MODEL_FAST`, `ANTHROPIC_DRAFT_THINKING`, `ANTHROPIC_DRAFT_EFFORT`, `ANTHROPIC_DRAFT_MAX_TOKENS`, `ANTHROPIC_BRIEF_EFFORT` |
| Billing | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`, `RAZORPAY_PLAN_ID` |
| Sentry | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` (build only) |

**`env.ts` checks:**
- `live` mode requires every variable to be present and well-formed (key prefixes, `rzp_live_` in production, 32-byte keys, current ≠ previous, no fake values).
- `QSTASH_DEV` must be unset in live mode.
- `fake` mode uses the documented fake defaults and is refused on Vercel unless allowed.

---

## 15. Milestones (D-50)

Every milestone ends with:
1. `npm run typecheck` (`next typegen && tsc --noEmit`)
2. `npm run lint`
3. `npm test`
4. `APP_MODE=fake npm run build` + smoke (`/api/health`, `/`, `/login` return 200)
5. `npm run simulate` with that milestone's checks
6. One commit
7. A 5-line summary

### M1: scaffold, CI, migrations, PGlite harness, fakes, CLAUDE.md
- [ ] Next 16 app (`src/` layout) with `global-error.tsx`; TypeScript strict; Tailwind 4; ESLint 9 with boundary, time-API and `URLSearchParams`-in-compose rules; Vitest with the `server-only` stub; `tsconfig.scripts.json`; `.gitignore` (`.env*`, `!.env.example`, `.data/`, `outbox/`, `.next/`, `coverage/`); `.nvmrc`
- [ ] Scripts `dev`, `build`, `start`, `typecheck`, `lint`, `test`, `simulate`; `.github/workflows/ci.yml` (all gates, Node 22, plus the client-bundle secret grep)
- [ ] `env.ts` with fake/live rules and refusals; `.env.example` (complete)
- [ ] `supabase/migrations/20261001000001_init.sql` (every table in §5: RLS, grants, default-privilege revoke, indexes); `supabase/config.toml`; `fake-shim.sql`; `migrate.ts` with the ledger; the migration test
- [ ] `Db` (Postgres.js serialised + PGlite; tx guard; driver normaliser; `DbError`); harness (dump and truncate)
- [ ] `Clock` + fakes skeleton: every port has a fake with unit tests. `FakeScheduler` takes an injected dispatch callback
- [ ] `security/crypto.ts` (kid, AAD, rotation) and HKDF keys; logger + shared `redact()`; Sentry files + shared options + scrubber and envelope tests; file-layout test
- [ ] `CLAUDE.md`, `README.md` skeleton, `docs/ARCHITECTURE.md` skeleton
- [ ] Simulation stage 1: boots the fakes and writes `summary.json` (no checks yet)

### M2: HubSpot OAuth, connection management, webhook intake, poller, classification
- [ ] `hubspot-app/` files, the `REQUIRED_SCOPES` constant + diff test; live `HubSpotHttpClient` (dated paths, Zod, request allow-list, per-portal limiter, error mapping, metadata allow-list)
- [ ] Domain: `computeProcessingState`, `entitled` (trial plus subscription statuses), `classifyRefreshFailure`, the HubSpot v3 signature check (with vectors)
- [ ] `/api/hubspot/install`, the callback (new portal, owner reinstall, non-owner reinstall), `pending_install`, `portal_history`
- [ ] Token manager (lease, compare-and-set, revoke path, transient path, 401 rule) + `renderEmail` + the ReconnectHubSpot template + Mailer (live Resend: Reply-To, idempotency, 409 handling, transient mapping)
- [ ] Jobs core: outbox publish, hop, claim/lease, sweeper, `/api/jobs/run`, `/api/jobs/failed`, QStash scheduler adapter + signature tests
- [ ] Webhook route (dedupe, `appId`, debounced double poll, privacy deletion → `privacy_delete` job)
- [ ] Poll cron (global lease, state evaluation, `pollPortal` with per-account lease, floors, cursors with `GREATEST`, transactional inserts) + cron auth
- [ ] Classification (Haiku params, `toClaudeJsonSchema`, lowercase enums, failure → `unclear`, `ai_calls`) + live `AnthropicLLM`
- [ ] Simulation stage 2: 6 leads (#5 from the poller), 2 filtered, no historical leads

### M3: brief builder, onboarding, inbox check, baseline
- [ ] `HttpWebFetcher` with the SSRF guard, robots parser, parallel crawl, hidden-DOM stripping; `brief_generate` job; brief editor and versions; booking-link rules
- [ ] Auth: `AuthProvider` (Supabase admin `createUser`/`generateLink` + own mailer; fake), `/login` (latency floor, limits), `/auth/confirm` (fragment, POST, `type`, `next`), `/onboarding/email` + `/onboarding/bind`, admin login, `requireOwner`/`OwnerScope`, `src/proxy.ts` (scope, CSP builder dev/prod + tests), the MagicLink template
- [ ] Action tokens (derivation, hashing, purpose, expiry, revocation); compose builders + golden vectors; `/a/[token]/send` (click heuristic, 302 / interstitial / copy) and `/a/[token]/copy`; InboxTest template
- [ ] Onboarding pages (forms with newsletter detection and floors; preferences with notify verification and change alerts)
- [ ] Inbox check (history, test contact handling, two legs, continue or skip, `logging_mode`, fix-step copy, `is_test` rules)
- [ ] Baseline job and sufficiency rules; onboarding completion → `active`
- [ ] Simulation stage 3: pre-run onboarding checks (magic link, inbox test, floors, baseline 3 h 30 m)

### M4: draft engine, validator, notification emails, action-link pages
- [ ] Draft and follow-up prompts (untrusted delimiters); validator with ≥40 golden cases; retry; needs-touch template and fallback (fatal, final delivery, failure callback); daily cap + deferred; AI budget breaker
- [ ] `lead_process` end to end with notification reservation, deterministic tokens, safe subject, defanged message, the secondary mailto link, Reply-To = owner
- [ ] Templates: NewLead, NeedsTouch, FollowUp, ReplyDetected (WeeklyReport stub, BillingInactive stub)
- [ ] `/a/[token]/edit` (200 result page) and `/a/[token]/dismiss` (confirm + POST); `/a/[token]/verify-notify`
- [ ] `shiftToAllowed` + timezone tests; follow-up job rows created in the "notified" transaction
- [ ] Simulation stage 4: `new_lead` ×4 at Day 0; all three action links work; clicks recorded

### M5: follow-up scheduler, reply detection, stop rules
- [ ] Follow-up job: hop or re-target, stops (including the dynamic supersede), contact read (paging, chunking, 404, merge, opt-out, bounce), `applySignals`/`markReplied`, follow-up drafts with honest notes, reservation predicates
- [ ] Dismiss, pause, revoke and disconnect cancellations; override (`process_rev`); resume follow-ups (`followup_stream`, `replies_ignored_before`)
- [ ] Tests: stop matrix, signals, crash/redelivery, dismiss during drafting
- [ ] Simulation stage 5: Day 2 ×4, Day 5 ×3 + `reply_detected`, statuses after each step

### M6: Monday report and dashboard
- [ ] Due-check + `weekly_report` job + `computeWeeklyMetrics` (cohort/event definitions, honesty rules, baseline comparison) + WeeklyReport template
- [ ] Dashboard (status card, banners, recent leads, lead detail with override, resume and refresh), brief editor page; views on `OwnerScope`; cross-tenant tests begin
- [ ] Simulation stage 6: Monday report metrics JSON exact

### M7: billing, trial, settings, disconnect/purge, admin
- [ ] Live `RazorpayBilling` (fetch); checkout (lock, guard, reuse, `start_at`/`expire_by`); resume; cancel branches; webhook (verify, window, dedupe, fetch-and-apply-if-newer, tombstone); second-subscription safety net; billing page; BillingInactive email on transition
- [ ] Settings page (all §5.11 items), pause/resume, disconnect (best effort + billing choice)
- [ ] Daily cron → `account_daily` (introspect probe, account details, reconcile, re-encrypt, orphan and purge with the subscription guard, tombstones); retention (hourly guard)
- [ ] `/admin` (allow-list, audit of views); rate limits on all public and auth routes; header tests
- [ ] Simulation stage 7: fake checkout → active; inactive → no processing and one email (separate scenario variant)

### M8: public pages, simulation polish, docs, REVIEW
- [ ] Landing, `/privacy` (sub-processors, retention, disclosures), `/terms`, `/refunds`, `/shipping` (all `TODO: legal review`)
- [ ] Simulation final: the full §13 check set, run under the 2030 system time; `/dev` panel complete; fake-mode end-to-end smoke test
- [ ] `docs/ARCHITECTURE.md`, `README.md`, `docs/WIRE_UP.md` (the brief's 9 steps, click by click, with the §17 live checks and a rotation runbook), `.env.example`, `CLAUDE.md` final
- [ ] Every finding ID cited in PLAN and DECISIONS resolves to a RESEARCH section (a check script)
- [ ] REVIEW: Definition of Done (§18), PASS/PARTIAL/FAIL per line

---

## 16. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | `sales-email-read` can't be granted for a marketplace app (evidence is community-level) | D-03 decision tree; fake 403 variant; WIRE_UP smoke test first |
| R2 | Reply detection depends on how the owner logs email | Two-leg check; `logging_mode`; honest notes and report wording; owner reviews every send; "Resume follow-ups" after an out-of-office |
| R3 | The legacy submissions endpoint (v1) is in HubSpot's September 2027 sunset | `LeadSource` boundary; the search trigger is a documented fallback; watch the changelog |
| R4 | 25-install cap until listed | Built to listing rules; listing work tracked outside v1 (D-43) |
| R5 | Gmail and Outlook compose URLs are undocumented | Env-switchable forms and bases; mailto link and copy page always available; live checks |
| R6 | Vercel Hobby crons (unverified) | Pro, or QStash schedules (D-16) |
| R7 | QStash Free limits (7-day delay; quota unverified) | Hop, sweeper; Pay-as-you-go recommended; quota errors alert |
| R8 | Haiku 4.5 retirement | Env swap (D-25) |
| R9 | Next 16 deviates from the brief | Sign-off; 14.x fallback documented (D-01) |
| R10 | Link scanners | Click heuristic; dismiss needs a POST; clicks never confirmed (D-26) |
| R11 | LLM quality, injection, cost | Validator with injection codes; owner review; caps and budget breaker; effort sweep at wire-up |
| R12 | Razorpay USD activation and policy-page review | Pages exist; legal text before activation |
| R13 | Database version and driver skew (PGlite 18 vs Supabase 15/17; type differences) | Conservative SQL; driver normaliser; `db push --dry-run` |
| R14 | Transaction-pooler pipelining | Serialised queries; no transactions across I/O; compare-and-set only (D-28) |
| R15 | Race and lock semantics can't be exercised on PGlite | Compare-and-set and lease design proven by sequential replay tests; documented limitation |
| R16 | `account-info` may enforce `external-settings-access` | Owner timezone fallback; smoke test |
| R17 | Content retention at Resend and Anthropic is unverified | WIRE_UP checks; choose ≤30 days or record a deviation (D-49) |
| R18 | AI cost per lead | About $0.03 per lead estimated; `ai_calls` measures it; caps |
| R19 | Many facts couldn't be fetched from vendor sites in the sandbox | §17 live checks; RESEARCH marks every such claim |

---

## 17. Live checks during WIRE_UP (from RESEARCH)

1. **Email scope:** `sales-email-read` is accepted at upload and install, and `GET /crm/objects/2026-09/emails?limit=1&properties=hs_timestamp` returns 200.
2. **Submissions endpoint:** page size, order and the `forms` scope on a Free and a Starter portal; whether `captured` forms work.
3. **Account info:** `account-info/2026-09/details` works with the `oauth` scope.
4. **Logging setup:** where the BCC address lives and how it behaves; connected-inbox "Log all"; both inbox-check legs, on Free and on Starter.
5. **Compose links:**
   - Gmail on both forms, with BCC, on the `/u/{email}/` path, signed in and signed out (including "Edit first");
   - Outlook work and personal, with BCC, using `mailtouri`;
   - the interstitial on iOS Safari, the Gmail and Outlook in-app browsers, and Android Chrome.
6. **Vercel:** cron plan limits; whether Deployment Protection blocks QStash.
7. **QStash plan:** maximum delay, retries and daily quota.
8. **Razorpay:**
   - a USD plan and International Cards;
   - Flash Checkout;
   - retrying a `created` subscription;
   - cancelling `authenticated` vs `active`;
   - Resume.
9. **HubSpot webhooks:** settings can take up to 5 minutes to apply before the live test; an install attempt by a non-admin user.
10. **Retention:** Resend's and Anthropic's content retention, and the Supabase backup window. Record the results in DECISIONS (D-49).
11. **Magic link:** fresh address → onboarding → magic link → session; confirm on a second device.
12. **AI:** one live request per schema (no "schema too complex"); the effort sweep on golden cases; Haiku deprecation status.

---

## 18. Definition of Done (brief §12)

REVIEW reports each line as **PASS**, **PARTIAL** (when the evidence is community-level or knowledge-base-level and the line depends on a §17 live check) or **FAIL**.

| DoD line | Proof |
|---|---|
| `npm run simulate` produces all expected emails with correct statuses in `summary.json` | §13 checks (non-zero exit on failure), also under the 2030 system time; `test/simulate.test.ts` in CI |
| Typecheck, lint and tests green | CI and every milestone gate |
| No secrets, tokens or message text in logs or Sentry payloads; a test proves the scrubber | `scrubber.test.ts`, `sentry-envelope.test.ts` (DB error, Server Action, AI error fixtures), `logger.test.ts`, client-bundle grep |
| Every [VERIFY] item resolved in RESEARCH.md with a source link | RESEARCH §0 index. Rows whose sources are only community or knowledge-base level report **PARTIAL** with their §17 check number |
| `WIRE_UP.md` complete for someone who has never seen the code | M8: the brief's 9 steps in order, with exact clicks and commands, a smoke test, a screenshot checklist and a rotation runbook |
| RLS enabled on every table, asserted by a migration test | `test/db/migrations.test.ts` (RLS, grants, functions) |
