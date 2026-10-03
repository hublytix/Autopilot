# Architecture

How Hublytix Autopilot is put together, as built through M8. [`PLAN.md`](PLAN.md) is the approved design and wins where this page is less precise; [`DECISIONS.md`](DECISIONS.md) has the rule behind each choice (D-xx), and [`WIRE_UP.md`](WIRE_UP.md) connects the real services.

**Contents:** [1 System](#1-the-system) · [2 Layers](#2-layers-and-boundaries) · [3 Ports, fakes, container](#3-ports-fakes-and-the-container) · [4 Data model](#4-data-model) · [5 Jobs](#5-jobs-the-outbox-and-the-sweeper) · [6 Owner emails](#6-owner-emails-the-notification-reservation) · [7 Data flow](#7-data-flow) · [8 Auth, proxy, CSP](#8-auth-sessions-the-proxy-and-csp) · [9 Billing and lifecycle](#9-billing-and-the-account-lifecycle) · [10 Retention](#10-retention-and-purge) · [11 Observability](#11-observability-and-scrubbing) · [12 Transactions and locks](#12-transactions-and-the-lock-order) · [13 Security map](#13-security-map) · [14 Testing and simulation](#14-testing-and-simulation) · [15 Where things live](#15-where-each-concern-lives)

## 1. The system

One Next.js 16 application (App Router, `src/`), deployed on Vercel, with every external service behind a port:

```
                 owner's browser / phone                         lead (fills a HubSpot form)
                          │                                                   │
      pages, Server Actions, /a/{token} links                                 ▼
                          │                                     HubSpot portal (read-only OAuth app)
                          ▼                                       │ webhooks          ▲ REST reads
   ┌────────────────── Next.js app on Vercel ──────────────────┐ ▼                   │
   │ src/proxy.ts (CSP nonce, session refresh)                  │◄─ /api/hubspot/webhooks
   │ route handlers · pages · Server Actions                    │──────────────────────┘
   │ services (intake, drafting, notifications, follow-ups,     │──► Anthropic (drafts, briefs, classification)
   │   reports, billing, retention) over ports                  │──► Resend (every email to the owner)
   │ /api/jobs/run, /api/jobs/failed ◄── QStash (delayed jobs) ─┤◄─► QStash (publish, cancel)
   │ /api/cron/* ◄── Vercel Cron (or QStash schedules)          │◄─► Razorpay (subscriptions; webhook)
   │                                                            │──► Sentry (errors only, scrubbed)
   └──────────────┬─────────────────────────────────────────────┘
                  ▼ Postgres.js (transaction pooler)      ▲ admin API, verifyOtp
             Supabase Postgres (RLS, no grants to anon)  Supabase Auth (magic links)
```

The product laws (brief §2, `CLAUDE.md`) shape all of it: the app never sends email as the owner (it emails the owner a draft and a compose link), never writes to HubSpot, counts only what HubSpot confirms, stores lead content for at most 30 days and never logs it, and says nothing untrue.

## 2. Layers and boundaries

```
src/app/**                      thin route files, pages, Server Components, global-error.tsx
   │  may import only ▼  (plus shared/, components/, and types from anywhere)
server/http · server/views · server/actions · server/container
   │                  route handlers (Request → Response), read models on OwnerScope,
   ▼                  Server Action bodies (each calls requireOwner())
server/services ──── take a Deps object ────▶ server/ports   (interfaces only)
   │                                               ▲
   │ use                                           │ implement
   ▼                                               │
server/domain   (pure)              server/adapters/live · server/adapters/fake
```

- **domain** is pure: validator, quiet hours, follow-up schedule, stop rules, signals, lead status, processing state, entitlement, checkout guard, compose links, report due-check and weekly metrics, robots parser. It imports only `domain/`, `zod` and `luxon`, so it is tested without a database or fakes.
- **ports** are the boundary to the outside world: `Clock`, `HubSpotClient`, `LLM`, `Mailer`, `Scheduler`, `Billing`, `WebFetcher`, `AuthProvider`. `Deps` bundles them with `env` and `db`.
- **adapters** implement the ports: `live/` against the real services, `fake/` in memory or on PGlite. Adapters never import services.
- **services** orchestrate one use case each over `Deps` and SQL. They never import adapters.
- **http / views / actions** are the only server modules pages and route files may call. Route files stay thin: `export async function POST(req) { return handleX(req, await getDeps()); }`.
- **Supporting modules:** `db/` (the `Db` interface, transaction guard, `DbError`, migrations runner), `security/` (crypto, keys, tokens, signatures, SSRF guard, CSP, rate limits, same-origin, cookies, the HubSpot request allow-list), `jobs/` (dispatcher, claim and lease, outbox publisher, re-publish, sweeper, failure path, alerts), `ai/` (model parameters, JSON-schema helper, prompts, pricing), `hubspot/` (scopes, paths, signature, refresh classifier), `email/` (rendering), `obs/` (logger), `env.ts`.
- **Client-safe code** lives in `src/shared/` (including `redact()` and the shared Sentry options), `src/components/` and `src/emails/`. None of it imports `src/server`. Every module under `src/server` imports `'server-only'`, so a client component that reaches for it fails the build.
- `src/proxy.ts` may import only the CSP builder and the `AuthProvider` session-refresh adapters.

Enforcement: ESLint `no-restricted-imports` (with `allowTypeImports`) on the raw specifier, plus a local rule (`autopilot/import-boundaries` in `eslint.config.mjs`) that resolves `@/`, relative paths, `import()`, `require()` and re-exports; `test/layout/boundaries.test.ts` refuses inline disables. Wall-clock reads (`Date.now()`, argument-less `new Date()`, `DateTime.now()` and Luxon's implicit "now") are banned outside `SystemClock`.

## 3. Ports, fakes and the container

| Port | Live adapter (`src/server/adapters/live/`) | Fake (`src/server/adapters/fake/`) |
|---|---|---|
| `Clock` | `system-clock.ts` (the only wall-clock reader) | `FakeClock` (tests, simulation), `DevClock` (dev: wall clock + an offset `/dev` advances, persisted) |
| `HubSpotClient` | `hubspot/` (plain `fetch` + Zod, dated paths, request allow-list, metadata allow-list) | in-memory portal from `test/fixtures/hubspot-portal.json`, logging modes, refresh modes, v3-signed webhooks, consent page `/dev/fake-hubspot/authorize` |
| `LLM` | `anthropic-llm.ts` (`messages.create` with JSON schema, per-model parameters) | deterministic classifier and validator-passing drafts; fault injection; asserts each request's parameters are valid for its model |
| `Mailer` | `resend-mailer.ts` (idempotency key, Reply-To, error classes) | `fake.dev_outbox` (dev), memory (tests), `./outbox` (simulation); Resend's idempotency semantics |
| `Scheduler` | `qstash-scheduler.ts` (`notBefore`, dedupe id, 4 retries, backoff, failure callback) | ordered queue delivering through the same dispatcher (`jobs/bridge.ts`), with redelivery, crash and exhausted-retry simulation |
| `Billing` | `razorpay-billing.ts` (REST via `fetch`) | fake subscriptions; `/dev/fake-checkout/{id}` emits signed webhooks |
| `WebFetcher` | `http-web-fetcher.ts` (undici with the SSRF guard on the socket) | the fixture site `test/fixtures/site` |
| `AuthProvider` | `supabase-auth.ts` (admin API, `verifyOtp`, session cookies) + `auth.ts` (proxy refresh) | signed `ap_session` cookie; links written to the outbox |

**The container** (`src/server/container.ts`) is the composition root. `getDeps()` builds `Deps` once per process from `env.ts`, never during `next build`: every page and layout reads the request (`await headers()`) before it calls `getDeps()`, so the build's prerender attempt stops there, and `getContainer()` refuses with `ConfigError('container_at_build')` under `NEXT_PHASE=phase-production-build` (D-86):
- **Live** (`APP_MODE=live`): `SystemClock`, Postgres.js on the Supabase transaction pooler (`{max: 1, prepare: false}`, queries serialised), and the live adapters, imported only when the live container is built.
- **Fake** (`APP_MODE=fake`): PGlite under `FAKE_DB_DIR`, migrated on first open (a lazy `globalThis` singleton, never opened at import time or from the proxy); every fake configured from `Env`; their state (portal, billing, auth, clock offset) persisted in `fake.state`; a dev job ticker that delivers due jobs every 10 s and runs the poll cron once per 5-minute slot of DevClock time. Fake mode needs no credentials and is refused on Vercel unless explicitly allowed (D-29).
- Every container points Luxon's `Settings.now` at its `Clock`. Tests pin it to a fixed year-2000 instant (`test/setup/luxon-clock.ts`).

**The `/dev` panel** (fake mode only; the layout, the page and the routes answer 404 otherwise; PLAN §7.6) is a server-rendered page (`src/app/dev/page.tsx`, read model `src/server/http/dev/panel.ts`) that shows the fake clock and its offset, the ticker, the fake scheduler's queue, the accounts with their subscriptions (an open checkout links `/dev/fake-checkout/{id}`), the fake portal as HubSpot sees it, the dev outbox (latest 50, each email at `/dev/email/{id}` in a sandboxed iframe without scripts) and a reset. Every action is a same-origin form POST to `/dev/actions` (works without JavaScript; Origin checked; Zod per action), answered `303 /dev?done=…|error=…`: submit a lead (a new contact gets HubSpot's signed `object.creation` webhook through the real handler), log the owner's send or the lead's reply, revoke the HubSpot token, opt a contact out, advance the clock, run due jobs (deliveries, the poll cron, the weekly due-check), run the daily maintenance, deliver Razorpay's queued webhooks, and reset (session cleared, persisted fakes restored to a fresh container's state, the scheduler queue cancelled, the clock back to real time, every table emptied). The composition that builds fresh fakes for the reset sits in `src/server/actions/dev/` because `http/` may not import adapters.

