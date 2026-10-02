import 'server-only';
import { DateTime } from 'luxon';
import type { AuthUser, Deps } from '@/server/ports';
import { loadAdminOverview, recordAdminView, type AdminOverview, type CodeCount } from '@/server/services/admin';

// /admin's read side (PLAN §7.5, brief §5.12): the caller passes the admin user requireAdminPage
// returned (so this is never reached without one); every call writes the `admin.view` audit row first,
// then reads the overview. Times are shown in UTC; money in US dollars. Ids, states, codes and counts
// only: nothing here can carry content (the overview never selects any).

export interface AdminPortalView {
  readonly accountId: string;
  readonly portalId: string;
  readonly processingState: string;
  readonly connectionStatus: string;
  readonly onboarding: 'complete' | 'incomplete';
  readonly paused: boolean;
  readonly ownerBound: boolean;
  readonly trialEnds: string;
  readonly trialActive: boolean;
  readonly subscriptionStatus: string;
  readonly graceUntil: string | null;
  readonly lastWebhook: string;
  readonly lastPolled: string;
  readonly purgeAfter: string | null;
}

export interface AdminPageView {
  readonly generatedAt: string;
  readonly portals: readonly AdminPortalView[];
  readonly portalsTruncated: boolean;
  readonly processingStateCounts: readonly CodeCount[];
  readonly webhooks: { readonly hubspot: string; readonly razorpay: string };
  readonly failedJobs: {
    readonly total7d: number;
    readonly byKind7d: readonly CodeCount[];
    readonly recent: readonly { readonly jobId: string; readonly kind: string; readonly errorCode: string; readonly accountId: string; readonly finishedAt: string }[];
  };
  readonly jobErrorCodes7d: readonly CodeCount[];
  readonly aiOutcomes7d: readonly CodeCount[];
  readonly ai: {
    readonly last7d: { readonly calls: number; readonly refusals: number; readonly cost: string };
    readonly last30d: { readonly calls: number; readonly refusals: number; readonly cost: string };
  };
  readonly reencryptBacklog: number;
  readonly notifications: { readonly failed7dByKind: readonly CodeCount[]; readonly stuckSending: number };
}

const NEVER = 'never';

export function formatUtc(at: Date): string {
  return DateTime.fromJSDate(at, { zone: 'UTC' }).toFormat("yyyy-LL-dd HH:mm 'UTC'");
}

function utcOr(at: Date | null, fallback: string): string {
  return at === null ? fallback : formatUtc(at);
}

/** Micro-dollars as "$12.35" (two decimals, rounded half up). */
export function formatUsd(microUsd: number): string {
  return `$${(Math.round(microUsd / 10_000) / 100).toFixed(2)}`;
}

function present(overview: AdminOverview): AdminPageView {
  const now = overview.now;
  return {
    generatedAt: formatUtc(now),
    portals: overview.portals.map((row) => ({
      accountId: row.accountId,
      portalId: row.portalId,
      processingState: row.processingState,
      connectionStatus: row.connectionStatus ?? 'none',
      onboarding: row.onboardingComplete ? 'complete' : 'incomplete',
      paused: row.paused,
      ownerBound: row.ownerBound,
      trialEnds: formatUtc(row.trialEndsAt),
      trialActive: row.trialEndsAt.getTime() > now.getTime(),
      subscriptionStatus: row.subscriptionStatus ?? 'none',
      graceUntil: row.graceUntil === null ? null : formatUtc(row.graceUntil),
      lastWebhook: utcOr(row.lastWebhookAt, NEVER),
      lastPolled: utcOr(row.lastPolledAt, NEVER),
      purgeAfter: row.purgeAfter === null ? null : formatUtc(row.purgeAfter),
    })),
    portalsTruncated: overview.portalsTruncated,
    processingStateCounts: overview.processingStateCounts,
    webhooks: { hubspot: utcOr(overview.webhooks.hubspot, NEVER), razorpay: utcOr(overview.webhooks.razorpay, NEVER) },
    failedJobs: {
      total7d: overview.failedJobs.total7d,
      byKind7d: overview.failedJobs.byKind7d,
      recent: overview.failedJobs.recent.map((job) => ({
        jobId: job.jobId,
        kind: job.kind,
        errorCode: job.errorCode ?? 'none',
        accountId: job.accountId ?? 'none',
        finishedAt: utcOr(job.finishedAt, 'unknown'),
      })),
    },
    jobErrorCodes7d: overview.jobErrorCodes7d,
    aiOutcomes7d: overview.aiOutcomes7d,
    ai: {
      last7d: { calls: overview.ai.last7d.calls, refusals: overview.ai.last7d.refusals, cost: formatUsd(overview.ai.last7d.costMicroUsd) },
      last30d: { calls: overview.ai.last30d.calls, refusals: overview.ai.last30d.refusals, cost: formatUsd(overview.ai.last30d.costMicroUsd) },
    },
    reencryptBacklog: overview.reencryptBacklog,
    notifications: overview.notifications,
  };
}

/** /admin for a verified admin: records the view, then reads the overview. */
export async function adminPageView(deps: Deps, admin: AuthUser): Promise<AdminPageView> {
  await recordAdminView(deps.db, admin.userId);
  return present(await loadAdminOverview(deps));
}
