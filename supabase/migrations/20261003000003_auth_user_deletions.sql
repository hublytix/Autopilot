-- D-82 (M7 review fix): auth users whose deletion is still owed (law 4).
--
-- A pending owner's Supabase auth user (created by /onboarding/email) is deleted when it is replaced
-- or when its unbound install is purged, but only once nothing refers to it any more (D-35, D-48,
-- D-62's guard). When that delete fails, or the user is still another unbound install's pending
-- owner for now, its id is queued here and the daily cron tries again (services/auth), so no auth
-- user (and its address, in Supabase) outlives everything that referred to it. Ids and times only:
-- never an address.
create table public.auth_user_deletions (
  auth_user_id uuid primary key,
  requested_at timestamptz not null,
  last_attempt_at timestamptz
);
create index auth_user_deletions_due_idx on public.auth_user_deletions (last_attempt_at nulls first, requested_at);
alter table public.auth_user_deletions enable row level security;
revoke all on table public.auth_user_deletions from anon, authenticated;
grant select, insert, update, delete on table public.auth_user_deletions to service_role;
