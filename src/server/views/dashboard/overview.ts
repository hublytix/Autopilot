import 'server-only';
import { z } from 'zod';
import { currentSubscription, entitlementOf, type SubscriptionSnapshot } from '@/server/domain/entitlement';
import type { AccountProcessingState, LeadDisplayStatus } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { canReadEmails } from '@/server/hubspot/scopes';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { localDay } from '@/server/services/drafting/cap';
import { aiAccountShareMicroUsd, aiAccountSpendTodayMicroUsd, aiDailyBudgetMicroUsd, aiSpendTodayMicroUsd } from '@/server/services/drafting/budget';
import { NotificationKeys } from '@/server/services/notifications/predicates';
import { connectionActive, loadAccountContext, type AccountContext } from './account';
import { DAY_MS, daysUntil, formatDateInZone, formatInZone } from './format';
import {
  leadSelect,
  leadNameOf,
  leadRecordUrl,
  leadStatusOf,
  notProcessedReasonOf,
  parseLeadRecord,
  type LeadNameView,
  type NotProcessedReason,
} from './leads';

// The /dashboard read model (PLAN §7.5, §6.1, §9.6, D-32, D-42, D-48): the status card, the banners
// and the most recent leads. Database reads only (no HubSpot call, no write, no alert), all by the
// OwnerScope's account id. Copy lives with the page (src/app/dashboard), which turns these codes and
// numbers into plain words; nothing here is estimated (law 3): every count is a count of rows.

/** Leads listed on the dashboard, newest first. */
export const RECENT_LEADS_LIMIT = 50;
/** How far back "recent" banners (needs touch, earlier deferred leads, a resume) look. */
export const RECENT_WINDOW_MS = 7 * DAY_MS;
/** The trial-ending banner shows in the trial's last days without a subscription. */
export const TRIAL_ENDING_DAYS = 3;

/** The account's processing state in the owner's words (the page has the copy). */
export type AccountStatusState = 'active' | 'paused' | 'disconnected' | 'billing_inactive' | 'setup_incomplete';

export interface StatusCardView {
  readonly state: AccountStatusState;
  /** Whole days left in the free trial while it runs; null otherwise. */
  readonly trialDaysLeft: number | null;
  /** For `disconnected`: whole days left to reconnect before the account's data is deleted; null when no deletion is scheduled. */
  readonly reconnectDaysLeft: number | null;
  /** The deletion date ("6 Nov 2026"), with reconnectDaysLeft. */
  readonly purgeOn: string | null;
  /** "Tue 6 Oct, 10:15" while paused. */
  readonly pausedSince: string | null;
}

export type DashboardBanner =
  /** The connection is not active (or a reconnect sign-in link brought the owner here: `requested`). */
  | { readonly type: 'reconnect'; readonly connected: boolean; readonly daysLeft: number | null; readonly purgeOn: string | null }
  /** Setup is not finished (shown only when the page cannot send the owner back to it). */
  | { readonly type: 'setup_incomplete' }
  | { readonly type: 'billing_inactive' }
  /** A failed payment inside its grace period (D-18). */
  | { readonly type: 'payment_grace'; readonly until: string }
  | { readonly type: 'trial_ending'; readonly daysLeft: number }
  /** Paused now: leads already received when it was paused, and skipped since. */
  | { readonly type: 'paused'; readonly since: string; readonly skippedLeads: number }
  /** Resumed recently: what the pause it ended left out. */
  | { readonly type: 'resumed'; readonly pausedFrom: string; readonly skippedLeads: number }
  /** The daily drafted-lead cap (D-36): reached today, and/or recent leads it deferred. */
  | { readonly type: 'daily_cap'; readonly limit: number; readonly reachedToday: boolean; readonly deferredToday: number; readonly deferredEarlier: number }
  /** The AI spend limit is reached for today: new leads get the starter draft (D-63, D-68). */
  | { readonly type: 'ai_limit' }
  /** Recent leads whose email to the owner carried a starter draft that needs their touch. */
  | { readonly type: 'needs_touch'; readonly count: number }
  /** How the owner's mailbox logs to HubSpot (D-14, D-34, D-37): what cannot be confirmed. */
  | { readonly type: 'logging'; readonly mode: 'none' | 'sends_only' | 'unknown' }
  /** The connection lacks the email-read scope: no logged email can be read (D-03 path b). */
  | { readonly type: 'email_scope_missing' }
  /** The inbox-logging check is still running. */
  | { readonly type: 'inbox_check_pending' };

