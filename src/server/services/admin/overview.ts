import 'server-only';
import { z } from 'zod';
import { currentSubscription } from '@/server/domain/entitlement';
import { ACCOUNT_PROCESSING_STATES, CONNECTION_STATUSES, type AccountProcessingState, type ConnectionStatus } from '@/server/domain/types';
import type { Deps } from '@/server/ports';
import { tokenCipher } from '@/server/services/hubspot';

// The /admin overview (PLAN §7.5, brief §5.12, D-36, D-51): portals and their processing states,
// trial and billing status, the last webhooks received, failed jobs, error counts, AI refusals and
// cost, the re-encryption backlog and failed notifications. Ids, states, codes, counts and times
// only: NO content (no names, email addresses, messages, drafts, hub domains), whatever the table
// holds. Windows are measured from the Clock on logical columns; the last webhook per provider is
// `webhook_events.recorded_at`, the instant the handler bound from the Clock (D-82; never the
// audit-only `received_at`, D-28).

export const ADMIN_PORTALS_LIMIT = 200;
export const ADMIN_RECENT_FAILED_JOBS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A reservation still `sending` this long after its first reservation is waiting on the sweeper. */
export const STUCK_SENDING_AFTER_MS = 60 * 60 * 1000;

export interface AdminPortalRow {
  readonly accountId: string;
  readonly portalId: string;
  readonly processingState: AccountProcessingState;
  readonly connectionStatus: ConnectionStatus | null;
  readonly onboardingComplete: boolean;
  readonly paused: boolean;
  readonly ownerBound: boolean;
  readonly trialEndsAt: Date;
  /** The current subscription's status (latest logical created_at), or null when there is none. */
  readonly subscriptionStatus: string | null;
  readonly graceUntil: Date | null;
  readonly lastWebhookAt: Date | null;
  readonly lastPolledAt: Date | null;
  readonly purgeAfter: Date | null;
  readonly createdAt: Date;
}

export interface CodeCount {
  readonly code: string;
  readonly count: number;
}

export interface FailedJobRow {
  readonly jobId: string;
  readonly kind: string;
  readonly errorCode: string | null;
  readonly accountId: string | null;
  readonly finishedAt: Date | null;
}

export interface AiWindow {
  readonly calls: number;
  readonly refusals: number;
  readonly costMicroUsd: number;
}

export interface AdminOverview {
  readonly now: Date;
  readonly portals: readonly AdminPortalRow[];
  /** More accounts exist than the list shows. */
  readonly portalsTruncated: boolean;
  readonly processingStateCounts: readonly CodeCount[];
  readonly webhooks: { readonly hubspot: Date | null; readonly razorpay: Date | null };
  readonly failedJobs: { readonly total7d: number; readonly byKind7d: readonly CodeCount[]; readonly recent: readonly FailedJobRow[] };
  /** `scheduled_jobs.last_error_code` of jobs that finished (or were created) in the last 7 days. */
  readonly jobErrorCodes7d: readonly CodeCount[];
  /** `ai_calls.outcome` other than ok, last 7 days. */
  readonly aiOutcomes7d: readonly CodeCount[];
  readonly ai: { readonly last7d: AiWindow; readonly last30d: AiWindow };
  /** Connections holding a token ciphertext under a key id that is not the current one (D-51). */
  readonly reencryptBacklog: number;
  readonly notifications: { readonly failed7dByKind: readonly CodeCount[]; readonly stuckSending: number };
}

const portalRow = z.object({
  id: z.string(),
  hubspot_portal_id: z.string(),
  processing_state: z.enum(ACCOUNT_PROCESSING_STATES),
  connection_status: z.enum(CONNECTION_STATUSES).nullable(),
  onboarding_completed_at: z.date().nullable(),
  paused_at: z.date().nullable(),
  owner_user_id: z.string().nullable(),
  trial_ends_at: z.date(),
  last_webhook_at: z.date().nullable(),
  last_polled_at: z.date().nullable(),
  purge_after: z.date().nullable(),
  created_at: z.date(),
});

const subscriptionRow = z.object({ id: z.string(), account_id: z.string(), status: z.string(), grace_until: z.date().nullable(), created_at: z.date() });
const codeCountRow = z.object({ code: z.string(), count: z.number() });
const failedJobRow = z.object({ id: z.string(), kind: z.string(), last_error_code: z.string().nullable(), account_id: z.string().nullable(), finished_at: z.date().nullable() });
const aiWindowRow = z.object({ calls: z.number(), refusals: z.number(), cost: z.number() });

function codeCounts(rows: readonly unknown[]): CodeCount[] {
  return rows.map((raw) => {
    const row = codeCountRow.parse(raw);
    return { code: row.code, count: row.count };
  });
}

