-- Hublytix Autopilot: initial schema (PLAN §5; D-21, D-28, D-30).
--
-- Rules for every table in `public`:
--   * row level security on, all privileges revoked from anon and authenticated, CRUD granted to
--     service_role, and no policies (the app reaches the database only from the server, D-21);
--   * ids are uuid default gen_random_uuid(), except the log tables (webhook_events, audit_log,
--     ai_calls), which use bigint identity columns (no sequence grants needed);
--   * HubSpot ids are text; hashes are lowercase hex text (no bytea); statuses are text + check;
--   * every logical timestamp is bound from the app Clock as $now and has NO default. The only
--     `default now()` columns are the audit-only audit_log.at and webhook_events.received_at, which
--     are the SQL-scan allow-list in test/db/migrations.test.ts (D-28);
--   * account-scoped tables cascade from accounts; the tombstones (portal_history,
--     billing_tombstones) deliberately do not reference accounts, so they survive a purge.
--
-- Must run unchanged on hosted Supabase (Postgres 15/17) and on PGlite (Postgres 18): no
-- version-specific features (no uuidv7(), no virtual generated columns, no NULLS NOT DISTINCT).

-- ---------------------------------------------------------------------------------------------
-- Default privileges (D-21)
-- ---------------------------------------------------------------------------------------------
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
-- Per-schema default privileges can only add to the global defaults, so the statement above cannot
-- take back the EXECUTE that Postgres grants PUBLIC on every new function. This one can.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Accounts and owners
-- ---------------------------------------------------------------------------------------------
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  hubspot_portal_id text not null,
  processing_state text not null default 'onboarding'
    check (processing_state in ('onboarding', 'active', 'paused', 'inactive', 'revoked', 'disconnected')),
  processing_state_changed_at timestamptz not null,
  paused_at timestamptz,
  onboarding_completed_at timestamptz,
  trial_started_at timestamptz not null,
  trial_ends_at timestamptz not null,
  -- null until HubSpot account details (or the owner) supply it (D-12)
  timezone text,
  timezone_source text check (timezone_source in ('hubspot', 'utc_offset', 'owner')),
  logging_mode text not null default 'unknown' check (logging_mode in ('unknown', 'log_all', 'sends_only', 'none')),
  last_install_at timestamptz not null,
  -- the Supabase auth user id of the bound owner (also users.auth_user_id)
  owner_user_id uuid,
  pending_owner_email text,
  pending_owner_expires_at timestamptz,
  pending_owner_auth_user_id uuid,
  disconnected_at timestamptz,
  purge_after timestamptz,
  checkout_lock_until timestamptz,
  entitlement_lost_at timestamptz,
  created_at timestamptz not null,
  constraint accounts_hubspot_portal_id_key unique (hubspot_portal_id),
  constraint accounts_trial_period_check check (trial_ends_at >= trial_started_at)
);
create index accounts_purge_after_idx on public.accounts (purge_after) where purge_after is not null;
alter table public.accounts enable row level security;
revoke all on table public.accounts from anon, authenticated;
grant select, insert, update, delete on table public.accounts to service_role;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null,
  account_id uuid not null references public.accounts (id) on delete cascade,
  email text not null,
  constraint users_auth_user_id_key unique (auth_user_id),
  constraint users_account_id_key unique (account_id)
);
create unique index users_email_lower_key on public.users (lower(email));
alter table public.users enable row level security;
revoke all on table public.users from anon, authenticated;
grant select, insert, update, delete on table public.users to service_role;

create table public.login_intents (
  -- sha256 (hex) of the Supabase hashed token; the token itself is never stored (D-22)
  token_hash_sha256 text primary key check (token_hash_sha256 ~ '^[0-9a-f]{64}$'),
  purpose text not null check (purpose in ('login', 'onboarding')),
  -- null for admin logins
  account_id uuid references public.accounts (id) on delete cascade,
  next text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null,
  constraint login_intents_onboarding_account_check check (purpose <> 'onboarding' or account_id is not null)
);
create index login_intents_expires_at_idx on public.login_intents (expires_at);
alter table public.login_intents enable row level security;
revoke all on table public.login_intents from anon, authenticated;
grant select, insert, update, delete on table public.login_intents to service_role;

