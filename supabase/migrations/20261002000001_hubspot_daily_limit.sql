-- D-11: "A daily-limit 429 defers to the next local midnight" (M2 review fix, D-55).
--
-- When HubSpot answers a call for a portal with its daily-limit 429, the portal client records
-- the next local midnight (the account's timezone, UTC when unknown) here. Until then no caller
-- reads HubSpot for that portal: the poll cron skips it, and a job gets a TransientError whose
-- Retry-After re-targets it to that instant (bounded by the dispatcher's claim count). Bound from
-- the app Clock like every logical timestamp (D-28); null when no limit was hit.
alter table public.hubspot_connections add column daily_limit_until timestamptz;
