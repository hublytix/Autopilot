# Hublytix Autopilot v1: build plan

Status: **PLAN, revision 5 (after four plan-review rounds), awaiting approval.** Reply `approve` to start EXECUTE at M1.

Inputs:
- `docs/BUILD_BRIEF.md`: the specification.
- `docs/RESEARCH.md`: the verified facts. DECISIONS cites them by finding ID in [brackets]; full evidence is in `docs/research/*.md`.
- `docs/DECISIONS.md`: D-01…D-52, every deviation from the brief and every choice where the brief is silent.

---

## 1. What you are approving

Six items need your explicit sign-off: **D-01, D-03, D-13, D-18, D-31, D-49** (listed at the top of DECISIONS). They are marked **sign-off** below. Everything else in §1.1 is either forced by vendor documentation or is a small change the brief would not reasonably object to; each row names its decision.

### 1.1 Changes to things the brief states
| # | Brief | Plan | Decision |
|---|---|---|---|
| 1 | Next.js 14 | **Next.js 16.3.8** (React 19). Middleware becomes `src/proxy.ts`; `src/instrumentation.ts` stays in `src/`. 14.x has no security support and 23 open advisories | D-01 (**sign-off**) |
| 2 | "Create the HubSpot public app" | Developer-platform **project** in `hubspot-app/`, platform `2026.09`, uploaded with the HubSpot CLI. Legacy public apps can no longer be created | D-02 |
| 3 | Scopes `oauth`, `crm.objects.contacts.read`, `forms` | Adds **`sales-email-read`**, needed to read logged emails. HubSpot's consent screen will say it allows reading the **content** of all logged emails; Autopilot requests only five metadata properties and never subjects or bodies, and `/privacy` says so. `forms` also permits edits, so read-only is enforced by a request allow-list in code | D-03 (**sign-off**) |
| 4 | Idempotent on `eventId` | Composite key `portalId:subscriptionType:objectId:eventId:occurredAt`; HubSpot says `eventId` is not unique | D-05 |
| 5 | Poller searches `recent_conversion_date`; webhook decides the form | Poller reads the **Forms submissions API** per selected form, with a 60-minute overlap; the webhook only triggers polls. Contacts carry no form ID | D-07 |
| 6 | Checkout blocked only on `active`/`halted`; processing while trialing or `active` (+3 d grace) | Blocked on `authenticated`/`active`/`pending`/`halted`/`paused`; **never on `created`**. Processing also runs while `authenticated` (a subscription that starts at trial end), and while `pending` only within the 3-day grace. Adds Resume for `paused` | D-18 (**sign-off**) |
| 7 | `/privacy`, `/terms` | Also `/refunds` and `/shipping` (`TODO: legal review`); Razorpay requires them to accept USD | D-20 |
| 8 | "Service-role key" | Supabase **secret key**, explicit grants in migrations, public sign-ups off | D-21 |
| 9 | Inbox check = one live test | Two legs (send logged, reply logged), checked in the background by a job, skippable. BCC logs sends but never replies | D-14 |
| 10 | Vercel Cron | Vercel Cron on **Pro**, or QStash schedules; every periodic route accepts both | D-16 |
| 11 | `/a/{token}/send` → 302 | 302 on desktop Gmail/Outlook. On phones and for "Other", a page that opens the mail app automatically. Expected to stay one tap; if a browser blocks the automatic open, the owner taps the button (two taps). §17 #5 checks this | D-13 (**sign-off**) |
| 12 | `/send` "records the click" | A hit that looks like a link scanner (a `HEAD`, a scanner user agent, or within 60 s of delivery without the page's beacon) is not recorded | D-26 |
| 13 | `/dismiss` "marks the lead dismissed" | The link opens a confirmation page; only its POST dismisses | D-26 |
| 14 | Mail client Gmail / Outlook / Other | Gmail / Outlook (work or school) / Outlook (personal) / Other; the two Outlooks use different hosts | D-13 |
| 15 | Law 4: the only content stored is "the lead's form message" | Stored: the lead's message, first name, last name, company and email. Missing values are filled from the same-named HubSpot contact property (brief §5.2's fallback). Nothing else; purged at 30 days. The compose links need the address and name | D-31 (**sign-off**) |
| 16 | Follow-up dedupe ID `lead:{id}:fu:{n}` | `{ENV_NAMESPACE}:lead:{id}:fu:{n}:s{followup_stream}`, re-published as `…:h{hops}`. Lets "Resume follow-ups" reschedule, keeps preview and production apart, and works with QStash's 10-minute dedupe window | D-15 |
| 17 | Lead statuses: filtered, drafted, send clicked, send confirmed, replied, no reply, dismissed | Adds **"not processed"** (failed, skipped or over the daily cap) and **"processing"** | D-32 |
| 18 | "Every Monday, the owner gets a short report" | Only accounts that are active with onboarding complete; none while paused, billing-inactive, revoked or disconnected | D-17 |
| 19 | Purge disconnected portals after 30 days | Also: an install that nobody finishes signing up for within 7 days is uninstalled and purged at once. HubSpot emails the portal's admins about the uninstall | D-48 |
| 20 | Milestone contents (brief §9) | Same order; small moves so each milestone ships what its gate needs | D-50 |
| 21 | REVIEW reports "pass/fail per line" | **PASS / PARTIAL / FAIL**; PARTIAL names the §17 live check it depends on | D-52 (§18) |
| 22 | Subject `New lead: {Name} — your reply is ready` | The lead's first name, sanitised (no control characters, at most 40 chars). When it contains a URL or an `@`, or is mostly digits, the subject is `New lead — your reply is ready` | D-47 |
| 23 | Law 4: never log tokens | Our logs and Sentry never contain tokens. Vercel's platform request logs do record the paths of `/a/{token}/…` links; we add no log drains, keep the shortest retention, and tokens expire after 7 days | D-49 (**sign-off**) |