create table public.settings (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  -- 1–3 addresses once preferences are saved (PLAN §5); empty only before that
  notify_emails text[] not null default '{}',
  -- only listed addresses can be verified (D-46)
  notify_emails_verified text[] not null default '{}',
  mail_client text not null default 'other' check (mail_client in ('gmail', 'outlook_work', 'outlook_personal', 'other')),
  gmail_account_email text,
  -- quiet hours apply to follow-ups only; start = end means none (D-33)
  quiet_start_hour smallint not null default 19 check (quiet_start_hour between 0 and 23),
  quiet_end_hour smallint not null default 8 check (quiet_end_hour between 0 and 23),
  skip_weekends boolean not null default true,
  followups_enabled boolean not null default true,
  bcc_address text,
  preferences_saved_at timestamptz,
  constraint settings_notify_emails_count_check
    check (cardinality(notify_emails) <= 3 and (preferences_saved_at is null or cardinality(notify_emails) >= 1)),
  constraint settings_verified_subset_check check (notify_emails_verified <@ notify_emails)
);
alter table public.settings enable row level security;
revoke all on table public.settings from anon, authenticated;
grant select, insert, update, delete on table public.settings to service_role;

-- ---------------------------------------------------------------------------------------------
-- HubSpot connection
-- ---------------------------------------------------------------------------------------------
create table public.hubspot_connections (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  portal_id text not null,
  hub_domain text,
  ui_domain text,
  data_hosting_location text,
  account_type text,
  scopes text[] not null default '{}',
  -- AES-256-GCM ciphertexts `v1.<kid>.<iv>.<ct>.<tag>` (D-51); wiped (null) on revoke/disconnect
  access_token_enc text,
  refresh_token_enc text,
  access_expires_at timestamptz,
  token_version integer not null default 0,
  refresh_lease_id text,
  refresh_lease_until timestamptz,
  status text not null default 'active' check (status in ('active', 'revoked', 'disconnected')),
  status_changed_at timestamptz not null,
  status_reason text,
  reconnect_email_sent_at timestamptz,
  transient_failures integer not null default 0 check (transient_failures >= 0),
  next_refresh_attempt_at timestamptz,
  last_refresh_at timestamptz,
  last_webhook_at timestamptz,
  last_polled_at timestamptz,
  poll_requested_at timestamptz,
  journal_offset text,
  constraint hubspot_connections_account_id_key unique (account_id),
  constraint hubspot_connections_portal_id_key unique (portal_id),
  -- defence in depth for law 4: a plaintext token can never be stored
  constraint hubspot_connections_access_token_format_check
    check (access_token_enc is null or access_token_enc ~ '^v1\.[0-9a-f]{8}\.[^.]+\.[^.]*\.[^.]+$'),
  constraint hubspot_connections_refresh_token_format_check
    check (refresh_token_enc is null or refresh_token_enc ~ '^v1\.[0-9a-f]{8}\.[^.]+\.[^.]*\.[^.]+$'),
  constraint hubspot_connections_active_tokens_check
    check (status <> 'active' or (access_token_enc is not null and refresh_token_enc is not null))
);
alter table public.hubspot_connections enable row level security;
revoke all on table public.hubspot_connections from anon, authenticated;
grant select, insert, update, delete on table public.hubspot_connections to service_role;

-- Tombstone: outside the accounts cascade, so a purge and reinstall cannot restart the trial (D-30).
create table public.portal_history (
  hubspot_portal_id text primary key,
  first_trial_started_at timestamptz not null
);
alter table public.portal_history enable row level security;
revoke all on table public.portal_history from anon, authenticated;
grant select, insert, update, delete on table public.portal_history to service_role;

