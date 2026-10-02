-- PGlite only (fake mode and tests): the pieces of a Supabase database that supabase/migrations
-- relies on, plus the `fake` schema. Hosted Supabase already has the roles and the auth schema and
-- never runs this file; it must never be copied into supabase/migrations (PLAN §5, D-29).
--
-- migrate.ts runs it before the migrations on every boot, so every statement is idempotent.
-- No now()/current_timestamp here either: fake rows bind their timestamps from the Clock (D-28).

-- Supabase's API roles (PG-SUPABASE-SHIM). service_role bypasses RLS, as on Supabase.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

-- A minimal `auth` stub. Keep migration dependencies on it to auth.users(id) and auth.uid().
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);
create or replace function auth.uid() returns uuid
  language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
create or replace function auth.jwt() returns jsonb
  language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
  $$;
grant usage on schema auth to anon, authenticated, service_role;

-- Fake-mode state, kept out of `public` (D-29). Only the app's own (postgres) connection uses it.
create schema if not exists fake;
revoke all on schema fake from public;

-- The fake-mode migration ledger: one row per applied supabase/migrations file.
create table if not exists fake._migrations (
  version text primary key,
  name text not null
);

-- Emails the fake Mailer "sent" in dev (PLAN §4); fake mode only (D-49).
create table if not exists fake.dev_outbox (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null,
  "to" text[] not null,
  subject text not null,
  html text not null,
  text text not null,
  kind text not null,
  meta jsonb not null default '{}'
);

-- Fake adapter state: the fake portal, the clock offset (PLAN §4).
create table if not exists fake.state (
  key text primary key,
  value jsonb not null
);

-- A Supabase project created before 2026-05-30 grants the API roles everything in `public` by
-- default, for objects the postgres role creates (SB-DATA-API-GRANTS-2026: legacy auto-grants stay on
-- those projects). Reproduce that on a fresh database, before the first migration, so the migrations'
-- own revokes are what keep anon and authenticated out (PLAN §5 migration test). Only while the
-- ledger is empty: on Supabase the migration's revoke of these defaults sticks, and this file re-runs
-- on every boot.
do $$
begin
  if not exists (select 1 from fake._migrations) then
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  end if;
end
$$;
