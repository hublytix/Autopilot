import 'server-only';
import { createPortalPollJobHandler, portalPollJobHandler } from '@/server/services/intake/jobs';
import { privacyDeleteJobHandler } from '@/server/services/privacy/privacy-delete';
import type { Registration } from '@/server/jobs';

// The intake job kinds (PLAN §8.2): `portal_poll` (inserted by the webhook, debounced) and
// `privacy_delete` (D-06). Neither has a failure path beyond the alert every kind gets: a lost poll
// is covered by the next cron poll, and a failed privacy deletion needs an operator (the alert).
// Added to REGISTRATIONS in ../handlers.ts. `lead_process` is registered by its own service.
export const registerIntakeJobs: Registration = ({ jobs, limiterSleep }) => {
  jobs.register('portal_poll', limiterSleep === undefined ? portalPollJobHandler : createPortalPollJobHandler({ sleep: limiterSleep }));
  jobs.register('privacy_delete', privacyDeleteJobHandler);
};
