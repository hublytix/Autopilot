# Hublytix Autopilot

Autopilot is for owners of small businesses on HubSpot Free or Starter, who have no workflows or sequences. When a lead fills in one of their HubSpot forms, Autopilot drafts a personalised reply and emails it to the owner. One tap opens the owner's own mail app with the reply filled in; the owner reviews it and sends it. On day 2 and day 5 Autopilot drafts follow-ups, unless HubSpot shows that the lead replied. Every Monday the owner gets a short report.

What it does not do:
- It never sends email on the owner's behalf. It only prepares drafts, and it asks for no Gmail or Outlook access.
- It only reads from HubSpot. It requests no write scopes, and a request allow-list in the code refuses any write.
- It counts a send or a reply only when HubSpot data confirms it. When the data isn't there, it says "Not enough data" instead of estimating.
- The only lead content it stores is the form message with the name, company and email needed to address the reply, and the drafts. Both are deleted after 30 days and never logged.

The product name comes from `PRODUCT_NAME` (default `Hublytix Autopilot`). The price is $49 a month after a 14-day free trial, billed through Razorpay.

## Status

All eight milestones of [`docs/PLAN.md` §15](docs/PLAN.md#15-milestones-d-50) are built. Their gates (typecheck, lint, tests, build, smoke, the end-to-end run, the simulation, the bundle check and the finding-ID check) run in fake mode, locally and in CI on every push.

**Nothing has run against the real services yet.** The build sandbox had no accounts, so HubSpot, Supabase, Vercel, QStash, Resend, Anthropic, Razorpay and Sentry are exercised only through fakes that follow the vendors' documented behaviour. Before launch:
- [`docs/WIRE_UP.md`](docs/WIRE_UP.md) connects each service and runs the fourteen live checks of PLAN §17, for the facts research could only partly verify (for example whether HubSpot grants the `sales-email-read` scope to a marketplace app, how Gmail and Outlook compose links behave on phones, and Razorpay's USD subscriptions).
- `/privacy`, `/terms`, `/refunds` and `/shipping` are placeholders marked "TODO: legal review". Razorpay reviews these pages before it activates International Cards (needed for USD) and may refuse placeholders, so the legal text comes first.
- A HubSpot marketplace app is limited to 25 installs until its Marketplace listing is approved; listing work is outside v1 (D-43).

## Quick start (fake mode, no credentials)

Fake mode replaces every external service with a local fake and uses PGlite for the database. It needs no accounts and no environment variable other than `APP_MODE`.

```sh
nvm use                      # Node 22 (.nvmrc); package.json requires >= 22.12
npm ci                       # see "Installing packages" below
APP_MODE=fake npm run dev    # http://localhost:3000
```

Fake mode assumes `APP_URL=http://localhost:3000`. If port 3000 is taken, Next moves to another port without asking, and then the same-origin checks (`/dev/actions`, the sign-in confirm, Server Actions) answer 403 and the fake HubSpot sends you back to :3000. On another port, set `APP_URL` to match: `APP_MODE=fake APP_URL=http://localhost:3001 npm run dev -- -p 3001`.

Then, in the browser:
1. On `/`, **Install with HubSpot** opens the fake HubSpot consent page; **Approve** creates the account and starts onboarding.
2. Enter any email address. The sign-in link is not really sent: open **`/dev`**, find the email in the outbox, and open its link.
3. Go through the onboarding steps (the brief is read from a fixture website) and **Finish setup**.
4. On `/dev`, submit a lead to one of the fake forms, advance the clock and run due jobs, log the owner's send or the lead's reply in the fake HubSpot, revoke the HubSpot token, opt a contact out, run the daily maintenance, or deliver Razorpay's queued webhooks; every email Autopilot "sends" appears in the outbox there. `/dev` and its fake HubSpot and Razorpay pages exist only in fake mode (404 otherwise).
5. To reach `/admin`, sign in at `/login` with `fake-only-admin@example.com` (the fake `ADMIN_EMAILS`) and open the link from the `/dev` outbox.

Fake data lives in `.data/pglite` (`FAKE_DB_DIR`) and survives restarts, including the fake clock's offset; use `/dev`'s reset, or delete that directory, to start over.

### The simulation

```sh
npm run simulate
```

runs the scripted scenario of [`docs/PLAN.md` §13](docs/PLAN.md#13-simulation-npm-run-simulate-d-39) end to end on fakes and a fake clock: an onboarding, six form submissions (a normal lead, one without a message, spam, a vendor pitch, a repeat submission and a lead who replies on day 3), then day 0, day 2, day 5 and Monday. It writes every rendered email to `./outbox/NNN-<kind>-<lead>.html` and `.txt`, and `./outbox/summary.json` with the timeline, the emails, the leads' final states, the Monday report's numbers and every check. Four variant scenarios (`daily-cap`, `billing`, `lapse`, `disconnect`) run in parallel and write to `./outbox/<variant>/`. Then every scenario runs again in a process whose clock says 2030 (`./outbox/system-time/`); since nothing reads the wall clock, each repeat must match its run exactly. The command exits non-zero if any check fails or a repeat differs. `SIMULATE_SYSTEM_TIME` (optional, scripts only; any year or ISO instant, default `2030`) chooses the repeat's system time; `npm run simulate` passes it to the child run. [`docs/ARCHITECTURE.md` §14](docs/ARCHITECTURE.md#14-testing-and-simulation) explains how to read `summary.json`.

### Configuration

`.env.example` lists every variable `src/server/env.ts` reads, each with a one-line comment and its default. Copy it to `.env.local` only to override something in fake mode. Never commit real values: `.gitignore` ignores every `.env*` file except `.env.example`. Live mode (`APP_MODE=live`) requires every variable without a default; [`docs/WIRE_UP.md`](docs/WIRE_UP.md) says where each value comes from.

### Deploying a change after launch

Vercel deploys every push to the production branch. A commit that adds a file to `supabase/migrations/` must have its migration applied **before** that push or merge (brief §10.2): run `npx -y supabase@2.119.0 db push --dry-run`, then `db push`, from that commit's checkout. Keep migrations additive, so the code still running reads the new schema. [`docs/WIRE_UP.md` step 2, "Later deploys"](docs/WIRE_UP.md#later-deploys-migrations-before-code) has the details.

### Installing packages

The lockfile was produced with npm 11, because npm 10.9's `npm install` crashes on this dependency tree (an arborist bug: "Cannot read properties of null (reading 'edgesOut')"). `npm ci` works with npm 10 and 11 and is what CI and Vercel use. To add or change a dependency, use npm 11 and pin the exact version:

```sh
npx -y npm@11.21.0 install --save-exact <package>@<version>
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server. Needs `APP_MODE` (`fake` for local work) |
| `npm run build` | Production build. The gates run it as `APP_MODE=fake npm run build` |
| `npm run start` | Serve the production build |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm run lint` | ESLint, including the module-boundary and wall-clock rules |
| `npm test` | Vitest: unit, integration and PGlite database tests; fakes only, no network |
| `npm run smoke` | Starts the built app and checks that `/api/health`, `/` and `/login` return 200 |
| `npm run e2e:fake` | Starts the built app in fake mode and drives install → onboarding → dashboard → settings → billing with the fake checkout → Disconnect → `/admin` with plain HTTP requests and no JavaScript |
| `npm run simulate` | The scripted scenarios on fakes; writes `./outbox/` |
| `npm run check:bundle` | Fails if the client bundle or the prerendered pages contain secret-like strings, secret values or the names of server-only environment variables |
| `npm run check:finding-ids` | Fails if PLAN, DECISIONS, WIRE_UP or ARCHITECTURE cite a research finding ID that heads no section of `docs/research/*.md` |
| `npm run qstash:schedules` | Creates the three cron schedules in QStash (an alternative to Vercel Cron, live mode only; `--dry-run` prints the plan). See WIRE_UP step 4 |

The milestone gate is typecheck, lint, test, the fake-mode build, smoke, `e2e:fake`, simulate, `check:bundle` and `check:finding-ids` (the exact commands are in [`CLAUDE.md`](CLAUDE.md)); CI (`.github/workflows/ci.yml`) runs the same on every push and pull request.

## Project layout

```
.
├── CLAUDE.md  README.md  .env.example  vercel.json  next.config.ts  eslint.config.mjs  vitest.config.ts
├── docs/         BUILD_BRIEF · RESEARCH (+ research/*) · PLAN · DECISIONS · ARCHITECTURE · WIRE_UP
├── hubspot-app/  the HubSpot developer-platform project (scopes, redirect URL, webhooks)
├── supabase/     config.toml · migrations/ (RLS and grants on every table)
├── scripts/      simulate.ts (+ simulation/) · smoke.ts · e2e-fake.ts · check-bundle.ts · check-finding-ids.ts · qstash-schedules.ts
├── test/         the PGlite harness, fixtures and cross-cutting suites
└── src/
    ├── proxy.ts  instrumentation.ts  instrumentation-client.ts  sentry.*.config.ts
    ├── app/          routes and pages (thin)
    ├── components/   client-safe UI
    ├── emails/       React Email templates
    ├── shared/       client- and server-safe code (redact(), Sentry options)
    └── server/       env, container, ports, adapters (live and fake), db, domain (pure),
                      services, jobs, http, views, actions, security, ai, hubspot, obs
```

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains the layers, the data flow and where each concern lives.

## Docs

| File | Contents |
|---|---|
| [`docs/BUILD_BRIEF.md`](docs/BUILD_BRIEF.md) | The original specification, including the five product laws |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | Verified vendor facts with sources; full evidence and test vectors in [`docs/research/`](docs/research/) |
| [`docs/PLAN.md`](docs/PLAN.md) | The approved build plan: schema, routes, jobs, flows, security, tests, simulation, environment, milestones, live checks |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every change from the brief and every choice where it is silent (D-01 onwards) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layers, ports, data model, jobs, owner emails, data flow, security map, tests |
| [`docs/WIRE_UP.md`](docs/WIRE_UP.md) | Connecting the real services step by step, the live checks, the smoke test, key rotation |
| [`hubspot-app/README.md`](hubspot-app/README.md) | The HubSpot app's files and how they map to the environment |
| [`CLAUDE.md`](CLAUDE.md) | Rules for anyone, human or agent, changing this repo |
