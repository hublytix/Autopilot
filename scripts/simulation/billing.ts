// Simulation stage 7 variants (PLAN §13 setup, §15 M7 "fake checkout → active; inactive → no
// processing and one email (separate scenario variant)"), each run on its own into its own outbox
// directory, so the main week's outbox and summary are unchanged. Both start with the same boot and
// pre-run (the trial runs from the install, Tue 2026-10-06 09:00, to Tue 2026-10-20 09:00 local)
// and then let two weeks go by tick by tick: polls every 5 minutes, the hourly due-check (the two
// Monday reports of a portal without leads), the daily maintenance.
//
// `billing`: the owner subscribes during the trial (Wed 10-07 10:00) through the real checkout
//   handler and the fake Razorpay checkout ("Authorise payment" → `subscription.authenticated`,
//   delivered signed to the real webhook handler); the trial ends and processing continues (a
//   submission at 09:30 is drafted and emailed); at 10:00 Razorpay charges the first payment
//   (`subscription.activated` + `subscription.charged`) → `active`. No billing_inactive email ever.
// `lapse`: no subscription. Sunday's dashboard warns that the trial ends in 2 days; at the trial's
//   end the 09:00 poll turns the account `inactive` and exactly one billing_inactive email goes out;
//   a submission at 10:00 is never read (no lead, no new_lead); the dashboard shows the billing banner
//   linking to /dashboard/billing, whose page offers Subscribe.
import { deliverQueuedWebhooks } from '@/server/http/dev/fake-checkout';
import { submit } from './day0';
import type { ScenarioSubmission } from './day0-scenario';
import {
  bannerLink,
  bannerSummary,
  outboxKinds,
  ownerBillingPage,
  ownerDashboard,
  processingState,
  subscribeThroughCheckout,
  subscriptionStatuses,
} from './owner-billing';
import { shownLocal } from './status';
import type { Simulation, Stage } from './types';

export const BILLING_SCENARIO = 'brightside-plumbing-billing';
export const LAPSE_SCENARIO = 'brightside-plumbing-lapse';

/** The trial's end (install + 14 days, PLAN §9.9): Tue 2026-10-20 09:00 local. */
export const TRIAL_END = '2026-10-20T09:00:00';
const BILLING_PATH = '/dashboard/billing';

/** A new enquiry after the trial's end (invented, example domain), with HubSpot's webhook. */
function lateSubmission(at: string): ScenarioSubmission {
  return {
    n: 7,
    at,
    form: 'Request a quote',
    email: 'sam.okafor@example.com',
    firstName: 'Sam',
    lastName: 'Okafor',
    message: 'Our water heater is leaking from the bottom. Could you quote a replacement and say when you could install it?',
    webhook: true,
    expected: { classification: 'lead', processingState: 'notified', trigger: 'webhook' },
  };
}

/** The leads of the account submitted at or after `at` (none expected in `lapse`). */
async function leadsSince(sim: Simulation, at: Date): Promise<{ id: string; processing_state: string }[]> {
  return sim.db.query(`select id, processing_state from public.leads where account_id = $1 and not is_test and submitted_at >= $2`, [sim.scenario.accountId, at]);
}

/** The owner opens the dashboard on Monday from the weekly report (the session is renewed inside its last day). */
function scheduleMondayVisit(sim: Simulation, prefix: string): void {
  sim.travel.at(sim.local('2026-10-12T09:30:00'), 'owner opens the dashboard (Mon)', async () => {
    const view = await ownerDashboard(sim, `${prefix}.monday_dashboard`);
    sim.record('step', 'dashboard.opened_by_owner', { from: 'weekly_report', banners: bannerSummary(view) });
    sim.check(`${prefix}.monday_dashboard_active_no_banner`, view !== null && view.status.state === 'active' && view.banners.length === 0, `${view?.status.state ?? 'none'}: ${bannerSummary(view)}`);
  });
}

// ── billing ───────────────────────────────────────────────────────────────────────────────────────

