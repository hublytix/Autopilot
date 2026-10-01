# Hublytix Autopilot — Build Brief for Claude Code (v1)

Follow this brief exactly. It is the complete specification for a new, standalone product.

---

## 0. How you work on this repo (non-negotiable)

1. **Phases:** RESEARCH → PLAN → **STOP for approval** → EXECUTE (milestones M1–M8) → REVIEW.
   - **RESEARCH:** verify every item marked **[VERIFY]** against official documentation. Write findings with source URLs to `docs/RESEARCH.md`. Where the docs contradict this brief, the docs win; record the change in `docs/DECISIONS.md`.
   - **PLAN:** write `docs/PLAN.md` (schema, routes, jobs, module boundaries, milestone checklist, risks). Then stop and wait. I approve with a single word: `approve`.
   - **EXECUTE:** work through the milestones in order without stopping unless genuinely blocked. Each milestone ends with typecheck, lint and tests green, then one commit, then a 5-line summary.
   - **REVIEW:** run the Definition of Done (section 12) and report pass/fail per line.
2. **Git rules:** stage specific paths only. Never `git add -A`, never `git add .`, never force-push. Never commit secrets; only `.env.example`.
3. **You are in a cloud sandbox with no access to my accounts** (HubSpot, Supabase, Vercel, Upstash, Resend, Anthropic, Razorpay, Sentry). Do not create accounts or call live services. Every external dependency sits behind an interface with a fake implementation, so the whole product runs and is tested with zero credentials. I wire up real services later using `docs/WIRE_UP.md`.
4. **This is a separate product:** new repo, new database, new HubSpot app. Do not import code from any existing Hublytix repo.
5. **Decide, don't ask.** Where this brief is silent, pick the simplest option that satisfies it and log the choice in `docs/DECISIONS.md`.

---

## 1. The product

**One line:** Hublytix Autopilot answers and follows up every new lead automatically for HubSpot Starter users — the follow-up HubSpot only offers on Professional — for $49 a month.

**Who it's for:** owners of small businesses (2–50 people) on HubSpot Free or Starter, usually working from their phone. They have no workflows or sequences (those are Professional-only).

**Core loop:**
1. A lead fills a HubSpot form.
2. Within about a minute, the owner gets an email with an AI-drafted, personalised reply.
3. One tap opens their own mail app, pre-filled. They hit send.
4. On day 2 and day 5, Autopilot drafts follow-ups unless HubSpot shows the lead replied.
5. Every Monday, the owner gets a short report.

**Display name:** read from env `PRODUCT_NAME` (default `Hublytix Autopilot`). The marketplace name is undecided.

---

## 2. Product laws (apply to code, UI copy and emails)

1. **Never send email on the owner's behalf in v1.** Autopilot only prepares drafts; the owner sends from their own mail app via a pre-filled compose link. No Gmail or Outlook API scopes.
2. **HubSpot access is read-only.** No write scopes in v1.
3. **Never overstate.** A send or a reply counts only when it is confirmed in HubSpot data. Clicked-but-unconfirmed sends are shown separately and never merged with confirmed ones. If data is missing, say "not enough data"; never estimate.
4. **Data minimisation.** Store HubSpot IDs, timestamps and statuses. The only content stored is the lead's form message and the drafts, and both are purged after 30 days. Never log tokens, message text or drafts; scrub them from logs and Sentry.
5. **Honest copy.** No testimonials, user counts or claims that aren't true. Legal pages are placeholders marked `TODO: legal review`.

---

## 3. Stack

- **Framework:** Next.js 14 (App Router), TypeScript `strict`, Tailwind. Mobile-first UI.
- **Database:** Supabase Postgres. SQL migrations in `supabase/migrations/`. RLS enabled on every table. Service-role key used only on the server. Supabase Auth email magic link for dashboard login.
- **Jobs:** Upstash QStash for delayed jobs (follow-ups). Vercel Cron for periodic jobs: lead poller every 5 minutes, Monday-report due-check hourly, retention purge daily.
- **Email:** Resend with React Email templates.
- **AI:** Anthropic TypeScript SDK (`@anthropic-ai/sdk`). Model IDs from env:
  - `ANTHROPIC_MODEL_DRAFT` (default `claude-sonnet-5-5`)
  - `ANTHROPIC_MODEL_FAST` (default `claude-haiku-4-5-20251001`)
  - **[VERIFY]** current model IDs and the recommended structured-output approach at docs.claude.com.
- **Billing:** Razorpay Subscriptions (hosted checkout). Plan ID from env `RAZORPAY_PLAN_ID`.
- **Monitoring:** Sentry. `instrumentation.ts` MUST live in `src/`; at the repo root it silently never initialises.
- **Validation and tests:** Zod for every external payload. Vitest for tests. PGlite (`@electric-sql/pglite`) so database tests run without Docker or credentials.

