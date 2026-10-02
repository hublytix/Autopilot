import 'server-only';
import { z } from 'zod';
import type { ContactStopFacts, StopState } from '@/server/domain/stops';
import { ACCOUNT_PROCESSING_STATES, CONNECTION_STATUSES, STOP_REASONS } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { supersededSql } from '@/server/services/notifications/supersede';

// The database half of evaluateStops' input (PLAN §6.2, §9.5 step 2): the lead's stored stop, its
// dismiss and reply times, the account's state, its connection, the follow-up setting, and D-44's
// dynamic supersede (supersededSql, the same rule as the follow_up reservation predicate: a newer
// non-test lead of the same contact already notified). The contact facts come from the HubSpot read
// (step 3).

const rowSchema = z.object({
  is_test: z.boolean(),
  stop_reason: z.enum(STOP_REASONS).nullable(),
  dismissed_at: z.date().nullable(),
  replied_at: z.date().nullable(),
  processing_state: z.enum(ACCOUNT_PROCESSING_STATES),
  connection_status: z.enum(CONNECTION_STATUSES).nullable(),
  followups_enabled: z.boolean(),
  superseded: z.boolean(),
});

export interface LoadStopStateInput {
  readonly leadId: string;
  /** Only a lead of this account. */
  readonly accountId?: string | undefined;
  /** The follow-up about to be sent (the job's n). */
  readonly followUpNumber: number;
  /** The contact read, when it has happened. */
  readonly contact?: ContactStopFacts | null | undefined;
}

/** The lead's StopState, or null when the lead is gone. */
export async function loadStopState(db: Db, input: LoadStopStateInput): Promise<StopState | null> {
  const raw = await db.maybeOne(
    `select l.is_test, l.stop_reason, l.dismissed_at, l.replied_at, a.processing_state, c.status as connection_status,
            coalesce(s.followups_enabled, false) as followups_enabled, ${supersededSql('l')} as superseded
       from leads l
       join accounts a on a.id = l.account_id
       left join hubspot_connections c on c.account_id = l.account_id
       left join settings s on s.account_id = l.account_id
      where l.id = $1 and ($2::uuid is null or l.account_id = $2::uuid)`,
    [input.leadId, input.accountId ?? null],
  );
  if (raw === null) return null;
  const row = rowSchema.parse(raw);
  return {
    isTest: row.is_test,
    stopReason: row.stop_reason,
    dismissedAt: row.dismissed_at,
    repliedAt: row.replied_at,
    accountState: row.processing_state,
    connectionStatus: row.connection_status,
    followupsEnabled: row.followups_enabled,
    followUpNumber: input.followUpNumber,
    superseded: row.superseded,
    contact: input.contact ?? null,
  };
}
