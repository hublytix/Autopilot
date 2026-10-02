# Hublytix Autopilot

Autopilot is being built for owners of small businesses on HubSpot Free or Starter who have no workflows or sequences. When a lead fills in one of their HubSpot forms, Autopilot drafts a personalised reply and emails it to the owner. One tap opens the owner's own mail app with the reply filled in; the owner reviews it and sends it. On day 2 and day 5 Autopilot drafts follow-ups, unless HubSpot shows that the lead replied. Every Monday the owner gets a short report.

What it does not do:
- It never sends email on the owner's behalf. It only prepares drafts, and it asks for no Gmail or Outlook access.
- It only reads from HubSpot. It requests no write scopes.
- It counts a send or a reply only when HubSpot data confirms it. When the data isn't there, it says "not enough data" instead of estimating.
- The only content it stores is the lead's form message (with the name, company and email needed to address the reply) and the drafts, and it deletes them after 30 days.

The product name comes from `PRODUCT_NAME` (default `Hublytix Autopilot`). The planned price is $49 a month after a 14-day trial. Billing is not built yet.

## Status

**Early development. Nothing is connected to real services yet.** The work follows the milestones in [`docs/PLAN.md` §15](docs/PLAN.md#15-milestones-d-50).

| Milestone | Scope | Status |
|---|---|---|
| M1 | Scaffold, CI, migrations, PGlite test harness, fakes, `CLAUDE.md` | Done |
| M2 | HubSpot OAuth, connection management, webhook intake, poller, classification | Done (pending commit) |
| M3 | Brief builder, onboarding, inbox-logging check, baseline | Not started |
| M4 | Draft engine, validator, notification emails, action-link pages | Not started |
| M5 | Follow-up scheduler, reply detection, stop rules | Not started |
| M6 | Monday report and dashboard | Not started |
| M7 | Billing, trial, settings, disconnect and purge, admin | Not started |
| M8 | Public pages, simulation polish, docs, review | Not started |

At M2 the app installs into HubSpot (in fake mode through the fake consent page `/dev/fake-hubspot/authorize`), stores the encrypted tokens, receives webhooks, polls the selected forms every 5 minutes and classifies each new lead. The onboarding pages arrive in M3, so an install currently ends on `/onboarding/email` (a 404 page for now). `npm run simulate` runs the install, a seeded onboarding and Day 0's six submissions, and checks intake and classification. Each milestone adds a stage to the simulation.

## Quick start (fake mode, no credentials)

Fake mode replaces every external service (HubSpot, Supabase, QStash, Resend, Anthropic, Razorpay, Sentry) with a local fake and uses PGlite for the database. It needs no accounts and no other environment variables.

```sh
nvm use                      # Node 22 (.nvmrc); package.json requires >= 22.12
npm ci
APP_MODE=fake npm run dev    # http://localhost:3000
npm run simulate             # scripted scenario on fakes
```

`npm run simulate` writes its results to `./outbox/`: `summary.json` (timeline, emails, leads, weekly report, checks, `ok`) and, as later milestones add them, every rendered email as `NNN-<kind>-<lead>.html` and `.txt`. It exits non-zero when a check fails. The full scenario is described in [`docs/PLAN.md` §13](docs/PLAN.md#13-simulation-npm-run-simulate-d-39).

`.env.example` lists every variable with a one-line comment. Copy it to `.env.local` only to override something. Never commit real values.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server. Needs `APP_MODE` (`fake` for local work) |
| `npm run build` | Production build. CI runs it as `APP_MODE=fake npm run build` |
| `npm run start` | Serve the production build |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm run lint` | ESLint, including the module-boundary and wall-clock rules |
| `npm test` | Vitest (fakes and PGlite only, no network) |
| `npm run smoke` | Starts the built app and checks that `/api/health`, `/` and `/login` return 200 |
| `npm run simulate` | Runs the scripted end-to-end scenario on fakes; writes `./outbox/` |
| `npm run check:bundle` | Fails if `.next/static` or the prerendered HTML/RSC payloads under `.next/server` contain secret-like strings, secret values from the environment or `.env*` files, or the names of server-only env vars |

Every milestone ends with typecheck, lint, test, fake-mode build, smoke, simulate and the bundle check all green. CI (`.github/workflows/ci.yml`) runs the same gates on every push and pull request.

## Docs

| File | Contents |
|---|---|
| [`docs/BUILD_BRIEF.md`](docs/BUILD_BRIEF.md) | The original specification, including the five product laws |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | Verified vendor facts with sources (details in `docs/research/`) |
| [`docs/PLAN.md`](docs/PLAN.md) | The approved build plan: schema, routes, jobs, flows, security, tests, simulation, environment, milestones |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | D-01 to D-52: each change from the brief and each choice where it is silent |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layers, data flow and where each concern lives (skeleton; completed in M8) |
| `docs/WIRE_UP.md` | Connecting the real services step by step (written in M8) |
| [`CLAUDE.md`](CLAUDE.md) | Rules for anyone, human or agent, changing this repo |