---

## 4. User journey (acceptance level)

1. **Install:** landing page → "Install with HubSpot" → HubSpot OAuth consent (read-only) → account created, 14-day trial starts (no card).
2. **Onboarding (target: under 5 minutes):**
   1. Owner email and magic-link login.
   2. Website URL → business brief generated (5.3) → owner edits and saves.
   3. Choose which HubSpot forms count as leads. The list is fetched from HubSpot; newsletter-style forms are unticked by default where detectable.
   4. Choose mail client (Gmail / Outlook / Other), notify email(s), and quiet hours with a weekends toggle. Portal timezone is auto-detected.
   5. Inbox-logging check (5.7).
   6. Baseline from the last 30 days (5.8).
3. **A lead arrives:** draft, then an owner email with three actions (5.5).
4. **Follow-ups:** day 2 and day 5, stopping on a confirmed reply (5.6).
5. **Monday report:** 08:00 in the owner's timezone (5.9).
6. **Day 15:** trial ends → checkout → $49/month. The owner can pause, edit the brief, cancel or disconnect at any time.

---

## 5. Functional spec

### 5.1 HubSpot connection
- OAuth 2.0 install flow with the minimum scopes **[VERIFY]**: `oauth`, `crm.objects.contacts.read`, `forms`.
- Store portal ID, hub domain and timezone **[VERIFY endpoint and scope for account timezone]**.
- Encrypt tokens at rest with AES-256-GCM (key in `TOKEN_ENCRYPTION_KEY`).
- **Refresh handling (learned the hard way):** distinguish a revoked or invalid refresh token (e.g. `BAD_REFRESH_TOKEN` / `invalid_grant`, **[VERIFY exact error shapes]**) from transient failures (429, 5xx, timeouts).
  - **Revoked:** set the connection to `revoked`, cancel that portal's scheduled jobs, show a "Reconnect HubSpot" banner and email the owner once. Never keep retrying a revoked token.
  - **Transient:** exponential backoff (max 5 attempts), then a Sentry alert; the connection stays active.
- **Uninstall or disconnect:** stop all processing immediately and purge the portal's data after 30 days **[VERIFY whether HubSpot notifies apps of uninstall]**.

### 5.2 Lead intake
- **Webhook:** `POST /api/hubspot/webhooks`.
  - Verify the HubSpot v3 signature and reject requests older than 5 minutes **[VERIFY algorithm]**.
  - Be idempotent on `eventId`. Respond 200 fast and process asynchronously.
  - Handle `contact.creation`: fetch the contact and decide whether it came from a selected form **[VERIFY which properties or Forms API data identify the submitting form]**.
- **Poller (every 5 minutes per active portal):**
  - Repeat submissions by existing contacts don't trigger `contact.creation`, and conversion-date properties are calculated, so they can't be webhook-subscribed.
  - Search contacts whose `recent_conversion_date` is newer than the portal's cursor **[VERIFY search support]**.
  - Deduplicate on (contact ID, submission timestamp).
- **Message extraction:** get the lead's message and name fields from the form submission **[VERIFY Forms submissions endpoint and scope]**. Fall back to mapped contact properties.
- **Classification (fast model):** `lead | spam | vendor_pitch | job_seeker | support_request | unclear`.
  - Only `lead` and `unclear` get drafts.
  - Everything else is logged and shown as "filtered" in the dashboard; the owner can override.

### 5.3 Business brief
- Fetch the homepage plus up to 8 internal pages, preferring services, pricing, about, contact and FAQ pages. Respect robots.txt. 10-second timeout per page. Strip navigation and scripts.
- The draft model returns JSON:
  - `company_name`, `one_line`, `services[]`, `who_we_serve`
  - `booking_link`
  - `tone` (`friendly | formal | direct`, plus a free-text note)
  - `sign_off_name`
  - `allow_pricing` (default `false`)
  - `never_promise[]`
  - `faqs[]` (8 or fewer)
- The owner edits it in a form. Keep `brief_versions` history.
- If no booking link is found, require the owner to add one or explicitly choose "no booking link".

### 5.4 Draft engine
- **Inputs:** the brief plus the lead's first name, company, message and form name. No other CRM data in v1.
- **Output JSON:** `subject`, `body`, `used_booking_link`, `flags[]`.
- **Deterministic validator** (unit-tested with golden cases):
  - Body is 120 words or fewer (follow-ups: 70 or fewer).
  - Plain text with no unfilled placeholders like `[Name]`.
  - Uses the first name when known.
  - Includes the booking link when one exists.
  - No currency amounts unless `allow_pricing` is true.
  - Nothing from `never_promise`.
- **On validation failure:** retry once with the validator errors fed back. If it still fails, send a "needs your touch" email with a minimal safe template.
- Record token counts per draft for cost tracking, with no content.

