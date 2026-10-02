# Architecture

Status: **skeleton (M1).** This page gives the shape of the system as planned in [`PLAN.md`](PLAN.md). Sections marked *To be completed in M8* get their final detail once the code exists. Where this page and PLAN differ, PLAN wins. The rules behind each choice are in [`DECISIONS.md`](DECISIONS.md).

## 1. Layers

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

- **domain** is pure: validator, quiet hours, stop rules, lead status, processing state, entitlement, checkout guard, compose links, metrics. It imports only `domain/`, `zod` and `luxon`, so it is tested without a database or fakes.
- **ports** are the boundary to the outside world: `Clock`, `HubSpotClient`, `LLM`, `Mailer`, `Scheduler`, `Billing`, `WebFetcher`, `AuthProvider`. `Deps` bundles them.
- **adapters** implement the ports: `live/` against the real services, `fake/` in memory or on PGlite. Adapters never import services.
- **services** orchestrate a use case over `Deps` and the repositories. They never import adapters.
- **container** (`src/server/container.ts`) is the composition root: it builds `Deps` from the live or fake adapters according to `APP_MODE` and keeps one lazy instance on `globalThis`.
- **Supporting modules:** `db/` (the `Db` interface over Postgres.js or PGlite, transaction guard, migrations, repositories), `security/` (crypto, keys, tokens, signatures, SSRF guard, CSP), `jobs/` (dispatcher, claim and lease, outbox publisher, sweeper), `obs/` (logger), `env.ts` (validated environment).
- **Client-safe code** lives in `src/shared/` (including `redact()` and the Sentry options), `src/components/` and `src/emails/`. None of it imports `src/server`. Every module under `src/server` imports `'server-only'`.

ESLint enforces these boundaries (`eslint.config.mjs`). The full rule list is in PLAN §3 and `CLAUDE.md`.

## 2. Modes: fake and live

`APP_MODE` is required. In `fake` mode every port uses its fake, the database is PGlite (a lazy `globalThis` singleton under `FAKE_DB_DIR`), secrets are the documented fake values, and `/dev/*` exposes the dev panel, the fake HubSpot consent page and the fake checkout. Live mode refuses the fake values; fake mode is refused on Vercel production and preview unless explicitly allowed (D-29). Tests and `npm run simulate` always run on fakes.

Container wiring: `getContainer()` / `getDeps()` build the container once per process, on first use. In fake mode, `createFakeDeps()` (`src/server/adapters/fake/index.ts`) configures every fake from `Env` (OAuth client, webhook secrets, plan id, models, the real refresh classifier, the FakeLLM parameter assertion), PGlite under `FAKE_DB_DIR` is migrated on first open, the fake mailer writes to `fake.dev_outbox`, and the FakeScheduler delivers due jobs to the job dispatcher through `src/server/jobs/bridge.ts` (the same `runJob` and failure path `/api/jobs/run` and `/api/jobs/failed` use). Dev runs on a `DevClock` (`src/server/adapters/fake/dev-clock.ts`): the wall clock plus an offset that `/dev` advances; `fake.state` persists it and the fake portal and billing snapshots across restarts (`src/server/services/fake-state`). Every container points Luxon's `Settings.now` at its clock. In live mode the container uses `SystemClock`, Postgres.js and the live HubSpot, Anthropic, Resend and QStash adapters (imported only when the live container is built); the ports whose live adapter is not built yet (billing, web fetcher, auth) throw `ConfigError('live_adapter_not_built')` when called. Job handlers, failure paths and notification resumers are registered in one place, `src/server/jobs/handlers.ts`. The simulation builds the same fake `Deps` on an in-memory PGlite and a `FakeClock` (which also drives Luxon's `Settings.now`), and its time-travel engine (`scripts/simulation/engine.ts`) steps through events, job deliveries and cron ticks in time order.

*To be completed in M8:* the dev job ticker, and how the fake clock drives the scheduler.

## 3. Data flow

The core loop, end to end. Each step names the job kind or route that carries it. PLAN §9 has the exact rules.

```
HubSpot form submission
   │ webhook (signed, deduped) → debounced portal_poll job     5-minute cron poll (safety net)
   ▼                                                            │
Intake: pollPortal reads the Forms submissions API per selected form, resolves the contact,
        and inserts lead + lead_messages + lead_process job in one transaction
   ▼
Draft:  lead_process job → classify (fast model) → filtered? stop
        → daily cap → draft (Sonnet) → validator (one retry) → or the needs-touch template
   ▼
Notify: reserveAndSend(new_lead | needs_touch) → owner email with Send / Edit / Dismiss links
        → on commit: first_notified_at, status notified, two followup job rows
   ▼
Owner:  /a/{token}/send opens their own mail app, pre-filled; they send from their mailbox;
        HubSpot logs the email (BCC or connected inbox)
   ▼
Follow-up (day 2, day 5, shifted out of quiet hours):
        followup job → stop rules → read contact and logged emails → applySignals
        → lead replied? markReplied + reply_detected email, remaining follow-ups cancelled
        → otherwise draft follow-up → validator → reserveAndSend(follow_up)
   ▼
Report: hourly due-check → weekly_report job at Monday 08:00 local
        → computeWeeklyMetrics (cohort and event counts, honesty rules) → reserveAndSend(weekly_report)
```

