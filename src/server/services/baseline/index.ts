import 'server-only';

// The onboarding baseline (PLAN §9.7, D-38): the `baseline` job, its figures and the stored rows.
// Import from here.
export { baselineFigures, median, MIN_MEDIAN_SAMPLES, percentWithout } from './figures';
export type { BaselineFigures } from './figures';
export {
  BASELINE_CLASSIFY_CONCURRENCY,
  BASELINE_JOB_BUDGET_MS,
  BASELINE_WINDOW_MS,
  baselineFailurePath,
  createBaselineHandler,
  registerBaselineJobs,
} from './job';
export type { BaselineJobOptions } from './job';
export { baselineReason, baselineView, insertBaseline, latestBaseline, MAX_BASELINE_SUBMISSIONS } from './repository';
export type { BaselineReason, BaselineRecord, BaselineView, NewBaseline } from './repository';
export { baselineDedupeKey, ensureBaselineStarted } from './start';
export type { StartBaselineResult } from './start';