### 5.5 Owner notification and action links
- **Email subject:** `New lead: {Name} — your reply is ready`.
- **Email body:** lead name, company and email; their message quoted; the draft; three buttons.
- **[Send from my email]** → `/a/{token}/send`, which records the click.
  - It then redirects (302) to a compose URL for the owner's client: Gmail web, Outlook web, or `mailto:` **[VERIFY current URL formats]**.
  - Always show a secondary "Open in default mail app" (`mailto:`) link.
  - If the encoded URL exceeds about 1,800 characters, fall back to a "copy reply" page.
- **BCC logging (optional):** if the owner saved their HubSpot BCC logging address during onboarding, add it as BCC on every compose link. The send then gets logged even without a connected inbox **[VERIFY BCC logging availability on Free and Starter]**.
- **[Edit first]** → `/a/{token}/edit`: a mobile page with editable subject and body, then the same send buttons. No login needed.
- **[Not a real lead]** → `/a/{token}/dismiss`: marks the lead dismissed and cancels its follow-ups.
- **Action tokens:** 32 random bytes, stored hashed, scoped to a single lead and a single purpose, expiring after 7 days.

### 5.6 Follow-ups and reply detection
- **Scheduling:** after the first notification, enqueue QStash jobs at +2 days and +5 days.
  - Shift each job to the next allowed hour outside quiet hours and weekends.
  - Dedupe IDs: `lead:{id}:fu:{n}`.
  - Verify the QStash signature on callbacks **[VERIFY]**.
- **When a job fires,** re-read the contact in HubSpot. Use the reply signal identified in RESEARCH (e.g. a last-replied timestamp newer than the first notification).
  - **Reply confirmed:** mark the lead `replied`, cancel the remaining job, and email the owner "{Name} replied — follow-ups stopped".
  - **No confirmed reply:** generate a shorter follow-up draft that references the original, and send the same three-button email.
- **Hard stops:**
  - maximum 2 follow-ups;
  - lead dismissed;
  - account paused;
  - trial expired or subscription inactive;
  - connection revoked;
  - contact deleted or opted out of email **[VERIFY property]**.

### 5.7 Inbox-logging check (onboarding)
- Explain in one sentence why it matters: replies can only be detected if the owner's email is logged in HubSpot.
- Detect, read-only, whether logged one-to-one emails exist in the portal's last 30 days **[VERIFY a read-only signal]**.
- Then run a live test:
  1. The owner sends a test reply to a test lead (their own other address) via the one-tap flow.
  2. Poll for up to 10 minutes for the logged activity.
  3. Show ✓ or ✗, with fix steps on failure.

### 5.8 Baseline at install
- From the last 30 days:
  - leads from the selected forms;
  - median time from submission to first logged outbound email;
  - leads with no logged outbound email.
- If logged history is insufficient, show "Not enough logged history". Never estimate.

### 5.9 Monday report
- An hourly cron sends the report to portals where it is Monday 08:00 local time.
- The report covers the last 7 days:
  - leads in, filtered leads (spam etc.) and drafts delivered;
  - sends confirmed in HubSpot, and clicked-but-unconfirmed sends, on separate lines;
  - median time from lead to confirmed first reply;
  - leads with no confirmed reply, with HubSpot record links;
  - replies confirmed and follow-ups drafted;
  - comparison with the baseline.

### 5.10 Billing
- **Trial:** 14 days from install, no card.
- **When processing runs:** while `trialing`, or while the subscription is `active` (plus a 3-day grace period on payment failure).
- **Checkout:** Razorpay hosted checkout for `RAZORPAY_PLAN_ID`.
- **Webhook:** `POST /api/razorpay/webhook` verifies the signature **[VERIFY]** and maps subscription statuses.
- **Checkout guard:** block a new checkout only when the status is `active` or `halted`. Never block on `created`; that permanently locks out users whose card was declined.
- **When inactive:** pause processing, show a banner and send one email.

### 5.11 Dashboard and settings (mobile-first)
- **Status:** trial days left, active, paused or revoked.
- **Recent leads**, each with one status: filtered, drafted, send clicked, send confirmed, replied, no reply, or dismissed.
- **Brief** editor.
- **Settings:**
  - notify emails (1–3);
  - mail client;
  - forms;
  - quiet hours and weekends;
  - follow-ups on/off;
  - pause all;
  - BCC address;
  - billing;
  - disconnect HubSpot.

### 5.12 Admin
- `/admin`, restricted to `ADMIN_EMAILS`.
- Shows portals and statuses, last webhook received, failed jobs and error counts. No message content.

### 5.13 Public pages
- `/` landing page:
  - the one-liner;
  - three-step "how it works";
  - "$49/month after a 14-day free trial";
  - Install button.