**The public pages** (`/`, `/privacy`, `/terms`, `/refunds`, `/shipping`) are server components with no data access; their facts (stores, sub-processors, the HubSpot disclosure, prices) live once in `src/components/marketing/legal.ts`. Each legal page carries "TODO: legal review"; `/privacy` gives day counts only for stores Autopilot controls.

`env.ts` parses the environment lazily (so `next build` needs none), applies the documented defaults, fills documented fake values in fake mode (which live mode refuses), and in live mode requires every variable without a default, well-formed (D-29, D-51, PLAN §14).

Job handlers, failure paths, notification resumers and failure hooks are registered in one place, `src/server/jobs/handlers.ts`.

## 4. Data model

Migrations live in `supabase/migrations/` (the init migration plus four later files). Rules for every `public` table (PLAN §5, D-21, D-28):
- RLS enabled, every privilege revoked from `anon` and `authenticated`, `select/insert/update/delete` granted to `service_role`, no policies; default execute on functions revoked.
- Statuses are `text` + `check`; IDs `uuid`, log tables `bigint` identity; hashes are hex `text`.
- Every logical timestamp is bound from the `Clock` as `$now`; `default now()` exists only on the audit columns `audit_log.at` and `webhook_events.received_at`.
- Account-scoped tables cascade from `accounts`; the tombstones `portal_history` and `billing_tombstones` are outside the cascade on purpose.

