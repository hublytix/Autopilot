import 'server-only';
import { z } from 'zod';
import { ACCOUNT_PROCESSING_STATES, CONNECTION_STATUSES, LOGGING_MODES, type AccountProcessingState, type ConnectionStatus, type LoggingMode } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { canReadEmails } from '@/server/hubspot/scopes';
import { displayZone } from './format';

// The account facts every dashboard page reads (PLAN §6.1, §7.5): the stored (derived) processing
// state and its inputs, the zone times are shown in, the logging mode, the HubSpot connection and the
// follow-up setting. One statement, by the OwnerScope's account id only.

export interface AccountContext {
  readonly accountId: string;
  readonly processingState: AccountProcessingState;
  /** Logical; when the stored state last changed (bound from the Clock). */
  readonly processingStateChangedAt: Date;
  readonly pausedAt: Date | null;
  readonly onboardingCompletedAt: Date | null;
  readonly trialEndsAt: Date;
  /** The zone times are shown in (UTC when the account has none or an unusable one). */
  readonly zone: string;
  readonly loggingMode: LoggingMode;
  readonly purgeAfter: Date | null;
  readonly portalId: string;
  readonly connection: {
    /** Null when the account has no connection row (treated as disconnected, §6.1). */
    readonly status: ConnectionStatus | null;
    readonly scopes: readonly string[];
    readonly uiDomain: string | null;
  };
  /** `settings.followups_enabled` (true when the account has no settings row: D-33's default). */
  readonly followupsEnabled: boolean;
}

const contextRow = z.object({
  processing_state: z.enum(ACCOUNT_PROCESSING_STATES),
  processing_state_changed_at: z.date(),
  paused_at: z.date().nullable(),
  onboarding_completed_at: z.date().nullable(),
  trial_ends_at: z.date(),
  timezone: z.string().nullable(),
  logging_mode: z.enum(LOGGING_MODES),
  purge_after: z.date().nullable(),
  hubspot_portal_id: z.string(),
  connection_status: z.enum(CONNECTION_STATUSES).nullable(),
  scopes: z.array(z.string()).nullable(),
  ui_domain: z.string().nullable(),
  followups_enabled: z.boolean().nullable(),
});

/** The account's context; throws when the account is gone (an OwnerScope always names an existing one). */
export async function loadAccountContext(db: Db, accountId: string): Promise<AccountContext> {
  const raw = await db.maybeOne(
    `select a.processing_state, a.processing_state_changed_at, a.paused_at, a.onboarding_completed_at, a.trial_ends_at, a.timezone,
            a.logging_mode, a.purge_after, a.hubspot_portal_id,
            c.status as connection_status, c.scopes, c.ui_domain, s.followups_enabled
       from accounts a
       left join hubspot_connections c on c.account_id = a.id
       left join settings s on s.account_id = a.id
      where a.id = $1`,
    [accountId],
  );
  if (raw === null) throw new Error('dashboard_account_missing');
  const row = contextRow.parse(raw);
  return {
    accountId,
    processingState: row.processing_state,
    processingStateChangedAt: row.processing_state_changed_at,
    pausedAt: row.paused_at,
    onboardingCompletedAt: row.onboarding_completed_at,
    trialEndsAt: row.trial_ends_at,
    zone: displayZone(row.timezone),
    loggingMode: row.logging_mode,
    purgeAfter: row.purge_after,
    portalId: row.hubspot_portal_id,
    connection: { status: row.connection_status, scopes: row.scopes ?? [], uiDomain: row.ui_domain },
    followupsEnabled: row.followups_enabled ?? true,
  };
}

/** The connection can be used (reads, refresh, processing). */
export function connectionActive(context: AccountContext): boolean {
  return context.connection.status === 'active';
}

/** The grant includes `sales-email-read` (whatever the connection's state). */
export function emailScopeGranted(context: Pick<AccountContext, 'connection'>): boolean {
  return canReadEmails(context.connection.scopes);
}

/** HubSpot logs the leads' replies for this account (D-37's rule: logging_mode log_all with the email scope). */
export function repliesLogged(context: Pick<AccountContext, 'loggingMode' | 'connection'>): boolean {
  return context.loggingMode === 'log_all' && emailScopeGranted(context);
}