- `/privacy` and `/terms`: placeholders marked `TODO: legal review`. List the sub-processors: Anthropic, Supabase, Vercel, Upstash, Resend, Razorpay, Sentry.

### 5.14 Retention job (daily)
- Purge lead message text and drafts older than 30 days.
- Purge all data for portals disconnected more than 30 days ago.

---

## 6. Data model (finalise in PLAN)

Tables:
- `accounts`, `users`, `settings`
- `hubspot_connections` (encrypted tokens, status)
- `briefs`, `brief_versions`, `selected_forms`
- `leads` (status plus timeline timestamps)
- `lead_messages` (`purge_at`)
- `drafts` (kind: initial / fu1 / fu2; validation result; `purge_at`)
- `action_tokens` (hash, purpose, `expires_at`)
- `scheduled_jobs`
- `notifications_sent` (no bodies)
- `weekly_reports`, `subscriptions`
- `webhook_events` (`eventId` unique)
- `audit_log` (no content)

RLS is enabled on every table.

---

## 7. Security checklist

- Webhook signatures verified (HubSpot, QStash, Razorpay) and timestamps checked.
- AES-256-GCM token encryption.
- Hashed, single-purpose action tokens.
- Zod validation on every input.
- Rate limits on public action and auth routes.
- CSP and security headers.
- Sentry `beforeSend` scrubbing.
- No secrets in client bundles.

---

## 8. Fakes, simulation and tests

**Fakes.** These interfaces each have a fake implementation:
- `HubSpotClient`
- `LLM`
- `Mailer`
- `Scheduler` (time-travel capable)
- `Billing`
- `WebFetcher`

`APP_MODE=fake|live` switches between fakes and real services.

**Simulation.** `npm run simulate` runs a scripted scenario end to end on fakes:
- A portal with 3 forms, one of them a newsletter form.
- 6 submissions:
  - a normal lead;
  - a lead with no message;
  - spam;
  - a vendor pitch;
  - a repeat submission by an existing contact;
  - a lead who replies on day 3.
- Time-travel through day 0, day 2, day 5 and Monday.
- Write every rendered email to `./outbox/*.html` and `./outbox/summary.json`, so I can review the whole product without credentials.

**Tests:**
- validator golden cases;
- signature verification with known vectors;
- token refresh: revoked vs transient;
- follow-up stop rules;
- quiet-hours scheduling across timezones;
- checkout guard;
- retention purge;
- idempotent webhook replay.

`npm run typecheck`, `npm run lint` and `npm test` must pass at the end of every milestone.

---

## 9. Milestones

- **M1:** scaffold, CI scripts, migrations, PGlite test harness, fakes, `CLAUDE.md`.
- **M2:** HubSpot OAuth, connection management with refresh/revocation, webhook intake, poller, classification.
- **M3:** brief builder, onboarding flow, inbox-logging check, baseline.
- **M4:** draft engine, validator, notification emails, action-link pages.
- **M5:** follow-up scheduler, reply detection, stop rules.
- **M6:** Monday report and dashboard.
- **M7:** billing, trial, settings, disconnect/purge, admin.
- **M8:** landing and legal placeholders, `simulate` polish, all docs, REVIEW.

---

## 10. Deliverables

- `README.md`
- `.env.example` (every variable, each with a one-line comment)
- `CLAUDE.md` (rules for future sessions, including the git rules above)
- `docs/RESEARCH.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`
- `docs/WIRE_UP.md`: exact click-by-click steps, in this order:
  1. Create the HubSpot public app (scopes, redirect URL, webhook URL and subscriptions).
  2. Create the Supabase project and run the migrations **before** deploying code that uses them.
  3. Create the Vercel project, set environment variables and crons.
  4. Set up QStash keys and the callback URL.
  5. Verify the Resend sending domain (suggest `autopilot.hublytix.ai`) and its DNS records.
  6. Add the Anthropic API key.
  7. Create the Razorpay plan and webhook. The key ID and key secret must come from the same key generation, or checkout fails silently.
  8. Add the Sentry DSN.
  9. Run the post-deploy smoke test and screenshot checklist.

---

## 11. Out of scope for v1

- Auto-sending through the Gmail or Outlook APIs.
- WhatsApp or SMS.
- Chat leads (conversation webhooks).
- Any HubSpot write scope.
- Multi-user teams.
- Marketplace listing assets.
- Analytics or tracking pixels.

---

## 12. Definition of Done

- `npm run simulate` produces all expected emails, with correct statuses in `summary.json`.
- Typecheck, lint and tests are green.
- No secrets, tokens or message text appear in logs or Sentry payloads; a test proves the scrubber.
- Every **[VERIFY]** item is resolved in `docs/RESEARCH.md` with a source link.
- `docs/WIRE_UP.md` is complete enough for someone who has never seen the code.
- RLS is enabled on every table; a migration test asserts it.