export type DashboardBannerType = DashboardBanner['type'];

export interface RecentLeadView {
  readonly id: string;
  readonly name: LeadNameView;
  readonly status: LeadDisplayStatus;
  readonly statusLabel: string;
  /** Why it was not processed, when its status is "Not processed" (deferred leads: `daily_cap`). */
  readonly notProcessed: NotProcessedReason | null;
  /** The starter draft needs the owner's touch. */
  readonly needsTouch: boolean;
  /** "Tue 6 Oct, 10:15" in the portal's zone. */
  readonly receivedAt: string;
  readonly recordUrl: string | null;
}

export interface DashboardView {
  readonly onboardingComplete: boolean;
  readonly connectionActive: boolean;
  readonly status: StatusCardView;
  readonly banners: readonly DashboardBanner[];
  readonly leads: readonly RecentLeadView[];
  /** The zone times are shown in. */
  readonly zone: string;
}

export interface DashboardViewOptions {
  /** `?reconnect=1`: a reconnect sign-in link brought the owner here; the Reconnect button shows whatever the connection's state (M3). */
  readonly reconnectRequested?: boolean | undefined;
}

function statusState(state: AccountProcessingState): AccountStatusState {
  switch (state) {
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    case 'inactive':
      return 'billing_inactive';
    case 'onboarding':
      return 'setup_incomplete';
    case 'revoked':
    case 'disconnected':
      return 'disconnected';
  }
}

const subscriptionRow = z.object({ id: z.string(), status: z.string(), grace_until: z.date().nullable(), created_at: z.date() });

async function loadCurrentSubscription(db: Db, accountId: string): Promise<SubscriptionSnapshot | null> {
  const rows = await db.query(`select id, status, grace_until, created_at from subscriptions where account_id = $1`, [accountId]);
  return currentSubscription(
    rows.map((raw) => {
      const row = subscriptionRow.parse(raw);
      return { id: row.id, status: row.status, graceUntil: row.grace_until, createdAt: row.created_at };
    }),
  );
}

const countRow = z.object({ count: z.number().int() });

async function count(db: Db, sql: string, params: readonly unknown[]): Promise<number> {
  return countRow.parse(await db.one(sql, params)).count;
}

/** Leads lead_process skipped (status `skipped`) in [from, to): the leads a pause left out once received. */
async function skippedLeadsBetween(db: Db, accountId: string, from: Date, to: Date | null): Promise<number> {
  return count(
    db,
    `select count(distinct l.id)::int as count
       from leads l join scheduled_jobs j on j.lead_id = l.id and j.kind = 'lead_process' and j.status = 'skipped'
      where l.account_id = $1 and not l.is_test and l.processing_state = 'skipped'
        and j.finished_at >= $2 and ($3::timestamptz is null or j.finished_at <= $3::timestamptz)`,
    [accountId, from, to],
  );
}

const pauseAuditRow = z.object({ action: z.string(), paused_at: z.string().nullable() });

/**
 * The pause the owner's latest Resume ended (`account.resumed`, meta pausedAt), when that Resume is
 * the latest pause/resume entry, the account is active again and its state changed within the
 * recent window (the transition the Resume made). Audit order is the identity column; `at` is an
 * audit-only column and never decides anything (D-28).
 */
async function recentResume(db: Db, context: AccountContext, now: Date): Promise<Date | null> {
  if (context.pausedAt !== null || context.processingState !== 'active') return null;
  if (now.getTime() - context.processingStateChangedAt.getTime() > RECENT_WINDOW_MS) return null;
  const raw = await db.maybeOne(
    `select action, meta ->> 'pausedAt' as paused_at from audit_log
      where account_id = $1 and action in ('account.paused', 'account.resumed')
      order by id desc limit 1`,
    [context.accountId],
  );
  if (raw === null) return null;
  const row = pauseAuditRow.parse(raw);
  if (row.action !== 'account.resumed' || row.paused_at === null) return null;
  const pausedAt = new Date(row.paused_at);
  return Number.isNaN(pausedAt.getTime()) ? null : pausedAt;
}