async function runBillingSubscribe(sim: Simulation): Promise<void> {
  const at = sim.local('2026-10-07T10:00:00');
  sim.travel.at(at, 'owner subscribes', async () => {
    const before = await ownerBillingPage(sim, 'billing.page_offers_subscribe');
    sim.check(
      'billing.page_offers_subscribe_billed_at_the_trial_end',
      before !== null && before.trial.active && before.trial.daysLeft === 13 && before.trial.endsOn === '20 Oct 2026' && before.action === 'subscribe' && before.subscribeBillsAtTrialEnd && before.subscription === null,
      before === null ? 'none' : `trial ${String(before.trial.active)} ${before.trial.daysLeft} days to ${before.trial.endsOn}, action ${before.action}, at trial end ${String(before.subscribeBillsAtTrialEnd)}`,
    );
    const outcome = await subscribeThroughCheckout(sim, 'billing');
    if (outcome === null) return;
    sim.record('step', 'billing.subscribed_by_owner', { hops: outcome.hops, delivered: outcome.delivered });
    sim.check(
      'billing.subscribe_flow',
      outcome.hops.join(' | ') === '303 /dashboard/billing/checkout | link own-origin/dev/fake-checkout/{id} | 303 /dev/fake-checkout/{id}?done=authorise&delivered=1&failed=0' &&
        outcome.checkoutActions.join(',') === 'authorise,decline,deliver' &&
        outcome.delivered === 1 &&
        outcome.failed === 0,
      `${outcome.hops.join(' | ')}; actions ${outcome.checkoutActions.join(',')}`,
    );
  });
  await sim.travel.advanceTo(sim.local('2026-10-07T10:05:00'));

  const statuses = await subscriptionStatuses(sim);
  const page = await ownerBillingPage(sim, 'billing.authenticated');
  sim.check(
    'billing.subscription_authenticated_first_payment_at_the_trial_end',
    statuses.join(',') === 'authenticated' && page?.subscription?.status === 'authenticated' && page.subscription.startsOn === '20 Oct 2026' && page.action === 'cancel' && !page.checkoutOpen,
    `${statuses.join(',')}; page ${page?.subscription?.status ?? 'none'} starts ${page?.subscription?.startsOn ?? 'none'}, action ${page?.action ?? 'none'}`,
  );
  const events = await sim.db.query<{ event_type: string | null; outcome: string | null }>(
    `select event_type, outcome from public.webhook_events where provider = 'razorpay' order by id`,
  );
  sim.check(
    'billing.webhook_verified_deduped_and_applied',
    events.map((event) => `${event.event_type ?? '-'}:${event.outcome ?? '-'}`).join(',') === 'subscription.authenticated:applied',
    events.map((event) => `${event.event_type ?? '-'}:${event.outcome ?? '-'}`).join(','),
  );
  sim.check('billing.account_active_during_the_trial', (await processingState(sim)) === 'active', String(await processingState(sim)));
}

