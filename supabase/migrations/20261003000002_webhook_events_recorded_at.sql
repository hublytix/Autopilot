-- D-82 (M7 review fix): webhook_events gets a logical "recorded" instant bound from the app Clock.
--
-- `received_at` stays the audit-only column (`default now()`, the database's wall clock, D-28) and
-- never decides behaviour. The 30-day prune (PLAN §9.10 step 7) and /admin's "last webhook" read
-- `recorded_at`, which both webhook handlers bind as $now, so the prune follows the app's Clock
-- like every other retention step (the simulation and tests can drive it).
alter table public.webhook_events add column recorded_at timestamptz;
update public.webhook_events set recorded_at = received_at where recorded_at is null;
alter table public.webhook_events alter column recorded_at set not null;
create index webhook_events_recorded_at_idx on public.webhook_events (recorded_at);