async function dailyCapBanner(deps: Pick<Deps, 'db' | 'env'>, context: AccountContext, now: Date): Promise<DashboardBanner | null> {
  const day = localDay(now, context.zone);
  const windowStart = new Date(now.getTime() - RECENT_WINDOW_MS);
  const row = z
    .object({ today: z.number().int(), earlier: z.number().int(), reached: z.boolean() })
    .parse(
      await deps.db.one(
        `select count(*) filter (where coalesce(l.classified_at, l.received_at) >= $2 and coalesce(l.classified_at, l.received_at) < $3)::int as today,
                count(*) filter (where coalesce(l.classified_at, l.received_at) >= $4 and coalesce(l.classified_at, l.received_at) < $2)::int as earlier,
                exists (select 1 from notifications_sent n where n.dedupe_key = $5) as reached
           from leads l
          where l.account_id = $1 and not l.is_test and l.processing_state = 'deferred' and l.dismissed_at is null`,
        [context.accountId, day.start, day.end, windowStart, NotificationKeys.leadCap(context.accountId, day.date)],
      ),
    );
  const reachedToday = row.reached || row.today > 0;
  if (!reachedToday && row.earlier === 0) return null;
  return { type: 'daily_cap', limit: deps.env.MAX_DRAFTED_LEADS_PER_DAY, reachedToday, deferredToday: row.today, deferredEarlier: row.earlier };
}

/** Today's AI spend has reached the daily budget or the account's share (read only: no alert is raised here). */
async function aiLimitReached(deps: Pick<Deps, 'db' | 'env'>, accountId: string, now: Date): Promise<boolean> {
  if ((await aiSpendTodayMicroUsd(deps.db, now)) >= aiDailyBudgetMicroUsd(deps.env)) return true;
  return (await aiAccountSpendTodayMicroUsd(deps.db, accountId, now)) >= aiAccountShareMicroUsd(deps.env);
}

async function banners(deps: Pick<Deps, 'db' | 'env'>, context: AccountContext, now: Date, options: DashboardViewOptions): Promise<DashboardBanner[]> {
  const { db } = deps;
  const out: DashboardBanner[] = [];
  const connected = connectionActive(context);

  if (!connected || context.processingState === 'revoked' || context.processingState === 'disconnected' || options.reconnectRequested === true) {
    out.push({
      type: 'reconnect',
      connected,
      daysLeft: context.purgeAfter === null ? null : daysUntil(context.purgeAfter, now),
      purgeOn: context.purgeAfter === null ? null : formatDateInZone(context.purgeAfter, context.zone),
    });
  }
  if (context.onboardingCompletedAt === null) out.push({ type: 'setup_incomplete' });

  // Billing (D-18): inactive now, a failed payment inside its grace, or the trial's last days with no subscription.
  const subscription = await loadCurrentSubscription(db, context.accountId);
  const entitlement = entitlementOf({ trialEndsAt: context.trialEndsAt }, subscription, now);
  if (context.processingState === 'inactive') out.push({ type: 'billing_inactive' });
  else if (entitlement.reason === 'grace' && subscription?.graceUntil !== null && subscription?.graceUntil !== undefined) {
    out.push({ type: 'payment_grace', until: formatInZone(subscription.graceUntil, context.zone, now) });
  } else if (entitlement.reason === 'trial' && context.onboardingCompletedAt !== null) {
    const daysLeft = daysUntil(context.trialEndsAt, now);
    const subscribed = subscription !== null && (subscription.status === 'authenticated' || subscription.status === 'active');
    if (!subscribed && daysLeft <= TRIAL_ENDING_DAYS) out.push({ type: 'trial_ending', daysLeft });
  }

  // Pause (PLAN §9.6, D-42): now, or the one the latest Resume ended.
  if (context.pausedAt !== null) {
    out.push({ type: 'paused', since: formatInZone(context.pausedAt, context.zone, now), skippedLeads: await skippedLeadsBetween(db, context.accountId, context.pausedAt, null) });
  } else {
    const pausedFrom = await recentResume(db, context, now);
    if (pausedFrom !== null) {
      out.push({
        type: 'resumed',
        pausedFrom: formatInZone(pausedFrom, context.zone, now),
        skippedLeads: await skippedLeadsBetween(db, context.accountId, pausedFrom, context.processingStateChangedAt),
      });
    }
  }

  const cap = await dailyCapBanner(deps, context, now);
  if (cap !== null) out.push(cap);
  if (context.processingState === 'active' && (await aiLimitReached(deps, context.accountId, now))) out.push({ type: 'ai_limit' });
  const needsTouch = await count(
    db,
    `select count(*)::int as count from leads l
      where l.account_id = $1 and not l.is_test and l.needs_touch and l.dismissed_at is null
        and coalesce(l.first_notified_at, l.received_at) >= $2`,
    [context.accountId, new Date(now.getTime() - RECENT_WINDOW_MS)],
  );
  if (needsTouch > 0) out.push({ type: 'needs_touch', count: needsTouch });

  // What HubSpot can confirm (D-14, D-37): the email scope first, then the inbox check, then the mode.
  if (context.onboardingCompletedAt !== null && connected) {
    const inboxCheckOpen = await count(db, `select count(*)::int as count from inbox_checks where account_id = $1 and status = 'open'`, [context.accountId]);
    if (!canReadEmails(context.connection.scopes)) out.push({ type: 'email_scope_missing' });
    else if (inboxCheckOpen > 0) out.push({ type: 'inbox_check_pending' });
    else if (context.loggingMode !== 'log_all') out.push({ type: 'logging', mode: context.loggingMode });
  }
  return out;
}