-- ---------------------------------------------------------------------------------------------
-- Business brief
-- ---------------------------------------------------------------------------------------------
create table public.briefs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  -- the current brief JSON (business info, brief §5.3); history lives in brief_versions
  brief jsonb not null default '{}',
  source_url text,
  booking_link_choice text not null default 'unset' check (booking_link_choice in ('unset', 'link', 'none')),
  booking_link_confirmed boolean not null default false,
  version integer not null default 0 check (version >= 0),
  updated_at timestamptz,
  constraint briefs_account_id_key unique (account_id)
);
alter table public.briefs enable row level security;
revoke all on table public.briefs from anon, authenticated;
grant select, insert, update, delete on table public.briefs to service_role;

create table public.brief_versions (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references public.briefs (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  version integer not null check (version >= 1),
  source text not null check (source in ('generated', 'owner')),
  brief jsonb not null,
  source_url text,
  booking_link_choice text not null check (booking_link_choice in ('unset', 'link', 'none')),
  booking_link_confirmed boolean not null default false,
  created_at timestamptz not null,
  constraint brief_versions_brief_id_version_key unique (brief_id, version)
);
create index brief_versions_account_id_idx on public.brief_versions (account_id, version desc);
alter table public.brief_versions enable row level security;
revoke all on table public.brief_versions from anon, authenticated;
grant select, insert, update, delete on table public.brief_versions to service_role;

create table public.brief_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  -- deliveries so far; read before a delivery increments it (PLAN §9.7)
  attempts integer not null default 0 check (attempts >= 0),
  error_code text,
  -- logical; drives the 5-per-day limit (D-36)
  created_at timestamptz not null,
  finished_at timestamptz
);
create index brief_jobs_account_id_created_at_idx on public.brief_jobs (account_id, created_at desc);
alter table public.brief_jobs enable row level security;
revoke all on table public.brief_jobs from anon, authenticated;
grant select, insert, update, delete on table public.brief_jobs to service_role;

create table public.selected_forms (
  account_id uuid not null references public.accounts (id) on delete cascade,
  form_id text not null,
  form_name text,
  form_type text,
  selected boolean not null default true,
  newsletter_detected boolean not null default false,
  -- only submissions with submittedAt > intake_floor_at become leads (D-07)
  intake_floor_at timestamptz not null,
  -- moves only forward (GREATEST, D-16)
  cursor_submitted_at timestamptz not null,
  primary key (account_id, form_id)
);
alter table public.selected_forms enable row level security;
revoke all on table public.selected_forms from anon, authenticated;
grant select, insert, update, delete on table public.selected_forms to service_role;

-- ---------------------------------------------------------------------------------------------
-- Leads (ids, timestamps and statuses only) and their content (purged after 30 d)
-- ---------------------------------------------------------------------------------------------
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  hubspot_contact_id text,
  form_id text,
  submitted_at timestamptz not null,
  conversion_id text,
  -- HubSpot conversionId, else HMAC(K_dedupe, formId|submittedAt|lower(email)); nulled at purge (D-31)
  submission_key text,
  intake_trigger text not null check (intake_trigger in ('webhook', 'cron', 'inbox_check')),
  is_test boolean not null default false,
  classification text
    check (classification in ('lead', 'spam', 'vendor_pitch', 'job_seeker', 'support_request', 'unclear')),
  classification_override text
    check (classification_override in ('lead', 'spam', 'vendor_pitch', 'job_seeker', 'support_request', 'unclear')),
  processing_state text not null default 'new'
    check (processing_state in ('new', 'processing', 'notified', 'filtered', 'deferred', 'failed', 'skipped')),
  process_rev integer not null default 0 check (process_rev >= 0),
  followup_stream integer not null default 0 check (followup_stream >= 0),
  needs_touch boolean not null default false,
  stop_reason text check (stop_reason in (
    'dismissed', 'replied', 'contact_deleted', 'opted_out', 'bounced', 'superseded', 'privacy_deletion',
    'followups_off', 'account_inactive', 'max_followups', 'test_lead'
  )),
  replies_ignored_before timestamptz,
  -- timeline; send_confirmed_at and replied_at are HubSpot event times (D-08)
  received_at timestamptz not null,
  classified_at timestamptz,
  first_notified_at timestamptz,
  first_send_clicked_at timestamptz,
  send_confirmed_at timestamptz,
  replied_at timestamptz,
  dismissed_at timestamptz,
  fu1_notified_at timestamptz,
  fu2_notified_at timestamptz,
  signals_checked_at timestamptz,
  constraint leads_contact_required_check check (is_test or hubspot_contact_id is not null),
  constraint leads_form_required_check check (is_test or form_id is not null),
  constraint leads_account_contact_submitted_key unique (account_id, hubspot_contact_id, submitted_at),
  constraint leads_account_form_submission_key unique (account_id, form_id, submission_key)
);
create index leads_account_received_at_idx on public.leads (account_id, received_at desc) where not is_test;
create index leads_account_contact_submitted_at_idx on public.leads (account_id, hubspot_contact_id, submitted_at desc);
alter table public.leads enable row level security;
revoke all on table public.leads from anon, authenticated;
grant select, insert, update, delete on table public.leads to service_role;

