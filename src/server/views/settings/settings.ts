import 'server-only';
import { firstPaymentAhead } from '@/server/domain/checkout-guard';
import type { AccountProcessingState, ConnectionStatus, SubscriptionStatus } from '@/server/domain/types';
import type { Deps } from '@/server/ports';
import type { OwnerScope } from '@/server/services/auth/owner-scope';
import { billingPageView, type BillingAction } from '@/server/views/billing';
import { loadAccountSubscriptions } from '@/server/services/billing/rows';
import { disconnectBillingOption, type NotCancellableStatus } from '@/server/services/disconnect';
import { PURGE_AFTER_MS } from '@/server/services/accounts/apply-processing-state';
import { loadAccountContext } from '@/server/views/dashboard/account';
import { daysUntil, formatDateInZone, formatInZone } from '@/server/views/dashboard/format';
import { preferencesPageView, type PreferencesPageView } from '@/server/views/onboarding/preferences';

// /dashboard/settings and its Disconnect dialog (PLAN §7.5, brief §5.11, §9.1 step 5): read through
// the OwnerScope's account only, from our own rows (no HubSpot or Razorpay call on a page view; the
// forms page reads HubSpot's list itself). Dates are shown in the account's zone (UTC when unknown).

export interface SelectedFormView {
  readonly id: string;
  readonly name: string;
}

/** The billing choice the Disconnect dialog shows, with its dates in the account's zone. */
export type DisconnectBillingView =
  | {
      readonly type: 'cancellable';
      readonly status: 'authenticated';
      /** The start_at date, if any. */
      readonly firstPaymentOn: string | null;
      /** Nothing charged yet: a start_at still ahead (else the first $49 was due at authorisation, D-82). */
      readonly firstPaymentAhead: boolean;
    }
  | { readonly type: 'cancellable'; readonly status: 'active'; readonly periodEndsOn: string | null }
  | { readonly type: 'not_cancellable'; readonly status: NotCancellableStatus }
  | { readonly type: 'already_cancelled'; readonly endsOn: string | null }
  | { readonly type: 'none' };

export interface SettingsPageView {
  readonly zone: string;
  readonly processingState: AccountProcessingState;
  /** When the owner paused (the pause intent survives other states); null when not paused. */
  readonly pausedSince: string | null;
  readonly onboardingComplete: boolean;
  readonly preferences: PreferencesPageView;
  /** The forms whose new submissions become leads, by name. */
  readonly forms: readonly SelectedFormView[];
  readonly connection: {
    /** Null: no connection row (treated as disconnected). */
    readonly status: ConnectionStatus | null;
    /** While revoked or disconnected: when the account's data is deleted unless the owner reconnects. */
    readonly purgeOn: string | null;
    readonly daysLeft: number | null;
  };
  readonly billing: {
    readonly action: BillingAction;
    readonly subscriptionStatus: SubscriptionStatus | null;
    /** `authenticated` with a start_at still ahead: the first $49 hasn't been taken. */
    readonly firstPaymentAhead: boolean;
    readonly cancelAtCycleEnd: boolean;
    readonly trialActive: boolean;
    readonly trialDaysLeft: number;
    readonly trialEndsOn: string;
  };
}

export interface DisconnectPageView {
  readonly zone: string;
  readonly connectionStatus: ConnectionStatus | null;
  /** The date the data would be deleted if the owner disconnected now (now + 30 days). */
  readonly purgeOnIfNow: string;
  /** While already revoked or disconnected: the stored deletion date. */
  readonly purgeOn: string | null;
  readonly billing: DisconnectBillingView;
  /** Where an owner whose subscription can't be cancelled through the API can write (D-27's Reply-To). */
  readonly supportEmail: string;
}

async function selectedForms(deps: Pick<Deps, 'db'>, accountId: string): Promise<SelectedFormView[]> {
  const rows = await deps.db.query<{ form_id: string; form_name: string | null }>(
    `select form_id, form_name from selected_forms where account_id = $1 and selected order by form_name, form_id`,
    [accountId],
  );
  return rows.map((row) => ({ id: row.form_id, name: row.form_name ?? '' }));
}

function purgeFacts(status: ConnectionStatus | null, purgeAfter: Date | null, zone: string, now: Date): { purgeOn: string | null; daysLeft: number | null } {
  if (status === 'active' || purgeAfter === null) return { purgeOn: null, daysLeft: null };
  return { purgeOn: formatDateInZone(purgeAfter, zone), daysLeft: daysUntil(purgeAfter, now) };
}

/** /dashboard/settings for the owner's account. */
export async function settingsPageView(scope: OwnerScope, deps: Deps): Promise<SettingsPageView> {
  const now = deps.clock.now();
  const context = await loadAccountContext(deps.db, scope.accountId);
  const preferences = await preferencesPageView(scope, deps);
  const forms = await selectedForms(deps, scope.accountId);
  const billing = await billingPageView(deps, scope);
  if (billing === null) throw new Error('settings_account_missing');
  return {
    zone: context.zone,
    processingState: context.processingState,
    pausedSince: context.pausedAt === null ? null : formatInZone(context.pausedAt, context.zone, now),
    onboardingComplete: context.onboardingCompletedAt !== null,
    preferences,
    forms,
    connection: { status: context.connection.status, ...purgeFacts(context.connection.status, context.purgeAfter, context.zone, now) },
    billing: {
      action: billing.action,
      subscriptionStatus: billing.subscription?.status ?? null,
      firstPaymentAhead: billing.subscription?.firstPaymentAhead ?? false,
      cancelAtCycleEnd: billing.subscription?.cancelAtCycleEnd ?? false,
      trialActive: billing.trial.active,
      trialDaysLeft: billing.trial.daysLeft,
      trialEndsOn: billing.trial.endsOn,
    },
  };
}

function dateOrNull(at: Date | null, zone: string): string | null {
  return at === null ? null : formatDateInZone(at, zone);
}

/** The Disconnect dialog for the owner's account. */
export async function disconnectPageView(scope: OwnerScope, deps: Deps): Promise<DisconnectPageView> {
  const now = deps.clock.now();
  const context = await loadAccountContext(deps.db, scope.accountId);
  const option = disconnectBillingOption(await loadAccountSubscriptions(deps.db, scope.accountId));
  const zone = context.zone;
  let billing: DisconnectBillingView;
  switch (option.type) {
    case 'cancellable':
      billing =
        option.status === 'authenticated'
          ? {
              type: 'cancellable',
              status: 'authenticated',
              firstPaymentOn: dateOrNull(option.firstPaymentAt, zone),
              firstPaymentAhead: firstPaymentAhead(option.firstPaymentAt, now),
            }
          : { type: 'cancellable', status: 'active', periodEndsOn: dateOrNull(option.periodEndsAt, zone) };
      break;
    case 'already_cancelled':
      billing = { type: 'already_cancelled', endsOn: dateOrNull(option.endsAt, zone) };
      break;
    case 'not_cancellable':
    case 'none':
      billing = option;
      break;
  }
  return {
    zone,
    connectionStatus: context.connection.status,
    purgeOnIfNow: formatDateInZone(new Date(now.getTime() + PURGE_AFTER_MS), zone),
    purgeOn: purgeFacts(context.connection.status, context.purgeAfter, zone, now).purgeOn,
    billing,
    supportEmail: deps.env.EMAIL_REPLY_TO,
  };
}
