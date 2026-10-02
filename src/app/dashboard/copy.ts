import type { ResumeControl, RealLeadControl, TimelineEvent } from '@/server/views/dashboard';
import type { AccountStatusState, DashboardBanner, LeadNameView, NotProcessedReason, StatusCardView } from '@/server/views/dashboard';
import type { DashboardResultCode, LeadResultCode } from '@/server/actions/dashboard';
import type { Classification, StopReason } from '@/server/domain/types';

// Every owner-facing sentence of the dashboard pages (PLAN §7.5), in one place so the copy rule
// (D-37, test/emails/copy-rule.test.tsx scans src/app) and law 3/5 are easy to check: an unqualified
// "reply"/"replied" is always the lead's; anything the owner sends is "you/your"; a click is never a
// confirmed send; nothing is promised that the build does not do; counts are counts, never estimates.

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── status card ───────────────────────────────────────────────────────────────────────────────────

export function statusTitle(status: StatusCardView): string {
  switch (status.state) {
    case 'active':
      return 'Active';
    case 'paused':
      return 'Paused';
    case 'billing_inactive':
      return 'Billing inactive';
    case 'setup_incomplete':
      return 'Setup incomplete';
    case 'disconnected':
      if (status.reconnectDaysLeft === null) return 'HubSpot disconnected';
      return status.reconnectDaysLeft === 0 ? 'HubSpot disconnected — reconnect today' : `HubSpot disconnected — reconnect within ${plural(status.reconnectDaysLeft, 'day', 'days')}`;
  }
}

export const STATUS_TEXT: Readonly<Record<AccountStatusState, string>> = {
  active: 'New leads are read from HubSpot, drafted and emailed to you.',
  paused: "New leads aren't read or drafted while Autopilot is paused, and follow-ups that come due are skipped.",
  billing_inactive: "Your free trial or subscription has ended, so new leads aren't read or drafted.",
  setup_incomplete: 'Finish setup to start getting drafts of your replies.',
  disconnected: "Autopilot can't read your HubSpot account, so nothing is read or drafted until you reconnect.",
};

export function trialText(daysLeft: number): string {
  return `Free trial: ${plural(daysLeft, 'day', 'days')} left.`;
}

// ── banners ───────────────────────────────────────────────────────────────────────────────────────

export interface BannerCopy {
  readonly tone: 'info' | 'warning' | 'error';
  readonly title: string;
  readonly lines: readonly string[];
  /** A link (or a plain link for route handlers, `plain`). */
  readonly link?: { readonly href: string; readonly label: string; readonly plain?: boolean } | undefined;
}

const INSTALL_PATH = '/api/hubspot/install';
const INBOX_CHECK_PATH = '/onboarding/inbox';
// The billing banners link to /dashboard/billing (M7), where the one action that fits is offered:
// Subscribe, Update payment method, Resume or Cancel.
const BILLING_LINK = { href: '/dashboard/billing', label: 'Go to billing' } as const;

const RECONNECT_LINK = { href: INSTALL_PATH, label: 'Reconnect HubSpot', plain: true } as const;

