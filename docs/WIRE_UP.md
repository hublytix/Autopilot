# Wiring up the real services

This guide connects Hublytix Autopilot to its real services, in the order the build brief asks for (brief §10): HubSpot, Supabase, Vercel, QStash, Resend, Anthropic, Razorpay, Sentry, then a post-deploy smoke test. It is written for someone who has never seen the code. Follow the steps in order; each one says what to click or type, which environment variable each value goes into, and which of the PLAN §17 live checks happen there and what to do if one fails.

Everything in the repository runs on fakes until this guide is done (`APP_MODE=fake`). Apart from the placeholders in `hubspot-app/` (step 1) and, if needed, the database version in `supabase/config.toml` (step 2), nothing here changes the repository, except the "if it fails" paths that say so.

**Conventions**
- Example values use the production origin `https://autopilot.hublytix.ai` and the sending domain `autopilot.hublytix.ai` (the brief's suggestion). Replace them with yours everywhere.
- `<APP_URL>` means that origin (scheme and host only, no trailing slash). Shell examples use `$APP_URL`.
- **†** marks a dashboard label or behaviour that comes from research but could not be checked against the live product (RESEARCH Appendix A, sandbox limits). If what you see differs, follow the product, take a screenshot and note it in the check log (step 0.6).
- "Check #n" is item n of PLAN §17 (live checks). Section 9.5 lists all fourteen with where they happen and what to do on failure.
- Never paste a secret into a commit, an issue, a chat or a screenshot. Secrets live in your password manager, in Vercel and, while you work, in the gitignored worksheet `.env.wireup` (step 0.5).

**Contents**
- [0. Before you start](#0-before-you-start)
- [1. HubSpot app](#1-hubspot-app-developer-platform-project)
- [2. Supabase project and migrations](#2-supabase-project-and-migrations-before-any-deploy)
- [3. Vercel project, environment variables and crons](#3-vercel-project-environment-variables-and-crons)
- [4. QStash keys and callback URLs](#4-qstash-keys-and-callback-urls)
- [5. Resend sending domain](#5-resend-sending-domain)
- [6. Anthropic API key](#6-anthropic-api-key-and-models)
- [7. Razorpay plan, webhook and keys](#7-razorpay-plan-webhook-and-keys)
- [8. Sentry DSN](#8-sentry-dsn)
- [9. Post-deploy smoke test and screenshot checklist](#9-post-deploy-smoke-test-and-screenshot-checklist)
- [10. Key rotation runbook](#10-key-rotation-runbook)
- [Appendix A. HubSpot OAuth probe app](#appendix-a-hubspot-oauth-probe-app-checks-1-2-3-13-14)
- [Appendix B. Every environment variable](#appendix-b-every-environment-variable)
- [Appendix C. Staging (optional)](#appendix-c-staging-optional)
- [Appendix D. Troubleshooting](#appendix-d-troubleshooting)

---

## 0. Before you start

### 0.1 Accounts and plans

| Service | What you need | Why |
|---|---|---|
| HubSpot | A developer account (developers.hubspot.com), plus test portals: a developer test account, and ideally one Free and one Starter portal you can install into | The app lives in the developer account; checks #2 and #4 must run on Free and Starter |
| Supabase | One project on a paid plan for production (free projects can be paused for inactivity†) | Postgres and Auth |
| Vercel | **Pro** plan (recommended) | The 5-minute and hourly crons in `vercel.json` need Pro (D-16, [VC-CRON-PLAN-LIMITS]). On Hobby, a deployment that declares them can be refused outright, so Hobby means a repository change first: delete the `crons` array from `vercel.json` and use QStash schedules (step 4.4) |
| Upstash | A QStash account; pay-as-you-go recommended for production | Delayed jobs; Free has a 7-day maximum delay and an unverified daily quota ([QS-FREE-QUOTA]) |
| Resend | An account and DNS access to `hublytix.ai` | Every email Autopilot sends |
| Anthropic | A Console account with billing set up | Drafts, briefs and classification |
| Razorpay | An **activated** (KYC-verified) business account with Subscriptions | $49/month billing in USD needs International Cards (D-20) |
| Sentry | An organisation and one project | Error reports (optional; without a DSN Sentry is off) |

### 0.2 Tools on your computer
- Node 22.12 or later (`node --version`), npm, git, `openssl`, `curl`, `dig`.
- A clone of this repository with dependencies installed: `npm ci` (see the README's install note).
- The HubSpot CLI: `npm install -g @hubspot/cli` (needs Node 20 or later).
- The Supabase CLI runs through npx: `npx -y supabase@2.119.0 --version`.
- Optional: the Vercel CLI, `npx -y vercel@latest --version`.

### 0.3 Decide the fixed values first

| Value | Example | Goes into |
|---|---|---|
| Production origin | `https://autopilot.hublytix.ai` | `APP_URL` |
| Environment name | `prod` (1–32 lower-case letters, digits or dashes; unique per environment) | `ENV_NAMESPACE` |
| Product name | `Hublytix Autopilot` (the default; leave unset to keep it) | `PRODUCT_NAME` |
| Admin addresses | `you@hublytix.ai` (comma-separated) | `ADMIN_EMAILS` |
| Sender | `Hublytix Autopilot <notify@autopilot.hublytix.ai>` | `EMAIL_FROM` (step 5) |
| Support inbox | `support@hublytix.ai`, a mailbox someone reads | `EMAIL_REPLY_TO` (step 5) |
| One region for everything | US East: Vercel `iad1`, Supabase East US (North Virginia), QStash `us-east-1`, Resend `us-east-1` (or an EU set) | steps 2–5 |

Two values are derived from the origin and must match it exactly:
- `HUBSPOT_REDIRECT_URI` = `<APP_URL>/api/hubspot/oauth/callback`
- `HUBSPOT_WEBHOOK_TARGET_URL` = `<APP_URL>/api/hubspot/webhooks`

### 0.4 Generate the app's own secrets

```sh
openssl rand -base64 32   # APP_SECRET (HKDF root for cookie, rate-limit and dedupe keys)
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY (AES-256-GCM for HubSpot tokens; must differ from APP_SECRET)
openssl rand -hex 32      # CRON_SECRET (Bearer secret for Vercel Cron; 32+ visible ASCII characters)
openssl rand -hex 32      # RAZORPAY_WEBHOOK_SECRET (you type it into Razorpay in step 7)
```

Store each in your password manager. `APP_SECRET` and `TOKEN_ENCRYPTION_KEY` must each decode to exactly 32 bytes, which `openssl rand -base64 32` gives.

### 0.5 Your worksheet

Copy the example file to a gitignored worksheet and fill it in as you go. `.gitignore` ignores every `.env*` file except `.env.example`, and Next.js never loads a file named `.env.wireup`, so local fake-mode runs and builds keep ignoring it:

```sh
cp .env.example .env.wireup
# edit: APP_MODE=live, then each value as the steps below give it to you
```

Validate it at any time without calling any service. The QStash schedule script parses the environment with the app's own rules (`src/server/env.ts`) and, with `--dry-run`, only prints its plan:

```sh
npx tsx --env-file=.env.wireup --tsconfig tsconfig.scripts.json scripts/qstash-schedules.ts --dry-run
```

It prints either the three planned schedules (the environment is valid) or `invalid environment:` followed by one line per problem, naming the variable and the problem, never the value. Until step 8 is done it lists the variables you have not filled in yet. Delete the worksheet when you finish (step 9.6).

### 0.6 How live checks are recorded

PLAN §17 lists fourteen claims that research could only partly verify. As you meet each one:
1. Write the result (pass, fail, what you saw) in a short check log, with a screenshot where step 9.6 asks for one.
2. Afterwards, record the outcomes in `docs/DECISIONS.md` as a new entry (and in D-49 for the retention check #10), so the REVIEW verdicts (PASS / PARTIAL / FAIL, D-52, D-87) can be updated.

### 0.7 Legal text first (it has the longest lead time)

`/privacy`, `/terms`, `/refunds` and `/shipping` are placeholders marked "TODO: legal review". Razorpay's account activation and its International Cards review (step 7.3, needed for USD) both look at these pages on the live site and may refuse placeholders (PLAN §16 R12), and a review can take days or weeks. So start now, before step 1:
1. Have the four pages reviewed. What the review must settle is listed in 9.4 ("Legal review before launch"): the contact details, the governing law, the refund policy itself, the refund promised for a payment taken after an account was deleted, and the providers' retention once check #10 is recorded.
2. Put the reviewed text in `src/app/privacy/page.tsx`, `src/app/terms/page.tsx`, `src/app/refunds/page.tsx`, `src/app/shipping/page.tsx` and, for the facts the pages share (sub-processors, the HubSpot disclosure, the price), `src/components/marketing/legal.ts`. Remove each page's "TODO: legal review" marker only then, and update `test/pages/public-pages.test.tsx` in the same commit (it checks the marker and the wording today). Run the gates; stage those paths only.
3. That commit must be on the production branch by step 3, so the first production deployment already serves the reviewed pages for Razorpay's website review (start Razorpay's KYC meanwhile; the website part completes after step 3).

---

## 1. HubSpot app (developer-platform project)

HubSpot no longer lets anyone create a "legacy public app", so Autopilot's app is a developer-platform project kept in `hubspot-app/` and uploaded with the HubSpot CLI (D-02, [HS-APP-PLATFORM], [HS-CLI-WORKFLOW]). Its scopes are read-only: `oauth crm.objects.contacts.read forms sales-email-read` (D-03).

1. **Developer account.** Sign in at developers.hubspot.com (create a developer account if you have none).
2. **Authenticate the CLI.**
   ```sh
   hs account auth          # opens the browser; create and paste a personal access key
   ```
3. **Replace the placeholder host** `autopilot.example.com` in the project files with your production host, and set a real support address:
   ```sh
   perl -pi -e 's/autopilot\.example\.com/autopilot.hublytix.ai/g' \
     hubspot-app/src/app/app-hsmeta.json hubspot-app/src/app/webhooks/webhooks-hsmeta.json
   grep -rn example.com hubspot-app/src     # must print nothing
   ```
   (`perl -pi -e` behaves the same on Linux and macOS; BSD `sed -i` would take the first file name as a backup suffix.) The config test below only checks that both URLs share one host, so the `grep` is what proves the placeholder is gone.
   Then open `hubspot-app/src/app/app-hsmeta.json` and check:
   - `config.auth.redirectUrls` is exactly `["https://autopilot.hublytix.ai/api/hubspot/oauth/callback"]` (= `HUBSPOT_REDIRECT_URI`);
   - `config.support.supportEmail` is a mailbox you read (change it if needed);
   - `config.auth.requiredScopes` is `["oauth", "crm.objects.contacts.read", "forms", "sales-email-read"]`.

   And in `hubspot-app/src/app/webhooks/webhooks-hsmeta.json`, `config.settings.targetUrl` is exactly `https://autopilot.hublytix.ai/api/hubspot/webhooks` (= `HUBSPOT_WEBHOOK_TARGET_URL`): no trailing slash, no query string, no redirect in front of it, because HubSpot signs each delivery over that exact URL ([HS-WH-SIG-V3-URI]).

   Run `npx vitest run test/hubspot/app-config.test.ts` (it checks the scopes, https, and that both URLs share one host), then commit the two files (stage those paths only).
4. **Upload.**
   ```sh
   cd hubspot-app
   hs project validate
   hs project upload        # builds; deploys automatically if auto-deploy is on
   hs project deploy        # only if the upload said the build was not deployed
   cd ..
   ```
   **Check #1, first half:** the upload must accept `sales-email-read` in `requiredScopes`. If `validate` or `upload` refuses it, stop here and follow check #1's failure path in 9.5.
5. **Copy the credentials.** Run `hs project open`, click the app (`hublytix_autopilot`) under Project components†, then:
   - **Auth** tab†, "Client credentials"†: Client ID → `HUBSPOT_CLIENT_ID` (a UUID); Client secret → `HUBSPOT_CLIENT_SECRET` (it also signs webhooks);
   - the app's numeric **App ID**† (shown on the app page) → `HUBSPOT_APP_ID`. Webhook events for any other app id are dropped.
   - Confirm the Redirect URL shown on the Auth tab equals `HUBSPOT_REDIRECT_URI`.
6. **Webhooks.** On the app's Webhooks page† you should see `object.creation` for contacts and `contact.privacyDeletion`, both active, with the target URL above. **Check #9, first half:** webhook settings can take up to 5 minutes to apply after an upload ([HS-WH-HSMETA-CONFIG]); don't test webhooks earlier.
7. **Test portals.** Create a developer test account (`hs test-account create`, or Test accounts† in the developer account). Plan on also using one real Free and one Starter portal for checks #2 and #4. Installing needs a Super Admin, or a user with App Marketplace Access, in the target portal ([HS-MARKETPLACE-INSTALL-CAP]).
8. **Worksheet.** Fill in `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_APP_ID`, `HUBSPOT_REDIRECT_URI`, `HUBSPOT_WEBHOOK_TARGET_URL`. Leave `HUBSPOT_API_VERSION` (default `2026-09`), `HUBSPOT_JOURNAL_ENABLED` (reserved; the Journal poller is not built in v1) and `HUBSPOT_CLIENT_SECRET_PREVIOUS` (rotation only, section 10) unset.

Launch limit: a marketplace-distribution app is capped at 25 installs until its Marketplace listing is approved (D-43). Listing work is outside v1.

Optional now, required for checks #1, #2, #3, #13 and #14: create the probe app in Appendix A.

---

## 2. Supabase project and migrations (before any deploy)

The migrations in `supabase/migrations/` must be in the database **before** any code that uses them is deployed (brief §10.2). Autopilot uses Supabase's new key model (`sb_publishable_…`, `sb_secret_…`), explicit grants and RLS on every table, and public sign-ups off (D-21).

1. **Create the project.** supabase.com/dashboard → New project → organisation → name `hublytix-autopilot` → generate a strong database password (save it) → region (the one chosen in 0.3) → Create. The project ref is in the dashboard URL: `https://supabase.com/dashboard/project/<ref>`.
2. **Apply the migrations** from the repository root:
   ```sh
   npx -y supabase@2.119.0 login                         # personal access token, browser flow
   npx -y supabase@2.119.0 link --project-ref <ref>      # asks for the database password
   npx -y supabase@2.119.0 db push --dry-run             # lists the migrations it would apply
   npx -y supabase@2.119.0 db push
   ```
   The dry run must list every file in `supabase/migrations/`, in filename order (`ls supabase/migrations`), starting with `20261001000001_init.sql`.
   `link` writes `supabase/.temp/` (gitignored). Never edit a migration that has been applied; add a new timestamped file instead.
3. **Verify** in Dashboard → SQL Editor:
   ```sql
   show server_version;   -- 15.x or 17.x; if it is not 17, set [db] major_version in supabase/config.toml to match and commit

   select version from supabase_migrations.schema_migrations order by version;   -- one row per migration file

   -- RLS on every public table: expect 0 rows
   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

   -- anon and authenticated have no table privileges: expect 0 rows
   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));

   -- service_role has all four: expect 0 rows
   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and not (has_table_privilege('service_role', c.oid, 'SELECT') and has_table_privilege('service_role', c.oid, 'INSERT')
          and has_table_privilege('service_role', c.oid, 'UPDATE') and has_table_privilege('service_role', c.oid, 'DELETE'));
   ```
   If a query returns rows, do not deploy: the migration test (`test/db/migrations.test.ts`) proves these on PGlite, so a difference means the hosted database behaves differently (PLAN §16 R13). Record it and fix with a new migration.
4. **API keys.** Project Settings → API Keys → "Publishable and secret API keys" tab† (click "Create new API keys"† if it is empty):
   - publishable key `sb_publishable_…` → `SUPABASE_PUBLISHABLE_KEY` (used on the server only; there are no `NEXT_PUBLIC_SUPABASE_*` variables);
   - secret key `sb_secret_…` → `SUPABASE_SECRET_KEY` (bypasses RLS: server only);
   - `https://<ref>.supabase.co` → `SUPABASE_URL`.
   Autopilot never uses the legacy `anon`/`service_role` JWT keys; you may disable them on the Legacy API Keys tab† ([SB-KEYS-MODEL]).
5. **Database URL.** Click **Connect**† (top bar) → Connection string → **Transaction pooler** (port **6543**) → copy the URI, put the database password in (URL-encode any special characters) → `DATABASE_URL`, e.g. `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`. The app refuses any other port in live mode (D-28).
6. **Data API.** Project Settings → Data API† → Exposed schemas: remove `public` (or turn the Data API off). Autopilot never uses PostgREST; this removes an unused door (D-21).
7. **Auth settings.**
   - Authentication → Sign In / Providers†: keep the **Email** provider enabled (sign-in links are verified with it), and turn **"Allow new users to sign up" off**. Autopilot creates its users itself (D-21, D-22).
   - Authentication → URL Configuration ([SB-URL-CONFIG]): Site URL = `<APP_URL>`; Redirect URLs: add `<APP_URL>/auth/confirm`.
   - Authentication → Rate Limits†: Autopilot verifies sign-in links from its own server (`verifyOtp`), so every owner's verification comes from Vercel's addresses, which share Supabase's per-IP verification limit (30 per 5 minutes by default, [SB-AUTH-EMAIL-LIMITS]). Raise "token verifications"† (for example to 150 per 5 minutes). Autopilot's own `/auth/confirm` limit (10 per 15 minutes per visitor) stays in place.
   - Custom SMTP is set in step 5.5, once the Resend domain is verified.
8. **Auth audit log** (D-82 (c), law 4). Supabase keeps sign-in events, including the owner's address, in `auth.audit_log_entries`, and keeps them after Autopilot deletes the user. Look for an audit-log retention setting under Authentication†. If there is none, schedule a cleanup with pg_cron, inside Supabase's own schema (not Autopilot's migrations):
   1. Database → Extensions† → enable `pg_cron`† (or Database → Cron† → enable it there).
   2. In the SQL Editor, run the delete once by hand first. The SQL Editor runs as `postgres`, and `auth.audit_log_entries` belongs to `supabase_auth_admin`; whether `postgres` may delete from it is unverified†. If this fails with a permission error, stop: the cron job would fail the same way every night. Record the error and use a retention setting or ask Supabase support instead.
      ```sql
      delete from auth.audit_log_entries where created_at < now() - interval '30 days';
      ```
   3. Schedule it:
      ```sql
      select cron.schedule('auth-audit-log-30d', '23 4 * * *',
        $$delete from auth.audit_log_entries where created_at < now() - interval '30 days'$$);
      ```
   4. Verify the next day: `select count(*) from auth.audit_log_entries where created_at < now() - interval '30 days';` returns `0`, and `select status, return_message from cron.job_run_details order by start_time desc limit 5;` shows `succeeded`, no errors.
   5. Record the outcome (setting, or cron job and its first successful run) in D-49. Until it holds, the owner's address can outlive the account in Supabase's log, which `/privacy` must not claim otherwise.
9. **Backups (check #10, part 1).** Database → Backups†: note the backup or point-in-time-recovery window. Deleted content survives in backups until that window passes; record the window in D-49 and give it to whoever writes `/privacy`.
10. **Worksheet.** `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`.

### Later deploys: migrations before code

Once step 3.1 connects the repository, Vercel deploys every push to the production branch by itself. The migrations-before-code rule (brief §10.2) therefore applies to every later change too, not only the first deploy:
1. A commit (or pull request) that adds a file to `supabase/migrations/` is migrated **before** it reaches the production branch: from that commit's checkout, run `npx -y supabase@2.119.0 db push --dry-run` (it must list exactly the new files), then `npx -y supabase@2.119.0 db push`. Only then merge or push it.
2. Keep migrations additive (new tables, new nullable columns, new values), so the code still deployed keeps working on the new schema until the new code arrives. A change that removes or renames something goes in two releases: stop using it first, remove it in a later migration.
3. Never edit an applied migration; add a new timestamped file.
4. Optional, stricter: Vercel → Settings → Git† → Ignored Build Step, or turn off automatic production deployments†, and promote each production deployment by hand once its migration is in.

---

## 3. Vercel project, environment variables and crons

1. **Import the repository.** vercel.com → Add New… → Project → import the Git repository. Framework preset: Next.js; root directory: the repository root.
2. **Build settings** (on the import screen, or later in Settings → Build and Deployment†):
   - Install Command: override with `npm ci` (the lockfile was made with npm 11; `npm ci` installs it exactly and avoids an npm 10 `npm install` crash, see the README);
   - Build Command: default (`npm run build`); Output: default;
   - Node.js Version: 22.x (Settings → Build and Deployment†). `package.json` requires `>=22.12`.
3. **Environment variables.** Settings → Environment Variables (or the import screen's Environment Variables section). Add every value you have so far for the **Production** environment only, marking secrets as Sensitive†:
   - `APP_MODE=live`, `APP_URL`, `APP_SECRET`, `TOKEN_ENCRYPTION_KEY`, `ADMIN_EMAILS`, `ENV_NAMESPACE`, `CRON_SECRET` (set it before the first production deploy: Vercel sends it on every cron call, [VC-CRON-SECRET-UA]);
   - step 1's five HubSpot values and step 2's four database values.
   Steps 4–8 add the rest; Appendix B lists every variable. Do not add Preview or Development values: previews then build but answer `{"ok":true,"mode":"unknown"}` and touch no service (for a real second environment see Appendix C). Never set `ALLOW_FAKE_ON_VERCEL`, `QSTASH_DEV`, `QSTASH_REGION`, any region-prefixed QStash variable, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_SPOTLIGHT`, `SENTRY_DEBUG` or `ANTHROPIC_CUSTOM_HEADERS`: live mode refuses them (`src/server/env.ts`).
4. **Deploy.** Click Deploy. The build needs no environment, so it passes; until every variable is in place (step 9.1) the app answers `/api/health` with `{"ok":true,"mode":"unknown"}` and every other route fails. The migrations are already in place (step 2), so nothing here runs against a missing table.
5. **Domain.** Settings → Domains → add `autopilot.hublytix.ai` → create the DNS record Vercel shows (for a subdomain, a CNAME to Vercel's target†) → wait for "Valid Configuration".
6. **Function region.** Settings → Functions† → Function Region: the one next to your Supabase region (e.g. Washington, D.C. `iad1` for US East). Keep Fluid Compute on (the default for new projects†). `/api/jobs/run`, `/api/cron/poll` and `/api/cron/daily` declare `maxDuration = 300` seconds and `/api/cron/weekly-report` 60 seconds, within Pro's limit ([VC-FUNCTION-DURATION]); `/api/jobs/failed` (the failure callback) uses the platform default.
7. **Crons.** There is nothing to type: `vercel.json` declares the three crons, created on each **production** deployment ([VC-CRON-CONFIG]):

   | Path | Schedule (UTC) | What it does |
   |---|---|---|
   | `/api/cron/poll` | `*/5 * * * *` | processing states, form polling, job sweeper, hourly content purge guard |
   | `/api/cron/weekly-report` | `0 * * * *` | Monday 08:00 local due-check |
   | `/api/cron/daily` | `17 3 * * *` | retention, billing reconcile, per-account daily jobs |

   After the deploy, Settings → Cron Jobs† lists all three. **Check #6, first half:** if the deployment is refused because of cron frequency (expected on Hobby, [VC-CRON-PLAN-LIMITS]), upgrade to Pro, or delete the `crons` array from `vercel.json` and use QStash schedules (step 4.4). Turning crons off in the dashboard does not help: the deployment is refused before that setting applies.
8. **Deployment Protection.** Settings → Deployment Protection†: keep protection for preview deployments only; the production domain must stay public, or QStash, HubSpot and Razorpay get Vercel's 401 instead of Autopilot ([WIREUP-QSTASH-CALLBACK-URL]). **Check #6, second half** is the curl test in 9.2.
9. **Logs (law 4, D-49).** Add no Log Drains, and keep the shortest runtime-log retention your plan offers. Vercel's own request logs record request paths, including the action token in `/a/{token}/…` links; Autopilot's own logs never contain tokens or content.

---

## 4. QStash keys and callback URLs

There is no account-level "callback URL" in QStash: Autopilot names the destination on every publish ([WIREUP-QSTASH-CALLBACK-URL]). Every job is published to `<APP_URL>/api/jobs/run` with a failure callback to `<APP_URL>/api/jobs/failed`, and both routes verify QStash's signature against those exact URLs, so `APP_URL` must be the public production origin.

1. **Region and keys.** console.upstash.com → QStash → choose the region (0.3) → the Quickstart / Request Builder panel† shows four values. Copy all four **from the same region** ([QS-ENV-REGION]):
   - `QSTASH_URL` (e.g. `https://qstash-us-east-1.upstash.io`; copy it exactly, the default host is the EU one);
   - `QSTASH_TOKEN`;
   - `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` (`sig_…`; the app accepts either, [QS-SIG-KEYS-ROTATION]).
2. **Plan (check #7).** On the plan/pricing page†, note: the maximum delay (Free: 7 days), the retry limit (Autopilot sends `Upstash-Retries: 4`, i.e. 5 deliveries) and the daily message quota. Pay-as-you-go is recommended ([QS-FREE-QUOTA]). Leave `QSTASH_MAX_DELAY_SECONDS` at its default `601200` (7 days minus 1 hour) unless the plan's maximum is lower; then set it to that maximum minus 3600. Jobs further away "hop" (D-15).
3. **Add to Vercel** (Production): the four values above. Leave `QSTASH_MAX_DELAY_SECONDS` unset unless step 2 said otherwise.
4. **Only if you use QStash schedules instead of Vercel Cron** (Hobby, or by choice; D-16, [QS-SCHEDULES-ALTERNATIVE]):
   - Make sure each tick runs once:
     - **On Hobby**, Vercel may refuse any deployment whose `vercel.json` declares these crons (check #6), and the dashboard setting cannot help because the deployment never gets that far. Change the repository first: replace `vercel.json`'s content with `{}` (delete the `crons` array), `git add vercel.json` (that path only), commit, push, and let Vercel redeploy. The tests and CI accept a `vercel.json` with no `crons` key (`test/layout/file-layout.test.ts`; an empty or partial list still fails), and `scripts/qstash-schedules.ts` holds the same three schedules.
     - **On Pro, by choice:** either do the same, or turn Vercel's cron jobs off (Settings → Cron Jobs → Disable†).
   - Once the worksheet is complete (step 9.1; the script checks the whole live environment first), preview, then create, the three schedules:
     ```sh
     npx tsx --env-file=.env.wireup --tsconfig tsconfig.scripts.json scripts/qstash-schedules.ts --dry-run
     npx tsx --env-file=.env.wireup --tsconfig tsconfig.scripts.json scripts/qstash-schedules.ts
     ```
     It creates or updates `prod-cron-poll`, `prod-cron-weekly-report` and `prod-cron-daily` (ids from `ENV_NAMESPACE`), each a signed POST to `<APP_URL>/api/cron/*` on the same UTC schedule as `vercel.json`. Running it again only updates them. A new schedule can take up to 60 s to start.
   - Check: QStash → Schedules† lists the three.

---

## 5. Resend sending domain

Every email Autopilot sends goes through Resend from your own domain: new-lead and follow-up drafts, sign-in links, reports, billing and account notices.

1. **Add the domain** ([RS-DOMAIN-DNS]). resend.com → Domains → Add Domain → `autopilot.hublytix.ai` → region (0.3; it cannot be changed later) → Add.
2. **DNS records.** In the DNS zone of `hublytix.ai`, create exactly the records Resend shows. With the default return path they are:

   | Type | Name (in the `hublytix.ai` zone) | Value | Priority |
   |---|---|---|---|
   | MX | `send.autopilot` | `feedback-smtp.<region>.amazonses.com` (e.g. `feedback-smtp.us-east-1.amazonses.com`) | 10 |
   | TXT | `send.autopilot` | `v=spf1 include:amazonses.com ~all` | |
   | TXT | `resend._domainkey.autopilot` | `p=MIGf…` (your account's DKIM key; copy it from Resend; some accounts get CNAMEs instead) | |
   | TXT (recommended) | `_dmarc.autopilot` | `v=DMARC1; p=none; rua=mailto:dmarc@hublytix.ai` | |

   On Cloudflare, set these records to "DNS only" (no proxy). Then click Verify in Resend and check from your computer:
   ```sh
   dig +short MX send.autopilot.hublytix.ai              # 10 feedback-smtp.us-east-1.amazonses.com.
   dig +short TXT send.autopilot.hublytix.ai             # "v=spf1 include:amazonses.com ~all"
   dig +short TXT resend._domainkey.autopilot.hublytix.ai   # "p=MIGf..."
   ```
   Wait until the domain shows **Verified**.
3. **Domain settings.** Turn **click tracking and open tracking off** (D-26: Resend's link rewriting would also break the one-tap links, and the brief rules out tracking pixels).
4. **API keys.** API Keys → Create API Key:
   - `autopilot-prod`: permission **Sending access**, domain `autopilot.hublytix.ai` → `RESEND_API_KEY`;
   - `supabase-smtp`: the same permission, a separate key so each can be rotated alone (used in 5.5).
5. **Supabase custom SMTP** ([SB-SMTP-RESEND], [SB-AUTH-EMAIL-LIMITS]). Supabase → Authentication → Emails → SMTP Settings† → enable custom SMTP: sender email `login@autopilot.hublytix.ai`, sender name = your product name, host `smtp.resend.com`, port `465`, username `resend`, password = the `supabase-smtp` key → Save. Autopilot never asks Supabase to send an email (it sends its own sign-in links through Resend, D-22); this only makes sure that anything Supabase does send leaves through your domain instead of Supabase's 2-per-hour team-only sender.
6. **Sender and reply address.** `EMAIL_FROM` = `Hublytix Autopilot <notify@autopilot.hublytix.ai>` (any address on the verified domain); `EMAIL_REPLY_TO` = a support inbox someone reads. `EMAIL_REPLY_TO` is the Reply-To of sign-in and billing emails only; lead emails reply to the owner's own address (D-27), and the Disconnect page names it as the support contact.
7. **Retention (check #10, part 2).** Find how long Resend keeps sent email content (dashboard settings† or its documentation). Choose 30 days or less if it is configurable; otherwise record the figure as a deviation in D-49. `/privacy` gives no day count for Resend until this is settled (PLAN §16 R17).
8. **Add to Vercel** (Production): `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`.

---

## 6. Anthropic API key and models

1. **Key.** console.anthropic.com → Settings → API Keys† → Create Key (name `autopilot-prod`) → `sk-ant-…` → `ANTHROPIC_API_KEY`. Add it to Vercel (Production).
2. **Spend.** Set a monthly spend limit on the account† that is higher than Autopilot's own breaker: `AI_DAILY_BUDGET_USD` (default 25 USD a day across all accounts, D-36) stops drafting for the day and alerts you; leads then get the "needs your touch" email with a starter template, never silence.
3. **Models (defaults, D-24, D-25).** Leave these unset unless you have a reason:

   | Variable | Default | Purpose |
   |---|---|---|
   | `ANTHROPIC_MODEL_DRAFT` | `claude-sonnet-5-5` | drafts, follow-ups, the business brief |
   | `ANTHROPIC_MODEL_FAST` | `claude-haiku-4-5-20251001` | classification, baseline |
   | `ANTHROPIC_DRAFT_THINKING` | `between_tools` | `between_tools` or `adaptive` |
   | `ANTHROPIC_DRAFT_EFFORT` | `medium` | `xhigh`/`max` need `adaptive` |
   | `ANTHROPIC_DRAFT_MAX_TOKENS` | `1024` | |
   | `ANTHROPIC_BRIEF_EFFORT` | `high` | first brief attempt |

4. **Check #12 (AI), here and in step 9.**
   - Deprecations: open Anthropic's model-deprecations page. If Haiku 4.5 has a retirement date, set `ANTHROPIC_MODEL_FAST=claude-sonnet-5-5` (no code change, D-25).
   - Prices: compare the pricing page with the rate table in `src/server/ai/pricing.ts` (prices as of 2026-10-01, [AI-PRICING-COST]). If they changed, update the table and its test in a commit.
   - Account date: note when the Anthropic account was created ([AI-MODEL-SONNET55]; on or after 2026-08-31 Sonnet 5.5 enforces its thinking-block check, which Autopilot's single-turn retries never trigger). Record it.
   - One live request per schema (classification, brief, draft) happens naturally in step 9.3; how to read the result is there.
5. **Retention (check #10, part 3).** Read Anthropic's commercial data-retention page for API inputs and outputs ([AI-DATA-RETENTION]) and record the figure in D-49; `/privacy` gives no day count until legal review.

---

## 7. Razorpay plan, webhook and keys

Razorpay bills $49/month in USD through a hosted subscription page; Autopilot creates the subscription, sends the owner to its `short_url`, and learns the outcome from signed webhooks plus a daily reconcile (D-18 to D-20). Do the whole step once in **Test mode** (for check #8), then again in **Live mode** for production. Production refuses test keys: on Vercel production `RAZORPAY_KEY_ID` must start with `rzp_live_`.

Dashboard steps per mode ([RZP-WIRE-UP-WEBHOOK]):
1. **Checkout features.** Account & Settings → Checkout Features† → enable **Flash Checkout**†; make sure Subscriptions is enabled.
2. **Cards in USD.** Subscriptions → Settings → **Card**† → on (recurring card payments in international currencies, [RZP-USD-INTERNATIONAL]).
3. **International Cards** (Live; needs a verified website). Account & Settings → International payments† → **Activate International Cards**. Razorpay reviews the site's Terms, Privacy, Refund and Cancellation, and Shipping pages: `<APP_URL>/terms`, `/privacy`, `/refunds`, `/shipping` (D-20). The reviewed texts from 0.7 must already be live there; Razorpay may refuse placeholders (PLAN §16 R12).
4. **API keys.** Account & Settings → API Keys† → Generate Key → download the file. `RAZORPAY_KEY_ID` (`rzp_test_…`/`rzp_live_…`) and `RAZORPAY_KEY_SECRET` must come **from the same download** (brief §10.7): a mismatched pair makes every Razorpay call fail with "The api key provided is invalid" ([RZP-API-KEYS]).
5. **Plan** ([RZP-PLAN-CREATE]). Plans cannot be edited; a price change means a new plan. Create it with the keys from 4 (same mode):
   ```sh
   rzp_id=rzp_test_…; rzp_secret=…   # shell variables for this mode's pair (not app variables); unset them when done
   curl -sS -u "$rzp_id:$rzp_secret" -X POST https://api.razorpay.com/v1/plans \
     -H 'Content-Type: application/json' \
     -d '{"period":"monthly","interval":1,"item":{"name":"Hublytix Autopilot","amount":4900,"currency":"USD","description":"$49/month"}}'
   ```
   Copy the `id` (`plan_…`) → `RAZORPAY_PLAN_ID`. Smoke test (D-20): the same pair must read it back with `"amount":4900`, `"currency":"USD"`, `"period":"monthly"`, `"interval":1`:
   ```sh
   curl -sS -u "$rzp_id:$rzp_secret" https://api.razorpay.com/v1/plans/plan_…
   ```
   A 401 means the id and secret are from different generations; a 400 "The id provided does not exist" means a plan from the other mode.
6. **Webhook** (Live mode; in Test mode only if you run a staging deployment, pointing at staging with staging's own secret, Appendix C; never point a Test webhook at production). Account & Settings → Webhooks† → + Add New Webhook:
   - Webhook URL: `<APP_URL>/api/razorpay/webhook`;
   - Secret: the `RAZORPAY_WEBHOOK_SECRET` you generated in 0.4 (mandatory for Autopilot: without it nothing is signed and every delivery is refused);
   - Alert Email: an address you read (Razorpay disables a webhook after 24 hours of failures and emails it, [RZP-WH-RETRY-TIMEOUT]);
   - Active Events: all ten `subscription.*` events: `authenticated`, `activated`, `charged`, `completed`, `updated`, `pending`, `halted`, `cancelled`, `paused`, `resumed` ([RZP-SUB-WEBHOOK-EVENTS-PAYLOAD]);
   - Create Webhook (Test mode asks for an OTP†; the docs give `754081`).
7. **Add to Vercel** (Production, **Live** values): `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_ID`. Leave `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` unset (rotation only).

**Check #8 (in Test mode, with curl and the hosted page; nothing here needs Autopilot).** Use the Test pair and Test plan; every API path below is on `https://api.razorpay.com` with `-u "$rzp_id:$rzp_secret"` (and `-H 'Content-Type: application/json'` with a body). Test cards: `4718 6091 0820 4366` (domestic Visa) and `5104 0155 5555 5558` (international Mastercard)†.
- *USD plan and International Cards:* the plan above was accepted and reads back in USD. Record whether Test mode needed International Cards first.
- *Future-start subscription (Autopilot's trial path):* create one that starts in 14 days and open its `short_url`:
  ```sh
  now=$(date +%s)
  curl -sS -u "$rzp_id:$rzp_secret" -X POST https://api.razorpay.com/v1/subscriptions \
    -H 'Content-Type: application/json' \
    -d "{\"plan_id\":\"plan_…\",\"total_count\":120,\"quantity\":1,\"customer_notify\":true,\"start_at\":$((now+14*86400)),\"expire_by\":$((now+7*86400))}"
  ```
  Pay with the international test card → `GET /v1/subscriptions/sub_…` says `authenticated`. Note the token amount charged and whether it was refunded ([RZP-TRIAL-START-AT]).
- *Flash Checkout:* the hosted page opens and takes the card (with Flash Checkout off it shows "Oops! Something went wrong").
- *Retrying a `created` subscription:* create another one, decline with a failing card†, then open the same `short_url` again and pay. Record whether the retry works (Autopilot reuses a `created` link while it is valid and replaces it otherwise, D-18).
- *Fetching an expired one:* create one with `expire_by` a few minutes ahead (the minimum is undocumented), do not pay, fetch it after `expire_by` and record the status.
- *Cancel `authenticated` vs `active`:* `POST /v1/subscriptions/sub_…/cancel` with `{"cancel_at_cycle_end":false}` on the authenticated one → `cancelled`. Create one **without** `start_at`, pay (→ `active`), cancel with `{"cancel_at_cycle_end":true}` → stays `active` until `current_end`.
- *Resume:* on another active one, `POST …/pause {"pause_at":"now"}` → `paused`; `POST …/resume {"resume_at":"now"}` → `active` (D-18).
- *Webhook deliveries:* none of the above needs a webhook (each result is read back with `GET /v1/subscriptions/sub_…`, as Autopilot itself does). With a staging deployment, its Test webhook's delivery log† shows the events these produced and staging's `/admin` the last one received; production's own delivery check is 9.3 step 11.

---

## 8. Sentry DSN

Sentry receives errors only (no tracing, no replays), through one shared configuration that drops request bodies, headers, cookies and query strings and rewrites URLs (D-23). Without a DSN it is off.

1. **Project.** sentry.io → Projects → Create Project → platform Next.js → name `hublytix-autopilot`. Copy the DSN (`https://<key>@<host>/<project id>`; its public key is not a secret).
2. **Variables** (Vercel, Production): `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`, both the same DSN. `NEXT_PUBLIC_SENTRY_DSN` is built into the browser bundle and into the CSP `connect-src`, so it must be set **before** the deployment is built (9.1 rebuilds). It is the only public value besides the product name.
3. **Source maps (optional, build only).** Settings → Auth Tokens† → create an organisation token that can upload releases → `SENTRY_AUTH_TOKEN`; plus `SENTRY_ORG` and `SENTRY_PROJECT` (the slugs). Without the token nothing is uploaded and no browser source maps are produced.
4. **Never set** `SENTRY_TRACES_SAMPLE_RATE` (on `@sentry/nextjs` the variable alone turns tracing on, which would leak action tokens in span names, [SENTRY-RECOMMENDED-CONFIG]), `SENTRY_SPOTLIGHT` or `SENTRY_DEBUG`. Live mode refuses all three.
5. **Server-side scrubbing** ([SENTRY-URL-QUERY-LEAK]). Project Settings → Security & Privacy†:
   - Data Scrubber: on; Use Default Scrubbers: on; Prevent Storing of IP Addresses: on;
   - Additional Sensitive Fields: only distinctive token prefixes: `apt_`, `sk-ant-`, `sb_secret_`, `rzp_live_`. Never generic words (`message`, `code`, `state`, `body`): an entry also erases any value that contains it;
   - Advanced Data Scrubbing†: `[Remove] [Anything] from [$http.data]`, and the same for `$http.cookies` and `$http.headers`.
6. **Alerts.** Autopilot's admin alerts (`raiseAlert`: failed jobs, unknown subscriptions, quota errors, the budget breaker, …) arrive as Sentry messages tagged `alert:<code>`, all with the fingerprint `['alert', <code>]`: each alert code is **one** Sentry issue, and every later alert of that code is a new event on it. A rule on "A new issue is created" alone would email you only the first time each code is seen. Create one issue alert rule (Alerts → Create Alert† → Issues†):
   - **When** any of these conditions is met†: "A new issue is created"; "The issue changes state from resolved to unresolved"; "The issue is seen more than 0 times in 1 hour"† (the event-frequency condition);
   - **If** (filter)†: "The event's tags match `alert` is set"† (so ordinary errors follow your normal rules);
   - **Then**: send an email to you (or your team);
   - **Action interval**†: 60 minutes (at most one email per alert code per hour).
   After acting on an alert, **resolve its issue** in Sentry, so the next occurrence reopens it and alerts again (the deliberate check in 9.2 ends the same way).
7. The checks that need a running deployment (the `register()` log line, a scrubbed server event, a browser event without a CSP violation) are in 9.2.

---

## 9. Post-deploy smoke test and screenshot checklist

### 9.1 Redeploy with every variable

1. Fill in the whole worksheet and validate it (0.5): the dry run must print the schedule plan, not `invalid environment`. (It cannot check the one rule that applies only on Vercel production: `RAZORPAY_KEY_ID` must start with `rzp_live_`.)
2. Compare it with Vercel's Production variables (Appendix B lists every one and whether to set it).
3. Vercel → Deployments → the latest production deployment → ⋯ → **Redeploy**† (a variable change takes effect only on a new deployment).
   If you chose QStash schedules (4.4), create them now.
4. When it is ready, set `APP_URL` in your shell and keep a terminal open for the checks below:
   ```sh
   export APP_URL=https://autopilot.hublytix.ai
   export CRON_SECRET=…   # from your password manager; unset it when done
   ```

### 9.2 Endpoint checks

Every response below comes from Autopilot itself: JSON bodies like `{"ok":false,…}`. An HTML login page, or a redirect to vercel.com, instead of the 401 bodies means Deployment Protection covers production (check #6, step 3.8).

| # | Command | Expected |
|---|---|---|
| 1 | `curl -sS $APP_URL/api/health` | `{"ok":true,"mode":"live"}`. `"mode":"unknown"` = the environment is invalid: Vercel → the deployment → Logs† show a `health: invalid environment` line whose `codes` name the variables at fault (once per server instance; any other route then logs `Invalid environment (N problems): VARIABLE: problem`), or run the dry run of 0.5 |
| 2 | `curl -sS -o /dev/null -D - $APP_URL/` | `200`; headers include `content-security-policy` with `script-src 'self' 'nonce-…' 'strict-dynamic'`, `form-action 'self'`, `frame-ancestors 'none'`, and `connect-src 'self' https://<your Sentry ingest host>` (just `'self'` without Sentry); `strict-transport-security: max-age=63072000; includeSubDomains`; `x-content-type-options: nosniff`; `referrer-policy: same-origin`; `permissions-policy: camera=(), …`; `x-frame-options: DENY`; no `x-powered-by` |
| 3 | `for p in /login /privacy /terms /refunds /shipping; do curl -sS -o /dev/null -w "$p %{http_code}\n" $APP_URL$p; done` | `200` for each; open the four legal pages in a browser: each says "TODO: legal review" |
| 4 | `curl -sS -o /dev/null -D - $APP_URL/api/hubspot/install` | `302`; `location: https://app.hubspot.com/oauth/authorize?client_id=<HUBSPOT_CLIENT_ID>&redirect_uri=https%3A%2F%2Fautopilot.hublytix.ai%2Fapi%2Fhubspot%2Foauth%2Fcallback&scope=oauth%20crm.objects.contacts.read%20forms%20sales-email-read&state=…`; a `set-cookie: ap_hs_state=…` |
| 5 | `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' $APP_URL/dashboard` | `303 https://autopilot.hublytix.ai/login` (no session) |
| 6 | `curl -sS -o /dev/null -w '%{http_code}\n' $APP_URL/dev` | `404` (the dev tools exist in fake mode only) |
| 7 | `curl -sS -X POST $APP_URL/api/jobs/run -H 'Content-Type: application/json' -d '{}'` | `{"ok":false,"code":"missing_signature"}` (401) |
| 8 | `curl -sS -X POST $APP_URL/api/hubspot/webhooks -H 'Content-Type: application/json' -d '[]'` | `{"ok":false,"code":"invalid_signature"}` (401) |
| 9 | `curl -sS -X POST $APP_URL/api/razorpay/webhook -H 'Content-Type: application/json' -d '{}'` | `{"ok":false,"code":"invalid_signature"}` (401) |
| 10 | `curl -sS $APP_URL/api/cron/poll` | `{"ok":false,"code":"unauthorized"}` (401) |
| 11 | `curl -sS -H "Authorization: Bearer $CRON_SECRET" $APP_URL/api/cron/poll` | `200` with `{"ok":true,…}` and counts only. A `500 {"ok":false,"code":"cron_poll_error"}` means the database or a service is unreachable: see the function logs |

Then, for Sentry (step 8):
- **Instrumentation ran:** Vercel → the deployment → Logs†: a line `{"level":"info","msg":"instrumentation registered","event":"obs.register","runtime":"nodejs","sentry":true}`. `"sentry":false` means `SENTRY_DSN` was missing at runtime.
- **A scrubbed server event:** send a correctly signed Razorpay webhook for a subscription Autopilot doesn't know. It changes nothing (one `webhook_events` row, outcome `unknown_subscription`) and raises the admin alert `billing_webhook_unknown_subscription` in Sentry:
  ```sh
  wh_secret=…   # the Live RAZORPAY_WEBHOOK_SECRET value, as a shell variable; unset it when done
  body="{\"entity\":\"event\",\"event\":\"subscription.activated\",\"created_at\":$(date +%s),\"payload\":{\"subscription\":{\"entity\":{\"id\":\"sub_WireupCheck0001\",\"status\":\"active\",\"plan_id\":\"plan_WireupCheck\",\"notes\":[]}}}}"
  sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$wh_secret" | sed 's/^.* //')
  curl -sS -X POST "$APP_URL/api/razorpay/webhook?probe=should-not-reach-sentry" \
    -H 'Content-Type: application/json' -H "X-Razorpay-Signature: $sig" -H 'x-razorpay-event-id: wireup-check-1' \
    -H 'Cookie: probe=should-not-reach-sentry' --data-raw "$body"
  ```
  Expect `{"ok":true,"outcome":"unknown_subscription"}`. In Sentry, the event `billing_webhook_unknown_subscription` must have no request body, no headers, no cookies, no query string and no `should-not-reach-sentry` anywhere ([SENTRY-SCRUBBER-TEST]); resolve it afterwards.
- **A browser event:** open `<APP_URL>/login`, open the browser console and run `setTimeout(() => { throw new Error('wireup-browser-check') })`. The error arrives in Sentry, and the console shows no Content-Security-Policy violation for the Sentry host ([SENTRY-TUNNEL-CSP]).
- Check that `SENTRY_TRACES_SAMPLE_RATE` exists in no Vercel environment.

### 9.3 End to end on a test portal

Use the HubSpot developer test account (then repeat the starred steps on a Free and a Starter portal for checks #2 and #4). You need: your phone, a second device (or a second browser), and an "other" personal address you can send from (not on your company domain).

1. **Install** (checks #1, #9). Open `<APP_URL>` → **Install with HubSpot** → HubSpot's consent screen lists the four permissions, including reading logged emails (screenshot) → pick the test portal → approve. You land on `/onboarding/email`. If you land on `/install/failed?reason=missing_scopes`, HubSpot did not grant every scope: check #1 failed.
   Also try once with a portal user who is neither a Super Admin nor has App Marketplace Access (check #9): record what HubSpot shows; Autopilot's landing page and failure page both name the permission needed.
2. **Owner email and magic link** (check #11). Enter a fresh address you control → **Send me the link** → the email "Confirm your email for Hublytix Autopilot" arrives from `EMAIL_FROM` within a minute (Resend → Emails† shows it delivered). Open the link **on your second device** → **Sign in** → you land on `/onboarding/brief`, signed in there.
3. **Brief.** Enter the business website → the summary appears within a few minutes → read it, confirm or replace the booking link → **Save and continue**.
4. **Forms** (★ check #2). Newsletter-like forms are unticked; tick the contact form you will test with → **Save and continue**.
5. **Preferences** (★ check #3). The time zone shows as detected from HubSpot (from `account-info/2026-09/details`). If the page asks you to choose one, that call failed: record it (the fallback is built in, D-12). Choose your mail client, keep your address, set quiet hours, and paste the portal's BCC logging address (HubSpot: Settings → Objects → Activities → Email Log & Track → BCC address†, [HS-BCC-LOGGING]) → **Save preferences**.
6. **Inbox check** (★ checks #1, #4). The page shows how many logged emails HubSpot holds for the last 30 days (two `emails/search` counts: these need `sales-email-read`). Enter your "other" address → **Start the test** → a test-lead email arrives → tap **Send from my email** and send it from your mailbox → then reply to it from the "other" address. Within 10 minutes each: "Your send is logged" and "Replies from leads are logged" turn to seen or not seen. Record both legs per portal, and the HubSpot logging setup you used (BCC only; connected inbox with "Log all emails to/from known contacts"†, [HS-CONNECTED-INBOX]).
7. **Baseline and finish.** The baseline runs in the background → **Finish setup** → `/dashboard` shows Active and the trial days left.
8. **A lead** (★ check #2; check #12). From a phone or a private window, submit the ticked HubSpot form as a new contact with a short enquiry. Within about a minute (webhook → poll; at most the 5-minute cron) the owner address gets **"New lead: {first name} — your reply is ready"** with the draft and three buttons. The dashboard lists the lead as Drafted.
   Check #12: by now the brief, the classification and the draft have each made a live request with their schema. Sign in to `/admin` (step 10 below): the AI section counts the calls and lists no AI error codes (any outcome other than ok is listed by code), and Sentry has no `ai_fatal_config` alert. A "Schema is too complex for compilation" answer would show up there, and the lead would have got the "needs your touch" email instead of a draft.
9. **Send it** (check #5). On your phone, tap **Send from my email** → your mail app opens with the lead's address, subject and draft filled in → send. Within a few minutes of HubSpot logging it, the lead page (`/dashboard/leads/<id>`, it refreshes on view) shows "Send link opened" and then "Send confirmed in HubSpot".
10. **Admin.** Sign out, go to `/login`, enter an `ADMIN_EMAILS` address → **Email me a sign-in link** → open it → `/admin` shows the portal, its state, the last HubSpot webhook, failed jobs and AI calls, and no names, addresses or message text (screenshot). Any other signed-in account gets a 404 there.
11. **Billing, live** (check #8, production half). As the owner: `/dashboard/billing` → **Subscribe** → Razorpay's hosted page → a real card. With more than one day of trial left the subscription starts at the trial end, so only Razorpay's auto-refunded authorisation amount is taken ([RZP-TRIAL-START-AT]). Razorpay does not send you back: return to `/dashboard/billing`, which shows "Waiting for Razorpay" and refreshes itself until the webhook arrives; then the status is subscribed; `/admin` shows a Razorpay webhook received. Then **Cancel subscription** → "Your subscription is cancelled. Nothing was charged." Razorpay's dashboard shows it `cancelled`.
12. **HubSpot webhooks** (check #9). The project's monitoring page† (developer account) lists the `object.creation` deliveries with 200 responses; `/admin` shows the last HubSpot webhook time.
13. **Disconnect** (only after the first-week checks in 9.7, or on a second test install, because it stops everything for this account). `/dashboard/settings` → **Disconnect HubSpot** → confirm. HubSpot emails the portal's admins that the app was uninstalled; the dashboard says HubSpot is disconnected and when the data will be deleted (30 days); links in old emails stop working. Signing in and choosing Reconnect HubSpot within those 30 days restores the account.

### 9.4 Manual browser and phone checks

There was no browser in the build sandbox, so these were never run against real browsers (D-62, D-13):
- **Magic link in Chrome and in Firefox** (desktop): sign in once and sign out once in each. In DevTools → Network, the POST to `/auth/confirm` must carry `Origin: <APP_URL>` and answer `303` to the next page (`/onboarding/brief` for an onboarding link, `/dashboard` otherwise), never the 403 page. The sign-out POST (`/auth/signout`) answers `303` to `/login?signed_out=1`.
- **Compose links** (check #5), with BCC on, for each mail client setting (change it on `/dashboard/settings`) and a fresh lead or the inbox-check test lead:
  - Gmail, on both forms (`COMPOSE_GMAIL_FORM=u`, the default, and `view`), on the `/u/<email>/` path, signed in and signed out, including **Edit first**;
  - Outlook work or school, and Outlook personal, with `COMPOSE_OUTLOOK_MODE=mailtouri` (to with a plus-address, cc, bcc, subject, a multi-line body: research marks this a launch blocker, [CMP-OUTLOOK-PARAMS-BCC]);
  - on phones: iOS Safari, the Gmail app's in-app browser, the Outlook app's in-app browser, Android Chrome. The page should open the mail app by itself (one tap); if a browser blocks that, the owner taps **Open mail app** (two taps, accepted by D-13). Record one tap or two for each;
  - a long draft near 1,800 characters falls back to the "Copy your reply" page ([CMP-URL-LENGTH-LIMITS]).
  Changing `COMPOSE_*` variables needs a redeploy (9.1).
- **Public pages.** On `<APP_URL>/privacy`, open each sub-processor's policy link once (HubSpot, Anthropic, Supabase, Vercel, Upstash, Resend, Razorpay, Sentry). They were never fetched from the build sandbox; if one has moved, correct it in `src/components/marketing/legal.ts` (the only place the links live) and redeploy. The landing page's footer must reach `/privacy`, `/terms`, `/refunds` and `/shipping` (Razorpay's website review looks for them, step 7.3).
- **Legal review before launch** (started in 0.7; confirm it is done). `/privacy`, `/terms`, `/refunds` and `/shipping` ship as placeholders marked "TODO: legal review": the contact details, the governing law and the refund policy itself are still to be decided, and `/refunds` says a payment taken after an account was deleted is refunded (the code cancels the subscription and alerts you, `billing_tombstone_cancelled_refund`; the refund is made by hand in Razorpay). `/privacy` states no Log Drains and the shortest log retention (3.9) and gives no day counts for the providers' own retention until check #10 is recorded. Replace each page's text with the reviewed text and remove its "TODO: legal review" marker only then (`test/pages/public-pages.test.tsx` checks the marker today; change it in the same commit).

### 9.5 The fourteen live checks: where, and what to do if one fails

| # | Check (PLAN §17) | Where | If it fails |
|---|---|---|---|
| 1 | `sales-email-read` accepted at upload and install; emails readable with `hs_email_direction` | 1.4, 9.3 (1, 6), Appendix A | D-03 path (b), two files: set `ASK_FOR_EMAIL_READ_SCOPE = false` in `src/server/hubspot/email-scope-switch.ts` (`REQUIRED_SCOPES` follows; `canReadEmails` is then false for every grant) and remove `"sales-email-read"` from `requiredScopes` in `hubspot-app/src/app/app-hsmeta.json` (`test/hubspot/app-config.test.ts` checks the two agree; `test/hubspot/email-scope-path-b.test.ts` already runs path (b)). For fake mode to match, also drop it from `grantedScopes` in `test/fixtures/hubspot-portal.json`; the simulation's checks that rely on logged emails (sends and replies confirmed in HubSpot) then fail by design and are re-baselined to "Not enough data" in the same change. Run every gate; commit (stage those paths only); redeploy; `hs project upload`. Every email-based figure then says "Not enough data" (built in). Path (a), `crm.objects.emails.read`, only if the scope picker really offers it ([HS-SCOPE-EMAIL-READ-RISK]). Record in DECISIONS |
| 2 | Submissions endpoint: page size 50, newest first, `forms` scope enough, on Free and Starter; `captured` forms | 9.3 (4, 8) on each portal; Appendix A for the raw call | Intake depends on it (D-07): record the actual behaviour and stop the launch until intake is adapted (the CRM-search trigger is the documented fallback, [HS-INTAKE-SEARCH-RECENT-CONVERSION], not built in v1). `captured` forms stay excluded unless they work |
| 3 | `account-info/2026-09/details` works with `oauth` | 9.3 (5); Appendix A | The preferences page asks for the time zone (built in, D-12). Record it; adding `external-settings-access` would be a new scope and needs a decision |
| 4 | Where the BCC address lives; connected inbox "Log all"; both inbox-check legs on Free and Starter | 9.3 (5, 6) | Record the real labels and behaviour; fix the onboarding fix-step copy and the BCC soft check (D-46) to match. Owners whose replies can't be logged get the honest notes and "Not enough data" (D-34, D-37) |
| 5 | Compose links (Gmail forms, Outlook hosts with `mailtouri`, phones, one tap or two) | 9.4 | Gmail: switch `COMPOSE_GMAIL_FORM`. Outlook: try `COMPOSE_OUTLOOK_MODE=params`, or other bases via `COMPOSE_OUTLOOK_WORK_BASE` / `COMPOSE_OUTLOOK_PERSONAL_BASE`; if neither works, Outlook owners use "Open in default mail app" and the copy page. Blocked auto-open: two taps, record it |
| 6 | Vercel cron plan limits; Deployment Protection lets QStash in | 3.7, 3.8, 9.2 (7, 11) | Cron refused: Pro, or delete the `crons` array from `vercel.json` (commit that path only, redeploy) and create QStash schedules (4.4). Protection: make the production domain public |
| 7 | QStash maximum delay, retries ≥ 4, daily quota | 4.2 | Lower `QSTASH_MAX_DELAY_SECONDS` to the plan maximum − 3600; a plan that caps retries below 4 or a quota you will reach: move to pay-as-you-go |
| 8 | Razorpay: USD plan + International Cards; Flash Checkout; retry `created`; fetch expired; cancel `authenticated` vs `active`; Resume | 7 (Test mode), 9.3 (11) | Activation or USD refused: complete International Cards (legal pages) before launch. Different status behaviour: record it; checkout, cancel and resume copy and rules live in `src/server/services/billing/` and `src/server/domain/checkout-guard.ts` (D-18, D-82) |
| 9 | Webhook settings take up to 5 minutes; a non-admin install attempt | 1.6, 9.3 (1, 12) | Wait and retry; record what HubSpot shows a non-admin |
| 10 | Retention: Resend, Anthropic, Supabase backups | 2.9, 5.7, 6.5 | Record each in D-49; above 30 days and not configurable → a recorded deviation, and legal reviews the `/privacy` wording |
| 11 | Magic link: fresh address → onboarding → session; a second device | 9.3 (2), 9.4 | No email: Resend domain, `EMAIL_FROM`, Resend logs. A 403 page on confirm: the browser sent no usable Origin (D-62), record browser and version. Supabase rate limit: 2.7 |
| 12 | AI: one live request per schema; effort sweep; Haiku status | 6.4, 9.3 (8) | Schema refused: a code change in `src/server/ai/` (schemas and `json-schema.ts`). Sweep: there is no sweep script in v1; send the same 5–10 representative enquiries with the defaults and with `ANTHROPIC_DRAFT_THINKING=adaptive`, `ANTHROPIC_DRAFT_EFFORT=high`, `ANTHROPIC_DRAFT_MAX_TOKENS=8000` ([AI-REQUEST-RECOMMENDATIONS]); compare how many pass the checks and the latency; keep the better and record it. Haiku retiring: `ANTHROPIC_MODEL_FAST=claude-sonnet-5-5` |
| 13 | Refresh-error body after uninstall; introspect of the revoked token | Appendix A | Expected: 400 `invalid_grant` / `BAD_REFRESH_TOKEN`, then `{"active":false}`. A different body: update `src/server/hubspot/refresh-classifier.ts` and its fixtures so a revoked token is never treated as transient ([HS-OAUTH-REFRESH-ERRORS]) |
| 14 | `hs_email_optout`, `hs_email_hard_bounce_reason_enum`, `hs_email_bad_address` | Appendix A | Different names or values: update the stop rules (`src/server/domain/signals.ts`, `src/server/domain/stops.ts`) and the contact property allow-list ([HS-OPTOUT], [HS-BOUNCE-BADADDRESS]) |

### 9.6 Screenshot checklist

Keep these outside the repository (they show account details). Hide or crop secrets, and personal data other than your own test addresses.

- **HubSpot:** the project page with the app component; the Auth tab (client secret hidden) with the redirect URL; the webhook subscriptions; the consent screen listing the four permissions; the monitoring page with 200 deliveries; the BCC address location and the logging rules on the Free and Starter portals.
- **Supabase:** the `db push` output; the migration list; the RLS and grants queries returning 0 rows; API Keys (values hidden); URL Configuration; sign-ups off; Data API exposed schemas; SMTP settings (password hidden); Rate Limits; the backup window; the audit-log retention or cron job.
- **Vercel:** Environment Variables (names only); Cron Jobs (three); Domains (valid); Deployment Protection; Build settings (`npm ci`, Node 22.x); Function region; no Log Drains.
- **QStash:** region and plan; Schedules (only if used).
- **Resend:** the domain verified with its records; tracking off; the two API keys' permissions.
- **Anthropic:** the key list (masked); the spend limit.
- **Razorpay (Test and Live):** the plan (USD 49.00, monthly); the webhook with ten events; International Cards active; Flash Checkout on; Subscriptions → Settings → Card on; the Test-mode check results.
- **Sentry:** Security & Privacy settings; the scrubbed `billing_webhook_unknown_subscription` event; the alert rule.
- **The app:** the 9.2 terminal output; the landing page; the four legal pages showing "TODO: legal review"; each onboarding step; the new-lead email on a phone; the compose window filled in, for each client and phone; the dashboard; a lead page; the billing page; settings; `/admin`.

Finally delete the worksheet: `rm .env.wireup`, and `unset CRON_SECRET rzp_id rzp_secret wh_secret`.

### 9.7 The first week

These run on their own; check them as they come due:
- **Day 2 and day 5** after the test lead's email: "Follow-up 1 for {first name} — your draft is ready" and "Follow-up 2 …", inside your quiet hours' allowed window, unless HubSpot shows the lead replied. Reply from the lead's address before day 5 to see "{first name} replied — follow-ups stopped" instead.
- **Monday after 08:00 in the portal's time zone** (about 15 minutes later): the weekly report email, whose numbers match the dashboard. Where HubSpot isn't logging your sends or the leads' replies, it says "Not enough data" instead of 0.
- **Every day at 03:17 UTC:** the daily run (Vercel → Logs: `/api/cron/daily` 200). `/admin` shows no failed jobs and a re-encryption backlog of 0.
- Sentry: no new issues other than the deliberate checks.
- Then run step 9.3's Disconnect on the test install if you want to see it, and the probe's check #13 (Appendix A) last.

---

## 10. Key rotation runbook

Rotate on a schedule, and at once if a secret may have leaked. Each change to a Vercel variable takes effect only after a redeploy (9.1 step 3). Where a `_PREVIOUS` variable exists, the app accepts the old value while the new one rolls out.

| Secret | Has a "previous"? | What it protects |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | `TOKEN_ENCRYPTION_KEY_PREVIOUS` (decrypt only) | HubSpot tokens at rest (D-51) |
| `HUBSPOT_CLIENT_SECRET` | `HUBSPOT_CLIENT_SECRET_PREVIOUS` (webhook verification only) | token refresh; HubSpot webhook signatures |
| `RAZORPAY_WEBHOOK_SECRET` | `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` (verification only) | Razorpay webhook signatures |
| `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | built in (either key verifies) | job and schedule deliveries |
| `CRON_SECRET` | no | Vercel Cron calls |
| `APP_SECRET` | no | cookies, rate-limit and dedupe keys |
| `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`, `QSTASH_TOKEN`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_SECRET_KEY`, database password, `SENTRY_AUTH_TOKEN` | no | calls to that service |

**`TOKEN_ENCRYPTION_KEY`** (ciphertexts carry a key id; a daily job re-encrypts old ones):
1. `openssl rand -base64 32` → the new key.
2. In Vercel: `TOKEN_ENCRYPTION_KEY_PREVIOUS` = the current value; `TOKEN_ENCRYPTION_KEY` = the new key (it must differ from both the previous key and `APP_SECRET`). Redeploy.
3. New tokens are written with the new key; old ones still decrypt. Each account's daily job (after 03:17 UTC) re-encrypts the rest.
4. Wait until `/admin` shows a re-encryption backlog of 0 (one daily run; check the next morning). A `token_reencrypt_failed` alert in Sentry means a ciphertext could not be read: investigate before going on.
5. Remove `TOKEN_ENCRYPTION_KEY_PREVIOUS` and redeploy. Removing it while the backlog is above 0 makes those connections unreadable.
If the key leaked together with a database copy, the stored HubSpot tokens are exposed too: access tokens expire within about 30 minutes, and a refresh token is useless without the client secret, so also rotate `HUBSPOT_CLIENT_SECRET` if it may have leaked as well.

**`HUBSPOT_CLIENT_SECRET`:**
1. Pick a quiet hour. In the app's Auth tab†, rotate the client secret and copy the new one.
2. At once in Vercel: `HUBSPOT_CLIENT_SECRET_PREVIOUS` = the old secret; `HUBSPOT_CLIENT_SECRET` = the new one. Redeploy.
3. Webhooks signed with either secret verify throughout. Token refreshes use only the current secret: until the redeploy finishes, refreshes fail as a configuration error, which never marks a portal revoked (D-11); jobs retry, and you may see one `hubspot_oauth_config` alert.
4. After 24 hours (HubSpot's webhook retry window), remove `HUBSPOT_CLIENT_SECRET_PREVIOUS` and redeploy.

**`RAZORPAY_WEBHOOK_SECRET`:**
1. `openssl rand -hex 32` → the new secret.
2. In Vercel: `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` = the old one; `RAZORPAY_WEBHOOK_SECRET` = the new one. Redeploy.
3. Razorpay → Webhooks† → edit the webhook → paste the new secret → save.
4. After 24 hours (Razorpay's retry window), remove `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` and redeploy.

**Razorpay key pair:** Generate a new key† and choose to keep the old one active for a while (up to 24 hours†). Put both new values (from the same download) into Vercel, redeploy, run the plan smoke test (7.5) with the new pair, then deactivate the old key. Never update only one of the two ([RZP-API-KEYS]).

**QStash signing keys:** QStash → Signing Keys → **Roll keys**† (the next key becomes current and a new next key is made). Copy both into `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY`, redeploy. Between the roll and the redeploy, deliveries are signed with what the app still has as its next key, so they verify. **Never roll twice** before the redeploy: both stored keys would then be stale and every delivery is refused ([QS-SIG-KEYS-ROTATION]).

**`QSTASH_TOKEN`:** reset it in the console†, update the variable, redeploy. Until then publishes fail; the unpublished jobs stay in the database and the sweeper publishes them within minutes after the redeploy.

**`CRON_SECRET`:** `openssl rand -hex 32`, update, redeploy. A missed tick in between is harmless (polling uses cursors, the Monday check is a due-check). QStash schedules, if used, are signed and unaffected.

**`APP_SECRET`** (rotate only if it leaked; there is no previous key): it derives the keys for the OAuth state cookie, the `pending_install` cookie, rate-limit keys and the dedupe HMACs (D-51). After the change and redeploy:
- installs in progress (10 minutes) fail once with "try again"; owners stuck at the email step of onboarding must click Install again;
- rate-limit counters and once-only markers start afresh (expect at most one repeated alert per kind that day);
- an inbox check started before the change no longer recognises its test address, so a form submitted from that address could become a lead: run the change when no inbox check is open, or dismiss such a lead;
- unconfirmed notify-address links stop working; the owner saves their preferences again to get a new one;
- lead deduplication stays correct (the second unique key, contact + submission time, still holds).
Signed-in sessions are Supabase's and are not affected; neither are action links nor stored HubSpot tokens.

**Other API keys** (`RESEND_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_SECRET_KEY`, the database password in `DATABASE_URL`, `SENTRY_AUTH_TOKEN`, the `supabase-smtp` key in Supabase's SMTP settings): create the new key in the service, update the variable, redeploy, check 9.2 rows 1 and 11, then revoke the old key.

---

## Appendix A. HubSpot OAuth probe app (checks #1, #2, #3, #13, #14)

Some checks need a HubSpot access token or refresh token in your hands, which Autopilot never gives out (its tokens are encrypted and never logged). A small separate app gives you one for a test portal. It mirrors Autopilot's scopes and uses the same API paths; it has no webhooks, and its redirect goes to `localhost`, where nothing needs to run.

1. Make the probe project outside the repository:
   ```sh
   cp -r hubspot-app /tmp/hubspot-probe && cd /tmp/hubspot-probe
   rm -r src/app/webhooks
   ```
   Edit `hsproject.json`: `"name": "hublytix-autopilot-probe"`. Edit `src/app/app-hsmeta.json`: `"uid": "hublytix_autopilot_probe"`, `"name": "Autopilot probe"`, and `"redirectUrls": ["http://localhost:3000/probe/callback"]` (localhost is the one http address HubSpot allows). Keep `distribution` and `requiredScopes` as they are.
2. `hs project upload`, then `hs project open` → Auth tab†: note the probe's client ID and secret.
3. Open in a browser (all on one line, with the probe's client ID filled in):
   `https://app.hubspot.com/oauth/authorize?client_id=<probe client id>&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fprobe%2Fcallback&scope=oauth%20crm.objects.contacts.read%20forms%20sales-email-read`
   Pick the test portal and approve. The browser then fails to load `http://localhost:3000/probe/callback?code=…`; copy the `code` value from the address bar (it is valid for a few minutes).
4. Exchange it (form-encoded body, never query parameters, [HS-OAUTH-TOKEN-ENDPOINT]):
   ```sh
   probe_id=…; probe_secret=…; code=…   # shell variables only
   curl -sS -X POST https://api.hubapi.com/oauth/2026-09/token \
     --data-urlencode grant_type=authorization_code --data-urlencode client_id="$probe_id" \
     --data-urlencode client_secret="$probe_secret" --data-urlencode redirect_uri=http://localhost:3000/probe/callback \
     --data-urlencode code="$code"
   at=…   # access_token from the answer (valid about 30 minutes)
   rt=…   # refresh_token
   ```
   If the answer lacks `sales-email-read` in its scopes, that is check #1 failing.
5. **Check #1:** at least one logged email must exist in the portal (the inbox-check test makes one):
   ```sh
   curl -sS "https://api.hubapi.com/crm/objects/2026-09/emails?limit=1&properties=hs_timestamp,hs_email_direction" -H "Authorization: Bearer $at"
   ```
   Expect 200 with `results[0].properties.hs_email_direction` set (`EMAIL`, `INCOMING_EMAIL`, …). A 403 with `MISSING_SCOPES` fails the check.
6. **Check #3:** `curl -sS https://api.hubapi.com/account-info/2026-09/details -H "Authorization: Bearer $at"` → 200 with `timeZone` and `uiDomain`.
7. **Check #2:** get a form id from `curl -sS "https://api.hubapi.com/marketing/v3/forms?limit=100" -H "Authorization: Bearer $at"`, submit that form twice, then:
   ```sh
   curl -sS "https://api.hubapi.com/form-integrations/v1/submissions/forms/<form id>?limit=50" -H "Authorization: Bearer $at"
   ```
   Expect 200, `limit=50` accepted, `results` newest `submittedAt` first, each with `values` (name/value pairs). Repeat on the Free and the Starter portal.
8. **Check #14:** in the portal, opt one test contact out of one-to-one email and hard-bounce another (send to a non-existent address on a real domain from the connected inbox), then read each contact:
   ```sh
   curl -sS "https://api.hubapi.com/crm/objects/2026-09/contacts/<contact id>?properties=hs_email_optout,hs_email_hard_bounce_reason_enum,hs_email_bad_address" -H "Authorization: Bearer $at"
   ```
   Expect `hs_email_optout` `"true"` for the opted-out contact, and a non-empty `hs_email_hard_bounce_reason_enum` (or `hs_email_bad_address` `"true"`) for the bounced one. Record the exact values.
9. **Check #13 (last):** uninstall the probe from the test portal (portal Settings → Integrations → Connected apps → the probe → Uninstall†), wait a minute, then:
   ```sh
   curl -sS -X POST https://api.hubapi.com/oauth/2026-09/token \
     --data-urlencode grant_type=refresh_token --data-urlencode client_id="$probe_id" \
     --data-urlencode client_secret="$probe_secret" --data-urlencode refresh_token="$rt"
   curl -sS -X POST https://api.hubapi.com/oauth/2026-09/token/introspect \
     --data-urlencode client_id="$probe_id" --data-urlencode client_secret="$probe_secret" \
     --data-urlencode token="$rt" --data-urlencode token_type_hint=refresh_token
   ```
   Expect HTTP 400 with `"error":"invalid_grant"` and `"status":"BAD_REFRESH_TOKEN"`, then `{"active":false}`. Record both bodies in the check log (they contain no secret; the request does, so don't record the command line).
10. Clean up: `unset at rt code probe_id probe_secret`; delete the probe project in the developer account†; `rm -r /tmp/hubspot-probe`.

---

## Appendix B. Every environment variable

`src/server/env.ts` is the source of truth; `.env.example` lists the same variables with a one-line comment each. In live mode every variable without a default is required and checked at first use. "Prod" says what to do on Vercel Production.

| Variable | Prod | Value | Step |
|---|---|---|---|
| `APP_MODE` | set | `live` | 3 |
| `ALLOW_FAKE_ON_VERCEL` | **never** | (fake mode only) | – |
| `APP_URL` | set | `https://autopilot.hublytix.ai` | 0.3 |
| `PRODUCT_NAME` | optional | default `Hublytix Autopilot` | 0.3 |
| `APP_SECRET` | set | `openssl rand -base64 32` | 0.4 |
| `TOKEN_ENCRYPTION_KEY` | set | `openssl rand -base64 32` | 0.4 |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | rotation only | the old key | 10 |
| `ADMIN_EMAILS` | set | comma-separated addresses | 0.3 |
| `ENV_NAMESPACE` | set | `prod` | 0.3 |
| `COMPOSE_URL_LIMIT` | default | `1800` | 9.4 |
| `COMPOSE_GMAIL_FORM` | default | `u` (or `view`) | 9.4 |
| `COMPOSE_OUTLOOK_MODE` | default | `mailtouri` (or `params`) | 9.4 |
| `COMPOSE_OUTLOOK_WORK_BASE` | default | `https://outlook.cloud.microsoft/mail/deeplink/compose` | 9.4 |
| `COMPOSE_OUTLOOK_PERSONAL_BASE` | default | `https://outlook.live.com/mail/deeplink/compose` | 9.4 |
| `MAX_DRAFTED_LEADS_PER_DAY` | default | `50` per account | – |
| `AI_DAILY_BUDGET_USD` | default | `25` | 6 |
| `FAKE_DB_DIR` | not used | (fake mode only) | – |
| `DATABASE_URL` | set | transaction pooler URI, port 6543 | 2.5 |
| `SUPABASE_URL` | set | `https://<ref>.supabase.co` | 2.4 |
| `SUPABASE_PUBLISHABLE_KEY` | set | `sb_publishable_…` | 2.4 |
| `SUPABASE_SECRET_KEY` | set | `sb_secret_…` | 2.4 |
| `HUBSPOT_CLIENT_ID` | set | UUID from the Auth tab | 1.5 |
| `HUBSPOT_CLIENT_SECRET` | set | from the Auth tab | 1.5 |
| `HUBSPOT_CLIENT_SECRET_PREVIOUS` | rotation only | the old secret | 10 |
| `HUBSPOT_APP_ID` | set | numeric app id | 1.5 |
| `HUBSPOT_REDIRECT_URI` | set | `<APP_URL>/api/hubspot/oauth/callback` | 0.3 |
| `HUBSPOT_WEBHOOK_TARGET_URL` | set | `<APP_URL>/api/hubspot/webhooks` | 0.3 |
| `HUBSPOT_API_VERSION` | default | `2026-09` | – |
| `HUBSPOT_JOURNAL_ENABLED` | default | `false` (reserved; not built in v1) | – |
| `QSTASH_URL` | set | the region's URL | 4.1 |
| `QSTASH_TOKEN` | set | from the console | 4.1 |
| `QSTASH_CURRENT_SIGNING_KEY` | set | `sig_…` | 4.1 |
| `QSTASH_NEXT_SIGNING_KEY` | set | `sig_…` | 4.1 |
| `QSTASH_MAX_DELAY_SECONDS` | default | `601200` | 4.2 |
| `CRON_SECRET` | set | `openssl rand -hex 32` | 0.4 |
| `RESEND_API_KEY` | set | `re_…`, sending access | 5.4 |
| `EMAIL_FROM` | set | `Hublytix Autopilot <notify@autopilot.hublytix.ai>` | 5.6 |
| `EMAIL_REPLY_TO` | set | a support inbox | 5.6 |
| `ANTHROPIC_API_KEY` | set | `sk-ant-…` | 6.1 |
| `ANTHROPIC_MODEL_DRAFT` | default | `claude-sonnet-5-5` | 6.3 |
| `ANTHROPIC_MODEL_FAST` | default | `claude-haiku-4-5-20251001` | 6.3 |
| `ANTHROPIC_DRAFT_THINKING` | default | `between_tools` | 6.3 |
| `ANTHROPIC_DRAFT_EFFORT` | default | `medium` | 6.3 |
| `ANTHROPIC_DRAFT_MAX_TOKENS` | default | `1024` | 6.3 |
| `ANTHROPIC_BRIEF_EFFORT` | default | `high` | 6.3 |
| `RAZORPAY_KEY_ID` | set | `rzp_live_…` | 7.4 |
| `RAZORPAY_KEY_SECRET` | set | same download as the id | 7.4 |
| `RAZORPAY_WEBHOOK_SECRET` | set | `openssl rand -hex 32` | 0.4, 7.6 |
| `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` | rotation only | the old secret | 10 |
| `RAZORPAY_PLAN_ID` | set | `plan_…` (Live) | 7.5 |
| `SENTRY_DSN` | optional | the DSN | 8.2 |
| `NEXT_PUBLIC_SENTRY_DSN` | optional | the same DSN (needed at build time) | 8.2 |
| `SENTRY_ORG` | optional (build) | organisation slug | 8.3 |
| `SENTRY_PROJECT` | optional (build) | project slug | 8.3 |
| `SENTRY_AUTH_TOKEN` | optional (build) | organisation token | 8.3 |

Read by `env.ts` but never set by you: `VERCEL_ENV` (Vercel sets it). Refused in live mode, so never set: `QSTASH_DEV`, `QSTASH_REGION` and region-prefixed QStash variables, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_SPOTLIGHT`, `SENTRY_DEBUG`, `ANTHROPIC_CUSTOM_HEADERS`.

---

## Appendix C. Staging (optional)

A second, fully separate environment lets you run this whole guide (and Razorpay's Test mode end to end) before production. Build it like production with these differences:
- **Vercel: a separate project** (the simplest way, and the recommended one). Import the same repository a second time as a new project (e.g. `hublytix-autopilot-staging`) whose **production** branch is a `staging` branch and whose production domain is the staging domain (e.g. `staging.autopilot.hublytix.ai`). Its production deployments are public like production's (3.8), and Vercel Cron runs there, so no QStash schedules are needed. Set its variables on that project's Production environment, with `ENV_NAMESPACE=staging`; keep them in a separate worksheet, `.env.wireup-staging`, and pass that file to the 0.5 dry run.
  The alternative, a branch domain on production's own project, needs a Deployment Protection exception for that domain† (under Standard Protection preview and branch domains are protected, and QStash, HubSpot and Razorpay would get Vercel's 401), and Vercel Cron does not run on previews ([VC-CRON-CONFIG]), so it also needs QStash schedules (4.4) from `.env.wireup-staging`. Check either way with 9.2 rows 7–9 against the staging domain.
- **Separate everything stateful:** its own Supabase project (step 2), its own HubSpot project (a copy of `hubspot-app/` with another `name`, `uid` and the staging URLs; HubSpot allows one webhook target per app), `ENV_NAMESPACE=staging`, its own `APP_SECRET`, `TOKEN_ENCRYPTION_KEY` and `CRON_SECRET`.
- **Razorpay Test mode:** test keys, the Test plan and a Test webhook pointing at the staging domain (allowed: the `rzp_live_` rule applies to Vercel production only).
- Never point staging at the production database: its jobs would act on production data.

---

## Appendix D. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/api/health` says `"mode":"unknown"` | A variable is missing or malformed | Vercel logs show a `health: invalid environment` line naming the variables (and `Invalid environment` lines from other routes; names only); fix the variable, redeploy |
| Install ends on `/install/failed?reason=state` | The install took over 10 minutes, cookies blocked, or `HUBSPOT_REDIRECT_URI` is not on `APP_URL` | Retry; check the two URLs in 0.3 match the app files |
| `/install/failed?reason=config` | Wrong client id or secret | Copy them again from the Auth tab (1.5) |
| `/install/failed?reason=missing_scopes` | HubSpot didn't grant every scope | Check #1 |
| Webhooks answered 401 (HubSpot monitoring) | `HUBSPOT_WEBHOOK_TARGET_URL` differs from the app's target URL (a slash, `www`, a redirect), or a wrong secret | Make them identical (1.3); redeploy |
| No new-lead email | Account not Active, form not ticked, the lead classified as spam (dashboard: Filtered), or a Resend problem | Dashboard status and lead list; `/admin` failed jobs; Resend logs |
| Jobs never run (`/admin`: failed jobs, QStash: deliveries failing) | Deployment Protection, wrong `QSTASH_URL` region, or keys from another region | 3.8, 4.1 |
| Sign-in link shows the 403 page | The browser sent no usable Origin (privacy extension, old browser) | 9.4; try another browser; record it |
| Razorpay webhook disabled, alert email received | 24 hours of failed deliveries (wrong secret or URL) | Fix the secret or URL, re-enable the webhook, ask Razorpay to replay (up to 15 days) |
| Checkout says "Update your payment method" or contacts support | The subscription is `pending`, `halted` or an undocumented status | Billing page; `/admin`; D-18, D-82 |
