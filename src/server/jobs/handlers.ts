import 'server-only';
import { registerAccountNotifications } from '@/server/services/accounts/emails';
import { registerLeadProcessJob } from '@/server/services/leads/process';
import { defaultNotificationRegistry, type NotificationRegistry } from '@/server/services/notifications/renderers';
import { registerIntakeJobs } from './handlers/intake';
import { defaultJobRegistry, type JobRegistry } from './registry';

// The one wiring point for job handlers, job failure paths and notification renderers. Each
// milestone adds its registration here, e.g.
//
//   import { registerIntakeJobs } from '@/server/services/intake/jobs';
//   const REGISTRATIONS = [registerIntakeJobs, …];
//
// where `registerIntakeJobs({ jobs })` calls `jobs.register('portal_poll', handler)`, and a service
// that sends a resumable email calls `notifications.register('reconnect', resumer)`.
//
// Job kinds (PLAN §8.2): portal_poll, privacy_delete (M2); brief_generate, inbox_check, baseline
// (M3); lead_process (M2 classification, M4 drafts); followup (M5); weekly_report (M6);
// account_daily (M7). Failure paths (PLAN §8.3 step 6) use `jobs.registerFailurePath`.
//
// The routes, the fake scheduler bridge and the poll cron call ensureJobHandlersRegistered() before
// delivering or sweeping anything.

export interface Registries {
  readonly jobs: JobRegistry;
  readonly notifications: NotificationRegistry;
}

export type Registration = (registries: Registries) => void;

/**
 * Filled in as the services that own each kind arrive. M2: portal_poll + privacy_delete (intake),
 * lead_process + its failure path, and the reconnect / billing_inactive / owner_alert resumers.
 */
const REGISTRATIONS: readonly Registration[] = [registerIntakeJobs, registerLeadProcessJob, registerAccountNotifications];

let registered = false;

/** Registers everything into the default registries, once per process. */
export function ensureJobHandlersRegistered(): Registries {
  const registries: Registries = { jobs: defaultJobRegistry, notifications: defaultNotificationRegistry };
  if (!registered) {
    for (const register of REGISTRATIONS) register(registries);
    registered = true;
  }
  return registries;
}
