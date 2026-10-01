# Hublytix Autopilot v1: build plan

Status: **PLAN, awaiting approval** (reply `approve` to start EXECUTE at M1).

Inputs:
- `docs/BUILD_BRIEF.md`: the specification.
- `docs/RESEARCH.md`: the verified facts. Finding IDs in [brackets] point there.
- `docs/DECISIONS.md`: every deviation and every choice, D-01…D-44.

Where this plan and the brief differ, the decision ID says why.

---

## 1. What changes from the brief (summary)

| # | Brief | Plan | Why |
|---|---|---|---|
| 1 | Next.js 14 | **Next.js 16.3.8** (React 19). `src/proxy.ts` replaces middleware; `src/instrumentation.ts` stays in `src/` | 14.x is unsupported and has 23 open advisories, 2 of them critical (D-01) |
| 2 | "Create the HubSpot public app" | HubSpot **developer-platform project** (`hubspot-app/`, platform `2026.09`), uploaded with the HubSpot CLI | Legacy public apps can no longer be created (D-02) |
| 3 | Scopes: `oauth`, `crm.objects.contacts.read`, `forms` | Adds **`sales-email-read`** (read-only) | Needed to read logged emails for confirmed sends, replies, the inbox check and the baseline (D-03) |
| 4 | `eventId` unique | Composite webhook dedupe key | HubSpot says `eventId` is not guaranteed unique (D-05) |
| 5 | Poller searches `recent_conversion_date` | Poller reads the **Forms submissions API** per selected form; the webhook only triggers a poll | Search exposes no form ID and only the latest conversion (D-07) |
| 6 | Checkout guard blocks `active`/`halted` | Blocks `authenticated`/`active`/`pending`/`halted`/`paused`; **never** blocks `created` | Every one of those is a live mandate (D-18) |
| 7 | `/privacy`, `/terms` | Also `/refunds` and `/shipping` placeholders | Razorpay needs these pages before it accepts USD card payments (D-20) |
| 8 | "service-role key" | Supabase **secret key** (`sb_secret_…`) plus explicit grants in every migration | Supabase key and grant changes in 2026 (D-21) |
| 9 | Inbox check = one live test | Two legs: send logged ✓/✗ and reply logged ✓/✗ | BCC logging records sends, not replies (D-14) |
| 10 | Vercel Cron | Vercel Cron (Pro plan) **or** QStash schedules; every periodic route accepts both | Hobby crons are probably daily-only (D-16) |

Everything else follows the brief as written.

---

## 2. Stack and pinned versions

| Area | Choice (exact pin in `package.json`) |
|---|---|
| Runtime | Node `>=22.12` (`.nvmrc` = 22); on Vercel, Node 22.x or 24.x |
| Framework | `next@16.3.8`, `react@19.x`, `react-dom@19.x`, App Router, `src/` layout |
| Language | `typescript@5.9.3`, `strict: true`, `noUncheckedIndexedAccess: true` |
| Styling | `tailwindcss@4.3.x` + `@tailwindcss/postcss`; mobile-first |
| Lint | `eslint@9.39.x` flat config, `eslint-config-next@16.3.8`, `typescript-eslint@8.x` (`next lint` no longer exists) |
| Tests | `vitest@4.1.x`; `@electric-sql/pglite@0.5.8` (Postgres 18.3, WASM) |
| Validation | `zod@4.x` everywhere (external payloads, env, AI output) |
| Time zones | `luxon@3.7.x` |
| Database (live) | Supabase Postgres via `postgres@3.4.x` (Postgres.js) on the transaction pooler: `{max:1, prepare:false, ssl:'require'}` (D-27) |
| Auth | Supabase Auth, `@supabase/ssr@0.12.7`, `@supabase/supabase-js@2.117.x`; token-hash magic links (D-22) |
| Jobs | `@upstash/qstash@2.12.0` (Client + Receiver, `devMode:false`); Vercel Cron |
| Email | `resend@6.31.x`; `react-email@6.11.0` (templates and rendering) |
| AI | `@anthropic-ai/sdk@0.131.0`; models from env (`claude-sonnet-5-5`, `claude-haiku-4-5-20251001`) |
| Billing | Razorpay REST API via `fetch` (no SDK) (D-20) |
| Monitoring | `@sentry/nextjs@11.2.0`: errors only, restrictive `dataCollection`, scrubber (D-23) |
| HTML parsing | `cheerio@1.2.x` (brief builder text extraction) |
| Scripts | `tsx` for `npm run simulate` |

---

## 3. Repository layout and module boundaries

```
.
├── CLAUDE.md                     # rules for future sessions (git rules, boundaries, laws)
├── README.md
├── .env.example                  # every variable with a one-line comment
├── .github/workflows/ci.yml      # typecheck, lint, test, simulate
├── eslint.config.mjs  next.config.ts  postcss.config.mjs  tsconfig.json  vitest.config.ts  vercel.json
├── docs/                         # BUILD_BRIEF, RESEARCH, PLAN, ARCHITECTURE, DECISIONS, WIRE_UP
├── hubspot-app/                  # HubSpot developer-platform project (D-02)
│   ├── hsproject.json
│   └── src/app/{app-hsmeta.json, webhooks/webhooks-hsmeta.json}
├── supabase/
│   ├── config.toml
│   └── migrations/20261001000001_init.sql  (… later migrations)
├── scripts/
│   ├── simulate.ts               # npm run simulate → ./outbox/*.html + summary.json
│   └── qstash-schedules.ts       # optional: upsert QStash schedules (Hobby alternative)
├── test/
│   ├── db/{harness.ts, supabase-shim.sql}       # PGlite + roles/auth shim (never in migrations)
│   └── fixtures/{hubspot-signature-v3.json, razorpay/*.body, compose-vectors.json, site/…}
└── src/
    ├── instrumentation.ts        # register(): runtime-gated Sentry init; onRequestError
    ├── instrumentation-client.ts # browser Sentry init (same shared options)
    ├── sentry.server.config.ts  sentry.edge.config.ts
    ├── proxy.ts                  # nonce CSP + strip inbound CSP headers + Supabase session refresh
    ├── app/                      # routes (thin; call src/server/http/*)
    ├── components/               # UI components (client-safe)
    ├── emails/                   # React Email templates (presentational)
    └── server/                   # every file imports 'server-only'
        ├── env.ts                # Zod-validated env; APP_MODE fake|live; boot assertions
        ├── container.ts          # builds Deps (ports + db) from env; test override
        ├── ports/                # interfaces only
        ├── adapters/live/        # HubSpotHttp, AnthropicLLM, ResendMailer, QStashScheduler,
        │                         #   RazorpayBilling, HttpWebFetcher, SystemClock, SupabaseAuth
        ├── adapters/fake/        # FakeHubSpot, FakeLLM, FakeMailer(outbox), FakeScheduler(time travel),
        │                         #   FakeBilling, FakeWebFetcher, FakeClock, FakeAuth
        ├── db/                   # Db interface, postgres.ts, pglite.ts, migrate.ts, repos/*.ts
        ├── domain/               # PURE logic, no I/O (validator, quiet hours, stop rules, status,
        │                         #   entitlement, checkout guard, compose URLs, newsletter detection,
        │                         #   stats, report metrics, refresh-error classifier, JSON schema helper)
        ├── security/             # crypto (AES-GCM), action tokens, signature verifiers, rate limit,
        │                         #   CSP builder, SSRF guard, cron auth
        ├── services/             # orchestration (install, tokens, intake, drafting, notify,
        │                         #   follow-ups, signals, inbox check, baseline, report, billing,
        │                         #   disconnect, retention, admin)
        ├── jobs/dispatcher.ts    # job kind → service; hop handling
        ├── http/                 # route handler implementations (req, deps) → Response
        └── obs/                  # logger + Sentry options/scrubber (shared)
```

**Dependency rules.** These are enforced by ESLint `no-restricted-imports` plus a small test.

