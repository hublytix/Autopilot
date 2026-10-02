import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import type { Sleep } from '@/server/services/hubspot';
import type { NotificationRegistry } from '@/server/services/notifications/renderers';
import { applySignals } from '@/server/services/signals';

// The daily signal refresh (PLAN §9.1 step 4, D-08): applySignals (caller 'refresh') for the leads
// whose follow-ups are finished or off — no follow-up job of the lead still scheduled or running;
// leads with pending follow-ups are checked by their own jobs — and that were emailed to the owner
// in the last 14 days, so the dashboard and the Monday report learn of sends and replies HubSpot
// logged after the last follow-up. Never a test lead (`AND NOT is_test`, D-14), a privacy-deleted
// or dismissed lead, or one without a contact; nor a lead whose send and reply are both already
// recorded (nothing left to learn). Only for an active account with an active connection (PLAN
// §6.1: only active accounts are processed and reported). Least recently checked first, at most 200
// a day. A HubSpot failure ends the run (tomorrow's continues); it never fails the daily job.

export const DAILY_SIGNAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const DAILY_SIGNAL_LIMIT = 200;

export interface SignalRefreshSummary {
  readonly candidates: number;
  readonly checked: number;
  /** The run ended early on a HubSpot or database error. */
  readonly stopped: boolean;
}

export interface SignalRefreshOptions {
  readonly sleep?: Sleep | undefined;
  readonly notifications?: NotificationRegistry | undefined;
}

export async function refreshFinishedLeadSignals(deps: Deps, accountId: string, options: SignalRefreshOptions = {}): Promise<SignalRefreshSummary> {
  const now = deps.clock.now();
  const leads = await deps.db.query<{ id: string }>(
    `select l.id from leads l
       join accounts a on a.id = l.account_id and a.processing_state = 'active'
       join hubspot_connections c on c.account_id = l.account_id and c.status = 'active'
      where l.account_id = $1 and not l.is_test
        and l.first_notified_at is not null and l.first_notified_at >= $2
        and l.hubspot_contact_id is not null and l.dismissed_at is null
        and l.stop_reason is distinct from 'privacy_deletion'
        and not (l.replied_at is not null and l.send_confirmed_at is not null)
        and not exists (select 1 from scheduled_jobs j
                         where j.lead_id = l.id and j.kind = 'followup' and j.status in ('scheduled', 'running'))
      order by l.signals_checked_at nulls first, l.first_notified_at, l.id
      limit $3`,
    [accountId, new Date(now.getTime() - DAILY_SIGNAL_WINDOW_MS), DAILY_SIGNAL_LIMIT],
  );
  let checked = 0;
  for (const lead of leads) {
    try {
      const result = await applySignals(deps, lead.id, { caller: 'refresh', accountId, sleep: options.sleep, notifications: options.notifications });
      if (result.outcome === 'checked') checked += 1;
    } catch (error) {
      log.warn('daily signal refresh stopped', { event: 'daily.signals_stopped', accountId, leadId: lead.id, code: errorCode(error) }, error);
      return { candidates: leads.length, checked, stopped: true };
    }
  }
  return { candidates: leads.length, checked, stopped: false };
}
