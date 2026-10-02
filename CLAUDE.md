# CLAUDE.md: rules for every session on Hublytix Autopilot

Autopilot drafts replies and follow-ups for new HubSpot form leads; the owner sends them from their own mail app. Next.js 16 (App Router, `src/`), TypeScript strict, Supabase Postgres (PGlite in tests and fake mode), QStash, Resend, Anthropic, Razorpay, Sentry. Every external service sits behind a port with a fake.

## Where things are written down
- `docs/BUILD_BRIEF.md`: the original spec. The product laws below always apply.
- `docs/PLAN.md`: the approved plan (schema §5, routes §7, jobs §8, flows §9, security §10, tests §12, simulation §13, env §14, milestones §15). Build exactly what it says. If PLAN and DECISIONS disagree, PLAN wins; record the discrepancy.
- `docs/DECISIONS.md`: D-01…D-62, the detailed rules behind the plan (D-53 records the M1 review fixes, D-54 the M2 build choices, D-55 the M2 review fixes, D-56…D-60 the M3 build choices, D-61 the M3 integration, D-62 the M3 review fixes).
- `docs/RESEARCH.md` + `docs/research/*.md`: verified vendor facts and test vectors. Finding IDs in [brackets] point here.
- `docs/ARCHITECTURE.md`: layers, data flow, where each concern lives.
- `docs/WIRE_UP.md` (M8): connecting the real services.

**Decide, don't ask.** Where the docs are silent, pick the simplest option that satisfies them and log the choice in `docs/DECISIONS.md`.

## Git rules (brief §0.2, verbatim)
**Git rules:** stage specific paths only. Never `git add -A`, never `git add .`, never force-push. Never commit secrets; only `.env.example`.

## Product laws (brief §2, verbatim; apply to code, UI copy and emails)
1. **Never send email on the owner's behalf in v1.** Autopilot only prepares drafts; the owner sends from their own mail app via a pre-filled compose link. No Gmail or Outlook API scopes.
2. **HubSpot access is read-only.** No write scopes in v1.
3. **Never overstate.** A send or a reply counts only when it is confirmed in HubSpot data. Clicked-but-unconfirmed sends are shown separately and never merged with confirmed ones. If data is missing, say "not enough data"; never estimate.
4. **Data minimisation.** Store HubSpot IDs, timestamps and statuses. The only content stored is the lead's form message and the drafts, and both are purged after 30 days. Never log tokens, message text or drafts; scrub them from logs and Sentry.
5. **Honest copy.** No testimonials, user counts or claims that aren't true. Legal pages are placeholders marked `TODO: legal review`.

D-31 and D-49 define exactly which lead fields count as content and where content may live.

## Module boundaries (PLAN §3; enforced by ESLint: `no-restricted-imports` with `allowTypeImports`, plus `autopilot/import-boundaries` on resolved paths, `import()` and `require()`)
- `src/server/domain/` is pure: it imports only `domain/`, `zod` and `luxon`. `src/server/ports/` contains types only.
- `adapters/*` implement ports and never import `services/`.
- `services/` take a `Deps` object and never import adapters. `src/server/container.ts` builds `Deps` from the adapters (tests wire fakes directly).
- `src/app/**` may import `server/http`, `server/views`, `server/actions`, `server/container`, `shared/` and `components/`; types from anywhere. Route files stay thin.
- `src/proxy.ts` may import only the CSP builder and the `AuthProvider` session-refresh adapter.
- Every module under `src/server` imports `'server-only'`. Client components never import `src/server/**`.
- Owner-facing repos take `OwnerScope {accountId, userId}` as their first argument; only `requireOwner()` creates one.
- No `NEXT_PUBLIC_*` secrets. The only public values are `NEXT_PUBLIC_PRODUCT_NAME` (derived in `next.config.ts`) and `NEXT_PUBLIC_SENTRY_DSN`. `npm run check:bundle` enforces this on the build output.
- `src/instrumentation.ts` must stay in `src/`. Next 16 uses `src/proxy.ts`, not `middleware.ts`.

## Time: `$now` and `Clock` (D-28)
- Never call `Date.now()`, argument-less `new Date()` or `DateTime.now()` outside `SystemClock` (`src/server/adapters/live/system-clock.ts`). Lint bans them, along with `Date` as a bare value, `performance.now()`, and the Luxon calls that fill in "now" (`DateTime.local()/utc()` without a full date, `fromObject` without `year`, `toRelative()` without `base`, `diffNow()`, `Settings.now()`). Never disable these rules inline; a test forbids it.
- Every container points Luxon's `Settings.now` at its `Clock`; in Vitest it is a fixed year-2000 instant (`test/setup/luxon-clock.ts`).
- Every timestamp comes from the injected `Clock` (`deps.clock.now()`), and SQL binds it as a parameter (`$now`). That includes the `created_at` columns that drive behaviour.
- No `now()`, `current_timestamp` or `clock_timestamp` in SQL. The only exceptions are `default now()` on the audit-only columns `audit_log.at` and `webhook_events.received_at`; a migration test scans for the rest.

## Data and privacy in code
- Zod for every external payload. TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), no `any` (use `unknown` + Zod).
- Never log or put into errors: tokens, message text, drafts, email addresses, compose URLs. Use the shared `redact()` (`src/shared/observability`) and the logger in `src/server/obs`; driver errors go through `DbError`.
- No transaction is held across network I/O. Concurrency control is single-statement compare-and-set or lease updates.
- Owner emails go through `reserveAndSend` (PLAN §8.4); jobs go through the outbox (PLAN §8.3).

## Tests and services
- Never call live services (HubSpot, Supabase, Vercel, Upstash, Resend, Anthropic, Razorpay, Sentry) and never create accounts. Tests, fake mode and the simulation use fakes and PGlite only.
- Never write real secrets. Only the documented fake values (`FAKE_ENV` in `src/server/env.ts`) and `.env.example`.
- Tests are Vitest, deterministic: inject the `Clock`, fake timers only, no network. Name tests after behaviour.
- `APP_MODE` (`fake` | `live`) is required. Fake mode needs no other variable.

## Milestone gate (every milestone ends with all of these green)
```sh
npm run typecheck                # next typegen && tsc --noEmit
npm run lint
npm test
APP_MODE=fake npm run build
APP_MODE=fake npm run smoke      # /api/health, /, /login return 200
npm run simulate                 # writes outbox/summary.json; exits non-zero if a check fails
npm run check:bundle             # no secrets or server-only env names in .next/static or the prerendered pages
```
Then one commit (specific paths only) and a 5-line summary. CI (`.github/workflows/ci.yml`) runs the same gates, plus `npm run e2e:fake` (the onboarding end to end against `next start` in fake mode, without JavaScript).