-- The only lead content (D-31). Inserted only in a CTE chained to the lead insert.
create table public.lead_messages (
  lead_id uuid primary key references public.leads (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  message text,
  first_name text,
  last_name text,
  company text,
  email text,
  -- submitted_at + 30 d (test leads + 24 h)
  purge_at timestamptz not null
);
create index lead_messages_purge_at_idx on public.lead_messages (purge_at);
alter table public.lead_messages enable row level security;
revoke all on table public.lead_messages from anon, authenticated;
grant select, insert, update, delete on table public.lead_messages to service_role;

create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  kind text not null check (kind in ('initial', 'fu1', 'fu2')),
  -- content: nulled (flags emptied) at purge
  subject text,
  body text,
  flags text[] not null default '{}' check (flags <@ array[
    'asks_pricing', 'urgent', 'non_english', 'missing_info', 'possible_spam', 'sensitive_topic', 'other'
  ]::text[]),
  used_booking_link boolean not null default false,
  validation_ok boolean not null default false,
  validation_errors text[] not null default '{}' check (validation_errors <@ array[
    'too_long', 'not_plain_text', 'placeholder', 'missing_first_name', 'missing_booking_link', 'currency',
    'never_promise', 'bad_subject', 'url_not_allowed', 'contact_not_allowed', 'addresses_owner', 'echoes_lead'
  ]::text[]),
  attempts integer not null default 0 check (attempts >= 0),
  needs_touch boolean not null default false,
  model text,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_micro_usd integer not null default 0 check (cost_micro_usd >= 0),
  -- = the lead's lead_messages.purge_at
  purge_at timestamptz not null,
  purged_at timestamptz,
  constraint drafts_lead_id_kind_key unique (lead_id, kind)
);
create index drafts_purge_at_idx on public.drafts (purge_at) where purged_at is null;
alter table public.drafts enable row level security;
revoke all on table public.drafts from anon, authenticated;
grant select, insert, update, delete on table public.drafts to service_role;

create table public.action_tokens (
  id uuid primary key default gen_random_uuid(),
  -- sha256 (hex) of `apt_` + base64url(32 random bytes); the token itself is never stored (D-45)
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid not null references public.accounts (id) on delete cascade,
  -- null for verify_notify tokens
  lead_id uuid references public.leads (id) on delete cascade,
  draft_id uuid references public.drafts (id) on delete cascade,
  notification_key text,
  purpose text not null check (purpose in ('send', 'edit', 'dismiss', 'verify_notify')),
  expires_at timestamptz not null,
  first_used_at timestamptz,
  use_count integer not null default 0 check (use_count >= 0),
  revoked_at timestamptz,
  constraint action_tokens_token_hash_key unique (token_hash)
);
create index action_tokens_expires_at_idx on public.action_tokens (expires_at);
create index action_tokens_lead_id_idx on public.action_tokens (lead_id) where lead_id is not null;
alter table public.action_tokens enable row level security;
revoke all on table public.action_tokens from anon, authenticated;
grant select, insert, update, delete on table public.action_tokens to service_role;