Before any of this, install and onboarding (PLAN §9.1, §9.7) create the account, bind the owner by magic link, build the business brief from the website, select forms, save preferences, run the inbox-logging check and compute the baseline. Billing (PLAN §9.9) and retention (PLAN §9.10) run beside the loop and can stop processing (`accounts.processing_state`, PLAN §6.1).

*To be completed in M8:* a sequence diagram per flow with the modules that implement each step, and the lead state machine (PLAN §6.2) as implemented.

## 4. Jobs and the outbox

Background work runs as rows in `scheduled_jobs`, delivered by QStash (live) or `FakeScheduler` (fake).

1. **Insert with the state change.** The job row is written in the same transaction as the change that needs it, with a dedupe key prefixed by `ENV_NAMESPACE`.
2. **Publish after commit.** `Scheduler.publish` runs after the commit and stores the message id. The sweeper publishes any row that was missed.
3. **Deliver.** QStash calls `/api/jobs/run` (signature verified). Jobs whose target is still more than 60 s away are re-published for later ("hops"), so delays beyond QStash's maximum work.
4. **Claim.** One compare-and-set moves the row to `running` with an attempt id and a 6-minute lease. Every later write is guarded by that attempt id.
5. **Outcome.** `done`; transient failure → back to `scheduled` and a 5xx so QStash retries (5 deliveries in all); permanent failure → the failure path and a non-retryable response. `/api/jobs/failed` runs the failure path when QStash gives up.
6. **Sweeper** (every 5 minutes): publishes unpublished rows, re-publishes overdue or expired-lease rows, re-enqueues failed weekly reports, and resumes owner emails stuck in `sending`.

Owner emails are exactly-once through `reserveAndSend` (PLAN §8.4): reserve a `notifications_sent` row under the kind's predicates, commit the action-token hashes, send with a Resend idempotency key, then commit `sent`. Periodic triggers (UTC): poll and sweeper every 5 minutes, report due-check hourly, daily maintenance at 03:17 (PLAN §8.1).

*To be completed in M8:* the job-kind table with handlers and failure paths as built, and the redelivery and crash scenarios the tests replay.

## 5. Where each concern lives

Paths are planned (PLAN §3) unless the code already exists.

| Concern | Location |
|---|---|
| Environment, fake/live rules | `src/server/env.ts`, `.env.example` |
| Composition root (`Deps`) | `src/server/container.ts`; ports in `src/server/ports/` |
| Live and fake adapters | `src/server/adapters/live/`, `src/server/adapters/fake/` |
| Time | `Clock` port; `SystemClock` in `src/server/adapters/live/system-clock.ts` is the only wall-clock reader; SQL binds `$now` |
| Database access, migrations | `src/server/db/` (`Db`, tx guard, `DbError`, migrate, repositories); SQL in `supabase/migrations/`; PGlite shim `src/server/db/fake-shim.sql` |
| Pure business rules | `src/server/domain/` |
| Use cases (intake, drafting, notifications, follow-ups, reports, billing, retention) | `src/server/services/` |
| Jobs, outbox, sweeper | `src/server/jobs/`; routes `/api/jobs/run`, `/api/jobs/failed`, `/api/cron/*` |
| HTTP handlers | `src/server/http/` (called from thin files in `src/app/`) |
| Owner pages' data | `src/server/views/` (take `OwnerScope`) |
| Server Actions | `src/server/actions/` (each calls `requireOwner()`) |
| Auth, CSP, session refresh | `src/proxy.ts`, `AuthProvider` port, `src/server/security/` |
| Crypto, keys, tokens, signatures, SSRF guard, rate limits | `src/server/security/` |
| Email templates | `src/emails/` (React Email, presentational) |
| Logging and Sentry scrubbing | `src/server/obs/`, `src/shared/observability/` (`redact()`, shared Sentry options), `src/instrumentation*.ts`, `src/sentry.*.config.ts` |
| HubSpot app definition | `hubspot-app/` |
| Simulation, smoke, bundle check | `scripts/simulate.ts`, `scripts/smoke.ts`, `scripts/check-bundle.ts` |
| Tests | colocated `*.test.ts` under `src/`; the PGlite harness, fixtures and cross-cutting suites in `test/` |

## 6. Data model

The schema, its rules (RLS on every table, explicit grants, no default timestamps except the audit columns) and the indexes are in PLAN §5. Migrations live in `supabase/migrations/`.

*To be completed in M8:* an entity overview and which tables hold content (and when it is purged).

## 7. Security and privacy

PLAN §10 lists every control: webhook and job signatures, token encryption with key ids, hashed action tokens, magic-link auth with server-side intents, the SSRF guard, CSP, tenant isolation through `OwnerScope`, the read-only HubSpot request allow-list, log and Sentry scrubbing, and the client-bundle check.

*To be completed in M8:* a threat-by-threat map to the code and tests.

## 8. Observability and testing

JSON logs with static messages and allow-listed fields; Sentry errors only, with one shared scrubbing configuration (PLAN §11). Tests run on Vitest with fakes and a PGlite harness (PLAN §12); `npm run simulate` runs the scripted scenario (PLAN §13).

*To be completed in M8:* the test map (which suite proves which rule) and how to read `outbox/summary.json`.