async function runBillingTrialEnd(sim: Simulation): Promise<void> {
  scheduleMondayVisit(sim, 'billing');
  sim.travel.at(sim.local('2026-10-18T10:00:00'), 'owner opens the dashboard (Sun)', async () => {
    const view = await ownerDashboard(sim, 'billing.sunday_dashboard');
    sim.record('step', 'dashboard.opened_by_owner', { from: 'bookmark', banners: bannerSummary(view) });
    // Subscribed: no "trial ends in 2 days" warning.
    sim.check('billing.no_trial_ending_banner_once_subscribed', view !== null && view.banners.length === 0, bannerSummary(view));
  });

  // Past the trial's end, still authenticated: processing continues, and a new lead is drafted.
  const late = lateSubmission('2026-10-20T09:30:00');
  sim.travel.at(sim.local(late.at), 'submission #7', () => submit(sim, late));
  sim.travel.at(sim.local('2026-10-20T09:31:00'), 'trial over, still running', async () => {
    const page = await ownerBillingPage(sim, 'billing.trial_over');
    const state = await processingState(sim);
    sim.check(
      'billing.trial_over_authenticated_still_active',
      page !== null && !page.trial.active && page.subscription?.status === 'authenticated' && state === 'active',
      `trial ${String(page?.trial.active)}, ${page?.subscription?.status ?? 'none'}, account ${String(state)}`,
    );
  });

  // Razorpay starts billing an hour after the trial's end: the first charge, then its webhooks.
  sim.travel.at(sim.local('2026-10-20T10:00:00'), 'Razorpay charges the first payment', async () => {
    sim.fakes.billing.sync();
    const { delivered, failed } = await deliverQueuedWebhooks({ deps: sim.deps, billing: sim.fakes.billing });
    sim.record('step', 'razorpay.first_payment_charged', { delivered, failed });
    sim.check('billing.charged_webhooks_delivered', delivered === 2 && failed === 0, `${delivered} delivered, ${failed} refused`);
  });
  await sim.travel.advanceTo(sim.local('2026-10-20T10:30:00'));

  const statuses = await subscriptionStatuses(sim);
  const page = await ownerBillingPage(sim, 'billing.active');
  const view = await ownerDashboard(sim, 'billing.active_dashboard');
  sim.check(
    'billing.charged_subscription_active',
    statuses.join(',') === 'active' && page?.subscription?.status === 'active' && page.subscription.periodEndsOn === '20 Nov 2026' && page.action === 'cancel',
    `${statuses.join(',')}; page ${page?.subscription?.status ?? 'none'} period to ${page?.subscription?.periodEndsOn ?? 'none'}, action ${page?.action ?? 'none'}`,
  );
  const events = await sim.db.query<{ event_type: string | null; outcome: string | null }>(`select event_type, outcome from public.webhook_events where provider = 'razorpay' order by id`);
  sim.check(
    'billing.activated_and_charged_applied',
    events.map((event) => `${event.event_type ?? '-'}:${event.outcome ?? '-'}`).join(',') ===
      'subscription.authenticated:applied,subscription.activated:applied,subscription.charged:applied',
    events.map((event) => `${event.event_type ?? '-'}:${event.outcome ?? '-'}`).join(','),
  );
  sim.check('billing.dashboard_active_no_billing_banner', view !== null && view.status.state === 'active' && view.banners.length === 0, `${view?.status.state ?? 'none'}: ${bannerSummary(view)}`);

  // The lead submitted after the trial's end was read, drafted and emailed.
  const leads = await leadsSince(sim, sim.local(TRIAL_END));
  const jobs = await sim.db.query<{ n: number }>(
    `select count(*)::int as n from public.scheduled_jobs where account_id = $1 and kind = 'followup' and status = 'scheduled'`,
    [sim.scenario.accountId],
  );
  const newLead = sim.fakes.mailer.sent.filter((mail) => mail.kind === 'new_lead');
  sim.check(
    'billing.lead_after_the_trial_drafted_and_emailed',
    leads.length === 1 && leads[0]?.processing_state === 'notified' && newLead.length === 1 && newLead[0]?.sentAt.getTime() === sim.local(late.at).getTime() && jobs[0]?.n === 2,
    `${leads.map((lead) => lead.processing_state).join(',') || 'no lead'}; new_lead at ${shownLocal(sim, newLead[0]?.sentAt ?? null)}; ${jobs[0]?.n ?? 0} follow-ups scheduled`,
  );

  const account = await sim.db.one<{ processing_state_changed_at: Date; onboarding_completed_at: Date | null }>(
    `select processing_state_changed_at, onboarding_completed_at from public.accounts where id = $1`,
    [sim.scenario.accountId],
  );
  sim.check(
    'billing.account_never_left_active',
    account.onboarding_completed_at !== null && account.processing_state_changed_at.getTime() === account.onboarding_completed_at.getTime(),
    `state last changed ${shownLocal(sim, account.processing_state_changed_at)}`,
  );
  await sim.travel.advanceTo(sim.local('2026-10-20T12:00:00'));
  sim.check(
    'billing.outbox_has_no_billing_inactive',
    outboxKinds(sim).join(',') === 'magic_link,inbox_test,weekly_report,weekly_report,new_lead',
    outboxKinds(sim).join(','),
  );
}

// ── lapse ─────────────────────────────────────────────────────────────────────────────────────────