async function recentLeads(db: Db, context: AccountContext, now: Date): Promise<RecentLeadView[]> {
  const rows = await db.query(
    `select ${leadSelect('$2')}
       from leads l left join lead_messages m on m.lead_id = l.id and m.account_id = l.account_id
      where l.account_id = $1 and not l.is_test
      order by l.received_at desc, l.id desc
      limit ${RECENT_LEADS_LIMIT}`,
    [context.accountId, now],
  );
  return rows.map((raw) => {
    const lead = parseLeadRecord(raw);
    const { status, label } = leadStatusOf(lead, context, now);
    return {
      id: lead.id,
      name: leadNameOf(lead),
      status,
      statusLabel: label,
      notProcessed: notProcessedReasonOf(lead, status),
      needsTouch: lead.needsTouch && status !== 'dismissed',
      receivedAt: formatInZone(lead.receivedAt, context.zone, now),
      recordUrl: leadRecordUrl(lead, context),
    };
  });
}

function statusCard(context: AccountContext, now: Date): StatusCardView {
  const state = statusState(context.processingState);
  const trial = now.getTime() < context.trialEndsAt.getTime();
  return {
    state,
    trialDaysLeft: trial ? daysUntil(context.trialEndsAt, now) : null,
    reconnectDaysLeft: state === 'disconnected' && context.purgeAfter !== null ? daysUntil(context.purgeAfter, now) : null,
    purgeOn: state === 'disconnected' && context.purgeAfter !== null ? formatDateInZone(context.purgeAfter, context.zone) : null,
    pausedSince: context.pausedAt === null ? null : formatInZone(context.pausedAt, context.zone, now),
  };
}

/** The dashboard for the owner's account. */
export async function dashboardView(scope: OwnerScope, deps: Pick<Deps, 'db' | 'env' | 'clock'>, options: DashboardViewOptions = {}): Promise<DashboardView> {
  const now = deps.clock.now();
  const context = await loadAccountContext(deps.db, scope.accountId);
  return {
    onboardingComplete: context.onboardingCompletedAt !== null,
    connectionActive: connectionActive(context),
    status: statusCard(context, now),
    banners: await banners(deps, context, now, options),
    leads: await recentLeads(deps.db, context, now),
    zone: context.zone,
  };
}