export function bannerCopy(banner: DashboardBanner): BannerCopy {
  switch (banner.type) {
    case 'reconnect':
      if (banner.connected) {
        return {
          tone: 'info',
          title: 'Finish reconnecting HubSpot',
          lines: ['Tap Reconnect HubSpot and approve the app in HubSpot again.'],
          link: RECONNECT_LINK,
        };
      }
      return {
        tone: 'error',
        title: 'Reconnect HubSpot',
        lines: [
          "Autopilot can't read your HubSpot account, so new leads aren't read or drafted.",
          banner.daysLeft === null || banner.purgeOn === null
            ? 'Reconnect to start again.'
            : `Reconnect within ${plural(banner.daysLeft, 'day', 'days')} (by ${banner.purgeOn}). After that we delete your account's data.`,
        ],
        link: RECONNECT_LINK,
      };
    case 'setup_incomplete':
      return { tone: 'warning', title: "Setup isn't finished", lines: ['Finish the setup steps to start getting drafts.'], link: { href: '/onboarding/baseline', label: 'Continue setup' } };
    case 'billing_inactive':
      return {
        tone: 'error',
        title: 'Billing inactive',
        lines: [
          "Your free trial or subscription has ended, so new leads aren't read or drafted.",
          "Subscribe to start again, or update your payment method if a payment didn't go through.",
        ],
        link: BILLING_LINK,
      };
    case 'payment_grace':
      return {
        tone: 'warning',
        title: "Your last payment didn't go through",
        lines: [
          `Autopilot keeps running until ${banner.until}. If the payment still hasn't gone through by then, new leads aren't read or drafted.`,
          'Update your payment method to keep it running.',
        ],
        link: BILLING_LINK,
      };
    case 'trial_ending':
      return {
        tone: 'info',
        title: `Your free trial ends in ${plural(banner.daysLeft, 'day', 'days')}`,
        lines: ["After it ends, new leads aren't read or drafted until you subscribe. Subscribe now to keep it running."],
        link: BILLING_LINK,
      };
    case 'paused':
      return {
        tone: 'warning',
        title: `Autopilot is paused (since ${banner.since})`,
        lines: [
          "While it's paused, new leads aren't read or drafted, and they won't be drafted after you resume either. Follow-ups that come due are skipped.",
          ...(banner.skippedLeads > 0 ? [`${plural(banner.skippedLeads, 'lead', 'leads')} already received weren't drafted because of the pause. They're marked Not processed below.`] : []),
        ],
      };
    case 'resumed':
      return {
        tone: 'info',
        title: 'Leads that arrived while Autopilot was paused were not drafted',
        lines: [
          `Autopilot was paused from ${banner.pausedFrom} until you resumed it. Form submissions from that time weren't read: check them in HubSpot.`,
          ...(banner.skippedLeads > 0 ? [`${plural(banner.skippedLeads, 'lead', 'leads')} already received weren't drafted because of the pause.`] : []),
        ],
      };
    case 'daily_cap': {
      const lines: string[] = [];
      if (banner.deferredToday > 0) {
        lines.push(`${plural(banner.deferredToday, 'lead', 'leads')} after that weren't drafted. They're listed below as Not processed; you can answer them from HubSpot.`);
      }
      if (banner.deferredEarlier > 0) {
        lines.push(`${plural(banner.deferredEarlier, 'lead', 'leads')} in the last 7 days weren't drafted because the daily limit was reached.`);
      }
      return {
        tone: 'warning',
        title: banner.reachedToday ? `You've reached today's limit of ${plural(banner.limit, 'drafted lead', 'drafted leads')}` : 'Some recent leads were over the daily limit',
        lines,
      };
    }
    case 'ai_limit':
      return {
        tone: 'warning',
        title: 'Drafting is limited for the rest of today',
        lines: ['New leads still get an email, with a short starter draft for you to finish.'],
      };
    case 'needs_touch':
      return {
        tone: 'warning',
        title: `${plural(banner.count, 'recent draft needs', 'recent drafts need')} your touch`,
        lines: ["We couldn't prepare a full draft, so the email to you had a short starter draft. Check it before you send."],
      };
    case 'logging':
      return loggingBanner(banner.mode);
    case 'email_scope_missing':
      return {
        tone: 'warning',
        title: "Autopilot can't read the emails logged in HubSpot",
        lines: ["HubSpot didn't give Autopilot access to logged emails, so we can't confirm your sends or see your leads' replies. Reconnect HubSpot and approve every permission it asks for."],
        link: RECONNECT_LINK,
      };
    case 'inbox_check_pending':
      return {
        tone: 'info',
        title: 'Inbox check still running',
        lines: ["We're still checking how HubSpot logs your emails."],
        link: { href: INBOX_CHECK_PATH, label: 'See the inbox check' },
      };
  }
}

function loggingBanner(mode: 'none' | 'sends_only' | 'unknown'): BannerCopy {
  const link = { href: INBOX_CHECK_PATH, label: 'Run the inbox check' };
  switch (mode) {
    case 'none':
      return {
        tone: 'warning',
        title: "HubSpot isn't logging your emails",
        lines: [
          "The inbox check found that HubSpot didn't log the email you sent, so some of your sends and your leads' replies may not show up here.",
          "To fix it, connect your mailbox to HubSpot with email logging on, or add your HubSpot BCC address to the emails you send, then run the inbox check again.",
        ],
        link,
      };
    case 'sends_only':
      return {
        tone: 'warning',
        title: "HubSpot logs your sends, but not the replies you get",
        lines: [
          "So we can't tell when a lead replied. Check your inbox before you send a follow-up.",
          'To fix it, make sure HubSpot also logs the emails your contacts send you, then run the inbox check again.',
        ],
        link,
      };
    case 'unknown':
      return {
        tone: 'info',
        title: "We haven't checked how HubSpot logs your emails",
        lines: ["Until it runs, a send of yours or a lead's reply that's missing here may simply not be logged in HubSpot. The check takes a few minutes."],
        link,
      };
  }
}