async function runLapse(sim: Simulation): Promise<void> {
  scheduleMondayVisit(sim, 'lapse');
  sim.travel.at(sim.local('2026-10-18T10:00:00'), 'owner opens the dashboard (Sun)', async () => {
    const view = await ownerDashboard(sim, 'lapse.sunday_dashboard');
    const page = await ownerBillingPage(sim, 'lapse.sunday_billing');
    sim.record('step', 'dashboard.opened_by_owner', { from: 'bookmark', banners: bannerSummary(view) });
    sim.check(
      'lapse.trial_ending_banner_two_days_before',
      view !== null && bannerSummary(view) === 'trial_ending:2' && bannerLink(view, 'trial_ending') === BILLING_PATH,
      `${bannerSummary(view)} → ${String(bannerLink(view, 'trial_ending'))}`,
    );
    sim.check(
      'lapse.billing_page_offers_subscribe',
      page !== null && page.action === 'subscribe' && page.trial.daysLeft === 2 && page.subscribeBillsAtTrialEnd && page.subscription === null,
      page === null ? 'none' : `${page.action}, ${page.trial.daysLeft} days`,
    );
  });

  // The trial ends at 09:00; the 09:00 poll recomputes the state (events and jobs first, then ticks).
  const late = lateSubmission('2026-10-20T10:00:00');
  sim.travel.at(sim.local(late.at), 'submission #7', () => submit(sim, late));
  sim.travel.at(sim.local('2026-10-20T10:30:00'), 'owner opens the dashboard (from the billing email)', async () => {
    const view = await ownerDashboard(sim, 'lapse.inactive_dashboard');
    const page = await ownerBillingPage(sim, 'lapse.inactive_billing');
    sim.record('step', 'dashboard.opened_by_owner', { from: 'billing_inactive', banners: bannerSummary(view) });
    sim.check(
      'lapse.dashboard_shows_the_billing_banner',
      view !== null && view.status.state === 'billing_inactive' && bannerSummary(view) === 'billing_inactive' && bannerLink(view, 'billing_inactive') === BILLING_PATH,
      `${view?.status.state ?? 'none'}: ${bannerSummary(view)} → ${String(bannerLink(view, 'billing_inactive'))}`,
    );
    sim.check(
      'lapse.billing_page_says_inactive_and_offers_subscribe',
      page !== null && page.processingState === 'inactive' && !page.trial.active && page.action === 'subscribe' && !page.subscribeBillsAtTrialEnd,
      page === null ? 'none' : `${page.processingState}, trial ${String(page.trial.active)}, ${page.action}`,
    );
  });
  await sim.travel.advanceTo(sim.local('2026-10-21T12:00:00'));

  const state = await processingState(sim);
  const account = await sim.db.one<{ processing_state_changed_at: Date }>(`select processing_state_changed_at from public.accounts where id = $1`, [sim.scenario.accountId]);
  sim.check(
    'lapse.inactive_from_the_trial_end',
    state === 'inactive' && account.processing_state_changed_at.getTime() === sim.local(TRIAL_END).getTime(),
    `${String(state)} since ${shownLocal(sim, account.processing_state_changed_at)}`,
  );
  const mails = sim.fakes.mailer.sent.filter((mail) => mail.kind === 'billing_inactive');
  const mail = mails[0];
  const reservations = await sim.db.query<{ status: string }>(`select status from public.notifications_sent where kind = 'billing_inactive' and account_id = $1`, [sim.scenario.accountId]);
  sim.check(
    'lapse.exactly_one_billing_inactive_email_at_the_trial_end',
    mails.length === 1 &&
      mail !== undefined &&
      mail.sentAt.getTime() === sim.local(TRIAL_END).getTime() &&
      mail.to.join(',') === sim.scenario.ownerEmail &&
      mail.replyTo === sim.deps.env.EMAIL_REPLY_TO &&
      mail.text.includes(`${sim.deps.env.APP_URL}${BILLING_PATH}`) &&
      reservations.length === 1 &&
      reservations[0]?.status === 'sent',
    `${mails.length} email(s) at ${shownLocal(sim, mail?.sentAt ?? null)}, ${reservations.length} reservation(s)`,
  );
  sim.check(
    'lapse.outbox_is_the_trial_then_one_billing_email',
    outboxKinds(sim).join(',') === 'magic_link,inbox_test,weekly_report,weekly_report,billing_inactive',
    outboxKinds(sim).join(','),
  );

  // Nothing is read or drafted once inactive: the submission's webhook is recorded, nothing polls.
  const leads = await leadsSince(sim, sim.local(TRIAL_END));
  const jobs = await sim.db.query<{ kind: string }>(
    `select kind from public.scheduled_jobs where account_id = $1 and created_at >= $2 and kind in ('portal_poll', 'lead_process', 'followup', 'weekly_report') order by created_at`,
    [sim.scenario.accountId, sim.local(TRIAL_END)],
  );
  const webhook = await sim.db.query<{ n: number }>(`select count(*)::int as n from public.webhook_events where provider = 'hubspot' and occurred_at >= $1`, [sim.local(late.at)]);
  sim.check(
    'lapse.no_lead_read_or_drafted_after_the_trial',
    leads.length === 0 && jobs.length === 0 && !sim.fakes.mailer.sent.some((m) => m.kind === 'new_lead') && webhook[0]?.n === 1,
    `${leads.length} lead(s), jobs [${jobs.map((job) => job.kind).join(',')}], webhook events ${webhook[0]?.n ?? 0}`,
  );
  const open = await sim.db.query<{ kind: string; status: string }>(
    `select kind, status from public.scheduled_jobs where account_id = $1 and status not in ('done', 'cancelled', 'skipped')`,
    [sim.scenario.accountId],
  );
  sim.check('lapse.every_job_done_cancelled_or_skipped', open.length === 0, open.map((job) => `${job.kind}:${job.status}`).join(',') || 'all finished');
}

export const BILLING_VARIANT_STAGES: readonly Stage[] = [
  { id: 'billing-subscribe', milestone: 'M7', run: runBillingSubscribe },
  { id: 'billing-trial-end', milestone: 'M7', run: runBillingTrialEnd },
];

export const LAPSE_VARIANT_STAGES: readonly Stage[] = [{ id: 'lapse-trial-end', milestone: 'M7', run: runLapse }];