-- ---------------------------------------------------------------------------------------------
-- Jobs and notifications (PLAN §8)
-- ---------------------------------------------------------------------------------------------
create table public.scheduled_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete cascade,
  kind text not null check (kind in (
    'portal_poll', 'lead_process', 'followup', 'weekly_report', 'baseline', 'brief_generate', 'inbox_check',
    'privacy_delete', 'account_daily'
  )),
  seq integer not null default 0,
  -- {ENV_NAMESPACE}:… (PLAN §8.2); re-publishes append :h{hops} to the QStash dedupe id only
  dedupe_key text not null,
  -- ids only, never content
  payload jsonb not null default '{}',
  run_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'running', 'done', 'cancelled', 'skipped', 'failed')),
  external_id text,
  published_at timestamptz,
  hops integer not null default 0 check (hops >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  attempt_id text,
  lease_until timestamptz,
  last_error_code text,
  cancel_reason text,
  -- logical; drives the sweeper's "unpublished for 2 min" rule
  created_at timestamptz not null,
  finished_at timestamptz,
  constraint scheduled_jobs_dedupe_key_key unique (dedupe_key)
);
create index scheduled_jobs_status_run_at_idx on public.scheduled_jobs (status, run_at);
create index scheduled_jobs_status_lease_until_idx on public.scheduled_jobs (status, lease_until);
create index scheduled_jobs_unpublished_idx on public.scheduled_jobs (status, created_at) where external_id is null;
create index scheduled_jobs_lead_id_idx on public.scheduled_jobs (lead_id) where lead_id is not null;
alter table public.scheduled_jobs enable row level security;
revoke all on table public.scheduled_jobs from anon, authenticated;
grant select, insert, update, delete on table public.scheduled_jobs to service_role;

-- One row per owner email (no bodies); only `sent` blocks a resend (PLAN §8.4).
create table public.notifications_sent (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,
  account_id uuid references public.accounts (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete cascade,
  kind text not null check (kind in (
    'new_lead', 'needs_touch', 'follow_up', 'reply_detected', 'inbox_test', 'weekly_report', 'reconnect',
    'billing_inactive', 'magic_link', 'verify_notify', 'lead_cap', 'owner_alert'
  )),
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  provider_message_id text,
  recipients_count integer not null default 0 check (recipients_count >= 0),
  -- never reset: bounds the sweeper's resumes to Resend's idempotency window
  first_reserved_at timestamptz not null,
  reserved_at timestamptz not null,
  send_attempts integer not null default 0 check (send_attempts >= 0),
  sweeper_resumes integer not null default 0 check (sweeper_resumes >= 0),
  sent_at timestamptz,
  constraint notifications_sent_dedupe_key_key unique (dedupe_key)
);
create index notifications_sent_sending_idx on public.notifications_sent (reserved_at) where status = 'sending';
alter table public.notifications_sent enable row level security;
revoke all on table public.notifications_sent from anon, authenticated;
grant select, insert, update, delete on table public.notifications_sent to service_role;

create table public.weekly_reports (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  week_start date not null,
  -- the zone the period was computed in (D-17)
  timezone text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  -- numbers only, never content; null until computed
  metrics jsonb,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  -- report runs (the sweeper re-enqueues a failed report while attempts < 3)
  attempts integer not null default 0 check (attempts >= 0),
  constraint weekly_reports_account_week_key unique (account_id, week_start),
  constraint weekly_reports_period_check check (period_end > period_start)
);
alter table public.weekly_reports enable row level security;
revoke all on table public.weekly_reports from anon, authenticated;
grant select, insert, update, delete on table public.weekly_reports to service_role;

-- ---------------------------------------------------------------------------------------------
-- Billing
-- ---------------------------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  provider_subscription_id text not null,
  plan_id text not null,
  -- Razorpay's nine statuses plus the local `stale` (D-18)
  status text not null check (status in (
    'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired', 'paused', 'stale'
  )),
  status_changed_at timestamptz not null,
  short_url text,
  start_at timestamptz,
  expire_by timestamptz,
  current_start timestamptz,
  current_end timestamptz,
  payment_failed_at timestamptz,
  grace_until timestamptz,
  cancel_at_cycle_end boolean not null default false,
  last_synced_at timestamptz,
  -- logical; the current subscription is the row with the latest created_at (D-18)
  created_at timestamptz not null,
  constraint subscriptions_provider_subscription_id_key unique (provider_subscription_id)
);
-- at most one `created` (checkout in progress) subscription per account (D-18)
create unique index subscriptions_one_created_per_account_key on public.subscriptions (account_id) where status = 'created';
create index subscriptions_account_created_at_idx on public.subscriptions (account_id, created_at desc);
alter table public.subscriptions enable row level security;
revoke all on table public.subscriptions from anon, authenticated;
grant select, insert, update, delete on table public.subscriptions to service_role;