- `domain/` imports only `domain/`, `zod` and `luxon`. It is pure and fully unit-testable.
- `ports/` is types only. `adapters/*` implement ports and may use `domain/`. They never import `services/`.
- `services/` depend on **port types** and `db/repos`. They receive a `Deps` object and never import adapters.
- `http/` wraps services with verification, parsing and rate limits. `src/app/**` calls only `http/` and `container`.
- Client components never import `src/server/**`. Every server module starts with `import 'server-only'`, so a bad import fails the build. The only public env vars are `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SENTRY_DSN` and `NEXT_PUBLIC_PRODUCT_NAME`.

---

## 4. Ports (interfaces) and fakes

`APP_MODE=fake|live` selects every adapter (D-28). Fake mode needs zero credentials: PGlite is persisted under `./.data/pglite` for `npm run dev`, and in memory for tests and `simulate`.

| Port | Key methods | Fake behaviour |
|---|---|---|
| `Clock` | `now()` | Settable and advanceable; drives the scheduler's time travel |
| `HubSpotClient` | `authorizeUrl`, `exchangeCode`, `refresh`, `introspect`, `revoke`, `accountDetails`, `listForms`, `listSubmissions(formId, {after,limit})`, `getContact(idOrEmail, {idProperty, properties, associations})`, `batchReadEmails(ids, props)`, `searchEmails(filters, props)`, `uninstallApp` | An in-memory portal: forms, contacts, newest-first 50-item submission pages, contact→email associations, email engagements with logging modes (`log_all`/`sends_only`/`none`) and logging delay, refresh modes (`ok`/`revoked`/`transient×N`/`config`), 404/merge simulation, webhook body generation signed with the v3 algorithm |
| `LLM` | `classify(input)`, `generateBrief(pages)`, `draft(input)`, `draftFollowUp(input)`; each returns `{value, usage, stopReason, model}` or a typed failure | Deterministic keyword classifier and templated drafts that pass the validator. Fault injection: `invalid` / `refusal` / `max_tokens` on the next call. Asserts the request parameters are valid for the model |
| `Mailer` | `send({to, subject, html, text, tags, idempotencyKey})` | Stores sent mail; in simulate mode writes `./outbox/NNN-kind-ref.html` (+ `.txt`) |
| `Scheduler` | `schedule({kind, payload, runAt, dedupeKey, labels})` → `{messageId}`, `cancel(messageId)` | Ordered queue; `runDue(now)` dispatches through the real `dispatcher`; honours dedupe and cancel |
| `Billing` | `createSubscription`, `fetchSubscription`, `cancelSubscription`, `fetchPlan`, `verifyWebhook` | Fake subscriptions; `short_url` → `/dev/fake-checkout/{id}`, which emits signed webhook events |
| `WebFetcher` | `fetch(url, {timeoutMs, maxBytes})` → `{status, contentType, finalUrl, body}` | A fixture website (`test/fixtures/site`) including `robots.txt` |
| `AuthProvider` | `sendMagicLink(email, next)`, `verify(tokenHash, type)`, `getSessionUser(req)`, `signOut()` | Magic link written to the outbox; signed `ap_session` cookie |

Live adapters follow the research: HubSpot via `fetch` + Zod, with the date-versioned path builder and a per-portal limiter (D-04, D-39); Anthropic per D-24; Resend with idempotency keys; QStash per D-15; Razorpay per D-19/D-20; `HttpWebFetcher` with the SSRF guard (§10.4).

---

## 5. Data model

One migration (`supabase/migrations/20261001000001_init.sql`) in M1. Later milestones add their own timestamped migrations. Rules applied to **every** table:
- `alter table … enable row level security;`
- `revoke all on table … from anon, authenticated;`
- `grant select, insert, update, delete on table … to service_role;`
- No RLS policies; all data access is server-side (D-21).

Other rules:
- Statuses use `text` columns with `check` constraints, not Postgres enums, so they are easy to evolve.
- Timestamps are `timestamptz`.
- Primary keys are `uuid default gen_random_uuid()`, except bigint identity on log tables.
- Every account-scoped table has `account_id … references accounts(id) on delete cascade`, so purging an account is one `delete`.

