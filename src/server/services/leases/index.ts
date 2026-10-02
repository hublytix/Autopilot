import 'server-only';

// Named leases (PLAN §5 `leases`, D-16): the poll cron's global lease and pollPortal's per-account lease.
export { acquireLease, LeaseNames, releaseLease, renewLease, withLease } from './leases';
export type { AcquireLeaseInput, Lease, LeaseRun } from './leases';