async function loadPortals(deps: Pick<Deps, 'db'>): Promise<{ portals: AdminPortalRow[]; truncated: boolean }> {
  const raw = await deps.db.query(
    `select a.id, a.hubspot_portal_id, a.processing_state, c.status as connection_status, a.onboarding_completed_at, a.paused_at,
            a.owner_user_id, a.trial_ends_at, c.last_webhook_at, c.last_polled_at, a.purge_after, a.created_at
       from accounts a left join hubspot_connections c on c.account_id = a.id
      order by a.created_at desc, a.id
      limit ${ADMIN_PORTALS_LIMIT + 1}`,
  );
  const rows = raw.map((row) => portalRow.parse(row));
  const shown = rows.slice(0, ADMIN_PORTALS_LIMIT);
  const ids = shown.map((row) => row.id);
  const subscriptions = ids.length === 0 ? [] : (await deps.db.query(`select id, account_id, status, grace_until, created_at from subscriptions where account_id = any($1::uuid[])`, [ids])).map((row) => subscriptionRow.parse(row));
  return {
    truncated: rows.length > ADMIN_PORTALS_LIMIT,
    portals: shown.map((row) => {
      const current = currentSubscription(
        subscriptions.filter((sub) => sub.account_id === row.id).map((sub) => ({ id: sub.id, status: sub.status, graceUntil: sub.grace_until, createdAt: sub.created_at })),
      );
      return {
        accountId: row.id,
        portalId: row.hubspot_portal_id,
        processingState: row.processing_state,
        connectionStatus: row.connection_status,
        onboardingComplete: row.onboarding_completed_at !== null,
        paused: row.paused_at !== null,
        ownerBound: row.owner_user_id !== null,
        trialEndsAt: row.trial_ends_at,
        subscriptionStatus: current?.status ?? null,
        graceUntil: current?.graceUntil ?? null,
        lastWebhookAt: row.last_webhook_at,
        lastPolledAt: row.last_polled_at,
        purgeAfter: row.purge_after,
        createdAt: row.created_at,
      };
    }),
  };
}

async function aiWindow(deps: Pick<Deps, 'db'>, since: Date, now: Date): Promise<AiWindow> {
  const row = aiWindowRow.parse(
    await deps.db.one(
      `select count(*)::int as calls, (count(*) filter (where outcome = 'refusal' or refusal_category is not null))::int as refusals,
              coalesce(sum(cost_micro_usd), 0)::bigint::float8 as cost
         from ai_calls where created_at >= $1 and created_at <= $2`,
      [since, now],
    ),
  );
  return { calls: row.calls, refusals: row.refusals, costMicroUsd: row.cost };
}

/** Everything /admin shows (see the header). Read-only. */
export async function loadAdminOverview(deps: Pick<Deps, 'db' | 'env' | 'clock'>): Promise<AdminOverview> {
  const db = deps.db;
  const now = deps.clock.now();
  const since7 = new Date(now.getTime() - 7 * DAY_MS);
  const since30 = new Date(now.getTime() - 30 * DAY_MS);

  const { portals, truncated } = await loadPortals(deps);
  const processingStateCounts = codeCounts(await db.query(`select processing_state as code, count(*)::int as count from accounts group by processing_state order by processing_state`));

  const webhookRows = await db.query<{ provider: string; last: Date | null }>(`select provider, max(recorded_at) as last from webhook_events group by provider`);
  const lastWebhook = (provider: string): Date | null => webhookRows.find((row) => row.provider === provider)?.last ?? null;

  const failedByKind = codeCounts(
    await db.query(
      `select kind as code, count(*)::int as count from scheduled_jobs where status = 'failed' and finished_at >= $1 and finished_at <= $2 group by kind order by count desc, kind`,
      [since7, now],
    ),
  );
  const recentFailed = (
    await db.query(
      `select id, kind, last_error_code, account_id, finished_at from scheduled_jobs where status = 'failed'
        order by finished_at desc nulls last, id limit ${ADMIN_RECENT_FAILED_JOBS}`,
    )
  ).map((raw) => {
    const row = failedJobRow.parse(raw);
    return { jobId: row.id, kind: row.kind, errorCode: row.last_error_code, accountId: row.account_id, finishedAt: row.finished_at };
  });
  const jobErrorCodes7d = codeCounts(
    await db.query(
      `select last_error_code as code, count(*)::int as count from scheduled_jobs
        where last_error_code is not null and coalesce(finished_at, created_at) >= $1 and coalesce(finished_at, created_at) <= $2
        group by last_error_code order by count desc, last_error_code limit 50`,
      [since7, now],
    ),
  );
  const aiOutcomes7d = codeCounts(
    await db.query(
      `select outcome as code, count(*)::int as count from ai_calls where outcome <> 'ok' and created_at >= $1 and created_at <= $2
        group by outcome order by count desc, outcome`,
      [since7, now],
    ),
  );

  const kid = tokenCipher(deps.env).currentKid;
  const backlog = await db.one<{ count: number }>(
    `select count(*)::int as count from hubspot_connections
      where (access_token_enc is not null and split_part(access_token_enc, '.', 2) <> $1)
         or (refresh_token_enc is not null and split_part(refresh_token_enc, '.', 2) <> $1)`,
    [kid],
  );

  const failedNotifications = codeCounts(
    await db.query(
      `select kind as code, count(*)::int as count from notifications_sent where status = 'failed' and first_reserved_at >= $1 and first_reserved_at <= $2
        group by kind order by count desc, kind`,
      [since7, now],
    ),
  );
  const stuck = await db.one<{ count: number }>(`select count(*)::int as count from notifications_sent where status = 'sending' and first_reserved_at <= $1`, [
    new Date(now.getTime() - STUCK_SENDING_AFTER_MS),
  ]);

  return {
    now,
    portals,
    portalsTruncated: truncated,
    processingStateCounts,
    webhooks: { hubspot: lastWebhook('hubspot'), razorpay: lastWebhook('razorpay') },
    failedJobs: { total7d: failedByKind.reduce((sum, row) => sum + row.count, 0), byKind7d: failedByKind, recent: recentFailed },
    jobErrorCodes7d,
    aiOutcomes7d,
    ai: { last7d: await aiWindow(deps, since7, now), last30d: await aiWindow(deps, since30, now) },
    reencryptBacklog: backlog.count,
    notifications: { failed7dByKind: failedNotifications, stuckSending: stuck.count },
  };
}