| Table | Purpose and key columns | Content? |
|---|---|---|
| `accounts` | `id`, `hubspot_portal_id bigint unique`, `onboarding_step`, `trial_started_at`, `trial_ends_at`, `timezone`, `timezone_source (hubspot\|owner)`, `logging_mode (unknown\|log_all\|sends_only\|none)`, `paused_at`, `disconnected_at`, `purge_after`, `billing_inactive_notified_at`, `created_at`, `updated_at` | none |
| `users` | `id`, `account_id unique` (one owner), `auth_user_id uuid unique`, `email` (owner), `last_login_at` | owner email only |
| `settings` | `account_id pk`, `notify_emails text[]` (1–3, check), `mail_client (gmail\|outlook_work\|outlook_personal\|other)`, `gmail_account_email`, `quiet_start_hour`, `quiet_end_hour` (defaults 19, 8), `skip_weekends` (default true), `followups_enabled` (default true), `bcc_address` | owner config |
| `hubspot_connections` | `account_id unique`, `portal_id unique`, `ui_domain`, `data_hosting_location`, `account_type`, `scopes text[]`, `access_token_enc`, `refresh_token_enc`, `access_expires_at`, `status (active\|revoked\|disconnected)`, `status_reason`, `reconnect_email_sent_at`, `transient_failures`, `last_refresh_at`, `last_webhook_at`, `last_polled_at`, `poll_requested_at`, `journal_offset` | encrypted tokens |
| `briefs` | `account_id pk`, `current_version`, `data jsonb` (brief JSON), `source_url`, `booking_link_choice (unset\|link\|none)` | business info (not lead content) |
| `brief_versions` | `account_id`, `version`, `data jsonb`, `source (generated\|owner)`; `unique(account_id, version)` | business info |
| `selected_forms` | pk `(account_id, form_id)`, `form_name`, `form_type`, `selected`, `newsletter_detected`, `cursor_submitted_at`, `last_polled_at` | none |
| `leads` | `id`, `account_id`, `hubspot_contact_id text` (null only for test leads), `form_id`, `submitted_at`, `submission_key` (conversionId or sha256(submittedAt + lower(email))), `is_test`, `classification (lead\|spam\|vendor_pitch\|job_seeker\|support_request\|unclear)`, `classification_override`, `status`, `needs_touch`, `followups_state (none\|scheduled\|done\|stopped\|off)`, `stop_reason`, timeline (`received_at`, `classified_at`, `first_notified_at`, `first_send_clicked_at`, `send_confirmed_at`, `replied_at`, `dismissed_at`, `fu1_notified_at`, `fu2_notified_at`, `no_reply_at`, `signals_checked_at`). Unique: `(account_id, form_id, submission_key)` and `(account_id, hubspot_contact_id, submitted_at)` (the brief's dedupe) | **none** (IDs, timestamps, statuses) |
| `lead_messages` | `lead_id pk`, `account_id`, `message`, `first_name`, `last_name`, `company`, `email`, `purge_at` (= submitted_at + 30 d) | **yes** (purged) (D-30) |
| `drafts` | `id`, `lead_id`, `account_id`, `kind (initial\|fu1\|fu2)`, `subject`, `body`, `used_booking_link`, `flags text[]`, `validation_ok`, `validation_errors text[]` (codes only), `attempts`, `needs_touch`, `model`, `input_tokens`, `output_tokens`, `cost_micro_usd`, `purge_at`, `purged_at`; `unique(lead_id, kind)` | **yes** (subject/body nulled at purge) |
| `action_tokens` | `id`, `token_hash bytea unique` (sha256), `account_id`, `lead_id`, `draft_id`, `purpose (send\|edit\|dismiss)`, `expires_at` (+7 d), `first_used_at`, `last_used_at`, `use_count`, `revoked_at` | none |
| `scheduled_jobs` | `id`, `account_id`, `lead_id`, `kind (followup\|lead_process\|portal_poll\|weekly_report\|baseline)`, `seq`, `dedupe_key unique` (env-prefixed), `run_at`, `external_id` (QStash msg id), `status (scheduled\|running\|done\|cancelled\|failed\|skipped)`, `attempts`, `last_error_code`, `cancel_reason`, `finished_at` | none |
| `notifications_sent` | `id`, `account_id`, `lead_id`, `kind (magic_link\|new_lead\|needs_touch\|follow_up\|reply_detected\|weekly_report\|reconnect_hubspot\|billing_inactive\|inbox_test)`, `dedupe_key unique`, `provider_message_id`, `status`, `recipients_count` | none (no bodies, no addresses) |
| `weekly_reports` | `account_id`, `week_start date`, `period_start`, `period_end`, `metrics jsonb` (counts, medians, lead IDs), `status (pending\|sent\|failed)`, `sent_at`; `unique(account_id, week_start)` (D-17) | none |
| `subscriptions` | `account_id`, `provider_subscription_id unique`, `plan_id`, `status` (open text), `short_url`, `start_at`, `current_start`, `current_end`, `expire_by`, `payment_failed_at`, `grace_until`, `cancel_at_cycle_end`, `last_event_created_at`, `last_synced_at` | none |
| `webhook_events` | `id bigint identity`, `provider (hubspot\|razorpay)`, `dedupe_key` (HubSpot: `portal:subType:objectId:eventId:occurredAt`; Razorpay: event id), `body_sha256`, `portal_id`, `account_id`, `event_type`, `occurred_at`, `received_at`, `outcome`; `unique(provider, dedupe_key)`, partial unique on `(provider, body_sha256)` for Razorpay (D-05, D-19) | none |
| `audit_log` | `id bigint identity`, `account_id`, `at`, `actor`, `action`, `level`, `meta jsonb` (allow-listed keys only: ids, codes, counts) | none |
| `baselines` | `account_id pk`, `computed_at`, `window_start`, `window_end`, `status (ok\|insufficient\|unavailable)`, `leads_count`, `portal_outbound_logged`, `leads_with_outbound`, `leads_without_outbound`, `median_seconds_to_first_outbound` | none |
| `inbox_checks` | `id`, `account_id`, `started_at`, `test_address` (purged after 24 h), `test_lead_id`, `history_outbound_30d`, `history_inbound_30d`, `send_leg (pending\|passed\|failed\|timeout)`, `send_leg_at`, `reply_leg`, `reply_leg_at`, `finished_at` | owner's test address (24 h) |
| `ai_calls` | `id bigint identity`, `account_id`, `lead_id`, `draft_id`, `purpose (classify\|brief\|draft\|followup)`, `attempt`, `model`, `request_id`, `stop_reason`, `refusal_category`, the four token counts, `thinking_tokens`, `cost_micro_usd`, `latency_ms`, `outcome` | none |
| `rate_limits` | pk `(key_hash, window_start)`, `count` | none (salted hashes) |
| `leases` | `name pk`, `holder`, `expires_at` (stops overlapping cron runs; session advisory locks don't survive the transaction pooler) | none |

Indexes are created for every hot path:
- `leads(account_id, received_at desc)`
- `leads(account_id, status)`
- `lead_messages(purge_at)`
- `drafts(purge_at) where purged_at is null`
- `scheduled_jobs(status, run_at)`
- `action_tokens(expires_at)`
- `webhook_events(portal_id, received_at desc)`
- `accounts(purge_after) where purge_after is not null`

**Migration test (DoD):** on PGlite with the shim, assert that:
1. no `public` table has `relrowsecurity = false`;
2. `anon` and `authenticated` have no table privileges;
3. `service_role` has CRUD on every table;
4. the migrations apply cleanly twice to fresh databases.

---

## 6. Lead lifecycle

```
submission found ──► lead(new) ──► processing ──► classification
                                      │
                       spam/vendor_pitch/job_seeker/support_request ──► FILTERED  (owner may override → re-run)
                                      │
                               lead/unclear ──► draft (+1 retry) ──► needs_touch? ──► notify owner (3 buttons)
                                                                                      │  status DRAFTED
                                    /a/{t}/send click ──► SEND_CLICKED (never "confirmed")
                         HubSpot EMAIL engagement after notify ──► SEND_CONFIRMED
                                                                                      │
                fu1 @ T0+2d (shifted) ──► stops? ──► reply? ──► REPLIED (cancel fu2, "replied" email)
                                                      └─ else follow-up draft #1 → notify
                fu2 @ T0+5d (shifted) ──► same ──► else follow-up draft #2 → notify → NO_REPLY ("no confirmed reply")
                owner "Not a real lead" (POST) ──► DISMISSED (cancel jobs)
```

- **Shown status:** `deriveLeadStatus(timeline)`, a pure function, gives the single status. Precedence: dismissed > replied > filtered > no_reply > send_confirmed > send_clicked > drafted (D-31).
- **Superseded leads:** a newer lead for the same contact cancels the older lead's pending follow-ups (`stop_reason='superseded'`), so the same person never gets two follow-up streams.
- **Hard stops** (`evaluateStops`, pure and table-tested), checked at the start of every follow-up job:

| Stop | Source |
|---|---|
| more than 2 follow-ups | brief |
| lead dismissed or replied | brief |
| account paused | brief |
| not entitled (trial over and subscription inactive) | brief |
| connection revoked or disconnected | brief |
| follow-ups turned off | brief |
| contact 404 | brief, D-09 |
| `hs_email_optout == "true"` | brief, D-09 |
| hard bounce / bad address | D-09 |
| superseded | §6 above |

---

## 7. Routes

All handlers live in `src/server/http/*`; the `src/app` files are wrappers. "Auth" column:
- **sig** = signature verified on the raw body;
- **session** = Supabase session (or the fake session) belonging to the account owner;
- **token** = hashed action token with the right purpose and not expired;
- **cron** = Bearer `CRON_SECRET` **or** a QStash signature.

### 7.1 Public pages
| Route | Notes |
|---|---|
| `/` | Landing: one-liner, 3-step "how it works", "$49/month after a 14-day free trial", **Install with HubSpot** (links to `/api/hubspot/install`). No testimonials or user counts. |
| `/privacy`, `/terms`, `/refunds`, `/shipping` | Placeholders marked `TODO: legal review`. `/privacy` lists sub-processors (Anthropic, Supabase, Vercel, Upstash, Resend, Razorpay, Sentry) and the read-only email-metadata access (D-03). |
| `/login` | Email form → Server Action → `AuthProvider.sendMagicLink`. The response is always neutral. Rate-limited by IP and email. |
| `/auth/confirm` | GET shows a "Sign in" button; POST runs `verifyOtp(token_hash, type)` then redirects (D-22). |
| `/auth/signout` | POST |

### 7.2 HubSpot, billing and job endpoints
| Route | Auth | Notes |
|---|---|---|
| `GET /api/hubspot/install` | rate limit | Random `state` in a signed httpOnly cookie (10 min) → 302 to `https://app.hubspot.com/oauth/authorize?client_id&scope=<REQUIRED_SCOPES>&redirect_uri&state` |
| `GET /api/hubspot/oauth/callback` | state | Exchange the code (`/oauth/2026-09/token`) → verify granted scopes → `account-info/2026-09/details` → upsert account + connection (encrypted tokens) → start the trial on first install → signed `pending_install` cookie → `/onboarding` (D-34). Errors show a neutral "Install failed — try again" page; the code is never logged. |
| `POST /api/hubspot/webhooks` | sig (HubSpot v3) | Raw text → verify against `HUBSPOT_WEBHOOK_TARGET_URL` (±5 min) → Zod array (≤100) → insert `webhook_events` (ON CONFLICT DO NOTHING) → for each active portal with an `object.creation`/`contact.creation` event, set `poll_requested_at` (debounced to 1/min) and enqueue a `portal_poll` job. `contact.privacyDeletion` → purge that contact's content and stop follow-ups. Always 200 quickly; unknown or inactive portals are ignored. |
| `POST /api/jobs/run` | sig (QStash) | Payload `{kind, …ids, targetAt}` → `dispatcher`. Status codes: 200 done/no-op; 489 + `Upstash-NonRetryable-Error` for permanent errors; 5xx for transient. `maxDuration = 300`. |
| `POST /api/jobs/failed` | sig (QStash) | Failure callback → `scheduled_jobs.status='failed'` + Sentry (ids only) |
| `GET\|POST /api/cron/poll` | cron | `*/5 * * * *`. Takes a lease; for each active, entitled, unpaused account (bounded concurrency, ~240 s budget) runs `pollPortal`; sends the one-time "billing inactive" email when needed. |
| `GET\|POST /api/cron/weekly-report` | cron | `0 * * * *`. Due-check (D-17) → insert `weekly_reports(pending)` → enqueue a `weekly_report` job |
| `GET\|POST /api/cron/daily` | cron | `17 3 * * *`. Retention purge, purge of accounts disconnected >30 d (incl. the Supabase auth user), Razorpay reconcile, account-details/timezone refresh, `no_reply` for leads with follow-ups off, prune of `rate_limits`/expired tokens/old `webhook_events`, optional journal poll |
| `POST /api/razorpay/webhook` | sig (Razorpay) | Raw body → HMAC (timing-safe; current + previous secret) → `created_at` window → dedupe (event-id header + body hash) → fetch the subscription → apply status (D-19). 200 for duplicates and ignored events. |
| `POST /api/billing/checkout` | session + same-origin | Checkout guard (D-18) → reuse a `created` subscription or create one → 303 to `short_url` |
| `GET /api/onboarding/inbox-test/status` | session | Rate-limited to 1 HubSpot check per 20 s per account; returns the leg states |
| `GET /api/health` | none | `{ok, mode, version}`; no secrets |

### 7.3 Owner action links (no login, mobile-first)
| Route | Auth | Behaviour |
|---|---|---|
| `GET /a/[token]/send[?via=mailto]` | token(send) + rate limit | Record the click (skip `HEAD` and scanner user agents; D-26). Pick the target: phone UA or `via=mailto` → **mailto interstitial** (200, with a button); else Gmail/Outlook URL → **302**; if the URL is over 1,800 chars → **copy-reply page**. Content purged → "This draft has expired" page. |
| `GET /a/[token]/copy` | token(send) | Copy-reply page: recipient, subject, body and BCC address, each with a copy button |
| `GET /a/[token]/edit` | token(edit) | Editable subject and body + "Send from my email" + "Open in default mail app" |
| `POST /a/[token]/edit` | token(edit) + same-origin | Validate the edit (single-line subject; body length) → record the click → same target logic. The edited text is **not stored**. |
| `GET /a/[token]/dismiss` | token(dismiss) | Confirmation page (link scanners can't dismiss) |
| `POST /a/[token]/dismiss` | token(dismiss) + same-origin | `dismissed_at`, cancel follow-ups, audit |

### 7.4 App pages (session required; mobile-first)
| Route | Content |
|---|---|
| `/onboarding` | Routes to the current step. Step 1, `/onboarding/email`, accepts the `pending_install` cookie with no session yet: enter the owner email → magic link. |
| `/onboarding/brief` | Website URL → generate (sync, ≤240 s budget, spinner) → editable form. A booking link, or an explicit "no booking link" choice, is required to continue. |
| `/onboarding/forms` | HubSpot forms (`formTypes=hubspot,flow`), with newsletter-like forms unticked (D-07, [HS-ONBOARD-NEWSLETTER-DETECT]) |
| `/onboarding/preferences` | Mail client (Gmail / Outlook work / Outlook personal / Other), notify emails (1–3), quiet hours, skip weekends, timezone (auto-detected and shown), optional BCC address with guidance |
| `/onboarding/inbox` | One-sentence why → history counts → two-leg live test with ✓/✗ and fix steps (D-14) |
| `/onboarding/baseline` | Baseline job + polling; "Not enough logged history" when insufficient (D-37) |
| `/dashboard` | Status card (trial days left / active / paused / revoked + banners), recent leads with one status each and a HubSpot link |
| `/dashboard/leads/[id]` | Timeline, draft (until purged), "This is a real lead" override for filtered leads, "Resume follow-ups" |
| `/dashboard/brief` | Brief editor (saving creates `brief_versions`) |
| `/dashboard/settings` | Notify emails, mail client, forms, quiet hours/weekends, follow-ups on/off, pause all, BCC address, disconnect HubSpot |
| `/dashboard/billing` | Status, Subscribe (checkout), Update payment method (pending/halted), Cancel (at cycle end) |
| `/admin` | `ADMIN_EMAILS` only, otherwise 404. Portals, statuses, trial/billing, last webhook received, failed jobs, error counts (7 d), AI refusal counts. No content. |

### 7.5 Dev-only (`APP_MODE=fake`; 404 in live mode)
| Route | Purpose |
|---|---|
| `/dev` | Submit a test lead, advance the clock and run due jobs, view the outbox |
| `/dev/fake-checkout/[id]` | Simulate a paid or declined checkout (emits signed fake Razorpay webhooks) |

Mutations from authenticated pages use **Server Actions** (built-in Origin check), each wrapped with `Sentry.withServerActionInstrumentation`. Token routes use plain HTML forms posting to route handlers, with an explicit same-origin check.

---

## 8. Jobs and schedules

### 8.1 Periodic triggers (UTC)
| Name | Schedule | Route | Idempotency |
|---|---|---|---|
| Lead poller | `*/5 * * * *` | `/api/cron/poll` | lease `poller`; per-form cursors + overlap; lead unique keys |
| Monday report due-check | `0 * * * *` | `/api/cron/weekly-report` | `weekly_reports` unique `(account, week_start)` |
| Daily maintenance | `17 3 * * *` | `/api/cron/daily` | lease `daily`; every step re-runnable |

`vercel.json` declares the three crons (Vercel Pro). `scripts/qstash-schedules.ts` creates equivalent QStash schedules for Hobby (D-16).

### 8.2 QStash job kinds (`POST /api/jobs/run`)
| Kind | Payload | Dedupe key | Created by |
|---|---|---|---|
| `portal_poll` | `{accountId}` | `{env}:poll:{accountId}:{minute}` | webhook (debounced) |
| `lead_process` | `{leadId}` | `{env}:lead:{leadId}:process` | poller |
| `followup` | `{leadId, n, targetAt}` | `{env}:lead:{leadId}:fu:{n}` | after the first notification |
| `weekly_report` | `{accountId, weekStart}` | `{env}:report:{accountId}:{weekStart}` | due-check |
| `baseline` | `{accountId}` | `{env}:baseline:{accountId}:{day}` | onboarding |

The QStash dedupe window is only 10 minutes, so the durable idempotency is the `scheduled_jobs` row: unique `dedupe_key` plus an atomic claim `UPDATE … SET status='running' WHERE id=$1 AND status='scheduled' RETURNING` (D-15).

**Hop:** if `targetAt − now` is more than `QSTASH_MAX_DELAY_SECONDS`, publish at the maximum delay. When the hop arrives with `now < targetAt − 60 s`, re-publish and update `external_id`.

**Cancel:** by stored message id only, with 404 treated as success. Handlers always re-check the stop rules.

### 8.3 Follow-up timing
- Times: `T0 = first_notified_at`; fu1 target = `shiftToAllowed(T0 + 2d)`, fu2 target = `shiftToAllowed(T0 + 5d)`.
- `shiftToAllowed(t, tz, quietStart, quietEnd, skipWeekends)`: if the local time falls in quiet hours (which may wrap past midnight) or on Sat/Sun when skipped, move to the next whole hour that is allowed, typically `quietEnd:00` on the next allowed day. Luxon handles DST.

The tests cover:
- `America/New_York` (both DST changes)
- `Asia/Kolkata` (+05:30)
- `Asia/Kathmandu` (+05:45)
- `Pacific/Auckland`
- `Europe/London`
- quiet windows that wrap midnight and ones that don't
- skip weekends on and off
- the Sunday-night worst case that exceeds 7 days (hop)

---

## 9. Main flows (sequence detail)

### 9.1 Install and connection
1. `/api/hubspot/install` → HubSpot consent (read-only scopes).
2. The callback exchanges the code, checks that `scopes ⊇ REQUIRED_SCOPES` (missing `sales-email-read` → email features flagged unavailable), and reads account details (`timeZone`, `uiDomain`).
3. It upserts the `accounts` row (`trial_ends_at = now + 14 d` on first install only) and the `hubspot_connections` row (tokens AES-256-GCM, with AAD = connection id + field).
4. **Token manager** (`getAccessToken(accountId)`): refresh when `access_expires_at − 5 min < now`. It takes a single-flight lock per connection (`SELECT … FOR UPDATE` inside a transaction), always saves the newest refresh token, and classifies failures (D-11):
   - `revoked` → connection `revoked`, cancel the portal's jobs, send the reconnect email once (`notifications_sent` dedupe `reconnect:{connectionId}:{revokedAt}`), show the dashboard banner;
   - `transient` → backoff 1/2/4/8/16 s with jitter (5 attempts, honouring `Retry-After`), then a Sentry alert, and the connection stays active;
   - `config` → a Sentry alert once, connection unchanged.
5. **Disconnect** (settings): `DELETE /appinstalls/2026-09/external-install` → revoke the refresh token → wipe tokens → `status=disconnected`, `disconnected_at`, `purge_after = +30 d` → cancel jobs. Processing stops immediately because every job checks the connection status.

### 9.2 Intake (D-07)
`pollPortal(account)`:
1. Skip unless the connection is active, the account is not paused, and it is entitled.
2. For each selected form, read submissions pages (`limit=50`) until a page has nothing newer than `cursor − 15 min`, or 20 pages (raise a Sentry warning at the cap).
3. For each new submission, in ascending `submittedAt`:
   - extract the fields (email, `firstname`, `lastname`, `company`, `message`, else the form's first `multi_line_text` field);
   - resolve the contact with `GET contacts/{email}?idProperty=email&properties=…`;
   - on 404, retry on the next poll for up to 60 min, then audit-skip;
   - insert `leads` + `lead_messages` with `ON CONFLICT DO NOTHING` on both unique keys;
   - for new rows, enqueue `lead_process`.
4. Advance the cursor only past processed submissions.

On resume or reactivation, cursors are set to "now": no backlog is drafted (D-41).

### 9.3 Process → draft → notify
`lead_process`:
1. Claim the lead.
2. **Classify** (Haiku; message + form name + first name + company; untrusted text inside delimiters).
3. **Filtered** classes stop here.
4. Otherwise **draft** (Sonnet 5.5) from brief + first name + company + message + form name → Zod → **validator** → on failure, one retry fed the error codes (a fresh single-turn request) → on a second failure or a refusal, `needs_touch` with the minimal safe template. Each attempt is recorded in `ai_calls`; totals go on `drafts`.
5. Mint 3 action tokens.
6. Render `NewLeadEmail` (subject `New lead: {Name} — your reply is ready`, or the needs-touch variant).
7. `Mailer.send` to `notify_emails` with idempotency key `lead-notify/{leadId}` → `notifications_sent`.
8. Set `first_notified_at`.
9. If follow-ups are on, create the 2 `scheduled_jobs` rows and publish.
10. Supersede older open leads for the same contact.

**Draft validator** (pure; golden-tested):
- word count ≤ 120 (follow-ups ≤ 70);
- plain text (no HTML or markdown);
- no unfilled placeholders (`[Name]`, `{{x}}`, `{first_name}`, `<NAME>`, `XXX`);
- the first name appears when known;
- the booking link appears verbatim when the brief has one;
- no currency amounts (symbols, ISO codes or words next to numbers) unless `allow_pricing`;
- no `never_promise` phrase (case-insensitive and whitespace-normalised);
- the subject is non-empty, one line and ≤ 120 chars.

It returns error **codes** only, never text.

### 9.4 Action links
Covered in §7.3. Composition and encoding follow D-13: `domain/compose.ts` contains `pct`, `pctAddr`, `mailto`, `gmail`, `outlook(kind)` and `chooseTarget(client, ua, via)`, with golden vectors from RESEARCH. BCC is added only when the owner saved a logging address.

### 9.5 Follow-up job (D-08, D-09)
1. Claim the job (hop if early).
2. Run `evaluateStops` on the DB state.
3. `GET contact/{id}?properties=email,hs_additional_emails,hs_email_optout,hs_email_bad_address,hs_email_hard_bounce_reason_enum,hs_sales_email_last_replied&associations=emails`. Handle 404/merge and opt-out/bounce stops.
4. `batchReadEmails(ids, METADATA_PROPS)` → `computeSignals` (pure) → update `send_confirmed_at` and `replied_at`.
5. If replied: mark it, cancel the remaining job, send `ReplyDetectedEmail` ("{Name} replied — follow-ups stopped").
6. Else draft the follow-up (≤70 words; it references the original draft's subject/body while that content still exists) → validate/retry/needs-touch → `FollowUpEmail`. The email includes honest notes when the first send is unconfirmed (D-33) or replies aren't logged (D-14).
7. For n = 2, set `no_reply_at`.
8. Mark the job done.

### 9.6 Inbox-logging check (D-14) and baseline (D-37)
**History:** two `emails/search` calls (`limit=1`, `total`): outbound `EMAIL` and inbound `INCOMING_EMAIL|FORWARDED_EMAIL` in the last 30 d.

**Live test:**
1. The owner enters a test address (another of their own addresses; ideally external).
2. We create a test lead plus a template draft (no LLM) and email the normal 3-button notification.
3. The owner taps **Send** from their phone or desktop.
4. The page polls `GET contacts/{testEmail}?idProperty=email&associations=emails` + `batchRead` every 20 s for up to 10 min for an `EMAIL` to the test address (**send leg**).
5. Next it asks the owner to reply from the test address, then polls up to 10 min for an `INCOMING_EMAIL` from it (**reply leg**).
6. It stores `logging_mode` and shows fix steps for each failed leg.

**Baseline (job):**
1. For each selected form, read submissions from the last 30 d → contact → associated emails → first `EMAIL` after `submittedAt` addressed to the lead.
2. Compute: the lead count; the median time to first outbound (only when n ≥ 3); leads with no logged outbound (shown only when the portal has any logged outbound history). Otherwise show "Not enough logged history".

### 9.7 Monday report (D-17, D-36)
1. Claim the job.
2. Window = the 7 days ending at this Monday 08:00 local.
3. Refresh signals for leads notified in the window (bounded, rate-limited).
4. `computeWeeklyMetrics(rows, baseline)` (pure) produces:
   - leads in, filtered, drafts delivered;
   - **sends confirmed** and **clicked but unconfirmed** on separate lines;
   - median lead → first confirmed send (n ≥ 3, else "Not enough data");
   - leads with no confirmed reply, with record links (first 20 + "and N more");
   - replies confirmed, follow-ups drafted;
   - baseline comparison (only when both sides are sufficient).
5. Render and send `WeeklyReportEmail` (idempotency `weekly-report/{account}/{week}`). Store the metrics (no content).

### 9.8 Billing (D-18 to D-20)
- **Trial:** 14 days from first install.
- **Entitlement:** `entitled(now, account, subscription)`, pure and table-tested over all 9 statuses + `created` + `none` + unknown.
- **Checkout:** described in §7.2. If the owner subscribes during the trial, `start_at = trial_end`.
- **Webhook and reconcile:** described in §7.2 and §8.
- **Becoming inactive:** processing stops (the poller skips the account; jobs stop), a banner shows, and one email is sent per transition (`billing-inactive/{account}/{transitionAt}`).
- **Cancel:** at cycle end.

### 9.9 Retention (daily, §5.14)
1. `delete from lead_messages where purge_at < now()`.
2. `update drafts set subject=null, body=null, purged_at=now() where purge_at < now() and purged_at is null`.
3. `inbox_checks.test_address = null` after 24 h.
4. For accounts with `purge_after < now()`: delete the Supabase auth user (admin API), then `delete from accounts` (cascades everywhere).
5. Prune `webhook_events` > 30 d, expired `action_tokens`, and `rate_limits`.

Every step is tested on PGlite with a fixed clock.

---

## 10. Security and privacy design (§2, §7)

1. **Signatures** (each with known-vector tests from RESEARCH):
   - HubSpot v3: HMAC-SHA256 base64 over `method + uri + rawBody + timestamp`, using the env target URL, the ±300 000 ms rule, and timing-safe comparison;
   - QStash: `Receiver.verify` with `url`, `clockTolerance: 5`, `devMode: false`; a JWT signed with the public dev key must be rejected;
   - Razorpay: hex HMAC of the raw body with the webhook secret, timing-safe, empty secret refused.
2. **Crypto:**
   - tokens use AES-256-GCM (`v1.iv.ct.tag`, AAD-bound); `TOKEN_ENCRYPTION_KEY_PREVIOUS` is used to decrypt during rotation;
   - action tokens are 32 random bytes (`apt_` + base64url) stored as SHA-256 hashes, single-purpose, scoped to a lead and draft, expiring after 7 days;
   - OAuth `state` and `pending_install` cookies are HMAC-signed with `APP_SECRET`, httpOnly, Secure and SameSite=Lax.
3. **Zod everywhere:** env, webhook bodies, HubSpot/Razorpay/QStash payloads, AI output, form posts, query params.
4. **SSRF guard** for the owner-supplied website URL:
   - `http`/`https` only;
   - resolve DNS and block private, loopback, link-local, CGNAT and metadata ranges (IPv4 + IPv6);
   - at most 3 redirects, each re-checked;
   - 10 s timeout and 2 MB cap per page;
   - honour `robots.txt` with our own user agent `HublytixAutopilot/1.0`.
5. **Rate limits:** Postgres fixed windows on `/a/*`, `/login`, `/auth/confirm` and `/api/hubspot/install` (D-35).
6. **Headers:**
   - `src/proxy.ts` deletes inbound `content-security-policy(-report-only)` request headers, then sets a nonce CSP: `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'nonce-…'; img-src 'self' data:; connect-src 'self' <sentry ingest>; frame-ancestors 'none'; form-action 'self' https://mail.google.com https://outlook.cloud.microsoft https://outlook.live.com; base-uri 'self'; object-src 'none'`;
   - `next.config` sets HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (keeps token URLs out of Referer), `Permissions-Policy`, and `poweredByHeader: false`.
7. **Logging and Sentry:**
   - one `redact()` is shared by the logger and the Sentry scrubber (D-23);
   - no content, tokens, email addresses or compose URLs are ever logged;
   - AI and SDK error messages are dropped, keeping class/status/request id only.
8. **No secrets in client bundles:** `server-only` everywhere in `src/server`; a CI check greps `.next/static` for secret-looking strings and env names.
9. **Read-only HubSpot:** `REQUIRED_SCOPES` is a single constant. A test fails if any scope does not end in `.read`, apart from the allow-list (`oauth`, `forms`, `sales-email-read`).
10. **Email metadata allow-list test** (D-03).

---

## 11. Observability

- **Logger:** `src/server/obs/log.ts` writes JSON lines `{level, msg (static string), event, ids…, codes…}`. Only allow-listed keys pass, values go through `redact()`, and free text is never logged.
- **Sentry:** shared options in `src/server/obs/sentry-options.ts`, imported by all three init files. Errors only; restrictive `dataCollection`; `tracePropagationTargets: []`; `Anthropic_AI` and `Console` integrations removed; `beforeSend`/`beforeBreadcrumb` = `scrubEvent`/`scrubBreadcrumb`. Without a DSN (fake mode) Sentry is a no-op.
- **Proof tests:**
  - `scrubber.test.ts`: golden events containing tokens, message text, drafts and emails in URL/path/query/body/extra/breadcrumbs/exception values must come out clean;
  - `sentry-envelope.test.ts`: the real `@sentry/node` with the shared options and an in-memory transport; the serialized envelopes must not contain the fixture strings.

---

## 12. Testing strategy

- **Unit (pure `domain/`, `security/`):** fast and table-driven.
- **Integration (`services/`):** real SQL on PGlite (`test/db/harness.ts`: create once per file, then `clone()` per test, with the shim and migrations) + fakes + `FakeClock`.
- **Route tests:** call the `src/server/http/*` handlers with real `Request` objects (signatures included).
- **Simulation:** `npm run simulate` and `test/simulate.test.ts` (in-memory) assert `summary.json`.

| Brief §8 required test | Where |
|---|---|
| Validator golden cases | `domain/validator.test.ts` (≥30 cases: word limits, placeholders, first name, booking link, currency variants, never-promise, plain text) |
| Signature verification with known vectors | `security/hubspot-signature.test.ts` (5 vectors + 10 negatives incl. the 300000/300001 boundary), `razorpay-signature.test.ts` (A–C + negatives), `qstash.test.ts` (jose-signed JWTs, fake timers, dev-key rejection) |
| Token refresh: revoked vs transient | `services/token-manager.test.ts` with exact HubSpot error fixtures (`invalid_grant`/`BAD_REFRESH_TOKEN`, `BAD_HUB`, `invalid_client`, 429 `TEN_SECONDLY_ROLLING`/`DAILY`, 502, timeout) |
| Follow-up stop rules | `domain/stops.test.ts` (one case per stop and per combination) + `services/followups.test.ts` |
| Quiet-hours scheduling across timezones | `domain/quiet-hours.test.ts` (zones and DST listed in §8.3) |
| Checkout guard | `domain/checkout-guard.test.ts` (every status) + `entitlement.test.ts` |
| Retention purge | `services/retention.test.ts` (PGlite, fixed clock, cascade) |
| Idempotent webhook replay | `http/hubspot-webhook.test.ts` (same body twice; `attemptNumber` 0 and 1; webhook plus poller → one lead) + Razorpay duplicate/replay tests |

Additional tests:
- RLS/grants migration test;
- compose vectors (TV1–TV3, lone surrogate, IDN, plus sign, `&`, CRLF);
- newsletter detection;
- Monday due-check (Kolkata/Kathmandu);
- weekly metrics;
- reply/confirmed-send signal evaluation;
- `toClaudeJsonSchema` snapshots and `buildModelParams`;
- `REQUIRED_SCOPES` vs `app-hsmeta.json`;
- email metadata allow-list;
- SSRF guard;
- robots parser;
- CSP builder;
- env validation (live mode requires everything; `QSTASH_DEV` forbidden);
- crypto round-trip and tamper;
- action-token purpose and expiry;
- scrubber and envelope;
- module-boundary lint.

---

## 13. Simulation (`npm run simulate`)

**Setup:** fakes only, PGlite in memory, `FakeClock`. Portal `1234567`, timezone `America/New_York`, `uiDomain app.hubspot.com`, logging mode `log_all`. The 3 forms are:
- **Contact us:** name/email/company/message.
- **Request a quote:** name/email/company/message.
- **Newsletter signup:** email only, lifecycle stage `subscriber`. It is auto-detected and unticked.

**Pre-run:** the scripted install and onboarding run first:
- owner email → magic link (outbox);
- brief generated from the fixture site via FakeWebFetcher + FakeLLM, then saved;
- forms selected;
- preferences: Gmail, quiet hours 19–08, weekends skipped, BCC on;
- inbox check (both legs ✓);
- baseline from the fixture history.

**Calendar** (D-38):

| Step | Local time | Events |
|---|---|---|
| Day 0 | Tue 2026-10-06 10:00 | 6 submissions. **#1** normal lead (new contact, Contact us). **#2** no message (Request a quote). **#3** spam. **#4** vendor pitch. **#5** repeat submission by a pre-existing contact: no webhook, found by the poller. **#6** a lead who will reply. Webhooks fire for the new contacts → polls → processing. Owner taps **Send** for #1, #6 (logged in HubSpot) and #2 (never logged → clicked but unconfirmed). |
| Day 1 | Wed 10:00 | Owner sends #5 from the original email (logged). |
| Day 2 | Thu ~10:01 | fu1 for #1, #2, #5, #6 |
| Day 3 | Fri 14:00 | #6 replies (`INCOMING_EMAIL` from the lead's address) |
| Day 5 | Sun ~10:01 | fu2 is due but weekends are skipped → moved to Mon 08:00. **No emails.** |
| Monday | Mon 2026-10-12 08:00 | fu2 jobs run: #1, #2, #5 get follow-up 2; #6's reply is detected → "replied — follow-ups stopped". Then the due-check sends the Monday report. |

**Expected outbox: 15 emails.**

| When | Emails |
|---|---|
| Onboarding | magic link, inbox test |
| Day 0 | `new_lead` ×4 (#1, #2, #5, #6) |
| Day 2 | `follow_up` ×4 |
| Monday | `follow_up` ×3, `reply_detected` ×1, `weekly_report` ×1 |

**Expected final statuses:**
- #1 `no_reply`, with send confirmed;
- #2 `no_reply`, clicked but unconfirmed;
- #3 `filtered` (spam);
- #4 `filtered` (vendor_pitch);
- #5 `no_reply`, with send confirmed;
- #6 `replied`.

**Expected report:**
- leads in 6, filtered 2, drafts delivered 4;
- sends confirmed 3, clicked but unconfirmed 1;
- median lead → confirmed send computed (n = 3);
- no confirmed reply: #2 with its record link;
- replies confirmed 1;
- follow-ups drafted 7;
- a baseline comparison.

**Output:** `./outbox/NNN-<kind>-<lead>.html` (+ `.txt`) and `./outbox/summary.json`:
`{scenario, timeline[], emails[{file, kind, lead, at}], leads[{ref, scenario, classification, status, timeline}], weeklyReport{metrics}, checks[{name, expected, actual, pass}], ok}`.

The script exits non-zero if any check fails. `outbox/` is git-ignored.

---

## 14. Environment variables (`.env.example`, one-line comment each)

| Group | Variables |
|---|---|
| App | `APP_MODE` (fake\|live), `APP_URL`, `PRODUCT_NAME`, `NEXT_PUBLIC_PRODUCT_NAME`, `APP_SECRET` (cookie HMAC + rate-limit salt), `TOKEN_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY_PREVIOUS`, `ADMIN_EMAILS`, `COMPOSE_URL_LIMIT`, `ENV_NAMESPACE` |
| Database / auth | `DATABASE_URL` (transaction pooler, :6543), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `FAKE_DB_DIR` |
| HubSpot | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_APP_ID`, `HUBSPOT_REDIRECT_URI`, `HUBSPOT_WEBHOOK_TARGET_URL`, `HUBSPOT_API_VERSION` (2026-09), `HUBSPOT_JOURNAL_ENABLED` (false) |
| QStash / cron | `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_MAX_DELAY_SECONDS`, `CRON_SECRET` |
| Email | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` |
| AI | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_DRAFT` (claude-sonnet-5-5), `ANTHROPIC_MODEL_FAST` (claude-haiku-4-5-20251001), `ANTHROPIC_DRAFT_EFFORT` (medium), `ANTHROPIC_BRIEF_EFFORT` (high) |
| Billing | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`, `RAZORPAY_PLAN_ID` |
| Sentry | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` (build only) |

Validation (`env.ts`):
- In `live` mode, every required variable must be present and well-formed (key prefixes, 32-byte base64 keys, URLs). The build fails fast otherwise.
- `QSTASH_DEV` must be unset in live mode.
- In `fake` mode none are needed.

---

## 15. Milestones (each ends with `npm run typecheck && npm run lint && npm test` green → one commit → a 5-line summary)

### M1: Scaffold, CI, migrations, PGlite harness, fakes, CLAUDE.md
- [ ] Next 16 app (`src/` layout), TS strict, Tailwind 4, ESLint 9 flat config with boundary rules, Vitest; `package.json` scripts `dev`, `build`, `start`, `typecheck`, `lint`, `test`, `simulate`
- [ ] `.github/workflows/ci.yml` (Node 22: install, typecheck, lint, test, simulate)
- [ ] `src/server/env.ts` (Zod, fake/live, boot assertions) + `.env.example` (complete)
- [ ] `supabase/migrations/20261001000001_init.sql`: all tables in §5 with RLS, grants and indexes; `supabase/config.toml`
- [ ] `test/db/harness.ts` + `supabase-shim.sql`; migration/RLS/grants test
- [ ] `Db` interface + Postgres.js (serialised) + PGlite implementations; base repos
- [ ] All port interfaces + fake adapters (Clock, HubSpot, LLM, Mailer, Scheduler, Billing, WebFetcher, Auth) with their own unit tests; `container.ts`
- [ ] `src/instrumentation.ts`, `instrumentation-client.ts`, `sentry.*.config.ts`, shared Sentry options + scrubber + scrubber/envelope tests; file-layout test (`src/instrumentation.ts` exists, no root `app/` or `instrumentation.ts`)
- [ ] Logger with `redact()`; `security/crypto.ts` (AES-GCM) + tests
- [ ] `CLAUDE.md` (git rules, laws, boundaries, commands, "read `node_modules/next/dist/docs` before Next code"), `README.md` skeleton, `docs/ARCHITECTURE.md` skeleton

### M2: HubSpot OAuth, connection management, webhook intake, poller, classification
- [ ] `hubspot-app/` project files (`hsproject.json`, `app-hsmeta.json`, `webhooks-hsmeta.json`) + `REQUIRED_SCOPES` constant + diff test
- [ ] Live `HubSpotHttpClient` (dated path builder, Zod schemas, per-portal limiter, error mapping incl. 423/429/477/5xx; metadata allow-list)
- [ ] `/api/hubspot/install`, `/api/hubspot/oauth/callback` (state, scopes check, account details, encrypted tokens, trial start, `pending_install`)
- [ ] Token manager: refresh, single-flight, `classifyRefreshFailure`, revoked handling (cancel jobs, reconnect email once, banner flag), transient backoff + Sentry; tests with fixtures
- [ ] `/api/hubspot/webhooks` (v3 verification + vectors, Zod, composite dedupe, debounced poll trigger, privacy deletion, inactive portals ignored) + replay test
- [ ] `/api/jobs/run` + `/api/jobs/failed` + dispatcher + QStash scheduler adapter (hop, cancel 404 = ok, never bulk) + Receiver verification tests
- [ ] Poller (`/api/cron/poll`, lease, `pollPortal`: submissions paging, cursor/overlap, contact resolution, lead + content insert, enqueue) + cron auth (Bearer or QStash)
- [ ] Classification service (Haiku params, structured output via `toClaudeJsonSchema`, `ai_calls`) + live `AnthropicLLM` + `buildModelParams` tests; filtered handling + override hook

### M3: Brief builder, onboarding, inbox check, baseline
- [ ] `HttpWebFetcher` + SSRF guard + robots parser + page selection (services/pricing/about/contact/faq, ≤8 internal) + text extraction; tests on the fixture site
- [ ] Brief generation (Sonnet adaptive/high, schema, `faqs ≤ 8`, booking-link check against fetched content) + editor + `brief_versions`
- [ ] Auth: `AuthProvider` (Supabase `generateLink` + own mailer; fake), `/login`, `/auth/confirm` (GET button, POST verify), proxy session refresh, owner binding (D-34)
- [ ] Onboarding pages (email, brief, forms with newsletter detection, preferences, inbox, baseline) + progress state
- [ ] Inbox check: history counts + two-leg live test + `logging_mode` + fix-step copy
- [ ] Baseline job + "Not enough logged history" rules

### M4: Draft engine, validator, notification emails, action-link pages
- [ ] Draft + follow-up prompts (untrusted delimiters), `draft` service with one retry → needs-touch template; token/cost tracking
- [ ] Validator + ≥30 golden cases
- [ ] React Email templates: NewLead, NeedsTouch, FollowUp, ReplyDetected, WeeklyReport (stub), ReconnectHubSpot, BillingInactive, MagicLink, InboxTest; `renderEmail → {html, text}`; live `ResendMailer` (idempotency keys, ASCII tags, no tracking)
- [ ] Action tokens (mint/hash/verify/expiry/purpose) + `/a/[token]/send|copy|edit|dismiss` (scanner-safe dismiss, click heuristics, 302/interstitial/copy) + compose builders with golden vectors
- [ ] `lead_process` end to end on fakes (classify → draft → notify → schedule)

### M5: Follow-up scheduler, reply detection, stop rules
- [ ] `shiftToAllowed` + timezone tests; follow-up scheduling (rows + publish, hop)
- [ ] Follow-up job: stops, contact read (404/merge/opt-out/bounce), signals (`computeSignals`), replied path (cancel + email), follow-up draft path (honest notes), `no_reply`
- [ ] Superseding older leads; dismiss cancels; pause/revoke/inactive cancel jobs
- [ ] Tests: stop matrix, signals, at-least-once replay (duplicate delivery → one email)

### M6: Monday report and dashboard
- [ ] Due-check cron + `weekly_report` job + `computeWeeklyMetrics` (pure) + WeeklyReport template (separate confirmed/clicked lines, "Not enough data", record links via `uiDomain`)
- [ ] Dashboard (status card, banners, recent leads with one status each, lead detail with override/resume), brief editor page
- [ ] Tests: metrics, due-check zones, honest-copy snapshot (no merged counts)

### M7: Billing, trial, settings, disconnect/purge, admin
- [ ] Live `RazorpayBilling` (fetch: create/fetch/cancel/plan) + checkout route + guard + entitlement + webhook (verify, window, dedupe, fetch-and-apply) + daily reconcile + inactive banner/email; fake checkout page
- [ ] Settings page (all §5.11 items) + pause all + disconnect (uninstall API + revoke + purge clock)
- [ ] Daily maintenance cron (retention, account purge incl. auth user, prune, account-details refresh)
- [ ] `/admin` (ADMIN_EMAILS, no content)
- [ ] Rate limiting on public/auth routes; CSP/security headers + tests

### M8: Public pages, simulate polish, docs, REVIEW
- [ ] Landing, `/privacy` (sub-processors + email-metadata disclosure), `/terms`, `/refunds`, `/shipping` (all `TODO: legal review`)
- [ ] `scripts/simulate.ts` complete per §13 + `test/simulate.test.ts`; `/dev` panel
- [ ] `docs/ARCHITECTURE.md`, `README.md`, `docs/WIRE_UP.md` (9 steps, click by click, incl. the live re-checks in §17) final; `.env.example` final; `CLAUDE.md` final
- [ ] Client-bundle secret check; `npm audit` review
- [ ] REVIEW: run the Definition of Done (§18) and report pass/fail per line

---

## 16. Risks and mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | `sales-email-read` turns out not to be grantable for a marketplace app (evidence is community-level) | No confirmed sends, replies, inbox check or baseline | Granted scopes are detected at install; features show "Not enough data"; the WIRE_UP smoke test calls `GET /crm/objects/2026-09/emails?limit=1` first (D-03) |
| R2 | Reply detection depends on the owner's logging setup (connected inbox + "log all") | Follow-ups sent after an unlogged reply | Two-leg inbox test, `logging_mode`, a warning on every follow-up email; owners always review before sending; "Resume follow-ups" for auto-replies (D-14) |
| R3 | Legacy form submissions endpoint (`/form-integrations/v1`) is in HubSpot's v1–v3 sunset (Sept 2027) | Intake breaks | The `LeadSource` boundary; watch the changelog; the CRM search trigger is a documented fallback (D-07) |
| R4 | 25-install cap until Marketplace listing | Growth beyond 25 portals is blocked | Built to listing rules from day one; listing work tracked outside v1 (D-42) |
| R5 | Gmail and Outlook compose URLs are undocumented | Broken send button | Config-driven hosts and modes; mailto secondary link always shown; copy-reply fallback; manual tests in WIRE_UP step 9 (D-13) |
| R6 | Vercel Hobby crons (likely daily-only; unverified) | Poller won't run | Vercel Pro in WIRE_UP or the QStash schedules script (D-16) |
| R7 | QStash Free limits (7-day delay; daily quota not verified) | Follow-ups rejected | Hop scheduling; Pay-as-you-go recommended in WIRE_UP; daily rate-limit errors alert via Sentry (D-15) |
| R8 | Haiku 4.5 retirement floor of 2026-10-15 | Classification fails | Env swap to Sonnet 5.5 with no code change; 404 on a model alerts the admin (D-25) |
| R9 | Next 16 deviates from the brief | Owner may prefer 14 | Clearly flagged; documented 14.x fallback with mitigations (D-01) |
| R10 | Link scanners pre-click links | False "send clicked"; accidental dismissals | POST-only dismiss; HEAD and scanner-UA filtering; clicks never count as confirmed (D-26) |
| R11 | LLM quality, refusals or prompt injection in lead text | Bad drafts | Deterministic validator + retry + needs-touch; untrusted delimiters; the owner always reviews; effort sweep at wire-up (D-24) |
| R12 | Razorpay USD needs International Cards; the review may reject placeholder policy pages | Can't charge | Policy pages exist (placeholders now); legal text before activation; WIRE_UP step 7 (D-20) |
| R13 | PGlite (PG 18.3) vs Supabase (PG 15/17) version skew | SQL works in tests but not in prod | Conservative SQL (no PG18-only features); migrations applied via `supabase db push --dry-run` first |
| R14 | Transaction pooler pipelining can return mismatched rows | Data corruption | Queries serialised per client; multi-statement work in one transaction (D-27) |
| R15 | Search/association eventual consistency | Missed or late signals | Associations + batch read (record store) for signals; overlap windows for polling |
| R16 | Unsure whether `/account-info` enforces an undocumented scope (`external-settings-access`) | No auto timezone | Owner-selected timezone fallback; smoke test (D-12) |
| R17 | Many items are unverifiable from the sandbox (blocked vendor docs) | Wrong assumptions in wire-up | Listed in §17 and repeated as checks in WIRE_UP |
| R18 | AI cost per lead | Margin | Estimate: ~$0.002 classification + ~$0.01 per draft × up to 3 drafts ≈ $0.03/lead; `ai_calls` tracks the real cost; admin page shows per-portal monthly totals |

---

## 17. Facts to re-check live during WIRE_UP (from RESEARCH)

1. `sales-email-read` is selectable and the emails endpoints return 200.
2. Forms submissions endpoint: default/max page size, newest-first order, `forms` scope, behaviour on Free and Starter portals.
3. `account-info/2026-09/details` works with the `oauth` scope.
4. BCC address location and behaviour, and connected-inbox "Log all" on Free and Starter (both legs of the inbox test).
5. Gmail and Outlook (work and personal) compose links prefill to/subject/body **and BCC**, signed in and signed out, on desktop and phone.
6. Vercel Cron plan limits; whether Deployment Protection blocks QStash.
7. QStash plan max delay, retries and daily quota.
8. Razorpay: USD plan creation, International Cards, Flash Checkout, `created → retry` on the same `short_url`.
9. Webhook settings caching (up to 5 min) before the live test.
10. Webhooks Journal availability (only if `HUBSPOT_JOURNAL_ENABLED` is to be switched on).

---

## 18. Definition of Done mapping (brief §12)

| DoD line | How it is proven |
|---|---|
| `npm run simulate` produces all expected emails with correct statuses in `summary.json` | §13 checks inside the script (non-zero exit on failure) + `test/simulate.test.ts` in CI |
| Typecheck, lint and tests green | CI workflow + local run at every milestone |
| No secrets, tokens or message text in logs or Sentry payloads; a test proves the scrubber | `scrubber.test.ts` + `sentry-envelope.test.ts` + logger redaction test + AI-error sanitising test |
| Every [VERIFY] item resolved in RESEARCH.md with a source link | RESEARCH.md §0 index table (one row per marker, with links) |
| WIRE_UP.md complete enough for someone who has never seen the code | M8 deliverable, 9 steps in the brief's order, exact clicks/commands, plus a smoke test and screenshot checklist |
| RLS enabled on every table, asserted by a migration test | `test/db/migrations.test.ts` (RLS + grants) |
