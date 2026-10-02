import { describe, expect, it } from 'vitest';
import { LAPSE_SCENARIO } from './billing';
import { LAPSE_STAGES } from './stages';
import { checkIds, idFreeJson, PRE_RUN_CHECK_IDS, runVariant, UUID } from './variant-support';

// Simulation stage 7, the lapse variant (PLAN §15 M7 "inactive → no processing and one email"): a
// separate run with the system time set to 2030; `npm run simulate` runs it under the real one.

describe('the lapse variant (M7): no subscription → inactive at the trial end, one billing_inactive email, nothing read after it', () => {
  it('passes every check and sends exactly one billing_inactive email, at the trial end', async () => {
    const summary = await runVariant(LAPSE_STAGES, LAPSE_SCENARIO, '2030');
    expect(summary.checks.filter((check) => !check.ok)).toEqual([]);
    expect(checkIds(summary)).toEqual(
      [
        ...PRE_RUN_CHECK_IDS,
      'lapse.monday_dashboard_active_no_banner',
      'lapse.trial_ending_banner_two_days_before',
      'lapse.billing_page_offers_subscribe',
      'lapse.dashboard_shows_the_billing_banner',
      'lapse.billing_page_says_inactive_and_offers_subscribe',
      'lapse.inactive_from_the_trial_end',
      'lapse.exactly_one_billing_inactive_email_at_the_trial_end',
      'lapse.outbox_is_the_trial_then_one_billing_email',
      'lapse.no_lead_read_or_drafted_after_the_trial',
      'lapse.every_job_done_cancelled_or_skipped',
      ].map((id) => [id, true]),
    );
    expect(summary.scenario).toBe('brightside-plumbing-lapse');
    expect(summary.emails.map((email) => [email.at, email.kind])).toEqual([
      ['2026-10-06T13:00:00.000Z', 'magic_link'],
      ['2026-10-06T13:03:15.000Z', 'inbox_test'],
      ['2026-10-12T12:15:03.000Z', 'weekly_report'],
      ['2026-10-19T12:15:03.000Z', 'weekly_report'],
      // Tue 10-20 09:00 local: the poll at the trial's end.
      ['2026-10-20T13:00:00.000Z', 'billing_inactive'],
    ]);
    // The submission after the trial's end created no lead.
    expect(summary.leads).toEqual([]);
    const banners = summary.timeline.filter((entry) => entry.name === 'dashboard.opened_by_owner').map((entry) => [entry.local, entry.detail?.banners]);
    expect(banners).toEqual([
      ['Mon 2026-10-12 09:30:00', 'none'],
      ['Sun 2026-10-18 10:00:00', 'trial_ending:2'],
      ['Tue 2026-10-20 10:30:00', 'billing_inactive'],
    ]);
    // Polls go on (the state is recomputed every 5 minutes), but none reads the portal any more.
    const afterTrial = summary.timeline.filter((entry) => entry.name === 'cron.poll' && entry.at >= '2026-10-20T13:00:00.000Z');
    expect(afterTrial.length).toBeGreaterThan(300);
    expect(afterTrial.every((entry) => entry.detail?.polled === 0)).toBe(true);
    expect(idFreeJson(summary)).not.toMatch(UUID);
  }, 600_000);
});