| Group | Tables | Holds content? |
|---|---|---|
| Account | `accounts` (processing state, trial, timezone, logging mode, purge dates), `users`, `settings`, `login_intents` | owner addresses only |
| HubSpot | `hubspot_connections` (tokens encrypted `v1.kid.iv.ct.tag`, refresh lease, status), `selected_forms` (floors and cursors) | encrypted tokens |
| Brief | `briefs`, `brief_versions`, `brief_jobs` | business info (public website) |
| Leads | `leads` (IDs, timestamps, statuses only), **`lead_messages`** (message, first/last name, company, email; `purge_at`), **`drafts`** (subject, body, flags; nulled at purge) | **yes: purged at 30 days** (D-31) |
| Work | `scheduled_jobs` (the job outbox), `notifications_sent` (reservations, no bodies), `action_tokens` (sha256 hashes only) | none |
| Measurements | `baselines`, `inbox_checks` (test address cleared at 24 h, HMAC kept), `weekly_reports` (metrics JSON: ids, times, numbers, record links), `ai_calls` (tokens and cost) | test address for 24 h |
| Billing | `subscriptions`, `billing_tombstones`, `portal_history` | none |
| Plumbing | `webhook_events`, `audit_log` (allow-listed meta), `rate_limits`, `leases`, `auth_user_deletions` | none |

The `fake` schema (`_migrations` ledger, `dev_outbox`, `state`) exists only in PGlite, created by `src/server/db/fake-shim.sql`. `test/db/migrations.test.ts` proves RLS, grants, the function revoke, the ledger and the `now()` scan on the migrated tables.

## 5. Jobs, the outbox and the sweeper

Background work is a row in `scheduled_jobs`, delivered by QStash in live mode and by the FakeScheduler in fake mode (D-15, PLAN §8.3):

1. **Insert with the state change.** The job row is written in the same transaction as the change that needs it (`jobs/outbox.ts insertJob`), with a dedupe key.
2. **Publish after commit** (`publishJob`): QStash gets `{jobId}` only, `notBefore`, the dedupe id `{ENV_NAMESPACE}:{key}[:h{hops}]`, `Upstash-Retries: 4` and a failure callback. The message id is stored.
3. **Deliver** to `POST /api/jobs/run` (QStash signature verified against that exact URL). `runJob` (`jobs/dispatcher.ts`) first checks the hop: a target more than 60 s away is re-published for later, so delays beyond QStash's maximum work.
4. **Claim** (`jobs/claim.ts`): one compare-and-set to `running` with an attempt id and a 6-minute lease. Every later write is guarded by that attempt id (`assertJobOwned`).
5. **Outcome:** done → 200; transient → back to `scheduled`, 5xx (QStash backs off; on the fifth delivery the failure path runs inline); permanent → the failure path, 489 + `Upstash-NonRetryable-Error`; a live lease elsewhere → 503 + `Retry-After`; already finished → 200.
6. **Failure callback** `POST /api/jobs/failed`: a compare-and-set to `failed` that only a job no live attempt holds can win; only the winner runs the failure path (`jobs/failure.ts`). Every failure raises the `job_failed` alert.
7. **Sweeper** (`jobs/sweeper.ts`, every poll cron): publishes rows never published, re-publishes overdue rows and expired leases, re-enqueues failed weekly reports (up to 3 runs, before local Tuesday), sends rows with 6+ attempts to the failure path, and resumes owner emails stuck in `sending` (section 6).
8. **Cancel** (`jobs/cancel.ts`): mark the row `cancelled`, then cancel the QStash message by id after commit. Never a bulk cancel. An account-wide cancel never cancels a `privacy_delete`.