-- Tombstone: outside the accounts cascade, keeps late Razorpay webhooks harmless after a purge (D-48).
create table public.billing_tombstones (
  provider_subscription_id text primary key,
  -- whatever Razorpay last reported (open text: a tombstone records, it does not judge)
  last_status text not null,
  expire_by timestamptz,
  purged_at timestamptz not null,
  last_checked_at timestamptz,
  resolved_at timestamptz
);
create index billing_tombstones_unresolved_idx on public.billing_tombstones (last_checked_at nulls first) where resolved_at is null;
alter table public.billing_tombstones enable row level security;
revoke all on table public.billing_tombstones from anon, authenticated;
grant select, insert, update, delete on table public.billing_tombstones to service_role;

-- ---------------------------------------------------------------------------------------------
-- Logs (bigint identity ids)
-- ---------------------------------------------------------------------------------------------
create table public.webhook_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('hubspot', 'razorpay')),
  -- HubSpot: portalId:subscriptionType:objectId:eventId:occurredAt; Razorpay: event id or sha256:<body hash> (D-05)
  dedupe_key text not null,
  body_sha256 text check (body_sha256 ~ '^[0-9a-f]{64}$'),
  portal_id text,
  account_id uuid references public.accounts (id) on delete cascade,
  event_type text,
  occurred_at timestamptz,
  -- audit-only: on the SQL-scan allow-list (D-28)
  received_at timestamptz not null default now(),
  outcome text,
  constraint webhook_events_provider_dedupe_key_key unique (provider, dedupe_key)
);
create unique index webhook_events_razorpay_body_sha256_key on public.webhook_events (provider, body_sha256) where provider = 'razorpay';
create index webhook_events_portal_received_at_idx on public.webhook_events (portal_id, received_at desc);
alter table public.webhook_events enable row level security;
revoke all on table public.webhook_events from anon, authenticated;
grant select, insert, update, delete on table public.webhook_events to service_role;

create table public.audit_log (
  id bigint generated always as identity primary key,
  account_id uuid references public.accounts (id) on delete cascade,
  -- audit-only: on the SQL-scan allow-list (D-28)
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  level text not null default 'info' check (level in ('debug', 'info', 'warn', 'error')),
  -- allow-listed keys only (ids, codes, timestamps), never content
  meta jsonb not null default '{}'
);
create index audit_log_account_at_idx on public.audit_log (account_id, at desc);
alter table public.audit_log enable row level security;
revoke all on table public.audit_log from anon, authenticated;
grant select, insert, update, delete on table public.audit_log to service_role;

