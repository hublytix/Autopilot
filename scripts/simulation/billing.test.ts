import { describe, expect, it } from 'vitest';
import { runPreRun } from './pre-run';
import { BILLING_SCENARIO, BILLING_VARIANT_STAGES } from './billing';
import { BILLING_STAGES, BOOT_STAGE } from './stages';
import type { Stage } from './types';
import { checkIds, idFreeJson, PRE_RUN_CHECK_IDS, runVariant, UUID } from './variant-support';

// Simulation stage 7, the billing variant (PLAN §15 M7 "fake checkout → active"): a separate run, so
// the main week's outbox stays the 15 emails. Run here with the system time set to 2030; `npm run
// simulate` runs it under the real one, and both must pass the same exact checks.

const SUBSCRIBE_ONLY: readonly Stage[] = [BOOT_STAGE, { id: 'pre-run', milestone: 'M3', run: runPreRun }, ...BILLING_VARIANT_STAGES.slice(0, 1)];

describe('the billing variant (M7): subscribe during the trial → authenticated → past the trial end → charged → active', () => {
  it('produces the same summary twice, the second time with the system time set to 2030 (random Razorpay ids never reach it)', async () => {
    const first = await runVariant(SUBSCRIBE_ONLY, BILLING_SCENARIO);
    const second = await runVariant(SUBSCRIBE_ONLY, BILLING_SCENARIO, '2030');
    expect(first.checks.filter((check) => !check.ok)).toEqual([]);
    expect({ ...second, systemTime: null }).toEqual(first);
    expect(idFreeJson(first)).not.toMatch(UUID);
    expect(JSON.stringify(first)).not.toMatch(/sub_[A-Za-z0-9]/);
  }, 300_000);

  it('passes every check: the checkout, the authenticated webhook, processing past the trial end, the first charge, no billing_inactive email', async () => {
    const summary = await runVariant(BILLING_STAGES, BILLING_SCENARIO, '2030');
    expect(summary.checks.filter((check) => !check.ok)).toEqual([]);
    expect(checkIds(summary)).toEqual(
      [
        ...PRE_RUN_CHECK_IDS,
      'billing.page_offers_subscribe_billed_at_the_trial_end',
      'billing.subscribe_flow',
      'billing.subscription_authenticated_first_payment_at_the_trial_end',
      'billing.webhook_verified_deduped_and_applied',
      'billing.account_active_during_the_trial',
      'billing.monday_dashboard_active_no_banner',
      'billing.no_trial_ending_banner_once_subscribed',
      'billing.trial_over_authenticated_still_active',
      'billing.charged_webhooks_delivered',
      'billing.charged_subscription_active',
      'billing.activated_and_charged_applied',
      'billing.dashboard_active_no_billing_banner',
      'billing.lead_after_the_trial_drafted_and_emailed',
      'billing.account_never_left_active',
      'billing.outbox_has_no_billing_inactive',
      ].map((id) => [id, true]),
    );
    expect(summary.scenario).toBe('brightside-plumbing-billing');
    expect(summary.stages.map((stage) => [stage.id, stage.milestone])).toEqual([
      ['boot', 'M1'],
      ['pre-run', 'M3'],
      ['billing-subscribe', 'M7'],
      ['billing-trial-end', 'M7'],
    ]);
    expect(summary.emails.map((email) => [email.at, email.kind, email.lead])).toEqual([
      ['2026-10-06T13:00:00.000Z', 'magic_link', null],
      ['2026-10-06T13:03:15.000Z', 'inbox_test', null],
      // The two Monday reports of a portal without leads yet (08:00 local + the 15-minute grace + the stagger).
      ['2026-10-12T12:15:03.000Z', 'weekly_report', null],
      ['2026-10-19T12:15:03.000Z', 'weekly_report', null],
      // Tue 10-20 09:30 local, after the trial's end: drafted while the subscription is authenticated.
      ['2026-10-20T13:30:00.000Z', 'new_lead', 'L7'],
    ]);
    expect(summary.leads.map((lead) => [lead.ref, lead.processingState, lead.intakeTrigger])).toEqual([['L7', 'notified', 'webhook']]);
    const steps = summary.timeline.filter((entry) => entry.kind === 'step' && entry.stage.startsWith('billing-'));
    expect(steps.map((entry) => [entry.local, entry.name])).toEqual([
      ['Wed 2026-10-07 10:00:00', 'billing.subscribed_by_owner'],
      ['Mon 2026-10-12 09:30:00', 'dashboard.opened_by_owner'],
      ['Sun 2026-10-18 10:00:00', 'dashboard.opened_by_owner'],
      ['Tue 2026-10-20 09:30:00', 'portal.form_submitted'],
      ['Tue 2026-10-20 10:00:00', 'razorpay.first_payment_charged'],
    ]);
    expect(steps[0]?.detail).toEqual({
      hops: ['303 /dashboard/billing/checkout', 'link own-origin/dev/fake-checkout/{id}', '303 /dev/fake-checkout/{id}?done=authorise&delivered=1&failed=0'],
      delivered: 1,
    });
    expect(idFreeJson(summary)).not.toMatch(UUID);
  }, 600_000);
});