### 1.2 Behaviour choices where the brief is silent (what the owner will see)
| Choice | What the owner will see | Decision |
|---|---|---|
| Quiet hours apply to follow-ups only | New-lead emails arrive immediately, at any hour | D-33 |
| Pause, or billing lapse, skips leads | A lead that arrives while paused, inactive or revoked is never drafted; the dashboard says so | D-42, D-48 |
| A newer lead supersedes an older one | One follow-up stream per contact | D-44 |
| Unqualified "reply" always means the lead's | "Replies from leads", "{Name} replied — follow-ups stopped". Anything you send is phrased with "you/your": "your reply is ready", "Median time to your first reply" | D-37 |
| Honest "Not enough data" | When HubSpot isn't logging your sends or replies, the report says so instead of showing 0 | D-37, D-38 |
| Baseline counts only real leads | The 30-day history is classified by the fast model in memory (at most 500 submissions, nothing stored), so spam doesn't distort the comparison | D-38 |
| Daily cap, counted after classification | At most 50 drafted leads per day (configurable). Spam is still shown as filtered; overflow leads are listed as "not processed" and you get one email that day | D-36 |
| Extra notify addresses must confirm | Addresses other than your login email get a confirmation link first | D-46 |
| Change alerts after onboarding | Later changes to notify or BCC addresses email you an alert; the first save during onboarding doesn't | D-46 |
| Onboarding completes only with a saved brief | "Finish" stays disabled until you have saved your brief, picked at least one form and saved preferences with a notify address | D-48 |
| `captured` (non-HubSpot) forms not offered in v1 | Only HubSpot forms and pop-ups appear in the form list | D-07 |
| Reply-To on lead emails = your own address | Tapping "Reply" by mistake writes to yourself, not to us or the lead | D-27 |
| A reinstall doesn't restart the trial | The 14 days count from the portal's first install, even after a purge and reinstall | D-30, D-35 |
| "Replied" email only when follow-ups were stopped | A reply found after follow-ups have finished updates the status without an email | D-08 |

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
| Auth | `@supabase/supabase-js@2.117.x` (admin) + `@supabase/ssr@0.12.7` (session cookies, refreshed in the proxy) |
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
├── .github/workflows/ci.yml            # typecheck · lint · test · build+smoke · simulate · bundle secret grep
├── eslint.config.mjs  next.config.ts  postcss.config.mjs  tsconfig.json  tsconfig.scripts.json
├── vitest.config.ts  vercel.json
├── docs/        BUILD_BRIEF · RESEARCH (+ research/*) · PLAN · ARCHITECTURE · DECISIONS · WIRE_UP
├── hubspot-app/ hsproject.json · src/app/app-hsmeta.json · src/app/webhooks/webhooks-hsmeta.json
├── supabase/    config.toml · migrations/20261001000001_init.sql (+ later timestamped files)
├── scripts/     simulate.ts · qstash-schedules.ts · check-finding-ids.ts
├── test/        db/harness.ts (+ globalSetup) · stubs/empty.ts · fixtures/{hubspot-signature-v3.json,
│                razorpay/*.body, compose-vectors.json, site/**, hubspot-portal.json}
└── src/
    ├── instrumentation.ts            # register(): runtime-gated Sentry init; onRequestError
    ├── instrumentation-client.ts     # browser Sentry (shared options; disabled on /a/* and /auth/*)
    ├── sentry.server.config.ts  sentry.edge.config.ts
    ├── proxy.ts                      # CSP nonce, strips inbound CSP request headers, AuthProvider.refreshSession on app paths
    ├── app/                          # thin route files; global-error.tsx
    ├── components/                   # client-safe UI
    ├── emails/                       # React Email templates (presentational)
    ├── shared/                       # client- and server-safe: observability/sentry-options.ts (redact, scrubbers), types
    └── server/                       # every module imports 'server-only' (aliased to a stub in Vitest and tsx)
        ├── env.ts                    # Zod env; APP_MODE required; documented defaults; fake-mode refusals; key checks
        ├── container.ts              # Deps factory + lazy globalThis singleton
        ├── ports/                    # interfaces
        ├── adapters/live/  adapters/fake/
        ├── db/                       # Db (Postgres.js | PGlite), tx guard, migrate (fake._migrations ledger),
        │                             #   fake-shim.sql (roles/auth/fake schema for PGlite), repos/* (OwnerScope for owner data)
        ├── domain/                   # pure: validator, quiet hours, stops, lead status, processing state, entitlement,
        │                             #   checkout guard, compose, newsletter detect, metrics, refresh classifier,
        │                             #   AI params + JSON-schema helper, signals, reservation predicates
        ├── security/                 # crypto (AES-GCM + kid), HKDF keys, action tokens, signatures, same-origin,
        │                             #   rate limit, CSP builder, SSRF guard, cron auth, HubSpot request allow-list
        ├── services/                 # orchestration (incl. applyProcessingState, notifications, intake, signals)
        ├── jobs/                     # dispatcher, claim/lease, outbox publisher, re-publish, sweeper
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
- `src/proxy.ts` may import only the CSP builder and the `AuthProvider` session-refresh adapter (§7.7).
- Owner-facing repos take `OwnerScope {accountId, userId}` as a required first argument. Only `requireOwner()` creates one, from a verified session. No repo method that serves owner pages accepts a bare lead or draft id.
- Client components never import `src/server/**`. The build fails otherwise, because of `server-only`.
- There are **no** `NEXT_PUBLIC_*` secrets. The only public values are `NEXT_PUBLIC_PRODUCT_NAME` (derived from `PRODUCT_NAME` in `next.config.ts`) and `NEXT_PUBLIC_SENTRY_DSN`.

---

## 4. Ports, fakes and fake mode

`APP_MODE=fake|live` is **required** (D-29). Fake mode runs with zero credentials, using fixed documented fake secrets that live mode rejects. Fake mode is refused on Vercel production/preview unless `ALLOW_FAKE_ON_VERCEL=1`.

| Port | Key methods | Fake |
|---|---|---|
| `Clock` | `now()` | Settable and advanceable; offset persisted in fake mode; drives Luxon and the scheduler |
| `HubSpotClient` | `authorizeUrl`, `exchangeCode`, `refresh`, `introspect`, `revoke`, `accountDetails`, `listForms`, `listSubmissions`, `getContact(idOrEmail,{idProperty,properties,associations})`, `listContactEmailIds`, `batchReadEmails`, `searchEmailsCount`, `uninstallApp` | In-memory portal loaded from `test/fixtures/hubspot-portal.json`: forms, contacts (optional visibility delay), submissions (newest first, 50 per page), more than 100 associations with paging, emails with logging modes (`log_all`/`sends_only`/`none`), refresh modes (`ok`/`revoked`/`transient×N`/`config`/`477`), 404, merge, 403 `MISSING_SCOPES` variant, v3-signed webhook bodies. Enforces the request allow-list. Consent page `/dev/fake-hubspot/authorize` |
| `LLM` | `classify`, `generateBrief`, `draft`, `draftFollowUp`, each returning `{value, usage, stopReason, model}` or a typed failure | Deterministic keyword classifier; validator-passing templated drafts; fault injection (`invalid`/`refusal`/`max_tokens`/`transient`/`fatal`/`slow`); asserts each request's parameters are valid for its model (`buildModelParams`, from M2) |
| `Mailer` | `send({to, replyTo, subject, html, text, tags, idempotencyKey})` | Persists to `fake.dev_outbox` (dev), memory (tests) or `./outbox` (simulate). Same idempotency semantics as Resend (same key + same payload = original; different payload = 409 `invalid_idempotent_request`) |
| `Scheduler` | `publish({jobId, kind, runAt, dedupeId, retries})` → `{messageId, deduplicated}`; `cancel(messageId)` | Ordered queue; `runDue(now)` calls an **injected** dispatch callback; simulates redelivery, crashes and exhausted retries (calls the failure handler) |
| `Billing` | `createSubscription`, `fetchSubscription`, `cancelSubscription(id, atCycleEnd)`, `resumeSubscription`, `fetchPlan` | Fake subscriptions; `short_url` → `/dev/fake-checkout/{id}`, which emits signed fake webhooks; a future-start subscription stays `created` until `start_at`, as Razorpay documents |
| `WebFetcher` | `fetch(url, {signal, maxBytes})` | Fixture website (`test/fixtures/site`) including `robots.txt`, nav/header/footer, hidden DOM, an injection sample and a slow page |
| `AuthProvider` | `createUser`, `generateLink(email)` → `{hashedToken}`, `verify(tokenHash, type)`, `getVerifiedUser(req)`, `refreshSession(request, response)`, `signOut` | Links written to the outbox; signed `ap_session` cookie; rejects a wrong `type` for new users, as Supabase does |

The live `Scheduler` sends `Upstash-Retries: retries` (4 for every kind, i.e. 5 deliveries, brief §5.1's "max 5 attempts") and `Upstash-Retry-Delay: pow(2, retried) * 10000` (10, 20, 40, 80 s), with a failure callback to `/api/jobs/failed` (D-11).

**Dev affordances (fake mode only):**
- `/dev` actions: submit a lead, log an owner send, log a lead reply, revoke a token, opt out a contact, advance the clock, run due jobs, view the outbox.
- A dev job ticker runs due fake jobs every 10 s.
- PGlite lives in a lazy `globalThis.__autopilot` singleton, listed in `serverExternalPackages`, and is never opened at import time or from `proxy`/`instrumentation`.

---

## 5. Data model

The first migration is `supabase/migrations/20261001000001_init.sql`. Later milestones add their own timestamped files.

**Rules applied to every `public` table:**
- `enable row level security`, `revoke all … from anon, authenticated`, and `grant select, insert, update, delete … to service_role`. No policies.
- `alter default privileges in schema public revoke execute on functions from public, anon, authenticated` (D-21).
- Statuses are `text` + `check`.
- IDs are `uuid default gen_random_uuid()`, except log tables, which use `bigint generated always as identity` (no sequence grants needed).
- HubSpot IDs are `text`.
- No `bytea`; hashes are stored as hex `text`.
- Every logical timestamp is **bound from `Clock`** (`$now`) with no default. That includes the `created_at` columns that drive behaviour: `accounts`, `subscriptions`, `brief_jobs`, `scheduled_jobs`, `login_intents`. `default now()` is allowed only on the audit-only columns `audit_log.at` and `webhook_events.received_at`, which are the SQL-scan allow-list (D-28).

**Cascades:** account-scoped tables use `on delete cascade` from `accounts`. The exceptions are the tombstones (`portal_history`, `billing_tombstones`), which are deliberately outside the cascade.

| Table | Columns (key ones) | Content? |
|---|---|---|
| `accounts` | `hubspot_portal_id text unique`, `processing_state (onboarding\|active\|paused\|inactive\|revoked\|disconnected)` (derived, §6.1), `processing_state_changed_at`, `paused_at` (owner intent), `onboarding_completed_at`, `trial_started_at`, `trial_ends_at`, `timezone`, `timezone_source`, `logging_mode (unknown\|log_all\|sends_only\|none)`, `last_install_at` (logical; the orphan clock), `owner_user_id` (nullable), `pending_owner_email`, `pending_owner_expires_at` (+24 h), `pending_owner_auth_user_id`, `disconnected_at`, `purge_after`, `checkout_lock_until`, `entitlement_lost_at` (start of the current non-entitled period, §6.1), `created_at` (logical) | owner email (pending), cleared on bind |
| `users` | `auth_user_id unique`, `account_id unique`, `email`; **unique `lower(email)`** | owner email |
| `login_intents` | `token_hash_sha256 text pk` (sha256 of the Supabase hashed token), `purpose (login\|onboarding)`, `account_id`, `next`, `expires_at` (+1 h, the link's validity), `consumed_at`, `created_at` (logical) | none |
| `settings` | `account_id pk`, `notify_emails text[]` (1–3), `notify_emails_verified text[]`, `mail_client (gmail\|outlook_work\|outlook_personal\|other)`, `gmail_account_email`, `quiet_start_hour`, `quiet_end_hour` (0–23; equal means none), `skip_weekends`, `followups_enabled`, `bcc_address`, `preferences_saved_at` | owner config |
| `hubspot_connections` | `account_id unique`, `portal_id unique`, `hub_domain`, `ui_domain`, `data_hosting_location`, `account_type`, `scopes text[]`, `access_token_enc`, `refresh_token_enc` (format `v1.kid.iv.ct.tag`), `access_expires_at`, `token_version int`, `refresh_lease_id`, `refresh_lease_until`, `status (active\|revoked\|disconnected)`, `status_changed_at`, `status_reason`, `reconnect_email_sent_at`, `transient_failures`, `next_refresh_attempt_at`, `last_refresh_at`, `last_webhook_at`, `last_polled_at`, `poll_requested_at`, `journal_offset` | encrypted tokens |
| `portal_history` | `hubspot_portal_id pk`, `first_trial_started_at` (tombstone, outside the cascade) | none |
| `briefs` / `brief_versions` | brief JSON (business info), `source_url`, `booking_link_choice (unset\|link\|none)`, `booking_link_confirmed`, `version`, `source (generated\|owner)` | business info |
| `brief_jobs` | `account_id`, `status (queued\|running\|done\|failed)`, `attempts`, `error_code`, `created_at` (logical; rate limit 5/day) | none |
| `selected_forms` | pk `(account_id, form_id)`, `form_name`, `form_type`, `selected`, `newsletter_detected`, `intake_floor_at not null`, `cursor_submitted_at not null` | none |
| `leads` | `account_id`, `hubspot_contact_id text` (`check (is_test or hubspot_contact_id is not null)`), `form_id`, `submitted_at`, `conversion_id`, `submission_key` (HMAC; nulled at purge), `intake_trigger (webhook\|cron\|inbox_check)`, `is_test`, `classification`, `classification_override`, `processing_state (new\|processing\|notified\|filtered\|deferred\|failed\|skipped)`, `process_rev`, `followup_stream`, `needs_touch`, `stop_reason`, `replies_ignored_before`. Timeline: `received_at`, `classified_at`, `first_notified_at`, `first_send_clicked_at`, `send_confirmed_at` (HubSpot time), `replied_at` (HubSpot time), `dismissed_at`, `fu1_notified_at`, `fu2_notified_at`, `signals_checked_at`. **Unique** `(account_id, hubspot_contact_id, submitted_at)` and `(account_id, form_id, submission_key)` | none |
| `lead_messages` | `lead_id pk`, `account_id`, `message`, `first_name`, `last_name`, `company`, `email`, `purge_at` (+30 d; test lead +24 h). Inserted only in a CTE chained to the lead insert | **yes** |
| `drafts` | `lead_id`, `kind (initial\|fu1\|fu2)`, `subject`, `body`, `flags` (closed-enum `text[]`), `used_booking_link`, `validation_ok`, `validation_errors` (codes), `attempts`, `needs_touch`, `model`, token totals, `cost_micro_usd`, `purge_at` (= lead `purge_at`), `purged_at`; unique `(lead_id, kind)` | **yes** (subject, body and flags nulled at purge) |
| `action_tokens` | `token_hash text unique` (sha256 hex of 32 random bytes), `account_id`, `lead_id`, `draft_id`, `notification_key`, `purpose (send\|edit\|dismiss\|verify_notify)`, `expires_at`, `first_used_at`, `use_count`, `revoked_at` | none |
| `scheduled_jobs` | `account_id`, `lead_id`, `kind (portal_poll\|lead_process\|followup\|weekly_report\|baseline\|brief_generate\|inbox_check\|privacy_delete\|account_daily)`, `seq`, `dedupe_key unique`, `payload jsonb` (ids only), `run_at`, `status (scheduled\|running\|done\|cancelled\|skipped\|failed)`, `external_id`, `published_at`, `hops int`, `attempts`, `attempt_id`, `lease_until`, `last_error_code`, `cancel_reason`, `created_at` (logical), `finished_at` | none |
| `notifications_sent` | `dedupe_key unique`, `account_id`, `lead_id`, `kind`, `status (sending\|sent\|failed)`, `provider_message_id`, `recipients_count`, `first_reserved_at` (never reset), `reserved_at`, `send_attempts`, `sweeper_resumes`, `sent_at` | none |
| `weekly_reports` | `account_id`, `week_start date`, `timezone`, `period_start`, `period_end`, `metrics jsonb`, `status (pending\|sent\|failed)`, `attempts` (report runs); unique `(account_id, week_start)` | none |
| `subscriptions` | `account_id`, `provider_subscription_id unique`, `plan_id`, `status` (Razorpay's 9 + `stale`), `status_changed_at`, `short_url`, `start_at`, `expire_by`, `current_start`, `current_end`, `payment_failed_at`, `grace_until`, `cancel_at_cycle_end`, `last_synced_at`, `created_at` (logical); **partial unique** `(account_id) where status='created'` | none |
| `billing_tombstones` | `provider_subscription_id pk`, `last_status`, `expire_by`, `purged_at`, `last_checked_at`, `resolved_at` | none |
| `webhook_events` | `provider`, `dedupe_key`, `body_sha256`, `portal_id`, `account_id`, `event_type`, `occurred_at`, `received_at` (audit), `outcome`; unique `(provider, dedupe_key)`; partial unique `(provider, body_sha256) where provider='razorpay'` | none |
| `audit_log` | `account_id`, `at` (audit), `actor`, `action`, `level`, `meta jsonb` (allow-listed keys) | none |
| `baselines` | `status (ok\|insufficient\|unavailable)`, `submissions_read`, `leads_counted`, `median_seconds_to_first_outbound`, `without_outbound_count`, `percent_available` | none |
| `inbox_checks` | `test_address` (cleared at 24 h), `test_address_hmac`, `test_lead_id`, `history_outbound_30d`, `history_inbound_30d`, `send_leg (pending\|passed\|failed\|skipped)`, `reply_leg (…)`, `send_deadline_at`, `reply_deadline_at`, `status (open\|closed)`, timestamps | test address (24 h) |
| `ai_calls` | `purpose`, `attempt`, `model`, `request_id`, `stop_reason`, `refusal_category`, token counts, `cost_micro_usd`, `latency_ms`, `outcome` | none |
| `rate_limits` | pk `(key_hash, window_start)`, `count` | none |
| `leases` | `name pk`, `holder`, `expires_at` | none |

**The `fake` schema** (created by `fake-shim.sql`, PGlite only, never by `supabase/migrations`): `fake._migrations` (`version pk`, the fake-mode ledger), `fake.dev_outbox`, `fake.state` (fake portal state, clock offset).

**Indexes:**
- `leads(account_id, received_at desc) where not is_test`
- `leads(account_id, hubspot_contact_id, submitted_at desc)`
- `lead_messages(purge_at)`
- `drafts(purge_at) where purged_at is null`
- `scheduled_jobs(status, run_at)`
- `scheduled_jobs(status, lease_until)`
- `scheduled_jobs(status, created_at) where external_id is null`
- `action_tokens(expires_at)`
- `webhook_events(portal_id, received_at desc)`
- `accounts(purge_after) where purge_after is not null`
- `login_intents(expires_at)`

**Migration test (DoD)**, over the `public` tables created by `supabase/migrations`:
1. No such table has `relrowsecurity = false`.
2. `anon` and `authenticated` have no privileges on tables, sequences or functions.
3. `service_role` has CRUD on every table.
4. A persisted PGlite directory boots twice; the ledger prevents re-applying.
5. A scan finds no `now()`, `current_timestamp` or `clock_timestamp` outside the allow-list.

---

## 6. State machines

### 6.1 Account `processing_state` (D-42, D-48)
`computeProcessingState(account, connection, currentSubscription, now)` is pure. It checks these conditions in order and returns the first that matches:

1. `disconnected`, if the connection is disconnected;
2. `revoked`, if the connection is revoked;
3. `onboarding`, if `onboarding_completed_at` is null;
4. `paused`, if `paused_at` is not null (the owner's intent survives revoke, reconnect and billing changes);
5. `inactive`, if the account is not entitled (D-18);
6. otherwise `active`.

`applyProcessingState(accountId, $now)` loads the inputs, computes the state and applies it with a compare-and-set on the previous state, **in one transaction with all of the transition's database side effects** (no network I/O inside, D-28). One-shot emails are reserved (`sending`) in that transaction and sent after commit; QStash cancels also run after commit. Only the caller that wins runs the side effects, and a lost send is resumed by the sweeper (§8.3). **Every writer calls it:** Pause/Resume actions, the OAuth callback, the token manager, disconnect, billing webhooks and reconcile, onboarding completion, and the poll cron (for every non-purged account).

| Transition | Side effects (winner only) |
|---|---|
| → `active` | Move every `intake_floor_at` and `cursor_submitted_at` to `$now`; clear `purge_after` and `disconnected_at` |
| → `inactive` (from any state) | One billing-inactive email, key `billing-inactive:{acct}:{entitlement_lost_at}`. `accounts.entitlement_lost_at` is set to `$now` the first time `applyProcessingState` finds the account not entitled (whatever its state, paused included) and cleared when it is entitled again, so pause → trial ends → resume, or `pending` → `halted`, still send it once per non-entitled period |
| → `revoked` / `disconnected` | `purge_after = $now + 30 d`; cancel jobs; revoke action tokens |
| → `paused` | Cancel nothing; pending follow-ups fail their reservation predicate and are skipped |

**Onboarding complete** (sets `onboarding_completed_at`, then `applyProcessingState`) requires all of:
- an owner-saved brief (`brief_versions.source='owner'` with `booking_link_choice ≠ unset`);
- at least one selected form;
- saved preferences (`preferences_saved_at`) with at least one notify address.

The inbox check and the baseline may still be running in the background. Only `active` accounts are polled, processed and reported.

### 6.2 Lead lifecycle
```
submission (submittedAt > intake_floor_at, not an inbox-check test address, §9.2) ─tx─► lead(new) + lead_messages + job(lead_process)
lead_process: classify (failure → unclear) ─► filtered? ─yes─► FILTERED (owner override → process_rev+1)
                                           └─no─► daily cap reached? → DEFERRED (listed, no draft call)
                                                   draft (+1 retry) → needs_touch? → reserve notification (per-kind predicates)
                                                   → send "New lead" → notified (+ follow-up jobs in the same tx)
follow-up n (n=1,2 at T0+2d / T0+5d, shifted): stops → contact + signals → markReplied? → REPLIED (+ email)
                                           else → follow-up draft → reserve (predicates) → send
send link clicked (heuristic) → first_send_clicked_at;  logged EMAIL to lead → send_confirmed_at (HubSpot time)
dismiss POST → dismissed_at, jobs cancelled
```
- Displayed status: `deriveLeadStatus(lead, now)` (D-32).
- Follow-up hard stops (`evaluateStops`, table-tested):

| Stop | Source |
|---|---|
| more than 2 follow-ups | brief |
| dismissed | brief |
| replied (`replied_at` not null) | brief |
| account not `active` (paused, inactive, revoked, disconnected) | brief |
| follow-ups off | brief |
| contact 404 | brief, D-09 |
| opted out | brief, D-09 |
| bounced / bad address | D-09 |
| superseded (dynamic) | D-44 |
| privacy deletion | D-06 |
| test lead (follow-up jobs are never created for one; defensive) | D-14 |

- The stops are evaluated at job start, and the relevant ones again inside the **per-kind reservation SQL** right before the send (§8.4), so a dismiss, pause or disconnect during drafting is respected.

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
| **rl** | Rate-limited (D-36) |

### 7.2 Public
| Route | Notes |
|---|---|
| `/` | One-liner; three steps; "$49/month after a 14-day free trial"; Install button + "needs a Super Admin or App Marketplace Access" |
| `/privacy`, `/terms`, `/refunds`, `/shipping` | `TODO: legal review`. `/privacy` names every sub-processor and links its policy. Day counts appear only for stores we control (30 days for lead content and drafts, 24 h for test data). It states the HubSpot disclosure: "Autopilot never changes your HubSpot data. HubSpot's 'forms' permission would also allow edits; Autopilot never makes any. Disconnecting uninstalls the app." plus the email-metadata note (D-03, D-49) |
| `/login` (rl) | Server Action → neutral response, ~800 ms latency floor. Links only for (a) a bound owner (`login` intent), (b) an unexpired `pending_owner_email` (`onboarding` intent for that account), (c) `ADMIN_EMAILS` (D-22) |
| `GET /auth/confirm` | "Sign in" button + nonce'd script that copies `#th`/`type` from the fragment into a same-origin POST |
| `POST /auth/confirm` (origin, rl) | `verifyOtp({token_hash, type ∈ email\|magiclink\|signup})` → consume the login intent by compare-and-set (`sha256(token_hash)`, unexpired, unconsumed) → for `onboarding`, **bind** the owner in the same request (§9.1) → redirect to the intent's `next` (allow-listed), else `/dashboard` |
| `/auth/signout` | POST (origin) |

### 7.3 HubSpot, jobs, cron, billing
| Route | Auth | Behaviour |
|---|---|---|
| `GET /api/hubspot/install` | rl | HKDF-signed `state` cookie (10 min) → authorize URL with exactly `REQUIRED_SCOPES` (fake: `/dev/fake-hubspot/authorize`) |
| `GET /api/hubspot/oauth/callback` | state | Exchange the code → check granted scopes → introspect (`hub_domain`, installer email) → account details → one of four branches (D-35, §9.1): **(a)** new portal; **(b)** existing, never bound; **(c)** existing, owned, with the owner's session; **(d)** existing, owned, without it. Failures: neutral page with the permission note; the code is never logged |
| `POST /api/hubspot/webhooks` | sig (v3, ±5 min, against `HUBSPOT_WEBHOOK_TARGET_URL`; current or previous secret) | Zod (≤100 events) → drop when `appId ≠ HUBSPOT_APP_ID` → insert `webhook_events` (ON CONFLICT DO NOTHING). `contact.privacyDeletion` for **any known portal** → `privacy_delete` job. `object.creation`/`contact.creation` for an active portal, debounced to once a minute via `poll_requested_at` → two `portal_poll` jobs (now, +90 s). Always a quick 200 |
| `POST /api/jobs/run` | sig (QStash) | `{jobId}` → hop check → claim (§8.3) → dispatch → 200 / 5xx / 489 / 503. `maxDuration = 300` |
| `POST /api/jobs/failed` | sig (QStash) | Compare-and-set `status='failed'` where `external_id = sourceMessageId` and no live attempt holds the job (§8.3). Only the winner runs the failure path; anyone else gets 200 and does nothing |
| `GET\|POST /api/cron/poll` | cron | `*/5`. Global lease → `applyProcessingState` for every non-purged account → `pollPortal` per active account (per-account lease, ~240 s total budget) → sweeper (§8.3) → retention guard (D-49) |
| `GET\|POST /api/cron/weekly-report` | cron | `0 * * * *`. Due-check (D-17) → insert the report row + job in one transaction (staggered `notBefore`) |
| `GET\|POST /api/cron/daily` | cron | `17 3 * * *`. DB-local steps (retention, prunes) + the billing-tombstone reconcile (§9.10) + one `account_daily` job per account (§9.1, §9.10) |
| `POST /api/razorpay/webhook` | sig + `created_at` window | Dedupe → fetch the subscription → apply if newer → `applyProcessingState` (D-19). Tombstoned subscription → fetch it: `authenticated`/`active` → cancel (`cancel_at_cycle_end: false`) and alert the admin to refund; terminal → set `resolved_at`; then 200. Unknown subscription (no row, no tombstone) → 200 with an admin warning |
| `POST /api/billing/checkout` | owner + origin | Checkout lock → guard → reuse `created`, or resolve stale `created` rows and create → 303 `short_url` (D-18, D-20) |
| `POST /api/billing/resume`, `/api/billing/cancel` | owner + origin | D-18, D-20 |
| `GET /api/onboarding/status` | owner | Reads the DB only: brief job, inbox-check legs, baseline. HubSpot reads happen in the `inbox_check` and `baseline` jobs |
| `GET /api/health` | — | `{ok, mode}` |

### 7.4 Owner action links (no login, mobile-first, `no-store`, `noindex`, no browser Sentry)
| Route | Auth | Behaviour |
|---|---|---|
| `GET /a/[token]/send[?via=mailto]` | token(send) + rl | Record the click (heuristic, D-26). Desktop Gmail/Outlook and URL ≤ 1,800 chars → **302**. Phone UA, "Other" or `via=mailto` → **200 interstitial** that opens `mailto:` on load and sends a nonce'd beacon, with a button and "Copy your reply" fallback (D-13). Too long → copy page. Content purged → "This draft has expired" |
| `GET /a/[token]/copy` | token(send) + rl | Recipient, subject, body and BCC address, each with a copy button |
| `GET /a/[token]/edit` | token(edit) + rl | Editable subject and body; lead message shown as "Message from the lead (unverified)" with links defanged |
| `POST /a/[token]/edit` | token(edit) + origin + rl | Validate → record the click → **200** page with "Send from my email" (link), "Open in default mail app" and "Copy your reply". The edited text is never stored |
| `GET /a/[token]/dismiss` → `POST` | token(dismiss) (+origin) + rl | Confirmation page → dismiss (single use) |
| `GET /a/[token]/verify-notify` → `POST` | token(verify_notify) (+origin) + rl | Confirm an extra notify address (D-46) |

### 7.5 App (owner unless marked; `no-store`, `noindex`)
| Route | Content |
|---|---|
| `/onboarding/email` (rl) | Needs the signed `pending_install` cookie (24 h); pre-filled with the installer's email; stores `pending_owner_email` and `pending_owner_expires_at` (+24 h), creates or reuses the auth user (kept in `pending_owner_auth_user_id`; if the stored id differs from the user for the new email, the previous user is deleted only if no `users` row has that `auth_user_id` and no other account lists it as `pending_owner_auth_user_id`) and sends the magic link with an `onboarding` login intent (D-35). The cookie is not needed afterwards: binding happens in `/auth/confirm`, in any browser |
| `/onboarding/brief` | URL → `brief_generate` job (poll for status); the owner can continue to forms meanwhile. Brief form with booking-link confirm/none; `allow_pricing` defaults off. Saving creates a `brief_versions` row with `source='owner'` |
| `/onboarding/forms` | `hubspot` + `flow` forms, newsletter-like forms unticked; ticking sets `intake_floor_at = $now` |
| `/onboarding/preferences` | Mail client (4), notify emails (owner email pre-verified; extras need confirmation), quiet hours, skip weekends, detected timezone, optional BCC. Sets `preferences_saved_at`. No change alerts before onboarding is complete (D-46) |
| `/onboarding/inbox` | One-sentence "why", history counts, two-leg live test run by the `inbox_check` job, **"Continue, we'll keep checking"** and **"Skip for now"** |
| `/onboarding/baseline` | Starts the baseline job and shows its status. **Finish** is enabled only when the onboarding-complete conditions hold (§6.1); otherwise it says what is missing ("Finish your brief first", with a link). Finish sets `onboarding_completed_at` → `applyProcessingState` → `active` |
| `/dashboard` | Status card: trial days left, active/paused/revoked/inactive, banners (reconnect within 30 days, billing, logging warnings, inbox check pending, caps, leads skipped while paused). Recent leads with one status each; HubSpot record links |
| `/dashboard/leads/[id]` | Timeline; draft until purged; "This is a real lead"; "Resume follow-ups"; signal refresh on view (rate-limited; never for test leads) |
| `/dashboard/brief` | Editor (saves create `brief_versions`) |
| `/dashboard/settings` | Notify emails, mail client, forms, quiet hours/weekends, follow-ups on/off, pause/resume, BCC, disconnect (with an "also cancel billing" choice, or an explanation when the subscription is `paused`/`pending`/`halted`). Changes to notify or BCC addresses alert the owner |
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
- **Session refresh and the login redirect:** only on `/dashboard/*`, `/onboarding/*` (except `/onboarding/email`), `/admin` and `/api/billing/*`. The proxy calls `AuthProvider.refreshSession(request, response)`: live, the `@supabase/ssr` `createServerClient` + `getClaims()` pattern, returning its response with the CSP headers merged in; fake, a check of the signed `ap_session` cookie.
- **Never redirected:** `/api/hubspot/*`, `/api/razorpay/*`, `/api/jobs/*`, `/api/cron/*`, `/api/health`, `/a/*`, `/auth/*`.
- **The proxy never touches the database.** It imports only the CSP builder and the session-refresh adapter.
- **Unit tests:** one per path class, plus a live-adapter test that cookies set during refresh reach the response.

---

## 8. Jobs, scheduling and idempotency

### 8.1 Periodic triggers (UTC)
| Name | Schedule | Notes |
|---|---|---|
| Processing state + poller + sweeper + retention guard | `*/5 * * * *` | `/api/cron/poll` |
| Monday report due-check | `0 * * * *` | `/api/cron/weekly-report` |
| Daily maintenance | `17 3 * * *` | `/api/cron/daily` → per-account `account_daily` jobs |

`vercel.json` declares these for Vercel Pro. `scripts/qstash-schedules.ts` creates the same schedules in QStash (D-16).

### 8.2 Job kinds
Every dedupe key is prefixed with `{ENV_NAMESPACE}:`. Re-publishes append `:h{hops}` (§8.3).

| Kind | Created by (in the same transaction as) | Dedupe key |
|---|---|---|
| `portal_poll` | webhook (debounced) | `poll:{acct}:{minute}:{a\|b}` |
| `lead_process` | lead insert; owner override | `lead:{id}:process:r{process_rev}` |
| `followup` | the "notified" transition; Resume follow-ups | `lead:{id}:fu:{n}:s{followup_stream}` |
| `weekly_report` | report row insert | `report:{acct}:{week_start}` |
| `baseline` | onboarding step | `baseline:{acct}:{date}` |
| `brief_generate` | onboarding/brief editor | `brief:{acct}:{brief_job_id}` |
| `inbox_check` | the inbox-test send; then each run inserts the next until both legs resolve or their 10-minute windows end, every 60 s, in any processing state | `inbox:{acct}:{check_id}:{n}` |
| `privacy_delete` | webhook | `privacy:{portal}:{contact}:{occurredAt}` |
| `account_daily` | daily cron | `daily:{acct}:{localDate}` |

### 8.3 Outbox, claim, lease, re-publish, sweeper (D-15)
1. **Insert.** The job row (`status='scheduled'`, `external_id` null, `created_at=$now`, `hops=0`) is inserted in the same transaction as the state change that needs it. After commit, `Scheduler.publish` runs and `external_id`/`published_at` are stored.
2. **Hop check first.** If `payload.targetAt − now > 60 s`, re-publish for later (step 5) and return 200 without claiming. Re-publishing at the maximum delay this way also covers targets beyond `QSTASH_MAX_DELAY_SECONDS`.
3. **Claim.** This is the only lock:
   ```sql
   UPDATE scheduled_jobs
   SET status='running', attempt_id=$a, lease_until=$now+'6 min', attempts=attempts+1
   WHERE id=$1 AND (status='scheduled' OR (status='running' AND lease_until<$now))
   RETURNING *
   ```
4. **Outcomes.** Every write is guarded by `attempt_id=$a AND status='running'`.
   - success → `done`, 200;
   - transient error → `scheduled`, lease cleared, return 5xx (QStash backs off). On the final delivery (`Upstash-Retried` = 4) the failure path runs inline instead, then `failed` and 200;
   - permanent error → run the failure path inline, `failed`, return 489 + `Upstash-NonRetryable-Error`;
   - a live lease held by another attempt → 503 + `Retry-After`;
   - already `done`, `cancelled`, `skipped` or `failed` → 200.
5. **Re-publish** (hop, quiet-hours re-target, long wait, sweeper). A compare-and-set moves the row to `status='scheduled'`, sets the new `run_at`, `lease_until=NULL` and `hops=hops+1`, guarded by the current `hops` (before claim) or `attempt_id` (after claim). Then publish with dedupe id `{key}:h{hops}` and store the new `external_id`. A `deduplicated:true` response to a re-publish is an error.
6. **Failure callback** (`/api/jobs/failed`):
   ```sql
   UPDATE scheduled_jobs SET status='failed', finished_at=$now
   WHERE id=$1 AND external_id=$sourceMessageId
     AND (status='scheduled' OR (status='running' AND lease_until<$now))
   RETURNING *
   ```
   Only the winner runs the **failure path**: Sentry alert; `lead_process` → `leads.processing_state='failed'` + "needs your touch" (sharing the initial notification key, §8.4); `followup` → a lead-page note, no email; `brief_generate` → `brief_jobs.status='failed'` (the empty editable form); `weekly_report` → `weekly_reports.status='failed'`; `inbox_check` → the open legs become `failed`.
7. **Sweeper** (poll cron), each action a compare-and-set:
   - `scheduled` with `external_id` null and `created_at < $now − 2 min` → publish;
   - `scheduled` with `run_at` more than 30 min in the past → re-publish;
   - `running` with an expired lease → re-publish;
   - `weekly_report` jobs that are `failed` while `weekly_reports.attempts < 3` and before local Tuesday 00:00 → `UPDATE scheduled_jobs SET status='scheduled', run_at=$now, lease_until=NULL, attempts=0, hops=hops+1 WHERE id=$1 AND status='failed' RETURNING` plus `weekly_reports.status='pending', attempts=attempts+1`, then publish. The due-check never re-enqueues;
   - any row with `attempts ≥ 6` → the failure path instead of a re-publish;
   - `notifications_sent` rows still `sending` with `first_reserved_at > $now − 23 h` (inside Resend's 24 h idempotency window) and `reserved_at < $now − min(10 min × 2^sweeper_resumes, 2 h)` → `sweeper_resumes + 1`, resumed through §8.4 step 2, re-rendered from the stored draft, lead message, `weekly_reports.metrics` or template. Job deliveries don't count against this; only time bounds it. Rows with `first_reserved_at ≤ $now − 23 h` become `failed` with one admin alert. `magic_link` rows can't be re-rendered and become `failed`; the owner asks for a new link.
8. **Cancel.** Mark the row `cancelled`, then `Scheduler.cancel(external_id)` by id. A 404 counts as success. There is never a bulk cancel.

### 8.4 Notification reservation (exactly-once owner emails)
Every owner email goes through `reserveAndSend(kind, dedupeKey, …)`:

1. **Reserve.** `INSERT INTO notifications_sent (dedupe_key, kind, status='sending', first_reserved_at=$now, reserved_at=$now, send_attempts=0) SELECT … WHERE <predicates for this kind> ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`.
2. **No row returned.** Read the existing row. `sent` → done: only `sent` blocks. `sending` → take it over: `UPDATE notifications_sent SET kind=$k, reserved_at=$now WHERE dedupe_key=$key AND status='sending' AND kind=$oldKind AND reserved_at=$oldAt AND <predicates for $k>` (new_lead↔needs_touch and follow_up↔needs_touch share keys), then continue at step 3. If the predicates fail, the row becomes `failed` and the caller skips. This covers a retry after a crash, a needs-touch replacing an unsent new-lead email, and the sweeper. `failed` → skip. No existing row → a predicate failed → skip, and the job ends `skipped`.
3. **Tokens.** Mint `apt_` + base64url(32 random bytes) for each button. Insert only their sha256 hashes, with `notification_key`, and **commit before sending** (D-45). A resumed reservation mints fresh tokens and leaves earlier ones valid, because they may be in an email that already went out.
4. **Send.** Increment `send_attempts`, then `Mailer.send` with `idempotencyKey = {ENV_NAMESPACE}:{dedupe_key}`. An error D-36 classifies as transient (including any 5xx and the quota errors) leaves the row `sending` for a retry. An error D-36 classifies as permanent → `failed`, the just-minted tokens revoked, one Sentry alert. A Resend 409 `invalid_idempotent_request` on our own reserved key means an earlier attempt's email (with its committed tokens, possibly of the paired kind) already went out: mark it sent and revoke the just-minted tokens.
5. **Commit.** In one transaction: `status='sent'` + the lead timestamp + (for the first notification) the follow-up job rows.

**Keys and predicates by kind.** A needs-touch email shares the key of the email it replaces, so a lead gets at most one email per kind and stream.

| Kind | Dedupe key | Predicates checked in the reservation SQL |
|---|---|---|
| `new_lead`, `needs_touch` (initial) | `notify:{leadId}:initial:r{process_rev}` | lead not dismissed; `stop_reason` null; not `is_test`; account `active`; connection `active` |
| `follow_up`, `needs_touch` (follow-up n) | `notify:{leadId}:fu{n}:s{followup_stream}` | the above, plus `replied_at` null, not superseded, `followups_enabled` |
| `reply_detected` | `reply:{leadId}:s{followup_stream}` | Reserved inside the `markReplied` transaction (§9.5), only when follow-ups were still scheduled (D-08): `replied_at` not null; lead not dismissed; account and connection `active` |
| `inbox_test` | `inbox-test:{checkId}` | lead `is_test`; account `processing_state ∈ (onboarding, active)`; connection `active` |
| `weekly_report` | `report:{acct}:{week_start}` | account and connection `active` |
| `reconnect` | `reconnect:{conn}:{status_changed_at}` | reserved inside the revoke transaction (§9.1); re-checked on resume: the connection is still `revoked` with that `status_changed_at` |
| `billing_inactive` | `billing-inactive:{acct}:{entitlement_lost_at}` | reserved inside the `→ inactive` transition (§6.1); re-checked on resume: the account is still `inactive` |
| `magic_link` | `magic:{intentId}` | — |
| `verify_notify` | `verify-notify:{acct}:{addrHmac}` | the address is still listed and unverified |
| `lead_cap` | `cap:{acct}:{localDate}` | account `active` |
| `owner_alert` (settings changes, reconnect attempts) | `alert:{acct}:{kind}:{id}` | — |

### 8.5 Follow-up timing (D-33)
- **Target:** `shiftToAllowed(T0.setZone(tz).plus({days: n}))`.
  - T0 is `first_notified_at`.
  - The search is limited to 8 days.
  - A per-account offset of 0–10 min is added only when the time was shifted.
- **At fire time:** if the current settings forbid "now", re-target (§8.3 step 5).
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

### 9.1 Install, binding, tokens, reconnect, disconnect (D-10, D-11, D-22, D-35)
1. **OAuth callback branches:**
   - **(a) New portal:** create the account (`last_install_at=$now`; trial from `portal_history` if present, otherwise now + 14 d) and the connection; issue the signed `pending_install` cookie (24 h, carrying the account id and the introspected installer email) → `/onboarding/email`.
   - **(b) Existing, never bound** (`owner_user_id IS NULL`, not purged): store the fresh tokens, set the connection active, set `last_install_at=$now` (restarting the orphan clock), reset `pending_owner_email` and `pending_owner_expires_at` (keeping `pending_owner_auth_user_id` for the guarded delete below), keep the trial, issue a new `pending_install` → `/onboarding/email`.
   - **(c) Existing, owned, with the owner's session:** reactivate: connection active; clear `purge_after`, `disconnected_at`, `status_reason` and `reconnect_email_sent_at`; then `applyProcessingState` (floors move forward).
   - **(d) Existing, owned, without the owner's session:** change nothing. If the installer email equals the owner's email, show "Sign in to finish reconnecting" and email a magic link (`next=/dashboard?reconnect=1`). Otherwise show "This HubSpot account is already connected to Autopilot by another user" and send the owner an `owner_alert`: "Someone in your HubSpot account tried to connect Autopilot. Nothing changed. If this was you, sign in and tap Reconnect."
2. **Binding** (in `POST /auth/confirm`, any browser, after `verifyOtp`, for an `onboarding` intent), one statement:
   ```sql
   WITH b AS (
     UPDATE accounts SET owner_user_id=$u, pending_owner_email=NULL,
       pending_owner_expires_at=NULL, pending_owner_auth_user_id=NULL
     WHERE id=$intent.account_id AND owner_user_id IS NULL
       AND lower(pending_owner_email)=$verifiedEmail AND pending_owner_expires_at > $now
     RETURNING id)
   INSERT INTO users (auth_user_id, account_id, email) SELECT $u, b.id, $verifiedEmail FROM b
   ```
   On a unique violation nothing is bound, the losing account's `pending_owner_*` fields are cleared, and the page says "This email already owns an Autopilot account". No cookie or nonce is needed: a login-CSRF can't bind a stranger, because the verified email must equal the pending email. The email step also refuses an address that already owns another account.
3. **Token manager** (`getAccessToken`):
   - If `access_expires_at − 5 min > $now`, use the stored token.
   - Otherwise take a refresh lease with a compare-and-set (`refresh_lease_until`, 20 s). The loser re-reads the row, polling every 250 ms for up to 10 s.
   - The winner makes **one** HTTP call (8 s timeout), with no transaction open.
   - Success: a conditional update that bumps `token_version` and always stores the newest refresh token.
   - `revoked`: one transaction holds the compare-and-set on `status='active' AND token_version=$v` (sets `revoked`, wipes tokens), the `applyProcessingState` transition (`purge_after = +30 d`, jobs cancelled, tokens revoked) and the `reconnect` reservation. The email is sent after commit.
   - `transient`: release the lease and throw `TransientError`. Jobs rely on QStash's backoff and the failure callback's alert (D-11). Only the **inline** callers (the poll cron and the lead-page refresh) increment `transient_failures` and set `next_refresh_attempt_at = $now + min(2^(n−1) × 5 min, 30 min)`. The poll cron skips a portal only while its token needs a refresh and `$now < next_refresh_attempt_at`. The fifth consecutive inline failure raises one Sentry alert. Any successful refresh or API call, from any caller, resets both fields (brief §5.1).
   - `config`: Sentry once; the connection stays active.
   - A 401 from an API call triggers one refresh.
4. **`account_daily` job:**
   - introspect the refresh token for every active connection, whatever its pause or billing state; `active:false` → the revoked path;
   - refresh account details and timezone (D-12);
   - reconcile non-terminal Razorpay subscriptions;
   - re-encrypt rows whose kid isn't current (D-51);
   - orphan and purge handling (§9.10);
   - a signal refresh (`AND NOT is_test`) for leads whose follow-ups are finished or off and that were notified in the last 14 days. Leads with pending follow-ups are checked by their own jobs.
5. **Disconnect** (owner, best effort):
   - Optionally cancel the Razorpay subscription (only from `authenticated`/`active`; otherwise the dialog explains why not).
   - Try the uninstall API, then revoke the token.
   - Then **always**: wipe tokens, set the connection `disconnected`, `applyProcessingState` (→ `purge_after`), cancel jobs, revoke action tokens.
6. **Orphans:** no bound owner, `last_install_at < $now − 7 d` and no unexpired pending owner → uninstall API, token wipe, connection `disconnected`, then the immediate purge (§9.10), which deletes the pending auth user only if no `users` row has that `auth_user_id` and no other account lists it as `pending_owner_auth_user_id` (D-48).

### 9.2 Intake (D-07)
`pollPortal(account, trigger)` runs under the per-account lease, for `active` accounts only. `trigger ∈ {webhook, cron}` is stored on new leads as `intake_trigger`.
1. For each selected form:
   - Page through submissions newest first (limit 50) until a page has nothing newer than `cursor − 60 min`, or until 20 pages (Sentry warning at that cap). The 60-minute overlap lets a submission whose contact isn't visible yet be retried for an hour.
   - Keep only submissions with `submittedAt > intake_floor_at`. **Skip** any whose `HMAC(lower(email))` equals the `test_address_hmac` of an inbox check on this account with `check.created_at − 1 h ≤ submittedAt < check.created_at + 24 h`. The window is tested against `submittedAt`, not `$now`, so the skip never lapses for that submission (the HMAC is kept after `test_address` is cleared). A skipped submission counts as processed for the cursor.
2. For each new submission, in ascending order:
   - Resolve the contact with `GET contacts/{email}?idProperty=email&properties=firstname,lastname,company,message,email`. On a 404, skip it for now; later polls retry it while it is inside the overlap, after which an audit entry (no content) and a Sentry warning record it.
   - Fill missing fields from the contact.
   - Insert in **one transaction**: the lead (ON CONFLICT on both unique keys) → `lead_messages` (CTE on RETURNING) → the `lead_process` job.
3. Set the cursor with `GREATEST(cursor, max processed or skipped submittedAt)`.
4. After commit, publish (the outbox, §8.3).

### 9.3 Process → draft → notify
`lead_process`:
1. Claim the job (§8.3); re-read the lead (dismissed or account no longer active → `skipped`).
2. **Classify** (fast model; message + form name + first name + company inside untrusted-input delimiters). Any failure → `unclear`.
3. Filtered classes → `filtered`, then stop.
4. **Daily cap** (D-36), counted after classification: over `MAX_DRAFTED_LEADS_PER_DAY` → `deferred` (no draft call) and one `lead_cap` email per local day. If the AI budget breaker has tripped → needs-touch with the minimal safe template and an admin alert.
5. **Draft** (Sonnet 5.5) → Zod (enums lowercased) → validator (§9.4).
   - On failure: one retry carrying the error codes (a fresh single-turn request).
   - Then, or on a refusal, or on a FATAL-CONFIG error: `needs_touch` with the minimal safe template.
   - A transient error → 5xx (retry). On the final delivery, or in the failure callback, send the needs-touch fallback (D-24).
   - Record `ai_calls` for each attempt.
6. **Notify** (§8.4, kind `new_lead` or `needs_touch`):
   - Subject `New lead: {safe first name} — your reply is ready`, with a fallback (D-47).
   - The email contains the "This email isn't monitored" line (D-27), the lead's name, company, email and quoted message (defanged), the draft, three buttons and the "Open in default mail app" link.
   - Reply-To is the owner (D-27).
   - On commit: `first_notified_at`, `processing_state=notified`, and two `followup` job rows (unless follow-ups are off).

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

### 9.5 Follow-up job (D-08, D-09, D-34, D-44)
1. Hop check, then claim. If this lead's `reply:{leadId}:s{followup_stream}` reservation is still `sending`, resume it (§8.4 step 2) and finish.
2. Run `evaluateStops` on the database state (§6.2). If the current settings forbid "now", re-target.
3. Read `GET contacts/{id}?properties=email,hs_additional_emails,hs_email_optout,hs_email_bad_address,hs_email_hard_bounce_reason_enum,hs_sales_email_last_replied&associations=emails`, paging the associations and batch-reading emails (metadata allow-list only) in chunks of 100. 404 → stop `contact_deleted`; a different `id` → re-map (merge); opted out or bounced → stop.
4. Run `applySignals`:
   - `send_confirmed_at` = earliest qualifying `EMAIL` to the lead with `hs_timestamp ≥ first_notified_at − 60 s` (`LEAST`);
   - a qualifying reply (from the lead's address, `hs_timestamp > GREATEST(first_notified_at, COALESCE(replies_ignored_before, '-infinity'))`) → `markReplied()`: **one transaction** that sets `replied_at` (`WHERE replied_at IS NULL AND NOT is_test RETURNING`), marks the remaining follow-up jobs `cancelled` and inserts the `reply_detected` reservation (`sending`; this job was still scheduled). After commit: QStash cancels, then the email ("{Name} replied — follow-ups stopped", §8.4 steps 3–5). A crash or transient error before the send is recovered by step 1 on redelivery, or by the sweeper. Then done.
5. If not stopped:
   - draft the follow-up (≤70 words, referencing the original subject/body while that content still exists);
   - validator, retry and needs-touch as for initial drafts;
   - reserve and send (`follow_up`), with the honest notes from D-34.
6. Mark the job done.

### 9.6 Owner controls (D-42)
- **Pause all** sets `accounts.paused_at`; **Resume** clears it. Both call `applyProcessingState`. While paused, nothing is polled or sent; on resume the floors move to now and the dashboard says leads that arrived while paused were not drafted.
- **"This is a real lead"** (filtered → override): `process_rev + 1`, a new `lead_process` job with dedupe `lead:{id}:process:r{rev}`.
- **"Resume follow-ups"** (for example after an out-of-office auto-reply), in one transaction:
  - write the old `replied_at` to `audit_log` (timestamp only);
  - `replied_at = NULL`; `stop_reason = NULL` if it was `replied`;
  - `replies_ignored_before = $now`; `followup_stream + 1`;
  - insert jobs only for follow-ups not yet sent, at `shiftToAllowed(max(T0 + n days, now + 1 h))`.
  - A later real reply is recorded normally (§9.5) and stops follow-ups.

### 9.7 Onboarding: brief, inbox check, baseline (D-14, D-24, D-38, D-47)
- **Brief generation (`brief_generate` job, `brief_jobs.attempts` counts deliveries):**
  - **Crawl:** the homepage plus up to 8 same-site internal links, ranked by keywords in the path or link text (`services|pricing|about|contact|faq`). `robots.txt` is honoured. Each page gets a 10 s `AbortSignal`, inside a 60 s total budget, with at most 4 fetches at once (SSRF guard, §10.4).
  - **Extraction:** strip `nav`, `header`, `footer`, `script`, `style`, `noscript`, `svg`, `iframe` and hidden DOM (`display:none`, `hidden`, `aria-hidden`, `template`, comments) before extracting text.
  - **LLM:** Sonnet 5.5, adaptive thinking, `ANTHROPIC_BRIEF_EFFORT`, 16000 max tokens, per call `{timeout: remainingMs, signal: AbortSignal.timeout(remainingMs)}`. The first delivery uses those parameters; any later delivery (`brief_jobs.attempts`, read before this delivery increments it, is ≥ 1, or the previous attempt aborted) uses `between_tools`/`high`/4096. After the final delivery the job is `failed` and the owner gets the empty editable form, as on a refusal.
  - **Post-processing:** `faqs` capped at 8; `allow_pricing=false`; `booking_link` must be https and appear in the fetched pages, and the editor shows its host and asks the owner to confirm it.
- **Inbox check:**
  - **History:** two `emails/search` counts (outbound vs inbound, last 30 days).
  - **Live test:**
    1. The owner enters their other address. The check row (`test_address_hmac`, `status='open'`) is created **at once**, so intake skips submissions from that address made between 1 h before and 24 h after the check's creation (§9.2). Then `GET contacts/{testEmail}?idProperty=email`; on a 404 with no BCC saved, ask the owner to add their BCC address or submit one of their own forms with the test address.
    2. Create a test lead (`is_test`, `intake_trigger=inbox_check`, template draft, content purged after 24 h), set the deadlines, send the three-button `inbox_test` email to the owner, and insert the first `inbox_check` job.
    3. **Send leg:** the owner taps "Send from my email" and sends from their own mailbox; we look for an `EMAIL` to the test address within 10 min.
    4. **Reply leg:** the owner replies from the test address; we look for an `INCOMING_EMAIL` from it within 10 min.
    5. Each `inbox_check` run reads HubSpot, writes only `inbox_checks` and `logging_mode`, and inserts the next run (+60 s) until both legs resolve or time out. It never calls `markReplied`.
    6. The owner can "Continue" (the result lands on the dashboard) or "Skip for now" (`logging_mode=unknown`, dashboard reminder). Skip, or a check still without deadlines 24 h after creation, closes the check with its open legs `skipped`. Fix-step copy distinguishes "test contact missing" from "not logged".
  - **Test leads** never get follow-ups, never supersede, never count in metrics, and are excluded from `applySignals`, `markReplied` and every signal refresh (`AND NOT is_test`).
- **Baseline (job):**
  - Read the last 30 days of submissions on the selected forms. Above 500 → "Not enough data". Classify each with the fast model **in memory** (nothing stored); keep `lead`/`unclear`.
  - For each kept submission, read the contact's associated emails and take the first `EMAIL` sent **to** the lead after `submittedAt`.
  - Report the lead count; the median (n ≥ 3; even n = mean of the two middle values); and the number of leads with no logged outbound email, with that as a % of the lead count (only if the portal has any logged `EMAIL` in 30 days and the email scope is granted). Otherwise "Not enough logged history".

### 9.8 Monday report (D-17, D-37)
1. Claim the job.
2. Period `[Mon 08:00 local − 1 week, Mon 08:00 local)`, half-open, computed with Luxon in the portal zone.
3. Refresh signals (`AND NOT is_test`, rate-limited) for the cohort and for leads with events in the period.
4. `computeWeeklyMetrics(rows, baseline, loggingMode, scopes, period)`, pure:
   - **Cohort**, over non-test leads submitted in the period:
     - "Leads in"; "Filtered (spam etc.)" (not overridden);
     - "Drafts emailed to you" (`first_notified_at`);
     - "Your sends confirmed in HubSpot" (`send_confirmed_at < end`);
     - "Send link opened, not confirmed";
     - "Median time to your first reply (logged in HubSpot)" (submission → `send_confirmed_at`, n ≥ 3);
     - "Leads still waiting for your reply (nothing logged in HubSpot)": notified, not dismissed, not confirmed, with record links (first 20 + "and N more").
   - **Events** in the period: "Replies from leads" (`replied_at`); "Follow-ups drafted" (`fu1_notified_at` and `fu2_notified_at`).
   - **"Compared with your baseline":** the median, and "% with no logged reply from you" over the comparison population: non-test cohort leads whose effective class is `lead`/`unclear` (or overridden) and that are not dismissed; numerator = those with no `send_confirmed_at` before the period end.
   - **Honesty rules** (D-37): counts over 0 are always shown; a 0 becomes "Not enough data" when the logging mode or scopes can't support it; when sends aren't logged, the waiting list becomes "We can't confirm your sends in HubSpot for your account".
5. Store the metrics, then reserve, render and send (§8.4).

### 9.9 Billing (D-18 to D-20)
- **Trial:** 14 days from the first install of the portal (`portal_history`).
- **Entitlement:** `trialing` OR `authenticated` OR `active` OR (`pending` AND `now < grace_until`). Pure and table-tested over all 9 statuses, plus `created`, `stale`, none, unknown and `resumed`, and the grace boundaries. The current subscription is the one with the latest logical `created_at`.
- **Checkout:**
  1. Take the lock (`checkout_lock_until`, 30 s compare-and-set).
  2. Guard: block on `authenticated`, `active`, `pending`, `halted`, `paused`.
  3. Reuse a `created` row's `short_url` while `expire_by > now` and (`start_at` is null or `> now`).
  4. Otherwise re-fetch each non-reusable `created` row from Razorpay and apply a status other than `created`. If Razorpay still says `created` (it documents no expiry at `expire_by`), or the fetch fails, mark the row `stale` locally. Past `expire_by` the customer can no longer authorise it, and the second-live-subscription rule covers anything unexpected.
  5. Create (`start_at` if more than 1 day of trial is left; `expire_by` rule), insert, 303 to `short_url`.
- **Webhook and reconcile:** fetch-and-apply, applied only when newer, then `applyProcessingState`.
- **Second live subscription** for the same account: cancel the newer one immediately and alert the admin.
- **Cancel:** immediate when `authenticated`, at cycle end when `active`. **Resume** for `paused`.

### 9.10 Retention and purge (D-48, D-49)
Every query binds `$now`. The DB-local steps also run from the 5-minute cron through a cheap guard, so content never outlives 30 d + 1 h.
1. `delete from lead_messages where purge_at < $now`.
2. `update drafts set subject=null, body=null, flags='{}', purged_at=$now where purge_at < $now and purged_at is null`.
3. `update leads set submission_key=null where …` for leads whose content was purged.
4. Clear `inbox_checks.test_address` after 24 h; close checks still without deadlines after 24 h (§9.7); expire `login_intents`.
5. **Account purge** (`account_daily`), when `purge_after < $now` (or an orphan per §9.1 step 6, whose connection was just set `disconnected`) **and** no connection is active, re-checked right before the auth-user delete:
   - a live `authenticated`/`active` subscription is cancelled first (`cancel_at_cycle_end: false`);
   - a `paused`, `pending` or `halted` subscription can't be cancelled through the API: the purge still runs, and the admin is alerted to cancel it in the Razorpay dashboard;
   - write the tombstones (`portal_history`; `billing_tombstones` with every subscription's id, last status and `expire_by`, and `resolved_at = $now` for terminal ones, including any just cancelled);
   - delete the bound owner's auth user, or for an orphan the pending auth user only if no `users` row has that `auth_user_id` and no other account lists it as `pending_owner_auth_user_id`;
   - `delete from accounts`.
6. **Billing-tombstone reconcile** (daily cron, inline): `WHERE resolved_at IS NULL ORDER BY last_checked_at NULLS FIRST LIMIT 50`. For each row, `GET /v1/subscriptions/{id}`, store `last_status` and `last_checked_at = $now`. `authenticated`/`active` → cancel (`cancel_at_cycle_end: false`) and alert the admin to refund any charge; `cancelled`/`completed`/`expired`, or `created` past its `expire_by` (it can no longer be authorised) → `resolved_at = $now`; `pending`/`halted`/`paused` stay open and are re-checked in rotation. A failed fetch is retried the next day. The Razorpay webhook does the same for a tombstoned subscription (§7.3).
7. Prune `webhook_events` older than 30 d, expired tokens, `rate_limits`, and `ai_calls` older than 13 months.
8. Retention test: every content column is null or deleted for leads older than 30 d + 1 h, for revoked accounts, and for test leads after 24 h.

---

## 10. Security and privacy (brief §2, §7)

1. **Signatures.** Each is tested against the vectors in RESEARCH:
   - HubSpot v3: base64 HMAC-SHA256 of `method + uri + rawBody + timestamp`; timestamp must match `/^\d{13}$/`; accepted within ±300 000 ms; timing-safe compare; current or previous client secret.
   - QStash: `Receiver.verify` with `url`, `clockTolerance: 5`, `devMode: false`. A token signed with the dev key is rejected.
   - Razorpay: hex HMAC with the webhook secret, timing-safe, empty secret refused, previous secret accepted, `created_at` window.
2. **Crypto and keys (D-51):**
   - AES-256-GCM with a kid and AAD.
   - HKDF per-purpose keys.
   - Action tokens are 32 random bytes; only their sha256 hashes are stored, committed before the email is sent (D-45).
   - All cookies are HMAC-signed, `httpOnly`, `Secure`, `SameSite=Lax`.
3. **Auth (D-22, D-35):**
   - token in the URL fragment; `type=email`;
   - server-side login intents; `next` parsed with `new URL(next, APP_URL)`: same origin, pathname allow-list, query kept;
   - binding in the `/auth/confirm` POST, as one statement, by verified email = pending email, in any browser;
   - same-origin checks; latency floor on `/login`; rate limits on `/login`, `/onboarding/email` and `POST /auth/confirm`;
   - public Supabase sign-ups off.
4. **SSRF guard:**
   - Checks happen when the socket opens: an undici `Agent` with a guarded `lookup` that rejects any disallowed address and connects only to the vetted IP.
   - Ports 80 and 443 only.
   - Blocked ranges, IPv4 and IPv6: private, loopback, link-local, CGNAT, `0.0.0.0/8`, `fc00::/7`, `::ffff:0:0/96`, `64:ff9b::/96`, 6to4, and metadata addresses. IP-literal and single-label hosts are refused.
   - The same agent is used for `robots.txt` and for each of at most 3 redirects.
   - Limits: 2 MB per page after decompression; 9 pages, 10 MB, 10 s per page and 60 s in total.
   - Only `text/html` and `text/plain` are read; no cookies or auth headers are sent.
   - Our own user agent, and `robots.txt` is respected.
5. **Lead-controlled text (D-47):** sanitised subject, defanged message, validator injection codes, nav/scripts/hidden DOM stripped from briefs, booking-link confirmation.
6. **CSRF:**
   - Server Actions use their built-in Origin check.
   - Route-handler POSTs call `assertSameOrigin`.
   - CSP `form-action 'self'`.
7. **Headers:**
   - Nonce CSP from `buildCsp({nonce, dev})`; `'unsafe-eval'` only in development.
   - `connect-src 'self'` plus the Sentry ingest origin.
   - `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`.
   - HSTS, `nosniff`, `Referrer-Policy: no-referrer`, and a `Permissions-Policy`.
   - `Cache-Control: private, no-store` + `X-Robots-Tag: noindex` on personal-data pages.
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
  - Each test file loads the dump once; between tests it runs `TRUNCATE … RESTART IDENTITY CASCADE` on the `public` tables.
  - `hookTimeout` 30 s; DB test workers are capped.
- **Stubs and time.** `server-only` is aliased to a stub. The system time is set to 2030 in the time-sensitive suites, to prove nothing reads the wall clock.
- **Route tests** call `src/server/http/*` with real `Request` objects and explicit cookie jars.
- **Locking and race semantics** are tested as **sequential replays**: crash after claim, duplicate delivery, compare-and-set loser paths. PGlite has a single connection.

**Brief §8 required tests:**
| Required test | Where |
|---|---|
| Validator golden cases | `domain/validator.test.ts` (≥40, including injection payloads) |
| Signatures with known vectors | `security/hubspot-signature.test.ts` (5 vectors + negatives incl. the 300000/300001 boundary), `razorpay-signature.test.ts` (A–C + negatives), `qstash-signature.test.ts` (`jose`-signed tokens, fake timers, dev-key rejection) |
| Token refresh: revoked vs transient | `services/token-manager.test.ts` with exact HubSpot error fixtures (`invalid_grant`/`BAD_REFRESH_TOKEN`, `BAD_HUB`, `invalid_client`, 429 `TEN_SECONDLY_ROLLING`/`DAILY`, 477 + `Retry-After`, 502, timeout), lease loser, version compare-and-set, the inline backoff (ten failed job deliveries during a blip don't delay the next cron poll; the backoff never exceeds 30 min; success clears it) and the fifth-failure alert |
| Follow-up stop rules | `domain/stops.test.ts` + `services/followups.test.ts` (including stops arriving between claim and send) |
| Quiet hours across timezones | `domain/quiet-hours.test.ts` (§8.5) |
| Checkout guard | `domain/checkout-guard.test.ts` + `entitlement.test.ts` + checkout lock, stale-`created` (abandoned on trial day 2, still `created` on day 10 → `stale` → new checkout) and second-subscription tests |
| Retention purge | `services/retention.test.ts` (30 d + 1 h, revoked-then-reconnected not purged, orphan 7 d after the last install (a branch-(b) reinstall on day 6 is not purged on day 7), live subscription cancelled first, `paused`/`pending`/`halted` purged with a tombstone and an admin alert, a tombstoned `pending` subscription turning `active` with no webhook is cancelled by the daily tombstone reconcile (also with 60 unresolvable tombstones ahead of it, within 2 runs), an orphan purge never deletes an auth user that owns or is pending on another account, test lead at 24 h) |
| Idempotent webhook replay | `http/hubspot-webhook.test.ts` (same body twice; `attemptNumber` 0/1; webhook + poller → one lead; `appId` mismatch) + Razorpay replays (same id; missing header → body hash; old `created_at`) |

**Further tests:**
- **Migrations and data:** migrations/RLS/grants/functions (over `supabase/migrations` tables only); driver normaliser; no `now()` in SQL; DB-error sanitising.
- **Jobs:** claim/crash/redelivery/sweeper per kind; re-publish with `:h{hops}` (and `deduplicated:true` → error); a duplicate delivery during a live lease that exhausts its retries → the failure callback loses, exactly one owner email; a failed weekly report re-enqueued by the sweeper and sent once; `attempts ≥ 6` → failure path.
- **Notifications:** reservation per kind, including the happy path for `reply_detected` (after `markReplied`) and `inbox_test` (during onboarding); crash after send → no duplicate (the 409 path); dismiss during drafting → no send; needs-touch takes over an unsent new-lead reservation (exactly one email); a `sending` reservation is resumed by the sweeper at doubling intervals (10 min to 2 h) until 23 h; a `lead_process` whose 5 deliveries all hit a transient Resend error → exactly one new-lead or needs-touch email once Resend recovers; a Resend 500 → retried, exactly one email; a permanent Resend error → `failed`, one alert, no further resumes; the owner reconnects before the sweeper runs → no reconnect email; a takeover re-checks the new kind's predicates; `markReplied` followed by a transient Resend error → exactly one `reply_detected` on retry.
- **Processing state:** every transition; pause → revoke → reconnect stays `paused`; resume moves the floors at once; pause → trial ends → resume → exactly one billing-inactive email; `pending` → grace ends → `halted` → exactly one; a crash after a revoke commits still delivers the reconnect email (sweeper); the onboarding gate (brief job still running → Finish disabled, account stays `onboarding`).
- **Auth and onboarding:** callback branches (a)–(d), including an unbound reinstall reaching `/onboarding/email` with a new cookie and an owner-email reinstall without a session getting a magic link and no alert; cross-device bind (email step in cookie jar A, confirm in an empty jar B → owner bound); link confirmed at minute 45 → bind succeeds; login-CSRF with another email → no bind; a branch-(b) reinstall with the same email re-entered keeps the same auth user and binds, and with a different email deletes the previous user; two pending installs with the same email → the second bind is refused and that account stays unbound, and its later orphan purge leaves the first account's owner able to sign in; an email step abandoned on one portal, then the same email bound on another → the first portal's orphan purge keeps that owner; `next=/dashboard?reconnect=1` survives the allow-list; magic-link `type` and `next` handling; proxy refresh cookie propagation.
- **Intake:** contact visible 30 min after the submission still becomes a lead; a test-address submission on an active account, with no newer submission on that form, is still not a lead when re-read 25 h after the check was created; `privacy_delete` removes content, revokes tokens, cancels jobs and sets `stop_reason='privacy_deletion'`; historical submissions below the floor are never ingested; contact-filled values are purged with the rest.
- **Signals:** to-address rule, from-address rule, `replies_ignored_before`; out-of-office reply → Resume follow-ups → follow-up sent → real reply → `reply_detected` once and the remaining job cancelled; test leads excluded from every refresh.
- **HubSpot client:** request allow-list; email metadata allow-list; `REQUIRED_SCOPES` vs `app-hsmeta.json`; forms list query string; associations paging/chunking.
- **Domain:** compose vectors (TV1–TV3, lone surrogate, IDN, `+`, `&`, CRLF); newsletter detection; due-check (Kolkata, Kathmandu); weekly metrics and honesty by logging mode; the copy rule (every owner-side "reply"/"replied" is qualified by you, your or from you); `deriveLeadStatus`.
- **AI:** `toClaudeJsonSchema` snapshots; `buildModelParams` per model; brief parameters (the first delivery uses adaptive/`ANTHROPIC_BRIEF_EFFORT`/16000; after a slow first attempt the second uses `between_tools`/4096); AI error classification.
- **Brief builder:** page selection and ranking, per-page timeout, nav/script/hidden-DOM stripping, on `test/fixtures/site`.
- **Security:** SSRF (rebinding resolver, IPv6 forms, redirects); robots parser; CSP builder (dev and prod); proxy scope; cross-tenant isolation; env refusals; crypto (kid, rotation, tamper); rate limits on every public action and auth route.
- **Observability:** scrubber, envelope, logger.
- **Layout and app smoke:** `src/instrumentation.ts` exists; no root `app/`, `instrumentation.ts`, `middleware.ts` or `proxy.ts`. A fake-mode end-to-end fetch smoke test covers install → magic link → onboarding → dashboard → fake checkout.

---

## 13. Simulation (`npm run simulate`, D-39)

**Setup**
- Fakes, PGlite in memory, `FakeClock`. The run is repeated with the system time set to 2030.
- Portal `1234567`, timezone `America/New_York`, `uiDomain app.hubspot.com`; the owner's mailbox logs everything (`log_all` behaviour in the fake portal).
- Three forms:
  - **Contact us:** name, email, company, message.
  - **Request a quote:** name, email, company, message.
  - **Newsletter signup:** email only, lifecycle `subscriber`. It is auto-detected and unticked.
- Baseline fixture: 5 submissions from 5 existing contacts between 2026-09-10 and 09-30, all genuine enquiries (classified `lead`). Four have a logged outbound email after 30 m, 2 h, 5 h and 26 h (median **3 h 30 m**, the mean of 2 h and 5 h); one has none (**20%**).
- `advanceTo` steps through every job and cron tick in order: polls every 5 min, the hourly due-check, daily at 03:17 UTC. Events precede ticks at the same instant. Every tick and every intake trigger is recorded in `summary.timeline`.

**Pre-run, Tue 2026-10-06 (local).** Owner foreground steps 09:00–09:04:30:

| Time | Step |
|---|---|
| 09:00 | Install (fake consent) → branch (a) → `/onboarding/email` → magic link (outbox #1) |
| 09:00:30 | The link is opened on a **fresh cookie jar** → `/auth/confirm` POST → bound |
| 09:01 | Website URL submitted → `brief_generate` job (background) |
| 09:01:30 | Forms selected (newsletter unticked) |
| 09:02 | Preferences saved: Gmail, one notify email (the owner's), quiet hours 19–08, weekends allowed, BCC on. No change alert |
| 09:03 | Brief reviewed and saved (`source='owner'`) |
| 09:03:15 | Inbox test started: history counts; test lead; `inbox_test` email (outbox #2); `inbox_check` job |
| 09:03:30 | Owner taps "Send from my email" on the test email; the send is logged at 09:04 |
| 09:04:30 | Baseline job started; **Finish** → onboarding complete → `active`; floors at 09:04:30 |

Background: the owner replies from the test address at 09:05 (logged at 09:05); the `inbox_check` job sees both legs and sets `logging_mode=log_all`; the baseline job finishes (3 h 30 m, 20%). All done by 09:06. Historical submissions produce **no** leads.

**Calendar.**

| Step | Local time | Events → expected |
|---|---|---|
| Day 0 | Tue 10:00–10:41 | Submissions: **#1** normal (10:00, new contact), **#2** no message (10:05), **#3** spam (10:10), **#4** vendor pitch (10:15), **#6** future replier (10:20). Each fires a webhook → polls. **#5** is a repeat submission at **10:31** by one of the five baseline-fixture contacts (none of #1–#4, #6), with **no webhook**; the 10:35 cron poll picks it up (`intake_trigger=cron`). Classification: #3 spam, #4 vendor_pitch → filtered. Emails: `new_lead` ×4 (#1, #2, #5, #6). Owner: taps Send on #1 at 10:12 (logged at 10:13), on #2 at 10:30 (never logged), on #6 at 10:40 (logged at 10:41) |
| Day 1 | Wed 10:00 | Owner sends #5's reply (logged at 10:01) |
| Day 2 | Thu ≈10:00–10:36 | `follow_up` ×4 (fu1 for #1, #2, #5, #6) |
| Day 3 | Fri 14:00 | #6 replies (`INCOMING_EMAIL` from #6's address, `hs_timestamp` Fri 14:00). Nothing is sent |
| Day 5 | Sun ≈10:00–10:36 | fu2 jobs: #1, #2 and #5 → `follow_up` ×3; #6 → reply detected by the job → `reply_detected` ×1, follow-ups stopped |
| Monday | Mon 2026-10-12 08:00 | `weekly_report` ×1, covering `[Mon 10-05 08:00, Mon 10-12 08:00)` |
| Wednesday | Wed 10-14 12:00 | No emails. Final statuses are checked |

**Expected outbox: 15 emails.**

| When | Emails |
|---|---|
| Pre-run | 2: magic link, inbox test (exactly these) |
| Day 0 | 4 |
| Day 2 | 4 |
| Day 5 | 4 |
| Monday | 1 |

**Expected weekly metrics** (the full JSON is asserted):

| Metric | Value |
|---|---|
| Leads in | 6 |
| Filtered (spam etc.) | 2 |
| Drafts emailed to you | 4 |
| Your sends confirmed in HubSpot | 3 (#1, #5, #6) |
| Send link opened, not confirmed | 1 (#2) |
| Median time to your first reply (logged in HubSpot) | 21 min (13 m, 21 m, 23 h 30 m) |
| Leads still waiting for your reply (nothing logged in HubSpot) | [#2] with its record link |
| Replies from leads | 1 |
| Follow-ups drafted | 7 |
| Compared with your baseline | median 3 h 30 m → 21 m; % with no logged reply from you 20% → 25% (1 of #1, #2, #5, #6) |

**Expected final statuses (Wednesday):**

| Lead | Status | Notes |
|---|---|---|
| #1 | no reply | send confirmed |
| #2 | no reply | send link opened, never confirmed |
| #3 | filtered | spam |
| #4 | filtered | vendor pitch |
| #5 | no reply | send confirmed; `intake_trigger=cron` |
| #6 | replied | |

**Further checks:**
- owner foreground steps ≤ 5 simulated minutes;
- the pre-run outbox is exactly the magic-link and inbox-test emails;
- floors equal the onboarding-complete time (09:04:30);
- the test lead is absent from every list and metric, has no `follow_up` or `reply_detected` email and no `followup` jobs;
- no historical lead; `#5.intake_trigger = cron`;
- every `scheduled_jobs` row ends `done`, `cancelled` or `skipped`.

**Output:** `./outbox/NNN-<kind>-<lead>.html` (+`.txt`) and `./outbox/summary.json`, with fields `{scenario, timeline[], emails[], leads[], weeklyReport, checks[], ok}`. The script exits non-zero if any check fails. CI runs it at every milestone, with the checks that milestone has enabled (D-50).

---

## 14. Environment variables

Every variable is listed in `.env.example` with a one-line comment. `env.ts` requires, in live mode, **every variable without a documented default**, well-formed (key prefixes, `rzp_live_` in production, 32-byte keys, current ≠ previous, no fake values). `QSTASH_DEV` must be unset in live mode. Fake mode uses the documented fake values and is refused on Vercel unless allowed.

| Group | Variables |
|---|---|
| App | `APP_MODE` (required: `fake`\|`live`), `ALLOW_FAKE_ON_VERCEL`, `APP_URL`, `PRODUCT_NAME`, `APP_SECRET` (HKDF root), `TOKEN_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY_PREVIOUS`, `ADMIN_EMAILS`, `ENV_NAMESPACE`, `COMPOSE_URL_LIMIT`, `COMPOSE_GMAIL_FORM`, `COMPOSE_OUTLOOK_MODE`, `COMPOSE_OUTLOOK_WORK_BASE`, `COMPOSE_OUTLOOK_PERSONAL_BASE`, `MAX_DRAFTED_LEADS_PER_DAY`, `AI_DAILY_BUDGET_USD`, `FAKE_DB_DIR` |
| Database / auth | `DATABASE_URL` (transaction pooler :6543), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (all server-only) |
| HubSpot | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_CLIENT_SECRET_PREVIOUS`, `HUBSPOT_APP_ID`, `HUBSPOT_REDIRECT_URI`, `HUBSPOT_WEBHOOK_TARGET_URL`, `HUBSPOT_API_VERSION`, `HUBSPOT_JOURNAL_ENABLED` |
| QStash / cron | `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_MAX_DELAY_SECONDS`, `CRON_SECRET` |
| Email | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` (magic-link and billing emails only) |
| AI | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_DRAFT`, `ANTHROPIC_MODEL_FAST`, `ANTHROPIC_DRAFT_THINKING`, `ANTHROPIC_DRAFT_EFFORT`, `ANTHROPIC_DRAFT_MAX_TOKENS`, `ANTHROPIC_BRIEF_EFFORT` |
| Billing | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`, `RAZORPAY_PLAN_ID` |
| Sentry | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` (build only) |

**Documented defaults:**

| Variable | Default |
|---|---|
| `PRODUCT_NAME` | `Hublytix Autopilot` (also exposed as `NEXT_PUBLIC_PRODUCT_NAME` by `next.config.ts`; there is no separate variable) |
| `ANTHROPIC_MODEL_DRAFT` | `claude-sonnet-5-5` |
| `ANTHROPIC_MODEL_FAST` | `claude-haiku-4-5-20251001` |
| `ANTHROPIC_DRAFT_THINKING` | `between_tools` |
| `ANTHROPIC_DRAFT_EFFORT` | `medium` |
| `ANTHROPIC_DRAFT_MAX_TOKENS` | `1024` |
| `ANTHROPIC_BRIEF_EFFORT` | `high` |
| `HUBSPOT_API_VERSION` | `2026-09` |
| `HUBSPOT_JOURNAL_ENABLED` | `false` |
| `QSTASH_MAX_DELAY_SECONDS` | `601200` |
| `COMPOSE_URL_LIMIT` | `1800` |
| `COMPOSE_GMAIL_FORM` | `u` (`…/mail/u/{n}/?…&tf=cm`; alternative `view`) |
| `COMPOSE_OUTLOOK_MODE` | `mailtouri` (alternative `params`) |
| `COMPOSE_OUTLOOK_WORK_BASE` | `https://outlook.cloud.microsoft/mail/deeplink/compose` |
| `COMPOSE_OUTLOOK_PERSONAL_BASE` | `https://outlook.live.com/mail/deeplink/compose` |
| `MAX_DRAFTED_LEADS_PER_DAY` | `50` |
| `AI_DAILY_BUDGET_USD` | `25` |
| `FAKE_DB_DIR` | `.data/pglite` |

Optional with no default: the `*_PREVIOUS` rotation variables, `ALLOW_FAKE_ON_VERCEL`, `NEXT_PUBLIC_SENTRY_DSN`/`SENTRY_DSN` (Sentry is a no-op without them) and the Sentry build variables.

---

## 15. Milestones (D-50)

Every milestone ends with:
1. `npm run typecheck` (`next typegen && tsc --noEmit`)
2. `npm run lint`
3. `npm test`
4. `APP_MODE=fake npm run build` + smoke (`/api/health`, `/`, `/login` return 200)
5. `npm run simulate` with that milestone's checks
6. One commit (specific paths only)
7. A 5-line summary

### M1: scaffold, CI, migrations, PGlite harness, fakes, CLAUDE.md
- [ ] Next 16 app (`src/` layout) with `global-error.tsx`, **placeholder `/` and `/login` pages** and `GET /api/health` (`{ok, mode}`); TypeScript strict; Tailwind 4; ESLint 9 with boundary, time-API and `URLSearchParams`-in-compose rules; Vitest with the `server-only` stub; `tsconfig.scripts.json`; `.gitignore` (`.env*`, `!.env.example`, `.data/`, `outbox/`, `.next/`, `coverage/`); `.nvmrc`
- [ ] Scripts `dev`, `build`, `start`, `typecheck`, `lint`, `test`, `simulate`; `.github/workflows/ci.yml` (all gates, Node 22, plus the client-bundle secret grep)
- [ ] `env.ts` with fake/live rules, documented defaults and refusals; `.env.example` (complete); `next.config.ts` deriving `NEXT_PUBLIC_PRODUCT_NAME`
- [ ] `supabase/migrations/20261001000001_init.sql` (every table in §5: RLS, grants, default-privilege revoke, indexes); `supabase/config.toml`; `fake-shim.sql` (roles, `auth` stub, `fake` schema); `migrate.ts` with the `fake._migrations` ledger; the migration test
- [ ] `Db` (Postgres.js serialised + PGlite; tx guard; driver normaliser; `DbError`); harness (dump and truncate)
- [ ] `Clock` + fakes skeleton: every port has a fake with unit tests (FakeLLM without the parameter assertion yet). `FakeScheduler` takes an injected dispatch callback
- [ ] `security/crypto.ts` (kid, AAD, rotation) and HKDF keys; logger + shared `redact()`; Sentry files + shared options + scrubber and envelope tests; file-layout test
- [ ] `CLAUDE.md` containing: the brief §0.2 git rules verbatim (stage specific paths only; never `git add -A` or `git add .`; never force-push; never commit secrets, only `.env.example`); the five product laws; the module boundary rules; the `$now`/`Clock` rule (D-28); the milestone gate commands. `README.md` and `docs/ARCHITECTURE.md` skeletons
- [ ] Simulation stage 1: boots the fakes and writes `summary.json` (no checks yet)

### M2: HubSpot OAuth, connection management, webhook intake, poller, classification
- [ ] `hubspot-app/` files, the `REQUIRED_SCOPES` constant + diff test; live `HubSpotHttpClient` (dated paths, Zod, request allow-list, per-portal limiter, error mapping, metadata allow-list)
- [ ] Domain: `computeProcessingState` + `applyProcessingState` (with `paused_at`), `entitled` (trial plus subscription statuses), `classifyRefreshFailure`, the HubSpot v3 signature check (with vectors)
- [ ] `/api/hubspot/install`, the callback (branches a–d), `pending_install`, `portal_history`
- [ ] Token manager (lease, compare-and-set, revoke path, transient path, 401 rule) + `renderEmail` + the ReconnectHubSpot template + Mailer (live Resend: Reply-To, idempotency, 409 handling, transient mapping) + `reserveAndSend` with the per-kind predicate table (§8.4)
- [ ] Jobs core: outbox publish, hop, claim/lease, re-publish with `hops`, sweeper, `/api/jobs/run`, `/api/jobs/failed` (compare-and-set), QStash scheduler adapter (retries 4, backoff header) + signature tests
- [ ] Webhook route (dedupe, `appId`, debounced double poll, privacy deletion → `privacy_delete` job) and the `privacy_delete` handler (D-06) + test
- [ ] Poll cron (global lease, `applyProcessingState`, `pollPortal` with per-account lease, floors, 60-minute overlap, test-address skip, cursors with `GREATEST`, transactional inserts, `intake_trigger`) + cron auth
- [ ] Classification (Haiku params, `toClaudeJsonSchema`, lowercase enums, failure → `unclear`, `ai_calls`) + live `AnthropicLLM`; FakeLLM parameter assertion
- [ ] Simulation seed helper that creates an active account directly (forms selected, floors, `onboarding_completed_at`); M3 replaces it with the real onboarding
- [ ] Simulation stage 2: 6 leads (#5 via `cron`), 2 filtered, no historical leads

### M3: brief builder, onboarding, inbox check, baseline
- [ ] `HttpWebFetcher` with the SSRF guard, robots parser, page selection and ranking, per-page timeout, parallel crawl, nav/script/hidden-DOM stripping (tests on `test/fixtures/site`); `brief_generate` job with the LLM timeout and fallback; brief editor and versions; booking-link rules
- [ ] Auth: `AuthProvider` (Supabase admin `createUser`/`generateLink` + own mailer; `refreshSession`; fake), `login_intents`, `/login` (latency floor, limits), `/auth/confirm` (fragment, POST, `type`, intent, bind, `next`, rate limit), `/onboarding/email`, admin login, `requireOwner`/`OwnerScope`, `src/proxy.ts` (scope, CSP builder dev/prod, refresh + tests), the MagicLink template
- [ ] Action tokens (random, hashed, purpose, expiry, revocation, committed before send); compose builders + golden vectors; `/a/[token]/send` (click heuristic, 302 / interstitial / copy), `/a/[token]/copy` and `/a/[token]/verify-notify`; InboxTest and VerifyNotify templates
- [ ] Onboarding pages (forms with newsletter detection and floors; preferences with notify verification; change alerts only after onboarding)
- [ ] Inbox check (history, test contact handling, `inbox_check` job and its 60-second cadence, two legs, continue or skip, `logging_mode`, fix-step copy, `is_test` exclusions)
- [ ] Baseline job (in-memory classification, cap 500, sufficiency rules); the onboarding-complete gate → `active`
- [ ] Simulation stage 3: the real pre-run replaces the seed helper (foreground ≤ 5 min, fresh-cookie-jar bind, exactly 2 pre-run emails, floors at 09:04:30, baseline 3 h 30 m and 20%, `log_all`)

### M4: draft engine, validator, notification emails, action-link pages
- [ ] Draft and follow-up prompts (untrusted delimiters); validator with ≥40 golden cases; retry; needs-touch template and fallback (fatal, final delivery, failure callback); daily cap after classification + deferred + `lead_cap` email; AI budget breaker
- [ ] `lead_process` end to end with reservation, random tokens, safe subject, defanged message, the secondary mailto link, Reply-To = owner
- [ ] Templates: NewLead, NeedsTouch, FollowUp, ReplyDetected (WeeklyReport stub, BillingInactive stub)
- [ ] `/a/[token]/edit` (200 result page) and `/a/[token]/dismiss` (confirm + POST)
- [ ] `shiftToAllowed` + timezone tests; follow-up job rows created in the "notified" transaction; `deriveLeadStatus` (D-32) + table tests
- [ ] Simulation stage 4: `new_lead` ×4 at Day 0; all three action links work; clicks recorded

### M5: follow-up scheduler, reply detection, stop rules
- [ ] Follow-up job: hop or re-target, stops (including the dynamic supersede), contact read (paging, chunking, 404, merge, opt-out, bounce), `applySignals`/`markReplied` (`AND NOT is_test`), follow-up drafts with honest notes
- [ ] Dismiss, pause, revoke and disconnect cancellations; override (`process_rev`); Resume follow-ups (`replied_at` cleared, `followup_stream`, `replies_ignored_before`)
- [ ] Tests: stop matrix, signals, crash/redelivery, dismiss during drafting, out-of-office → resume → real reply
- [ ] Simulation stage 5: Day 2 ×4, Day 5 ×3 + `reply_detected`, statuses after each step

### M6: Monday report and dashboard
- [ ] Due-check + `weekly_report` job + sweeper re-enqueue + `computeWeeklyMetrics` (cohort/event definitions, comparison population, honesty rules, baseline comparison) + WeeklyReport template
- [ ] Dashboard (status card, banners, recent leads, lead detail with override, resume and refresh), brief editor page; views on `OwnerScope`; cross-tenant tests begin
- [ ] Simulation stage 6: Monday report metrics JSON exact

### M7: billing, trial, settings, disconnect/purge, admin
- [ ] Live `RazorpayBilling` (fetch); checkout (lock, guard, reuse, stale-`created` resolution, `start_at`/`expire_by`); resume; cancel branches; webhook (verify, window, dedupe, fetch-and-apply-if-newer, tombstone fetch and cancel); billing-tombstone reconcile in the daily cron; second-subscription safety net; billing page; BillingInactive email on transition
- [ ] Settings page (all §5.11 items), pause/resume, disconnect (best effort + billing choice or explanation)
- [ ] Daily cron → `account_daily` (introspect probe, account details, reconcile, re-encrypt, orphan and purge with the subscription guard, tombstones); retention (hourly guard)
- [ ] `/admin` (allow-list, audit of views); rate limits on all public action and auth routes; header tests
- [ ] Simulation stage 7: fake checkout → active; inactive → no processing and one email (separate scenario variant)

### M8: public pages, simulation polish, docs, REVIEW
- [ ] Landing, `/privacy` (sub-processors linked, day counts only for stores we control, the HubSpot disclosures), `/terms`, `/refunds`, `/shipping` (all `TODO: legal review`)
- [ ] Simulation final: the full §13 check set, run under the 2030 system time; `/dev` panel complete; fake-mode end-to-end smoke test
- [ ] `docs/ARCHITECTURE.md`, `README.md`, `docs/WIRE_UP.md` (the brief's 9 steps, click by click, with the §17 live checks and a rotation runbook), `.env.example`, `CLAUDE.md` final
- [ ] `scripts/check-finding-ids.ts`: every finding ID cited in PLAN and DECISIONS resolves to a RESEARCH section
- [ ] REVIEW: Definition of Done (§18), PASS/PARTIAL/FAIL per line

---

## 16. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | `sales-email-read` can't be granted for a marketplace app (evidence is community-level) | D-03: the expected fallback is path (b), dropping the scope and showing "Not enough data" for email-based features; fake 403 variant; §17 #1 is the first WIRE_UP smoke test |
| R2 | Reply detection depends on how the owner logs email | Two-leg check; `logging_mode`; honest notes and report wording; owner reviews every send; "Resume follow-ups" after an out-of-office |
| R3 | The legacy submissions endpoint (v1) is in HubSpot's September 2027 sunset | `LeadSource` boundary; the search trigger is a documented fallback; watch the changelog |
| R4 | 25-install cap until listed | Built to listing rules; listing work tracked outside v1 (D-43) |
| R5 | Gmail and Outlook compose URLs are undocumented; automatic `mailto:` open may be blocked | Env-switchable forms and bases; mailto link and copy page always available; §17 #5 |
| R6 | Vercel Hobby crons (unverified) | Pro, or QStash schedules (D-16) |
| R7 | QStash Free limits (7-day delay; quota unverified) | Hop, sweeper; Pay-as-you-go recommended; quota errors alert; §17 #7 |
| R8 | Haiku 4.5 retirement | Env swap (D-25) |
| R9 | Next 16 deviates from the brief | Sign-off; 14.x fallback documented (D-01) |
| R10 | Link scanners | Click heuristic; dismiss needs a POST; clicks never confirmed (D-26) |
| R11 | LLM quality, injection, cost | Validator with injection codes; owner review; caps and budget breaker; effort sweep at wire-up |
| R12 | Razorpay USD activation and policy-page review | Pages exist; legal text before activation |
| R13 | Database version and driver skew (PGlite 18 vs Supabase 15/17; type differences) | Conservative SQL; driver normaliser; `db push --dry-run` |
| R14 | Transaction-pooler pipelining | Serialised queries; no transactions across I/O; compare-and-set only (D-28) |
| R15 | Race and lock semantics can't be exercised on PGlite | Compare-and-set and lease design proven by sequential replay tests; documented limitation |
| R16 | `account-info` may enforce `external-settings-access` | Owner timezone fallback; §17 #3 |
| R17 | Content retention at Resend and Anthropic is unverified | §17 #10; choose ≤30 days or record a deviation (D-49); `/privacy` gives no day counts for them until then |
| R18 | AI cost per lead and per baseline (up to 500 fast-model calls) | About $0.03 per lead estimated; `ai_calls` measures it; caps and the budget breaker |
| R19 | Many facts couldn't be fetched from vendor sites in the sandbox | §17 live checks; RESEARCH marks every such claim |
| R20 | An owner never finishes signing up | Unbound reinstall restarts onboarding (branch b); the 7-day orphan uninstall, which HubSpot announces to the portal's admins |

---

## 17. Live checks during WIRE_UP (from RESEARCH)

1. **Email scope:** `sales-email-read` is accepted at upload and install, and `GET /crm/objects/2026-09/emails?limit=1&properties=hs_timestamp,hs_email_direction` returns 200 with `hs_email_direction` non-null.
2. **Submissions endpoint:** page size, order and the `forms` scope on a Free and a Starter portal; whether `captured` forms work.
3. **Account info:** `account-info/2026-09/details` works with the `oauth` scope.
4. **Logging setup:** where the BCC address lives and how it behaves; connected-inbox "Log all"; both inbox-check legs, on Free and on Starter.
5. **Compose links:**
   - Gmail on both forms, with BCC, on the `/u/{email}/` path, signed in and signed out (including "Edit first");
   - Outlook work and personal, with BCC, using `mailtouri`;
   - the interstitial's automatic open on iOS Safari, the Gmail and Outlook in-app browsers, and Android Chrome (one tap or two).
6. **Vercel:** cron plan limits; whether Deployment Protection blocks QStash.
7. **QStash plan:** maximum delay, a retry cap of at least 4, and the daily quota.
8. **Razorpay:**
   - a USD plan and International Cards;
   - Flash Checkout;
   - retrying a `created` subscription, and fetching an expired one;
   - cancelling `authenticated` vs `active`;
   - Resume.
9. **HubSpot webhooks:** settings can take up to 5 minutes to apply before the live test; an install attempt by a non-admin user.
10. **Retention:** Resend's and Anthropic's content retention, and the Supabase backup window. Record the results in DECISIONS (D-49).
11. **Magic link:** fresh address → onboarding → magic link → session; confirm on a second device.
12. **AI:** one live request per schema (no "schema too complex"); the effort sweep on golden cases; Haiku deprecation status.
13. **Refresh errors:** uninstall the test app, call `POST /oauth/2026-09/token` with the old refresh token and record the body (expect 400 `invalid_grant`/`BAD_REFRESH_TOKEN`); run introspect on the revoked token.
14. **Opt-out and bounce properties:** opt a test contact out of one-to-one email and hard-bounce another; read `hs_email_optout`, `hs_email_hard_bounce_reason_enum` and `hs_email_bad_address`.

---

## 18. Definition of Done (brief §12)

REVIEW reports each line as **PASS**, **PARTIAL** (when the evidence is community-level or knowledge-base-level and the line depends on a §17 live check) or **FAIL**. This extends the brief's "pass/fail per line" (§1.1 row 21).

| DoD line | Proof |
|---|---|
| `npm run simulate` produces all expected emails with correct statuses in `summary.json` | §13 checks (non-zero exit on failure), also under the 2030 system time; `test/simulate.test.ts` in CI |
| Typecheck, lint and tests green | CI and every milestone gate |
| No secrets, tokens or message text in logs or Sentry payloads; a test proves the scrubber | `scrubber.test.ts`, `sentry-envelope.test.ts` (DB error, Server Action, AI error fixtures), `logger.test.ts`, client-bundle grep |
| Every [VERIFY] item resolved in RESEARCH.md with a source link | RESEARCH §0 index. Rows whose sources are only community or knowledge-base level report **PARTIAL** with their §17 check number |
| `WIRE_UP.md` complete for someone who has never seen the code | M8: the brief's 9 steps in order, with exact clicks and commands, a smoke test, a screenshot checklist and a rotation runbook |
| RLS enabled on every table, asserted by a migration test | `test/db/migrations.test.ts` (RLS, grants, functions) |