// ── results (?result=) ────────────────────────────────────────────────────────────────────────────

export const DASHBOARD_RESULTS: Readonly<Record<DashboardResultCode, { tone: 'success' | 'info' | 'warning'; text: string }>> = {
  lead_not_found: { tone: 'warning', text: "We couldn't find that lead in your account." },
  paused: { tone: 'success', text: "Autopilot is paused. New leads aren't read or drafted until you resume." },
  already_paused: { tone: 'info', text: 'Autopilot was already paused.' },
  resumed: { tone: 'success', text: "Autopilot is running again. Leads that arrived while it was paused won't be drafted." },
  resumed_not_active: { tone: 'warning', text: "Pause is off, but Autopilot still isn't running: see the status above." },
  not_paused: { tone: 'info', text: "Autopilot wasn't paused." },
};

export const LEAD_RESULTS: Readonly<Record<LeadResultCode, { tone: 'success' | 'info' | 'warning'; text: string }>> = {
  'real_lead.queued': { tone: 'success', text: "Thanks. We'll draft this lead now and email it to you, as with any new lead." },
  'real_lead.not_filtered': { tone: 'info', text: "This lead isn't filtered any more, so nothing changed." },
  'real_lead.test_lead': { tone: 'warning', text: "This is the inbox check's test lead, so it isn't drafted." },
  'real_lead.dismissed': { tone: 'warning', text: "You marked this lead as not a real lead, so it isn't drafted." },
  'real_lead.privacy_deleted': { tone: 'warning', text: "The contact's data was deleted at their request, so this lead can't be drafted." },
  'real_lead.content_gone': { tone: 'warning', text: "The lead's message was removed after 30 days, so there's nothing to draft from." },
  'real_lead.account_not_active': { tone: 'warning', text: "Autopilot isn't running for your account right now, so this lead can't be drafted. See the status on your dashboard." },
  'resume_followups.resumed': { tone: 'success', text: "Follow-ups resumed. We'll email you the next follow-up draft when it's due." },
  'resume_followups.resumed_none_left': { tone: 'info', text: 'Done. Both follow-up drafts were already emailed to you, so none is left to schedule.' },
  'resume_followups.dismissed': { tone: 'warning', text: "You marked this lead as not a real lead, so follow-ups can't resume." },
  'resume_followups.test_lead': { tone: 'warning', text: "This is the inbox check's test lead: it has no follow-ups." },
  'resume_followups.privacy_deleted': { tone: 'warning', text: "The contact's data was deleted at their request, so follow-ups can't resume." },
  'resume_followups.not_notified': { tone: 'warning', text: 'We never emailed you a draft for this lead, so there are no follow-ups to resume.' },
  'resume_followups.not_replied': { tone: 'info', text: "There's no logged reply from this lead to set aside, so nothing changed." },
  'resume_followups.stopped': { tone: 'warning', text: "Follow-ups for this lead stopped for another reason (shown below), so they can't resume." },
  'resume_followups.account_not_active': { tone: 'warning', text: "Autopilot isn't running for your account right now, so follow-ups can't resume." },
  'resume_followups.followups_off': { tone: 'warning', text: 'Follow-ups are off in your settings. Switch them on first.' },
  'resume_followups.unschedulable': { tone: 'warning', text: "We couldn't schedule the follow-ups this time. Please try again later." },
  'dismiss.dismissed': { tone: 'success', text: 'Marked as not a real lead. Follow-ups for this lead have stopped.' },
  'dismiss.already_dismissed': { tone: 'info', text: 'This lead was already marked as not a real lead.' },
};

// ── leads ─────────────────────────────────────────────────────────────────────────────────────────

/** The lead's name, or the HubSpot contact id with why the details are gone (D-31). */
export function leadNameText(name: LeadNameView): string {
  if (name.kind === 'name') return name.name;
  const contact = name.contactId === null ? 'Contact' : `Contact #${name.contactId}`;
  if (name.removed === 'purged') return `${contact} (details removed after 30 days)`;
  if (name.removed === 'privacy_deleted') return `${contact} (details deleted at the contact's request)`;
  return contact;
}