create table public.ai_calls (
  id bigint generated always as identity primary key,
  account_id uuid references public.accounts (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete cascade,
  purpose text not null check (purpose in ('classify', 'baseline_classify', 'brief', 'draft', 'followup')),
  attempt integer not null default 1 check (attempt >= 1),
  -- response.model (costs are keyed by it, D-25)
  model text not null,
  request_id text,
  stop_reason text,
  refusal_category text,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_creation_input_tokens integer not null default 0 check (cache_creation_input_tokens >= 0),
  cache_read_input_tokens integer not null default 0 check (cache_read_input_tokens >= 0),
  cost_micro_usd integer not null default 0 check (cost_micro_usd >= 0),
  latency_ms integer check (latency_ms >= 0),
  outcome text not null check (outcome in (
    'ok', 'validator_fail', 'refusal', 'max_tokens', 'invalid_output', 'transient', 'fatal_config'
  )),
  -- logical; drives the daily AI budget breaker and the 13-month prune
  created_at timestamptz not null
);
create index ai_calls_created_at_idx on public.ai_calls (created_at);
alter table public.ai_calls enable row level security;
revoke all on table public.ai_calls from anon, authenticated;
grant select, insert, update, delete on table public.ai_calls to service_role;

-- ---------------------------------------------------------------------------------------------
-- Onboarding: baseline and inbox check
-- ---------------------------------------------------------------------------------------------
create table public.baselines (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  status text not null check (status in ('ok', 'insufficient', 'unavailable')),
  submissions_read integer not null default 0 check (submissions_read >= 0),
  leads_counted integer not null default 0 check (leads_counted >= 0),
  -- an even n takes the mean of the two middle values, so this can be fractional (D-38)
  median_seconds_to_first_outbound double precision,
  without_outbound_count integer check (without_outbound_count >= 0),
  -- whether "% without a logged outbound email" may be shown (D-38)
  percent_available boolean not null default false,
  created_at timestamptz not null
);
create index baselines_account_created_at_idx on public.baselines (account_id, created_at desc);
alter table public.baselines enable row level security;
revoke all on table public.baselines from anon, authenticated;
grant select, insert, update, delete on table public.baselines to service_role;

create table public.inbox_checks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  -- the owner's other address: cleared after 24 h; the HMAC is kept for the intake skip (D-14)
  test_address text,
  test_address_hmac text not null check (test_address_hmac ~ '^[0-9a-f]{64}$'),
  test_lead_id uuid references public.leads (id) on delete set null,
  history_outbound_30d integer check (history_outbound_30d >= 0),
  history_inbound_30d integer check (history_inbound_30d >= 0),
  send_leg text not null default 'pending' check (send_leg in ('pending', 'passed', 'failed', 'skipped')),
  reply_leg text not null default 'pending' check (reply_leg in ('pending', 'passed', 'failed', 'skipped')),
  send_deadline_at timestamptz,
  reply_deadline_at timestamptz,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null,
  send_resolved_at timestamptz,
  reply_resolved_at timestamptz,
  closed_at timestamptz
);
create index inbox_checks_account_created_at_idx on public.inbox_checks (account_id, created_at desc);
alter table public.inbox_checks enable row level security;
revoke all on table public.inbox_checks from anon, authenticated;
grant select, insert, update, delete on table public.inbox_checks to service_role;

-- ---------------------------------------------------------------------------------------------
-- Rate limits and leases
-- ---------------------------------------------------------------------------------------------
create table public.rate_limits (
  -- HMAC (hex) of the limited key (IP/route, email, token), never the raw value (D-36)
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  primary key (key_hash, window_start)
);
create index rate_limits_window_start_idx on public.rate_limits (window_start);
alter table public.rate_limits enable row level security;
revoke all on table public.rate_limits from anon, authenticated;
grant select, insert, update, delete on table public.rate_limits to service_role;

create table public.leases (
  name text primary key,
  holder text not null,
  expires_at timestamptz not null
);
alter table public.leases enable row level security;
revoke all on table public.leases from anon, authenticated;
grant select, insert, update, delete on table public.leases to service_role;

-- Identity columns own sequences; inserts through them need no grant, and nobody else gets one.
revoke all on all sequences in schema public from anon, authenticated;
