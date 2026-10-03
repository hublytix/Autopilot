import type { NotCancellableStatus } from '@/server/services/disconnect';
import type { DisconnectBillingView, SettingsPageView } from '@/server/views/settings';
import type { AccountProcessingState, SubscriptionStatus } from '@/server/domain/types';

// Every owner-facing sentence of the settings pages (PLAN §7.5, brief §5.11, §9.1 step 5), in one
// place for laws 3 and 5 and the D-37 copy rule (test/emails/copy-rule.test.tsx scans src/app): an
// unqualified "reply"/"replied" is always the lead's; nothing is promised that the build does not do
// (the uninstall and the token revoke are attempts; the local disconnect always happens).

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const INSTALL_PATH = '/api/hubspot/install';
export const BILLING_PATH = '/dashboard/billing';

export interface ResultCopy {
  readonly tone: 'success' | 'info' | 'warning';
  readonly text: string;
}

/** `?result=` codes from actions/settings (own-key lookup). */
export const SETTINGS_RESULTS: Readonly<Record<string, ResultCopy>> = {
  preferences_saved: { tone: 'success', text: 'Your preferences are saved.' },
  forms_saved: { tone: 'success', text: 'Your forms are saved. Only submissions made after you tick a form become leads.' },
  paused: { tone: 'success', text: "Autopilot is paused. New leads aren't read or drafted until you resume." },
  already_paused: { tone: 'info', text: 'Autopilot was already paused.' },
  resumed: { tone: 'success', text: "Autopilot is running again. Leads that arrived while it was paused weren't read: check them in HubSpot." },
  resumed_not_active: { tone: 'warning', text: "Your pause has ended, but Autopilot still isn't running. The status below says why." },
  not_paused: { tone: 'info', text: "Autopilot wasn't paused." },
  disconnected: { tone: 'success', text: "HubSpot is disconnected. Autopilot has stopped and won't read your HubSpot account again unless you reconnect." },
  already_disconnected: { tone: 'info', text: 'HubSpot was already disconnected.' },
};

/** `?billing=` after a disconnect (own-key lookup); null for the codes that need no line. */
export const DISCONNECT_BILLING_RESULTS: Readonly<Record<string, ResultCopy | null>> = {
  not_requested: null,
  cancelled: { tone: 'success', text: 'Your subscription is cancelled. Nothing was charged.' },
  cancelled_after_payment: { tone: 'success', text: "Your subscription is cancelled. No further payments are taken; cancelling doesn't refund a payment already taken." },
  cancel_scheduled: { tone: 'success', text: "Your subscription is cancelled. It ends at the end of the current billing period and isn't renewed." },
  already_cancelled: { tone: 'info', text: 'Your subscription was already cancelled.' },
  not_cancellable: {
    tone: 'warning',
    text: "Your subscription wasn't cancelled: it can't be cancelled in its current state. Open billing to resume it or update your payment method first.",
  },
  nothing_to_cancel: null,
  failed: { tone: 'warning', text: "We couldn't cancel your subscription just now. Cancel it on the billing page." },
};

/**
 * `?uninstall=` after a disconnect (own-key lookup): HubSpot's uninstall did not happen, so the owner
 * removes the app in HubSpot themselves (D-03's "Disconnecting uninstalls the app" kept true, D-86).
 */
export const DISCONNECT_UNINSTALL_RESULTS: Readonly<Record<string, ResultCopy>> = {
  failed: {
    tone: 'warning',
    text: "We couldn't uninstall the app from HubSpot for you. Remove it in HubSpot under Settings → Integrations → Connected apps.",
  },
  skipped: {
    tone: 'warning',
    text: "Autopilot had already lost access to HubSpot, so it couldn't ask HubSpot to uninstall the app. If the app is still listed in HubSpot under Settings → Integrations → Connected apps, remove it there.",
  },
};

/** Preferences saved: what else happened (counts and flags only). */
export function preferencesSavedLines(input: { sent: number; limited: boolean; bcc: boolean; alert: boolean }): string[] {
  const lines: string[] = [];
  if (input.sent > 0) {
    lines.push(
      `We sent a confirmation email to ${plural(input.sent, 'address', 'addresses')}. ${input.sent === 1 ? 'It gets' : 'They get'} lead alerts once confirmed; the link works for 7 days.`,
    );
  }
  if (input.limited) lines.push("We didn't send every confirmation email because of today's limit. Save again tomorrow to send the rest.");
  if (input.bcc) {
    lines.push(
      "Your BCC address doesn't look like a HubSpot BCC or forwarding address, which usually ends in bcc.hubspot.com or forward.hubspot.com. We saved it anyway.",
    );
  }
  if (input.alert) lines.push('Your lead-alert or BCC addresses changed, so we emailed you a note about it.');
  return lines;
}

// ── status ────────────────────────────────────────────────────────────────────────────────────────

export const STATE_TITLE: Readonly<Record<AccountProcessingState, string>> = {
  active: 'Running',
  paused: 'Paused',
  onboarding: 'Setup incomplete',
  inactive: 'Billing inactive',
  revoked: 'HubSpot disconnected',
  disconnected: 'HubSpot disconnected',
};

export const STATE_TEXT: Readonly<Record<AccountProcessingState, string>> = {
  active: 'New leads are read from HubSpot, drafted and emailed to you.',
  paused: "New leads aren't read or drafted while Autopilot is paused, and follow-ups that come due are skipped.",
  onboarding: 'Finish setup to start getting drafts of your replies.',
  inactive: "Your free trial or subscription isn't active, so new leads aren't read or drafted.",
  revoked: "Autopilot can't read your HubSpot account, so nothing is read or drafted until you reconnect.",
  disconnected: "Autopilot can't read your HubSpot account, so nothing is read or drafted until you reconnect.",
};