export const NOT_PROCESSED_TEXT: Readonly<Record<NotProcessedReason, string>> = {
  daily_cap: "Not drafted: it arrived after that day's limit of drafted leads was reached.",
  failed: 'Something went wrong while drafting this lead.',
  skipped: "Not drafted: Autopilot couldn't process it when it arrived (for example, it was paused).",
};

/** Short form for the list. */
export const NOT_PROCESSED_SHORT: Readonly<Record<NotProcessedReason, string>> = {
  daily_cap: 'Over the daily limit',
  failed: 'Drafting failed',
  skipped: 'Skipped',
};

const CLASS_TEXT: Readonly<Record<Classification, string>> = {
  lead: 'Classified as a lead',
  unclear: 'Classified as unclear (drafted like a lead)',
  spam: 'Filtered as spam',
  vendor_pitch: 'Filtered as a sales pitch',
  job_seeker: 'Filtered as a job application',
  support_request: 'Filtered as a support request',
};

export function timelineText(event: TimelineEvent): string {
  switch (event.kind) {
    case 'received':
      return 'Form submitted';
    case 'classified': {
      const base = event.classification === null ? 'Classified' : CLASS_TEXT[event.classification];
      return event.overridden ? `${base} — you marked it as a real lead` : base;
    }
    case 'emailed':
      return event.needsTouch ? 'Starter draft emailed to you (it needs your touch)' : 'Draft emailed to you';
    case 'send_link_opened':
      return 'You opened the send link (not confirmed as sent)';
    case 'send_confirmed':
      return 'Your send confirmed in HubSpot';
    case 'lead_replied':
      return event.resumed ? 'Lead replied (logged in HubSpot); you resumed follow-ups after it' : 'Lead replied (logged in HubSpot)';
    case 'followups_resumed':
      return 'You resumed follow-ups';
    case 'followup_emailed':
      return `Follow-up ${event.n} draft emailed to you`;
    case 'dismissed':
      return 'You marked it as not a real lead';
  }
}

export const STOP_TEXT: Readonly<Record<StopReason, string>> = {
  dismissed: 'you marked it as not a real lead.',
  replied: 'the lead replied (logged in HubSpot).',
  contact_deleted: 'the contact was deleted in HubSpot.',
  opted_out: 'the contact opted out of emails in HubSpot.',
  bounced: 'an email to this contact bounced.',
  superseded: 'the same contact sent a newer enquiry, which has its own follow-ups.',
  privacy_deletion: "the contact's data was deleted at their request.",
  followups_off: 'follow-ups were off in your settings.',
  account_inactive: "Autopilot wasn't running for your account when a follow-up was due.",
  max_followups: 'no more follow-ups are planned for this lead.',
  test_lead: "this is the inbox check's test lead.",
};

export const DRAFT_TITLES = { initial: 'Your first reply', fu1: 'Your follow-up 1', fu2: 'Your follow-up 2' } as const;

export const REAL_LEAD_TEXT: Readonly<Record<Exclude<RealLeadControl, null>, string>> = {
  available: "We'll draft it and email it to you, as with any new lead.",
  content_gone: "This lead can't be drafted any more: its message was removed after 30 days.",
  account_not_active: "Autopilot isn't running for your account right now, so this lead can't be drafted.",
};

export const RESUME_TEXT: Readonly<Record<Exclude<ResumeControl, null>, string>> = {
  available:
    'Use this if HubSpot logged an automatic reply from the lead, such as an out-of-office message. Follow-ups start again, and stop again if the lead replies.',
  account_not_active: "Autopilot isn't running for your account right now, so follow-ups can't resume.",
  followups_off: "Follow-ups are off in your settings, so they can't resume.",
};

export const SIGNALS_TEXT = {
  notChecked: "HubSpot's logged emails haven't been checked in full for this lead yet.",
  checkedAt: (at: string): string => `HubSpot's logged emails last checked in full: ${at}.`,
  unavailableNow: "HubSpot's logged emails couldn't be checked just now, so we can't tell whether your send was logged or whether the lead replied.",
  failedNow: "We couldn't reach HubSpot just now. This page shows what we knew before.",
  noScope: "HubSpot didn't give Autopilot access to logged emails, so we can't confirm your sends or your lead's replies.",
  disconnected: "HubSpot is disconnected, so this lead can't be checked there until you reconnect.",
  markedReplied: 'HubSpot has logged a reply from this lead, so follow-ups have stopped.',
} as const;
