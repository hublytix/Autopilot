# REVIEW: Definition of Done for Hublytix Autopilot v1

- **Date:** 2026-10-03
- **Code reviewed:** `4ee56d8` (the M8 review-fix commit), clean tree.
- **Where it ran:** the build sandbox, in fake mode, on fakes and PGlite. No live service was called and no account was used.
- **Verdicts (D-52, PLAN §18):** **PASS** means the proof ran here and passed. **PARTIAL** means the line rests on community- or knowledge-base-level evidence, or can only be proven by a live run; the PLAN §17 live check that settles it is named. **FAIL** means the proof failed here.

## 1. Definition of Done (brief §12, PLAN §18)

| # | DoD line | Verdict | Evidence (commands and key output) | Live check |
|---|---|---|---|---|
| 1 | `npm run simulate` produces all expected emails, with correct statuses in `summary.json` | **PASS** | `npm run simulate`: exit 0 in 3 min 18 s. Main week (`outbox/summary.json`): `ok=true`, 205/205 checks, **15 emails**: pre-run 2 (magic_link, inbox_test), Day 0 4 (new_lead #1 #2 #6 #5), Day 2 4 (follow_up 1 for #1 #2 #6 #5), Day 5 4 (follow_up 2 for #1 #2 #5, reply_detected for #6), Monday 1 (weekly_report at 08:15:03 local: the 08:00 due-check creates it and the D-77 intake grace plus the portal's stagger delays the send; PLAN §13's table says 08:00). Check `wednesday.final_statuses`: #1 no_reply, #2 no_reply, #3 filtered, #4 filtered, #5 no_reply, #6 replied. #5 `intake_trigger=cron`, picked up by the 10:35 poll. Check `monday.weekly_metrics_json_exactly_as_plan_13`: equal (leads in 6, filtered 2, drafts emailed 4, sends confirmed 3, send link opened not confirmed 1, median first reply 1260 s = 21 min from 3 samples, waiting [#2] with its record link, replies 1, follow-ups drafted 7, baseline 3 h 30 m → 21 m and 20% → 25% of 4). Other §13 checks pass: foreground steps end 270 s after 09:00, pre-run outbox exactly 2, floors at 09:04:30, no historical lead, test lead absent everywhere, every job done/cancelled/skipped. Variants: billing 51/51, disconnect 54/54, lapse 46/46, daily-cap 42/42. **2030 repeat:** all five scenarios rerun with the process clock at 2030-01-01; `compare.ts` reports each "identical" (summary.json apart from `systemTime`, and every email file once random tokens are masked; the raw files differ only in action tokens and magic-link token hashes). Also proven in `npm test` by `scripts/simulation/run.test.ts`, `compare.test.ts`, `system-time.test.ts`, `billing.test.ts`, `lapse.test.ts`, `disconnect.test.ts`. PLAN §18 names `test/simulate.test.ts`; that file was never created (recorded in D-85) | none |
| 2 | Typecheck, lint and tests are green | **PASS** | `npm run typecheck` exit 0. `npm run lint` exit 0, no output. `npm test`: exit 0, **229 files, 4440 tests passed**, 450 s | none |
| 3 | No secrets, tokens or message text appear in logs or Sentry payloads; a test proves the scrubber | **PASS** | `npx vitest run test/observability src/server/obs/log.test.ts test/db/migrations.test.ts scripts/check-bundle.test.ts`: 7 files, 160 tests passed. `test/observability/scrubber.test.ts` (`redact()` masks action links, OAuth callbacks, magic-link fragments, mailto links, emails, bearer tokens, JWTs, HubSpot refresh tokens, vendor keys, cookies, hashes, ciphertext; `scrubEvent()` "produces the golden event" and "leaves no fixture value anywhere in the serialised event"; `scrubBreadcrumb()` drops console breadcrumbs). `test/observability/sentry-envelope.test.ts` uses the real `@sentry/node` SDK: (a) a Server Action error, (b) an Anthropic APIError, (c) a PGlite database error as `DbError db_error`, all with "no fixture text, email, token, cookie or header"; the same captures without our options do leak, so the test has teeth. `test/observability/logger.test.ts` "logger output never contains content, emails or tokens". `npm run check:bundle`: exit 0, 31 client files, 28 patterns, "no secrets or server-only env names". Caveat (signed off, D-49, PLAN §1.1 row 23): Vercel's own platform request logs record `/a/{token}/…` paths; our logs and Sentry never do. Sentry's server-side scrubbing settings are still to be set and checked live (WIRE_UP 8.5 and 9.2); the tests prove our SDK options, not the hosted project's settings | WIRE_UP 9.2 (not a §17 item) |
| 4 | Every [VERIFY] item is resolved in `docs/RESEARCH.md` with a source link | **PARTIAL** | RESEARCH §0 has 17 rows: the brief's 16 [VERIFY] items plus the "reply signal identified in RESEARCH". Every row has an answer, a verdict, a status and at least one primary source link. `npm run check:finding-ids`: exit 0, "169 citation(s) … resolve to the 190 findings". Rows that rest on community- or knowledge-base-level evidence: row 3 scope grantability (§17 #1), row 5 refresh-error shapes (#13), row 8 form identification (#2), row 10 submissions endpoint (#2), row 11 Gmail and Outlook compose URLs (#5), row 12 BCC logging (#4), row 14 opt-out and bounce properties (#14), row 15 reply signal (#4). Rows 4 (account info, #3) and 16 (logged-email signal, #4) are PASS from the spec but still have a live check | #1, #2, #4, #5, #13, #14 (and #3) |
| 5 | `docs/WIRE_UP.md` is complete enough for someone who has never seen the code | **PARTIAL** | The brief §10 steps are sections 1–9, in order: 1 HubSpot app, 2 Supabase and migrations before code (plus "Later deploys"), 3 Vercel variables and crons, 4 QStash keys and callback URLs, 5 Resend domain and DNS, 6 Anthropic key, 7 Razorpay plan, webhook and same-download keys, 8 Sentry DSN, 9 smoke test (9.2 endpoint table, 9.3 end to end, 9.4 browser and phone) and screenshot checklist (9.6). Section 9.5 lists all 14 live checks with where and what to do on failure; section 10 is the rotation runbook. Variable names diffed mechanically: `env.ts` has 62 names; `.env.example` and Appendix B list the 55 an operator sets, and both name the other 7 in prose (`VERCEL_ENV`, set by Vercel; `QSTASH_DEV`, `QSTASH_REGION`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_SPOTLIGHT`, `SENTRY_DEBUG`, `ANTHROPIC_CUSTOM_HEADERS`, refused in live mode). Both also name the scripts-only `SIMULATE_SYSTEM_TIME`, which the app never reads (`.env.example` commented out under "Scripts only"; Appendix B in prose, a line added after this review's run). Not provable here: dashboard labels marked † were never seen in the live products, and nobody new has followed the guide yet | all 14; first proof is a full WIRE_UP run (steps 1–9) |
| 6 | RLS is enabled on every table; a migration test asserts it | **PASS** | The migrations create 27 tables: 26 in `20261001000001_init.sql` and `auth_user_deletions` in `20261003000003_auth_user_deletions.sql`; each has `enable row level security`. `test/db/migrations.test.ts` "(1) enables row level security on every public table" reads `pg_class` for every public table after all migrations, so later tables are covered. A scratch replay of all migrations on PGlite listed 27 public tables, none without RLS. The same file checks no policies, no grants to `anon`/`authenticated`/PUBLIC (including later objects) and full CRUD for `service_role`. Its `PLAN_TABLES` list has 26 names (no `auth_user_deletions`); it is only used with `arrayContaining`, so the RLS assertion is unaffected. The hosted database is still to be re-checked with the same queries at WIRE_UP 2.3 (PLAN §16 R13) | WIRE_UP 2.3 (not a §17 item) |

Brief §12 and PLAN §18 list the same six lines; there is no other DoD line.

## 2. The nine gates

Run one at a time, in this order, on `4ee56d8`.

| Gate | Result | Key output |
|---|---|---|
| `npm run simulate` | exit 0 (3 min 18 s) | 5 scenarios × 2 runs all `ok=true`; week 205/205, billing 51/51, disconnect 54/54, lapse 46/46, daily-cap 42/42; each 2030 repeat "identical" |
| `npm run typecheck` | exit 0 | `next typegen && tsc --noEmit`: route types generated, no errors |
| `npm run lint` | exit 0 | `eslint .`: no output |
| `npm test` | exit 0 (450 s) | 229 test files, 4440 tests passed |
| `npm run check:finding-ids` | exit 0 | 169 citations in PLAN, DECISIONS, WIRE_UP, ARCHITECTURE resolve to 190 findings |
| `APP_MODE=fake npm run build` | exit 0 | Next.js 16.3.8 (Turbopack), compiled, TypeScript passed, 26 static pages generated |
| `npm run check:bundle` | exit 0 | 31 client files, 28 patterns, no secrets or server-only env names |
| `APP_MODE=fake npm run smoke` | exit 0 | `/api/health` 200 `mode=fake`, `/` 200, `/login` 200 |
| `APP_MODE=fake npm run e2e:fake` | exit 0 (41 s) | 83/83 checks: install → onboarding → dashboard → settings → billing (fake checkout, cancel) → Disconnect → `/admin`, no JavaScript; server logged 0 warn/error lines |

## 3. Still to verify live at WIRE_UP (PLAN §17)

Each line: what it settles, and the WIRE_UP step that runs it.

1. **Email scope:** whether HubSpot accepts `sales-email-read` at upload and install, and emails are readable with `hs_email_direction`. If not, path (b): no email-based features. Steps 1.4, 9.3 (1, 6), Appendix A.
2. **Submissions endpoint:** page size, order and the `forms` scope on Free and Starter, and `captured` forms. Intake depends on it. Steps 9.3 (4, 8) on each portal, Appendix A.
3. **Account info:** whether `account-info/2026-09/details` works with `oauth` (else the owner picks the time zone). Step 9.3 (5), Appendix A.
4. **Logging setup:** where the BCC address lives, connected-inbox "Log all", and both inbox-check legs on Free and Starter. Settles reply detection and the report's "Not enough data" cases. Steps 9.3 (5, 6).
5. **Compose links:** Gmail forms, Outlook hosts with `mailtouri`, BCC, phones, one tap or two. Settles whether "Send from my email" works. Step 9.4.
6. **Vercel:** cron plan limits and whether Deployment Protection blocks QStash. Steps 3.7, 3.8, 9.2 (7, 11).
7. **QStash plan:** maximum delay, a retry cap of at least 4, the daily quota. Step 4.2.
8. **Razorpay:** USD plan and International Cards, Flash Checkout, retrying `created`, fetching an expired one, cancelling `authenticated` vs `active`, Resume. Step 7 (Test mode), 9.3 (11).
9. **HubSpot webhooks:** the up-to-5-minute settings delay and a non-admin install attempt. Steps 1.6, 9.3 (1, 12).
10. **Retention:** Resend's and Anthropic's content retention and the Supabase backup window, recorded in D-49. Steps 2.9, 5.7, 6.5.
11. **Magic link:** fresh address → onboarding → session, on a second device. Steps 9.3 (2), 9.4.
12. **AI:** one live request per schema, the effort sweep, Haiku 4.5's deprecation status. Steps 6.4, 9.3 (8).
13. **Refresh errors:** the body HubSpot returns for a revoked refresh token, and introspect on it. Appendix A.
14. **Opt-out and bounce properties:** `hs_email_optout`, `hs_email_hard_bounce_reason_enum`, `hs_email_bad_address`. Appendix A.

## 4. Known limitations

**Built and tested against fakes only**
- All seven live adapters (HubSpot, Supabase Auth, QStash, Resend, Anthropic, Razorpay, the website fetcher) are built but have never called the real service; neither has the Postgres driver (`postgres`) against Supabase, nor Sentry's transport. Every test, the simulation and the end-to-end run use fakes and PGlite.
- The database is PGlite (Postgres 18) in tests; production is Supabase (15 or 17). Driver and type differences are possible (R13). Races and row locks cannot be exercised on PGlite; the compare-and-set and lease design is proven only by sequential replay tests (R15).
- No real browser or phone was used. The magic-link POST, the `Origin` handling (D-62) and the compose-link interstitial are checked with `fetch` only (WIRE_UP 9.4).
- The sub-processor policy links on `/privacy` were never fetched (WIRE_UP 9.4).

**Undocumented vendor behaviour we rely on**
- The legacy Forms submissions endpoint (`/form-integrations/v1/…`) has no dated replacement and is in HubSpot's September 2027 sunset (R3). Intake depends on it.
- Gmail and Outlook compose URLs are not documented by Google or Microsoft (R5).
- BCC logging and reply logging come from knowledge-base summaries (D-14, D-08).
- Hobby cron limits and the QStash Free quota were not verified (R6, R7).
- The token amount Razorpay charges and refunds for a future-start subscription is unverified (D-78).
- Haiku 4.5 retires no sooner than 2026-10-15, 12 days from this review (D-25). If a date is announced, set `ANTHROPIC_MODEL_FAST=claude-sonnet-5-5`.

**Brief changes and discrepancies the owner should know before launch**
- Signed off in the plan: Next.js 16 instead of 14 (D-01); the extra `sales-email-read` scope, whose HubSpot consent text says it can read logged email content (D-03); the phone interstitial that may need two taps (D-13); the wider checkout guard (D-18); the lead fields stored as content (D-31); Vercel's request logs holding action-token paths (D-49).
- Other brief changes (PLAN §1.1): the Forms submissions API instead of the CRM-search trigger (D-07); two extra lead statuses (D-32); no Monday report while paused or inactive (D-17); unfinished installs are uninstalled and purged after 7 days (D-48); `/refunds` and `/shipping` added for Razorpay (D-20).
- Not built in v1: the CRM-search fallback trigger, the Webhooks Journal poller (`HUBSPOT_JOURNAL_ENABLED` is reserved) and an AI effort-sweep script (D-84, WIRE_UP 9.5).
- Referrer policy is `same-origin`, not PLAN's `no-referrer`: under `no-referrer` the Fetch spec sends `Origin: null` on a form POST, so the magic-link confirm, sign-out and every Server Action form without JavaScript would be refused (D-62; reasoned from the spec and Next's source, not seen in a real browser).
- An undocumented Razorpay status is stored as `unknown`: not entitled, and it blocks a new checkout until support looks (D-82).
- Resumed follow-ups keep a 3-day gap between follow-up 1 and 2, a deviation from PLAN §9.6's formula (D-72).
- **Brief change (D-83 (6)):** brief §4.6's "cancel … at any time" is narrowed: Razorpay's API cannot cancel a `paused`, `pending` or `halted` subscription, so neither can Autopilot; `/refunds` and the billing page say so.
- Brief §1's one-liner ("answers … every new lead automatically") overstates if read literally; it stays word for word on `/` only, with a qualifier under it, and the owner may reword it at legal review (D-83 (7), D-86).
- The current subscription is the newest row still holding a mandate, else the newest row: a deviation from PLAN §9.9's literal sentence that matters only for anomalies (D-81).
- A submission whose contact HubSpot shows only after the report's 15-minute intake grace counts in neither week's Monday report (D-77, residual).
- Public pages are not cached: the per-request CSP nonce makes every page `private, no-cache` (D-83).
- Supabase's auth audit log keeps the owner's address after deletion until a cleanup or setting is confirmed (D-82, WIRE_UP 2.8).
- A refund for a payment taken after an account was deleted is made by hand in Razorpay; the app only cancels and alerts (WIRE_UP 9.4).
- PLAN §18's `test/simulate.test.ts` does not exist; the same proof lives in `scripts/simulation/*.test.ts` and CI's `npm run simulate` (D-85).
- The 25-install cap applies until a Marketplace listing is approved; listing work is outside v1 (D-43).

**Legal pages**
- `/privacy`, `/terms`, `/refunds` and `/shipping` are placeholders marked "TODO: legal review". Contact details, governing law and the refund policy are not decided. `/privacy` gives no retention day counts for Resend, Anthropic or Supabase backups until check #10 is recorded. Razorpay may refuse activation and International Cards until reviewed text is live (R12, WIRE_UP 0.7).
