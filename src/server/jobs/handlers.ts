import 'server-only';
import { registerAccountNotifications } from '@/server/services/accounts/emails';
import { registerBaselineJobs } from '@/server/services/baseline/job';
import { registerBriefJobs } from '@/server/services/brief/job';
import { registerDraftingNotifications } from '@/server/services/drafting/cap';
import { registerInboxCheck } from '@/server/services/inbox-check/job';
import { registerLeadProcessJob } from '@/server/services/leads/process';
import { registerOnboardingNotifications } from '@/server/services/onboarding/notifications';
import type { Sleep } from '@/server/services/hubspot';
import { createNotificationRegistry, defaultNotificationRegistry, type NotificationRegistry } from '@/server/services/notifications/renderers';
import { registerIntakeJobs } from './handlers/intake';
import { createJobRegistry, defaultJobRegistry, type JobRegistry } from './registry';

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
  /**
   * The per-portal limiter's wait for handlers that call HubSpot (portal_poll, inbox_check,
   * baseline). Default real timers; the simulation passes one that advances its FakeClock, as it
   * does for the poll cron (a FakeClock never reaches the next limiter window on its own).
   */
  readonly limiterSleep?: Sleep | undefined;
}

export type Registration = (registries: Registries) => void;

/**
 * Filled in as the services that own each kind arrive. M2: portal_poll + privacy_delete (intake),
 * lead_process + its failure path, and the reconnect / billing_inactive / owner_alert resumers
 * (owner_alert also resumes M3's settings-change alerts). M3: verify_notify, brief_generate,
 * inbox_check + the inbox_test resumer, baseline. M4: lead_process drafts and emails the lead, and
 * registerLeadProcessJob also registers the lead email resumers (new_lead, needs_touch, follow_up,
 * reply_detected); the lead_cap resumer (services/drafting).
 */
const REGISTRATIONS: readonly Registration[] = [
  registerIntakeJobs,
  registerLeadProcessJob,
  registerOnboardingNotifications,
  registerAccountNotifications,
  registerBriefJobs,
  registerInboxCheck,
  registerBaselineJobs,
  registerDraftingNotifications,
];

/** Fresh registries holding every registration (the simulation's; the app uses the defaults below). */
export function createJobHandlerRegistries(options: { limiterSleep?: Sleep | undefined } = {}): Registries {
  const registries: Registries = { jobs: createJobRegistry(), notifications: createNotificationRegistry(), limiterSleep: options.limiterSleep };
  for (const register of REGISTRATIONS) register(registries);
  return registries;
}

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
