import { describe, expect, it } from 'vitest';
import { DISCONNECT_SCENARIO } from './disconnect';
import { DISCONNECT_STAGES } from './stages';
import { checkIds, idFreeJson, PRE_RUN_CHECK_IDS, runVariant, UUID } from './variant-support';

// Simulation stage 7, the disconnect variant (PLAN §9.1 step 5, §9.10, §15 M7): a separate run with
// the system time set to 2030; `npm run simulate` runs it under the real one.

describe('the disconnect variant (M7): Disconnect → nothing more is sent → the purge 30 days later leaves only the tombstones', () => {
  it('passes every check: processing stops, content goes at 30 days, the account at the first daily run after purge_after', async () => {
    const summary = await runVariant(DISCONNECT_STAGES, DISCONNECT_SCENARIO, '2030');
    expect(summary.checks.filter((check) => !check.ok)).toEqual([]);
    expect(checkIds(summary)).toEqual(
      [
        ...PRE_RUN_CHECK_IDS,
      'disconnect.day0_drafted_and_emailed',
      'disconnect.dialog_offers_to_cancel_the_authenticated_subscription',
      'disconnect.lands_on_settings_with_the_outcome',
      'disconnect.processing_stops_and_data_kept_30_days',
      'disconnect.app_uninstalled_and_refresh_token_revoked',
      'disconnect.subscription_cancelled_nothing_charged',
      'disconnect.follow_ups_cancelled_and_links_revoked',
      'disconnect.dashboard_and_settings_say_reconnect_within_30_days',
      'disconnect.nothing_sent_after_the_disconnect',
      'disconnect.lead_content_purged_at_30_days',
      'disconnect.no_lead_content_anywhere_after_30_days_before_purge',
      'disconnect.account_kept_until_purge_after',
      'disconnect.account_purged_by_the_first_daily_run_after_30_days',
      'disconnect.no_row_left_for_the_account',
      'disconnect.tombstones_remain',
      'disconnect.owner_sign_in_user_deleted',
      'disconnect.no_lead_or_draft_content_anywhere',
      'disconnect.outbox_unchanged_since_the_disconnect',
      ].map((id) => [id, true]),
    );
    expect(summary.scenario).toBe('brightside-plumbing-disconnect');
    // Day 0's four drafts, then nothing: no follow-up, no report, no reconnect email.
    expect(summary.emails.map((email) => [email.kind, email.lead])).toEqual([
      ['magic_link', null],
      ['inbox_test', null],
      ['new_lead', 'L1'],
      ['new_lead', 'L2'],
      ['new_lead', 'L6'],
      ['new_lead', 'L5'],
    ]);
    // The account and its leads are gone; the summary names the purged leads by their refs only.
    expect(summary.leads).toEqual([]);
    expect(idFreeJson(summary)).not.toMatch(UUID);
    const steps = summary.timeline.filter((entry) => entry.kind === 'step' && entry.stage === 'disconnect-purge' && entry.name !== 'portal.form_submitted');
    expect(steps.map((entry) => [entry.local, entry.name])).toEqual([
      ['Wed 2026-10-07 09:30:00', 'billing.subscribed_by_owner'],
      ['Wed 2026-10-07 10:00:00', 'hubspot.disconnected_by_owner'],
      ['Fri 2026-11-06 23:00:00', 'account.purged'],
    ]);
    const purgeRun = summary.timeline.filter((entry) => entry.name === 'job.account_daily' && entry.at === '2026-11-07T03:17:00.000Z');
    expect(purgeRun).toHaveLength(1);
    expect(summary.clock.end).toBe('2026-11-07T04:00:00.000Z');
  }, 600_000);
});
