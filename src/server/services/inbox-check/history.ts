import 'server-only';
import { errorCode, isAppError } from '@/server/domain/errors';
import { canReadEmails } from '@/server/hubspot/scopes';
import { log } from '@/server/obs/log';
import type { PortalHubSpotClient } from '@/server/services/hubspot';

// The inbox check's history step (PLAN §9.7, D-14, HS-INBOX-LOGGING-CHECK-DESIGN step A): two
// `emails/search` counts over the last 30 days, outbound (`EMAIL`) and inbound (`INCOMING_EMAIL`,
// `FORWARDED_EMAIL`), each a `limit=1` search that reads `total`. Read-only and informational: it
// never stops the live test. Without the email scope (D-03 path b) the counts are `unavailable`,
// whether the stored grant lacks it or HubSpot answers 403 MISSING_SCOPES.

export const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type EmailHistory =
  | { readonly status: 'ok'; readonly outbound: number; readonly inbound: number }
  | { readonly status: 'unavailable' }
  /** Another HubSpot error: shown as "couldn't count just now". */
  | { readonly status: 'error'; readonly code: string };

export interface ReadEmailHistoryInput {
  /** The connection's granted scopes. */
  readonly scopes: readonly string[];
  /** `$now`. */
  readonly now: Date;
  readonly signal?: AbortSignal | undefined;
}

export async function readEmailHistory(client: PortalHubSpotClient, input: ReadEmailHistoryInput): Promise<EmailHistory> {
  if (!canReadEmails(input.scopes)) return { status: 'unavailable' };
  const since = new Date(input.now.getTime() - HISTORY_WINDOW_MS);
  try {
    const outbound = await client.searchEmailsCount({ direction: 'outbound', since }, { signal: input.signal });
    const inbound = await client.searchEmailsCount({ direction: 'inbound', since }, { signal: input.signal });
    return { status: 'ok', outbound, inbound };
  } catch (error) {
    if (isAppError(error) && error.code === 'hubspot_missing_scopes') return { status: 'unavailable' };
    const code = errorCode(error);
    log.warn('inbox history not read', { event: 'inbox_check.history_failed', accountId: client.accountId, code });
    return { status: 'error', code };
  }
}
