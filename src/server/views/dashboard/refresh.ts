import 'server-only';
import { z } from 'zod';
import { errorCode } from '@/server/domain/errors';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { claimOnce, hitFixedWindow, rateLimitKeyHash } from '@/server/security/rate-limit';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { applySignals, type ApplySignalsOptions } from '@/server/services/signals';
import { parseLeadId } from './leads';

// The lead page's signal refresh on view (PLAN §7.5, §9.5, D-08, D-73): one HubSpot read of the
// lead's contact through applySignals (caller 'refresh', the owner's account only, inline refresh
// failures), so the page shows a send or a reply HubSpot logged since the last follow-up job. It is
// - never for a test lead (applySignals also refuses one: `AND NOT is_test`), nor for a lead whose
//   data was deleted, that was never emailed to the owner, that was dismissed, or whose account's
//   HubSpot connection is not active (nothing to read with);
// - at most once per 5-minute window per lead: a once-only marker in `rate_limits`, keyed by an HMAC
//   of the lead id and the window's aligned start, so the claim is the row's primary key and two
//   overlapping page loads can never both win it (a single-statement compare-and-set; across a window
//   boundary two reads can be under 5 minutes apart, never more than two). Claimed before the read
//   (a failed read still uses it, so HubSpot is never hammered);
// - at most ACCOUNT_REFRESH_BUDGET reads per 5-minute window per account (a fixed-window counter),
//   so one session looping over every lead can't spend the portal's API budget the poller and the
//   follow-up and report jobs need. A reload of a lead that is already rate-limited costs nothing,
//   and a refused account budget leaves the lead's slot unclaimed;
// - never in the way of the page: any error is logged by code and the page renders what it knows,
//   within REFRESH_BUDGET_MS.
// When the read could not see every logged email, the result says so (`emailsAvailable: false`) and
// the page says HubSpot's logged emails couldn't be checked (law 3: never "no reply" without a look).

export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** HubSpot reads per account per REFRESH_INTERVAL_MS window from lead-page views. */
export const ACCOUNT_REFRESH_BUDGET = 20;
/** How long the page waits for HubSpot before rendering without the refresh. */
export const REFRESH_BUDGET_MS = 8000;

export type LeadRefreshOutcome =
  /** HubSpot was read; `emailsAvailable` false: not every logged email could be read. */
  | { readonly type: 'checked'; readonly emailsAvailable: boolean; readonly replied: boolean; readonly markedReplied: boolean }
  /** Read in this 5-minute window already, or the account's views used up this window's reads. */
  | { readonly type: 'rate_limited' }
  /** Nothing to read for this lead (test lead, deleted data, never emailed, dismissed, connection not active). */
  | { readonly type: 'not_eligible' }
  /** Not a lead of the owner's account. */
  | { readonly type: 'not_found' }
  /** HubSpot (or the database) failed; the page shows what it already knew. */
  | { readonly type: 'failed' };

export interface LeadRefreshOptions {
  readonly signal?: AbortSignal | undefined;
  /** Test seam: applySignals' options (the limiter sleep, the notification registry). */
  readonly applyOptions?: Partial<Pick<ApplySignalsOptions, 'sleep' | 'notifications' | 'client'>> | undefined;
}

const eligibilityRow = z.object({
  is_test: z.boolean(),
  stop_reason: z.string().nullable(),
  first_notified_at: z.date().nullable(),
  hubspot_contact_id: z.string().nullable(),
  dismissed_at: z.date().nullable(),
  connection_status: z.string().nullable(),
});

function eligible(row: z.infer<typeof eligibilityRow>): boolean {
  return (
    !row.is_test &&
    row.stop_reason !== 'privacy_deletion' &&
    row.first_notified_at !== null &&
    row.hubspot_contact_id !== null &&
    row.dismissed_at === null &&
    row.connection_status === 'active'
  );
}

function windowStartOf(now: Date): Date {
  return new Date(Math.floor(now.getTime() / REFRESH_INTERVAL_MS) * REFRESH_INTERVAL_MS);
}

function leadSlotKey(deps: Pick<Deps, 'env'>, leadId: string): string {
  return rateLimitKeyHash(deps.env, `lead_refresh:${leadId}`);
}

/**
 * Takes the lead's refresh slot for the 5-minute window containing `now`: true for exactly one
 * caller per window (the insert's primary key decides, whatever order concurrent loads commit in),
 * false for every other.
 */
export async function claimRefreshSlot(db: Db, keyHash: string, now: Date): Promise<boolean> {
  return claimOnce(db, { keyHash, windowStart: windowStartOf(now) });
}

async function slotTaken(db: Db, keyHash: string, now: Date): Promise<boolean> {
  const row = await db.maybeOne(`select 1 as taken from rate_limits where key_hash = $1 and window_start = $2`, [keyHash, windowStartOf(now)]);
  return row !== null;
}

/** Counts one lead-page read against the account's window; false once the budget is spent. */
async function withinAccountBudget(deps: Pick<Deps, 'db' | 'env'>, accountId: string, now: Date): Promise<boolean> {
  const hit = await hitFixedWindow(deps.db, { keyHash: rateLimitKeyHash(deps.env, `lead_refresh_account:${accountId}`), windowMs: REFRESH_INTERVAL_MS, now });
  return hit.count <= ACCOUNT_REFRESH_BUDGET;
}

/** The refresh on the lead page's view. Never throws. */
export async function refreshLeadSignals(
  scope: OwnerScope,
  deps: Deps,
  leadIdInput: string,
  options: LeadRefreshOptions = {},
): Promise<LeadRefreshOutcome> {
  const leadId = parseLeadId(leadIdInput);
  if (leadId === null) return { type: 'not_found' };
  const accountId = scope.accountId;
  try {
    const raw = await deps.db.maybeOne(
      `select l.is_test, l.stop_reason, l.first_notified_at, l.hubspot_contact_id, l.dismissed_at, c.status as connection_status
         from leads l left join hubspot_connections c on c.account_id = l.account_id
        where l.id = $1 and l.account_id = $2`,
      [leadId, accountId],
    );
    if (raw === null) return { type: 'not_found' };
    if (!eligible(eligibilityRow.parse(raw))) return { type: 'not_eligible' };
    const now = deps.clock.now();
    const slot = leadSlotKey(deps, leadId);
    // A reload inside the lead's window costs the account nothing; then the account's budget; then the lead's slot.
    if (await slotTaken(deps.db, slot, now)) return { type: 'rate_limited' };
    if (!(await withinAccountBudget(deps, accountId, now))) {
      log.warn('lead page refresh budget spent', { event: 'dashboard.lead_refresh_budget', accountId, limit: ACCOUNT_REFRESH_BUDGET });
      return { type: 'rate_limited' };
    }
    if (!(await claimRefreshSlot(deps.db, slot, now))) return { type: 'rate_limited' };
    const result = await applySignals(deps, leadId, {
      caller: 'refresh',
      accountId,
      inline: true,
      signal: options.signal ?? AbortSignal.timeout(REFRESH_BUDGET_MS),
      ...options.applyOptions,
    });
    if (result.outcome !== 'checked') return { type: 'not_eligible' };
    return { type: 'checked', emailsAvailable: result.emailsAvailable, replied: result.replied, markedReplied: result.markedReplied };
  } catch (error) {
    log.warn('lead page refresh failed', { event: 'dashboard.lead_refresh_failed', accountId, leadId, errorCode: errorCode(error) });
    return { type: 'failed' };
  }
}
