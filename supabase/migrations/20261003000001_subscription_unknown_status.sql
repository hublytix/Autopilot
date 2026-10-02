-- D-82 (M7 review fix): an undocumented Razorpay subscription status gets its own local value.
--
-- Until now such a status was stored as the local `stale` (an unfinished checkout we stopped
-- using), which never blocks a checkout, is never re-read and counted as "can't charge" for the
-- purge. A status Razorpay doesn't document may belong to a subscription that still holds a
-- mandate, so it is stored as `unknown`: not entitled, blocks a new checkout (the owner is sent to
-- support), re-read by the daily reconcile and fetched by the purge, and the admin is alerted.
alter table public.subscriptions drop constraint subscriptions_status_check;
alter table public.subscriptions add constraint subscriptions_status_check check (status in (
  'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired', 'paused', 'stale', 'unknown'
));
