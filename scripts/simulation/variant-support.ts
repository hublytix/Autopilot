// Shared by the M7 variant tests (billing.test.ts, lapse.test.ts, disconnect.test.ts): one run of a
// variant on the PGlite harness dump, in a temporary outbox directory, optionally with the system
// time faked (the simulation never reads the wall clock, PLAN §13).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { createTestDb } from '../../test/db/harness';
import { runSimulation } from './run';
import type { SimulationSummary, Stage } from './types';

export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** The fixture's form ids are UUID-shaped but fixed. */
export const FIXTURE_FORM_IDS = /b1f0c6a2-3d4e-4f50-8a61-7b2c9d0e1f0[1-3]/g;

/** The pre-run's checks, in order: every variant starts with them (its own follow). */
export const PRE_RUN_CHECK_IDS: readonly string[] = [
  'prerun.install_redirects_to_fake_consent',
  'prerun.fake_consent_page_shows_required_scopes',
  'prerun.consent_redirects_to_callback',
  'prerun.callback_branch_a_to_onboarding_email',
  'prerun.onboarding_email_page_prefills_installer_email',
  'prerun.magic_link_is_outbox_1',
  'prerun.confirm_page_never_auto_submits',
  'prerun.magic_link_on_fresh_cookie_jar_binds_owner',
  'prerun.install_browser_cookie_not_needed',
  'prerun.owner_is_the_installer',
  'prerun.brief_generation_requested',
  'prerun.newsletter_form_detected_and_unticked',
  'prerun.forms_saved',
  'prerun.preferences_saved_without_any_email',
  'prerun.brief_generated_before_review',
  'prerun.brief_saved_as_owner_version',
  'prerun.inbox_test_is_outbox_2_with_an_inbox_check_job',
  'prerun.inbox_check_history_counted',
  'prerun.test_send_link_opens_gmail_compose',
  'prerun.test_send_link_click_not_counted_before_60s',
  'prerun.owner_send_logged_in_hubspot',
  'prerun.baseline_started_by_its_page',
  'prerun.finish_activates_the_account',
  'prerun.owner_foreground_steps_within_5_minutes',
  'prerun.outbox_is_exactly_magic_link_and_inbox_test',
  'prerun.account_active',
  'prerun.timezone_from_hubspot',
  'prerun.onboarding_completed_at_0904_30',
  'prerun.both_enquiry_forms_selected',
  'prerun.floors_at_onboarding_complete_0904_30',
  'prerun.inbox_check_both_legs_log_all',
  'prerun.baseline_3h30m_and_20_percent',
  'prerun.background_work_done_by_0906',
  'prerun.ai_calls_brief_on_the_draft_model_and_baseline_on_the_fast_model',
  'prerun.no_historical_lead',
  'prerun.one_test_lead_linked_to_the_check',
];

/**
 * Every check of the summary as `[id, ok]`, in order: pinning the full list means a check that
 * never ran (a `sim.travel.at` callback that did not fire) fails the test instead of vanishing.
 */
export function checkIds(summary: SimulationSummary): [string, boolean][] {
  return summary.checks.map((check) => [check.id, check.ok]);
}

/** Runs `stages` once (under `systemTime` when given, e.g. `2030`), then restores the real timers. */
export async function runVariant(stages: readonly Stage[], scenario: string, systemTime: string | null = null): Promise<SimulationSummary> {
  const outboxDir = await mkdtemp(path.join(tmpdir(), `autopilot-sim-${scenario}-`));
  if (systemTime !== null) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${systemTime}-01-01T00:00:00.000Z`));
  }
  const db = await createTestDb();
  try {
    return await runSimulation({ outboxDir, systemTime, db, stages, scenario });
  } finally {
    vi.useRealTimers();
    await db.close();
    await rm(outboxDir, { recursive: true, force: true });
  }
}

/** The summary as JSON with the fixture's fixed form ids masked: any id left would make runs differ. */
export function idFreeJson(summary: SimulationSummary): string {
  return JSON.stringify(summary).replaceAll(FIXTURE_FORM_IDS, 'form');
}