export const PAUSE_NOTE =
  "Pausing stops reading new leads and emailing drafts and follow-ups. Leads that arrive while paused aren't drafted later, so check them in HubSpot.";
export const RESUME_NOTE = 'When you resume, leads that arrive from then on are drafted again.';

// ── preferences ───────────────────────────────────────────────────────────────────────────────────

export const FOLLOWUPS_OFF_NOTE =
  "Turning follow-ups off: follow-up drafts already scheduled aren't emailed while follow-ups are off. If you turn them back on before one is due, it is emailed at its time.";

export function changeAlertNote(ownerEmail: string): string {
  return `When you change your lead-alert addresses or your BCC address, we email ${ownerEmail} to let you know.`;
}

// ── billing ───────────────────────────────────────────────────────────────────────────────────────

export function billingSummary(billing: SettingsPageView['billing']): string {
  const status: SubscriptionStatus | null = billing.subscriptionStatus;
  switch (status) {
    case 'authenticated':
      // Only a start_at still ahead means nothing has been charged (D-20, D-82).
      return billing.firstPaymentAhead ? 'Subscribed. The first $49 payment is taken when your free trial ends.' : 'Subscribed: $49/month. Your first payment has already come due.';
    case 'active':
      return billing.cancelAtCycleEnd ? "Subscribed until the end of this billing period; it isn't renewed." : 'Subscribed: $49/month.';
    case 'pending':
      return "Your last payment didn't go through.";
    case 'halted':
      return 'Payments failed, so your subscription has stopped.';
    case 'paused':
      return 'Your subscription is paused.';
    case 'unknown':
      return "Razorpay reported a status for your subscription that we don't recognise. Open billing for what to do.";
    default:
      return billing.trialActive
        ? `Free trial: ${plural(billing.trialDaysLeft, 'day', 'days')} left (it ends on ${billing.trialEndsOn}). Not subscribed yet.`
        : `Your free trial ended on ${billing.trialEndsOn}. Not subscribed.`;
  }
}

// ── HubSpot connection and the Disconnect dialog ─────────────────────────────────────────────────

export function disconnectedLines(purgeOn: string | null, daysLeft: number | null): string[] {
  if (purgeOn === null || daysLeft === null) return ["HubSpot is disconnected. Reconnect to start again."];
  return [
    'HubSpot is disconnected.',
    daysLeft === 0
      ? `We delete your account's data on ${purgeOn}. Reconnect today to keep it.`
      : `We delete your account's data on ${purgeOn} (in ${plural(daysLeft, 'day', 'days')}) unless you reconnect before then.`,
  ];
}

export function disconnectConsequences(purgeOn: string): string[] {
  return [
    'Autopilot stops now: it no longer reads new leads, and no drafts or follow-ups are emailed to you.',
    "We ask HubSpot to uninstall the app from your HubSpot account (HubSpot emails your account's admins about it) and to revoke our access. Either way, we delete our access keys now.",
    'The send, edit and dismiss links in emails we already sent you stop working.',
    `Your account and everything we store for it (leads, brief and settings) are deleted on ${purgeOn}, 30 days from now. Reconnect before then to keep them: you can reconnect from your dashboard.`,
  ];
}

const NOT_CANCELLABLE_STATE: Readonly<Record<NotCancellableStatus, string>> = {
  paused: 'Your subscription is paused.',
  pending: "Your subscription is waiting for a payment that didn't go through.",
  halted: 'Your subscription has stopped after failed payments.',
  unknown: "Razorpay reported a status for your subscription that we don't recognise.",
};

export interface BillingChoiceCopy {
  /** The "also cancel" checkbox label, when it can be offered. */
  readonly checkbox: { readonly label: string; readonly hint: string } | null;
  readonly lines: readonly string[];
}

export function billingChoice(billing: DisconnectBillingView, supportEmail: string): BillingChoiceCopy {
  switch (billing.type) {
    case 'cancellable':
      if (billing.status === 'authenticated') {
        // Only a start_at still ahead means nothing has been charged yet (D-20, D-82).
        return billing.firstPaymentAhead
          ? {
              checkbox: {
                label: 'Also cancel my subscription',
                hint:
                  billing.firstPaymentOn === null
                    ? 'Nothing has been charged yet, and nothing will be.'
                    : `Nothing has been charged yet, and the first payment (due on ${billing.firstPaymentOn}) won't be taken.`,
              },
              lines: ['If you keep your subscription, the first payment is taken when your free trial ends, even while HubSpot is disconnected.'],
            }
          : {
              checkbox: {
                label: 'Also cancel my subscription',
                hint: "No further payments are taken. Cancelling doesn't refund a payment already taken.",
              },
              lines: ['If you keep your subscription, it renews every month as usual, even while HubSpot is disconnected.'],
            };
      }
      return {
        checkbox: {
          label: 'Also cancel my subscription',
          hint:
            billing.periodEndsOn === null
              ? "It ends at the end of the current billing period and isn't renewed."
              : `It ends on ${billing.periodEndsOn}, at the end of the current billing period, and isn't renewed.`,
        },
        lines: ['If you keep your subscription, it renews as usual, even while HubSpot is disconnected.'],
      };
    case 'not_cancellable':
      return {
        checkbox: null,
        lines: [
          NOT_CANCELLABLE_STATE[billing.status],
          `Cancel isn't available in this state; resume or update payment first, or contact support at ${supportEmail}.`,
        ],
      };
    case 'already_cancelled':
      return {
        checkbox: null,
        lines: [billing.endsOn === null ? "Your subscription is already cancelled and won't renew." : `Your subscription is already cancelled and ends on ${billing.endsOn}.`],
      };
    case 'none':
      return { checkbox: null, lines: ["You don't have a subscription to cancel."] };
  }
}
