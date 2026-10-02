import 'server-only';

// The global AI daily budget breaker (D-36, PLAN §9.3 step 4) lives with drafting
// (services/drafting/budget.ts); classification checks the same breaker before every call: while it
// is tripped the lead becomes `unclear` without a model call (bounding a classification flood), and
// the admin gets one alert per UTC day.
export { isAiDailyBudgetTripped } from '@/server/services/drafting/budget';