| Kind | Created by | Handler | Failure path |
|---|---|---|---|
| `portal_poll` | HubSpot webhook, debounced (now and +90 s) | `services/intake` | alert only (the cron poll covers it) |
| `privacy_delete` | `contact.privacyDeletion` webhook | `services/privacy` | alert only (needs an operator) |
| `lead_process` | lead insert; "This is a real lead" | `services/leads/process.ts` | resume a pending new-lead email, else lead `failed` + "needs your touch" email |
| `followup` | the "notified" transaction; "Resume follow-ups" | `services/followups/job.ts` | lead-page note and the stream's end; never an email |
| `weekly_report` | the hourly due-check | `services/reports/job.ts` | report `failed`; the sweeper re-enqueues |
| `brief_generate` | the brief page | `services/brief/job.ts` | brief job `failed`: the owner gets the empty editable form |
| `inbox_check` | the inbox-test email's `sent` transaction, then each run | `services/inbox-check/job.ts` | open legs `failed` |
| `baseline` | the baseline page | `services/baseline/job.ts` | baseline `unavailable` |
| `account_daily` | the daily cron | `services/daily/job.ts` | alert only (tomorrow's job runs again) |

**Periodic triggers** (UTC, `vercel.json`; `scripts/qstash-schedules.ts` creates the same as QStash schedules, D-16). Each route accepts a Vercel Cron GET with `Bearer CRON_SECRET` or a signed QStash POST:

| Route | Schedule | Does |
|---|---|---|
| `/api/cron/poll` | `*/5 * * * *` | global lease → `applyProcessingState` for every account → `pollPortal` per active account (per-account lease, ~240 s budget) → sweeper → retention guard |
| `/api/cron/weekly-report` | `0 * * * *` | Monday 08:00 local due-check → report row + job |
| `/api/cron/daily` | `17 3 * * *` | retention and prunes → one `account_daily` job per account → billing-tombstone reconcile and queued auth-user deletions (120 s budget) |

## 6. Owner emails: the notification reservation

Every email to an owner goes through `reserveAndSend` (`services/notifications/send.ts`, PLAN §8.4) and is sent at most once per dedupe key:

1. **Reserve:** insert a `notifications_sent` row (`sending`) under the kind's predicates (lead not dismissed, account and connection active, …; `services/notifications/predicates.ts`), `on conflict do nothing`. No row → read the existing one: `sent` blocks; `sending` is taken over by compare-and-set (the paired kinds new_lead↔needs_touch and follow_up↔needs_touch share keys, so a lead gets at most one email per slot); predicates failing → skipped.
2. **Tokens:** mint the action tokens (`apt_` + 32 random bytes) for the buttons and **commit their sha256 hashes before sending** (D-45).
3. **Send** with Resend's idempotency key `{ENV_NAMESPACE}:{dedupe_key}`. Transient error → the row stays `sending` for a retry or the sweeper; permanent → `failed`, the minted tokens revoked, one alert; Resend's 409 on our own key → an earlier attempt already sent it: mark it sent.
4. **Commit** `sent` together with the caller's state (e.g. `first_notified_at`, `notified` and the two follow-up job rows).

The sweeper resumes `sending` rows at doubling intervals (10 minutes up to 2 hours) until 23 hours after the first reservation (inside Resend's 24-hour idempotency window), re-rendering from stored rows through the kind's **resumer**; older rows become `failed` with an alert. A reservation that becomes `failed` unsent runs the kind's **failure hooks** in the same transaction (an initial lead email's lead becomes "not processed"; a follow-up's stream ends). Some reservations are made inside another transaction and sent after commit: `reconnect` (in the revoke transaction), `billing_inactive` (in the `→ inactive` transition), `reply_detected` (in `markReplied`), `lead_cap` (in the cap check).

Emails are React Email templates in `src/emails/`, rendered by `src/server/email/render.ts`. Lead emails set Reply-To to the owner (D-27); only sign-in and billing emails use `EMAIL_REPLY_TO`.

## 7. Data flow

### 7.1 Install and onboarding (PLAN §9.1, §9.7)

```
/api/hubspot/install → HubSpot consent → /api/hubspot/oauth/callback
   exchange code → check granted scopes → introspect → account details → branch (D-35):
   (a) new portal: account + connection, trial (or the portal's first trial), pending_install cookie
   (b) unbound reinstall · (c) owner signed in: reactivate · (d) owner not signed in: change nothing
   ▼
/onboarding/email → login intent + magic link (reserveAndSend magic_link) → any browser:
   GET /auth/confirm (page reads the #fragment) → POST /auth/confirm → verifyOtp → intent compare-and-set
   → owner bind (one statement: verified email = pending email) → session → /onboarding/brief
   ▼
/onboarding/brief: brief_jobs + brief_generate job → crawl (WebFetcher behind the SSRF guard, robots.txt)
   → strip nav/scripts/hidden DOM → Sonnet → post-process → brief_versions 'generated' → owner saves 'owner'
/onboarding/forms: listForms → newsletter detection → selected_forms (floor and cursor = now when ticked)
/onboarding/preferences: settings; extra notify addresses get a confirmation link
/onboarding/inbox: history counts → test lead (is_test) → inbox_test email → inbox_check job every 60 s
   reads the test contact's logged emails → send leg, reply leg → accounts.logging_mode
/onboarding/baseline: baseline job (30 days of submissions classified in memory, first logged email per
   lead → median, % without) → Finish: the onboarding gate → onboarding_completed_at → active, floors = now
```

### 7.2 The core loop

```
HubSpot form submission
   │ webhook (signed, deduped) → debounced portal_poll jobs        5-minute cron poll (safety net)
   ▼                                                                 │
Intake (services/intake/poll-portal.ts): Forms submissions API per selected form, newest first,
        60-minute overlap, floor and test-address skip → resolve the contact by email →
        one transaction: lead + lead_messages + lead_process job (both unique keys dedupe)
   ▼
lead_process (services/leads/process.ts): classify (fast model; failure → unclear) → filtered? stop
        → daily cap (deferred + one lead_cap email) → AI budget breaker → draft (Sonnet) → validator
          (one retry with the error codes) → or the minimal safe template (needs_touch)
   ▼
Notify: reserveAndSend(new_lead | needs_touch) → "New lead: {name} — your reply is ready"
        with Send / Edit first / Not a real lead + "Open in default mail app"
        → on commit: first_notified_at, processing_state notified, two followup job rows
   ▼
Owner:  /a/{token}/send → click heuristic (D-26) → 302 to Gmail/Outlook web compose (desktop)
        or an interstitial that opens mailto: (phones, "Other"), or the copy page (too long)
        → the owner sends from their own mailbox → HubSpot logs it (BCC or connected inbox)
   ▼
Follow-up n (T0 + 2 / + 5 local days, shifted out of quiet hours; services/followups/job.ts):
        stops (dismissed, replied, opted out, superseded, account not active, …)
        → read the contact and its logged emails → applySignals: confirmed send (EMAIL to the lead),
          reply (INCOMING_EMAIL from the lead) → markReplied: replied_at, remaining job cancelled,
          "{name} replied — follow-ups stopped" → else draft the follow-up → reserveAndSend(follow_up)
   ▼
Report: hourly due-check → weekly_reports row + weekly_report job (Monday 08:00 local + 15 min + stagger)
        → refresh the week's signals → computeWeeklyMetrics (cohort and event counts, honesty rules)
        → store the metrics → reserveAndSend(weekly_report)
   ▼
Dashboard: /dashboard, /dashboard/leads/[id], /dashboard/brief, /dashboard/settings, /dashboard/billing
        read views on the OwnerScope; the lead page refreshes the lead's signals on view (≤ every 5 min)
        and posts its controls (real lead, resume follow-ups, dismiss, pause) as Server Actions
```

### 7.3 The lead's state, as built

The only stored lifecycle field is `leads.processing_state`; timestamps record the rest, and the status the owner sees is derived (`domain/lead-status.ts`, D-32):

```
new ──claim──► processing ──classified filtered──► filtered ──"This is a real lead"──► new (process_rev + 1)
                   │ ──over the daily cap──► deferred
                   │ ──skipped (dismissed, account not active, content gone)──► skipped
                   │ ──failure path──► failed
                   └──initial email sent──► notified ──► follow-ups, signals, replies (timestamps)
```

Displayed status, first match wins: Dismissed → Replied → Filtered → Not processed (failed, skipped, deferred) → No reply from lead (none logged; only after a complete HubSpot read, with reply logging, once follow-ups are over) → Send confirmed in HubSpot → Send link opened → Drafted → Processing.

## 8. Auth, sessions, the proxy and CSP

- **Magic links only** (D-22): `auth.admin.generateLink` mints a hashed token for (a) a bound owner, (b) the pending owner of an install, (c) an `ADMIN_EMAILS` address; Autopilot emails `{APP_URL}/auth/confirm#th=…&type=email` itself. The token is in the fragment, so it never reaches a server log. A server-side `login_intents` row (sha256 of the token) carries the purpose, account and allow-listed `next`. `GET /auth/confirm` shows a "Sign in" button; its nonce'd script posts the fragment same-origin; `POST /auth/confirm` runs `verifyOtp`, consumes the intent by compare-and-set and, for onboarding, binds the owner in one statement (D-35). `/login` answers the same neutral text after an 800 ms floor and does the work in `after()`.
- **Sessions:** live, Supabase's `@supabase/ssr` cookies; fake, a signed `ap_session` cookie. `requireOwner()` (`services/auth/owner-scope.ts`) is the only way to get an `OwnerScope`; every owner-facing view and action takes it, and `test/security/cross-tenant.test.ts` runs every owner page and action with another account's ids. `/admin` needs a verified session whose email is in `ADMIN_EMAILS`, else 404.
- **Proxy** (`src/proxy.ts`, PLAN §7.7): on every HTML response a fresh nonce CSP, inbound CSP headers stripped first. Session refresh and the `/login` redirect only on `/dashboard`, `/onboarding` (not `/onboarding/email`), `/admin` and `/api/billing`. Webhooks, jobs, cron, health, `/a/*` and `/auth/*` are never redirected. It never touches the database.
- **Headers** (`security/csp.ts`): `script-src 'self' 'nonce-…' 'strict-dynamic'`, `form-action 'self'`, `frame-ancestors 'none'`, `connect-src 'self'` + the Sentry ingest origin, HSTS, `nosniff`, `Referrer-Policy: same-origin` (D-62), a Permissions-Policy, `X-Frame-Options: DENY`; `private, no-store` and `noindex` on personal-data pages. Every page renders per request so every framework script carries the nonce.
- **Action links** (`/a/{token}/…`): hashed, single-purpose tokens, 7-day expiry, rate-limited, no browser Sentry; dismiss needs a confirmation POST; a click counts only when it does not look like a link scanner.
- **CSRF:** Server Actions' built-in Origin check; `assertSameOrigin` on every route-handler POST; `form-action 'self'`. Checkout leaves for Razorpay through our own page and a script navigation, never a cross-origin form redirect (D-78).

## 9. Billing and the account lifecycle

`accounts.processing_state` is derived, never set directly (D-42, D-48, PLAN §6.1). `computeProcessingState` (pure) returns the first match of: disconnected, revoked, onboarding, paused (`paused_at`, the owner's intent), inactive (not entitled), active. `applyProcessingState` applies it by compare-and-set **in one transaction with the transition's side effects**, and every writer calls it (pause/resume, OAuth callback, token manager, disconnect, billing webhook and reconcile, onboarding completion, the poll cron):

| Transition | Side effects (the winner only) |
|---|---|
| → active | intake floors and cursors move to now; purge dates cleared |
| → inactive | one `billing_inactive` email per non-entitled period |
| → revoked / disconnected | `purge_after = now + 30 d`; jobs cancelled (not privacy deletions); action tokens revoked; follow-up leads get `stop_reason = account_inactive`; a revoke also reserves the "Reconnect HubSpot" email |
| → paused | nothing cancelled; due follow-ups fail their predicates and are skipped |

Only `active` accounts are polled, processed and reported.

- **Entitlement** (`domain/entitlement.ts`, D-18): trialing, or a subscription `authenticated`/`active`, or `pending` within 3 days of the first failed payment. The current subscription is the newest one that holds a mandate, else the newest (D-81).
- **Checkout** (`services/billing/checkout.ts`): a 30 s lock, the guard (`domain/checkout-guard.ts`: block on a live mandate, never on `created`), reuse of a valid `created` link, stale links re-fetched, then `POST /v1/subscriptions` (start at the trial's end when more than a day is left) → our `/dashboard/billing/checkout` page → Razorpay's `short_url`.
- **Webhook** (`POST /api/razorpay/webhook`): HMAC over the raw bytes (current or previous secret), `created_at` window, dedupe, then the event is only a trigger: GET the subscription and apply it if newer (`services/billing/apply.ts`), then `applyProcessingState`. The daily job reconciles every non-terminal subscription the same way.
- **Disconnect** (`services/disconnect`): optional cancel, best-effort uninstall and token revoke, then always wipe tokens and go `disconnected` (purge in 30 days). **Revoked** connections are found by a failed refresh or the daily introspect probe (D-10).
- **Orphans and purge** (`services/purge`): an install nobody binds within 7 days is uninstalled and purged at once; any account past `purge_after` with no active connection is purged: live subscriptions cancelled first, tombstones written (`portal_history` keeps the trial start, `billing_tombstones` keep late webhooks harmless), the auth user deleted behind one guard (`services/auth/auth-user-deletion.ts`), then `delete from accounts` cascades.

## 10. Retention and purge

| Store | Lifetime | Mechanism |
|---|---|---|
| `lead_messages` | 30 days from submission (test leads 24 h) | deleted at `purge_at` |
| `drafts` subject, body, flags | same as the lead's message | nulled/emptied, `purged_at` set |
| `inbox_checks.test_address` | 24 hours | cleared; the HMAC stays so the intake skip keeps working |
| `webhook_events`, expired action tokens, `rate_limits`, `ai_calls` | 30 days / expiry / 2 days / 13 months | daily prunes |
| `fake.dev_outbox` (fake mode only) | 30 days | daily prune |
| a disconnected or revoked account | 30 days after the event | the purge (section 9) |

The content purge is one statement (`services/retention/content.ts`) run hourly through the poll cron's cheap guard and daily as a catch-all, so content never outlives 30 days + 1 hour (D-49). The views also stop showing content the moment `purge_at` passes, whether or not the purge has run. Outside our database: Vercel request logs (paths of action links), Resend and Anthropic (their policies), Supabase backups and its auth audit log; see WIRE_UP steps 2, 5 and 6.

## 11. Observability and scrubbing

- **Logger** (`src/server/obs/log.ts`): JSON lines; `msg` is always a static string; fields come from an allow-list (ids, codes, counts); values pass through the shared `redact()` (`src/shared/observability/redact.ts`). Driver errors become `DbError` (sqlstate, constraint, table, column; never detail, query text or parameters); AI and SDK error messages are dropped.
- **Sentry** (errors only, `@sentry/nextjs` 11): one options object (`src/shared/observability/sentry-options.ts`) for the server, edge and browser inits; no tracing, no replays, `dataCollection` off, `tracePropagationTargets: []`, the Anthropic and Console integrations removed; `beforeSend`/`beforeBreadcrumb` (`scrub.ts`) rewrite URLs and transactions (including `/a/{token}`) and delete request data, cookies, headers and query strings. No browser Sentry on `/a/*` or `/auth/*`. Without a DSN it is a no-op.
- **Alerts** (`src/server/jobs/alert.ts`): `raiseAlert(code)` writes one error log line and one Sentry message whose text is the code, tagged `alert:<code>`.
- **Admin** (`/admin`): portals and states, last webhooks, failed jobs, error counts, AI calls and cost, the re-encryption backlog, failed owner emails; ids, codes and counts only; each view audited.
- **Proof:** `test/observability/scrubber.test.ts`, `sentry-envelope.test.ts` (the real SDK with an in-memory transport and fixtures for a database error, a Server Action and an AI error) and `logger.test.ts`; `npm run check:bundle` greps the client bundle and prerendered pages for secrets and server-only variable names.

## 12. Transactions and the lock order

Rules (D-28): queries run one at a time per client; `Db.tx(fn)` hands out a transaction handle and the root handle refuses use while a transaction is open in the same async context; **no transaction is held across network I/O** (emails, QStash cancels and HubSpot or Razorpay calls happen after commit, or before the transaction starts); concurrency control is single-statement compare-and-set or lease updates, which PGlite's sequential tests can prove.

**Row lock order.** `accounts` → `hubspot_connections`, `accounts` → `subscriptions`, and `leads` → `scheduled_jobs` (D-55, D-73, D-81):
- A transaction that writes both an account and its connection locks `accounts` first: the OAuth callback updates the account before storing the connection; the revoke path (`services/hubspot/revoke.ts`), Disconnect (`services/disconnect`) and the orphan step (`services/purge/orphan.ts`) take `select … from accounts … for no key update` before the connection row.
- Every billing transaction (apply-if-newer, checkout insert, cancel/resume) takes the account row `for no key update` before `subscriptions … for update`, then `applyProcessingStateInTx`.
- A transaction that writes a lead and its jobs locks the lead first: `markReplied`, dismiss and "Resume follow-ups" update or lock the lead before they cancel or insert jobs; a job's ownership check (`assertJobOwned`) takes `select 1 from leads where id = $1 for no key update` before its own `scheduled_jobs … for update`; the `→ revoked / disconnected` transition writes the leads' `stop_reason` before its account-wide cancel; a lead email's `sent` or failure transaction goes `notifications_sent` → `leads` → `scheduled_jobs`.
- The account purge's last transaction locks `accounts` `for update`, writes the tombstones, cancels the account's jobs and deletes the account.
- A privacy deletion locks the account row (`for no key update`) before reading the contact's leads, and the lead insert takes `for share` on it, so a concurrent lead is either seen by the deletion or refused by the insert's privacy-deletion guard (D-06, D-55).

`FOR NO KEY UPDATE` is what an ordinary `UPDATE` takes; it does not wait for the key-share locks that inserts with a foreign key to the account hold. `test/followups/transactions.test.ts` checks the statement order and that no transaction makes a network call.

## 13. Security map

| Threat | Control | Code | Proof |
|---|---|---|---|
| Forged HubSpot webhook (e.g. a fake privacy deletion) | v3 HMAC over method + exact target URL + body + timestamp, ±5 min, current or previous secret; `appId` check | `src/server/hubspot/signature.ts`, `http/hubspot-webhook.ts` | `src/server/hubspot/signature.test.ts` (published vectors), `http/hubspot-webhook.test.ts` |
| Forged job or cron call | QStash JWT verified for the route's own URL, `devMode: false`; Bearer `CRON_SECRET` compared in constant time | `security/qstash.ts`, `security/cron-auth.ts` | `qstash.test.ts`, `cron-auth.test.ts` |
| Forged or replayed Razorpay webhook | hex HMAC over raw bytes, constant time, empty secret refused; `created_at` window; dedupe | `security/razorpay-signature.ts`, `services/billing/webhook.ts` | `razorpay-signature.test.ts`, `test/billing/webhook.test.ts` |
| Stolen database copy | HubSpot tokens AES-256-GCM with key id and AAD; action tokens stored as sha256 only | `security/crypto.ts`, `security/action-tokens.ts` | `crypto.test.ts`, `action-tokens.test.ts` |
| Writes to HubSpot (law 2) | request allow-list before any network call; read-only scopes | `security/hubspot-allow-list.ts`, `hubspot/scopes.ts` | `hubspot-allow-list.test.ts`, `test/hubspot/app-config.test.ts`, `client-data-minimisation.test.ts` |
| Account takeover through sign-in | fragment tokens, server-side intents, bind only when the verified email equals the pending one, rate limits, latency floor | `services/auth/` | `services/auth/*.test.ts`, `test/security/rate-limits.test.ts` |
| One owner reading another's data | `requireOwner()` → `OwnerScope` on every owner read and action | `services/auth/owner-scope.ts`, `views/`, `actions/` | `test/security/cross-tenant.test.ts`, `test/settings/cross-tenant.test.ts`, `test/billing/cross-tenant.test.ts` |
| XSS, clickjacking, CSRF | nonce CSP, `frame-ancestors 'none'`, same-origin checks, Server Action Origin check | `src/proxy.ts`, `security/csp.ts`, `security/same-origin.ts` | `csp.test.ts`, `src/proxy.test.ts`, `test/security/headers.test.ts` |
| SSRF through the website crawl | checks on the socket's resolved address, ports 80/443, blocked ranges, limits, robots.txt | `security/ssrf.ts`, `adapters/live/http-web-fetcher.ts` | `ssrf.test.ts`, `http-web-fetcher.test.ts` |
| Prompt injection from leads or websites | untrusted-input delimiters; validator codes (URLs, contacts, notes to the AI, echoes); defanged display; the owner sends every email | `ai/prompts/`, `domain/validator/`, `domain/defang.ts` | `domain/validator/validator.test.ts` (golden cases, injection payloads included) |
| Link scanners acting on emails | click heuristic; dismiss by POST only | `services/action-links/click.ts`, `dismiss.ts` | `services/action-links/click.test.ts`, `dismiss.test.ts` |
| Content or tokens in logs or Sentry (law 4) | allow-listed logger, `redact()`, Sentry scrubbers, no tracing | `obs/log.ts`, `src/shared/observability/` | scrubber, envelope and logger tests |
| Secrets in the browser bundle | no `NEXT_PUBLIC_*` secrets | `next.config.ts` | `npm run check:bundle` |
| Fake mode in production | refused on Vercel unless allowed; fake secrets refused in live mode | `env.ts` | `env.test.ts` |
| Abuse and cost | rate limits, daily drafted-lead cap, AI budget breaker and per-account share | `security/rate-limit.ts`, `services/drafting/` | `test/security/rate-limits.test.ts`, drafting tests |

## 14. Testing and simulation

- **Unit and integration tests** (Vitest; `npm test`): colocated `*.test.ts` under `src/` for pure modules, adapters and handlers; cross-cutting suites in `test/`. Database tests run on PGlite: `test/db/global-setup.ts` migrates one database and dumps it, each file loads the dump, and tables are truncated between tests. `server-only` is aliased to a stub. Time-sensitive suites set the system time to 2030 to prove nothing reads the wall clock. Races are tested as sequential replays (crash after claim, duplicate delivery, compare-and-set losers), because PGlite has one connection.
- **Where the brief's required tests live** (PLAN §12): validator golden cases `src/server/domain/validator/validator.test.ts`; signature vectors `src/server/hubspot/signature.test.ts`, `src/server/security/razorpay-signature.test.ts`, `src/server/security/qstash.test.ts`; token refresh revoked vs transient `src/server/services/hubspot/token-manager.test.ts`; follow-up stop rules `src/server/domain/stops.test.ts` + `test/followups/`; quiet hours across time zones `src/server/domain/quiet-hours.test.ts`; checkout guard `src/server/domain/checkout-guard.test.ts` + `test/billing/checkout.test.ts`; retention purge `test/retention/`; idempotent webhook replay `src/server/http/hubspot-webhook.test.ts` + `test/billing/webhook.test.ts`; RLS `test/db/migrations.test.ts`; the honest-copy rule `test/emails/copy-rule.test.tsx`.
- **Simulation** (`npm run simulate`, PLAN §13, D-39): the scripted week on fakes, an in-memory PGlite and a `FakeClock`, driving the real route handlers, read models and Server Action bodies. `scripts/simulation/engine.ts` steps through events, job deliveries and cron ticks in time order. Five scenarios run in parallel processes: `week` (`./outbox`), `daily-cap`, `billing`, `lapse`, `disconnect` (`./outbox/<name>/`). Each scenario then runs again in a process started with `scripts/simulation/system-time-preload.mjs`, which moves `Date`, `Date()` and `performance.timeOrigin` (and so PGlite's `now()`) to 2030-01-01, into `./outbox/system-time/`; `scripts/simulation/compare.ts` requires each repeat to equal its run (summary.json apart from `systemTime`, every email file once action tokens, token hashes and UUIDs are masked). The script exits 1 if any check fails or a repeat differs; `scripts/simulation/*.test.ts` also run the stages under Vitest's faked 2030 Date.
- **Reading `outbox/summary.json`:** `scenario`; `clock` (start and end); `stages` (id, milestone, steps, checks); `timeline` (every step, cron tick, intake and job delivery, UTC and portal-local); `emails` (sequence, time, kind, lead ref, recipients, subject, file name of the rendered `.html`/`.txt` beside it); `leads` (stable refs `L1`…`L6`, never database ids: contact, form, submission time, intake trigger, class, processing state, stop reason); `weeklyReport` (the stored Monday metrics); `checks` (id, stage, ok, a content-free detail); `ok`.
- **End to end** (`npm run e2e:fake`): `next start` in fake mode driven with plain `fetch` and no JavaScript through install, the magic link, every onboarding step, the dashboard, settings, billing with the fake checkout, Disconnect and `/admin`.
- **Smoke** (`npm run smoke`): the built app answers `/api/health`, `/` and `/login` with 200.
- **Doc checks:** `npm run check:finding-ids` (every finding ID PLAN, DECISIONS and these docs cite heads a section of `docs/research/*.md`).

## 15. Where each concern lives

| Concern | Location |
|---|---|
| Environment, fake/live rules | `src/server/env.ts`, `.env.example` |
| Composition root (`Deps`) | `src/server/container.ts`; ports in `src/server/ports/` |
| Live and fake adapters | `src/server/adapters/live/`, `src/server/adapters/fake/` |
| Time | `Clock` port; `src/server/adapters/live/system-clock.ts` is the only wall-clock reader; SQL binds `$now` |
| Database access, migrations | `src/server/db/` (`Db`, tx guard, `DbError`, migrate, PGlite shim); SQL in `supabase/migrations/` |
| Pure business rules | `src/server/domain/` |
| Jobs, outbox, sweeper, alerts | `src/server/jobs/`; routes `/api/jobs/run`, `/api/jobs/failed`, `/api/cron/*` |
| HTTP handlers | `src/server/http/` (called from thin files in `src/app/`) |
| Owner pages' data | `src/server/views/` (take `OwnerScope`) |
| Server Actions | `src/server/actions/` (each calls `requireOwner()`) |
| Proxy, CSP, session refresh | `src/proxy.ts`, `src/server/security/csp.ts`, `src/server/adapters/live/auth.ts` |
| Crypto, keys, tokens, signatures, SSRF guard, rate limits, same-origin, cookies, HubSpot allow-list | `src/server/security/`; the HubSpot signature in `src/server/hubspot/signature.ts` |
| HubSpot install, tokens, limiter, revoke | `src/server/services/install/`, `src/server/services/hubspot/`, `src/server/hubspot/` |
| Sign-in, owner binding, `requireOwner`/`OwnerScope` | `src/server/services/auth/`, `src/server/http/auth/`, `src/server/actions/auth/` |
| Intake (webhook, poll, insert), privacy deletion | `src/server/services/intake/`, `src/server/services/privacy/` |
| Brief builder | `src/server/services/brief/`, `src/server/adapters/live/http-web-fetcher.ts`, `src/server/ai/prompts/` |
| Onboarding steps, gate, change alerts, notify verification | `src/server/services/onboarding/`, `src/server/views/onboarding/`, `src/server/actions/onboarding/` |
| Inbox-logging check, baseline | `src/server/services/inbox-check/`, `src/server/services/baseline/` |
| Classification, drafting, cap, AI budget | `src/server/services/classification/`, `src/server/services/drafting/`, `src/server/ai/` |
| `lead_process` and lead emails | `src/server/services/leads/` |
| Owner emails (reservation, resumers, failure hooks) | `src/server/services/notifications/`; templates in `src/emails/`; rendering `src/server/email/` |
| Compose links, action-link pages, click heuristic | `src/server/domain/compose/`, `src/server/services/action-links/`, `src/server/http/action-links/` |
| Follow-up schedule, job, failure path, stream end | `src/server/domain/followup-schedule.ts`, `src/server/domain/quiet-hours.ts`, `src/server/services/followups/` |
| Stops, confirmed sends and replies | `src/server/domain/stops.ts`, `src/server/domain/signals.ts`, `src/server/services/signals/` |
| Owner controls (pause, real lead, resume follow-ups, dismiss) | `src/server/services/owner-controls/` |
| Monday report | `src/server/domain/report-due.ts`, `src/server/domain/weekly-metrics.ts`, `src/server/services/reports/` |
| Dashboard and lead page | `src/server/views/dashboard/`, `src/server/actions/dashboard/`, `src/app/dashboard/` |
| Billing | `src/server/domain/checkout-guard.ts`, `src/server/domain/entitlement.ts`, `src/server/services/billing/`, `src/server/views/billing/`, `src/server/adapters/live/razorpay-billing.ts`, `src/server/http/razorpay-webhook.ts`, `src/server/http/billing/`, `src/server/actions/billing/` |
| Processing state and account emails | `src/server/domain/processing-state.ts`, `src/server/services/accounts/` |
| Daily maintenance, retention, purge | `src/server/services/daily/`, `src/server/services/retention/`, `src/server/services/purge/`, `src/server/services/auth/auth-user-deletion.ts` |
| Settings, Disconnect, /admin | `src/server/views/settings/`, `src/server/actions/settings/`, `src/server/services/disconnect/`, `src/server/services/admin/`, `src/server/views/admin/` |
| Public pages | `src/app/page.tsx`, `src/app/{privacy,terms,refunds,shipping}/`, `src/components/marketing/` |
| Dev tools (fake mode) | `src/app/dev/`, `src/server/http/dev/`, `src/server/services/dev-ticker/`, `src/server/services/fake-state/` |
| UI kit | `src/components/ui/` |
| Logging and Sentry | `src/server/obs/`, `src/shared/observability/`, `src/instrumentation.ts`, `src/instrumentation-client.ts`, `src/sentry.server.config.ts`, `src/sentry.edge.config.ts` |
| HubSpot app definition | `hubspot-app/` |
| Scripts | `scripts/simulate.ts` (+ `scripts/simulation/`), `smoke.ts`, `e2e-fake.ts`, `check-bundle.ts`, `check-finding-ids.ts`, `qstash-schedules.ts` |
| Tests | colocated `*.test.ts` under `src/` and `scripts/`; the PGlite harness, fixtures and cross-cutting suites in `test/` |
