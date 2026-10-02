import 'server-only';
import type { BaselineStatus } from './types';

// Why a stored baseline (D-38) has no full figures, read the same way by the onboarding baseline
// step and the Monday report's "Compared with your baseline" (D-74, D-77). Pure.

/** Above this many submissions in 30 days the baseline is "Not enough data" (D-38). */
export const MAX_BASELINE_SUBMISSIONS = 500;

/** Why a baseline has no full figures, for the owner-facing copy. */
export type BaselineReason =
  /** More than 500 submissions in 30 days: "Not enough data". */
  | 'too_many_submissions'
  /** No lead in 30 days: "Not enough data". */
  | 'no_leads'
  /** The portal has no logged outbound email in 30 days: "Not enough logged history". */
  | 'no_logged_email'
  /** Logged emails could not be read (scope missing, or the job gave up): "Not enough logged history". */
  | 'not_readable';

export const BASELINE_REASONS = ['too_many_submissions', 'no_leads', 'no_logged_email', 'not_readable'] as const satisfies readonly BaselineReason[];

/** The fields the reason is read from (a `baselines` row). */
export interface BaselineReasonInput {
  readonly status: BaselineStatus;
  readonly submissionsRead: number;
  readonly leadsCounted: number;
}

/** Null for an `ok` baseline. */
export function baselineReason(record: BaselineReasonInput): BaselineReason | null {
  if (record.status === 'ok') return null;
  if (record.status === 'unavailable') return 'not_readable';
  if (record.submissionsRead > MAX_BASELINE_SUBMISSIONS) return 'too_many_submissions';
  if (record.leadsCounted === 0) return 'no_leads';
  return 'no_logged_email';
}

/** The owner-facing wording family: "Not enough data" or "Not enough logged history" (the onboarding page's mapping). */
export function baselineReasonIsLoggedHistory(reason: BaselineReason): boolean {
  return reason === 'no_logged_email' || reason === 'not_readable';
}
