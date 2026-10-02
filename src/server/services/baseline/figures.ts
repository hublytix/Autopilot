import 'server-only';
import { wholePercent } from '@/server/domain/weekly-metrics';

// The baseline's figures (D-38, PLAN §9.7), pure. Over the leads (submissions classified `lead` or
// `unclear`) of the last 30 days:
// - the lead count;
// - the median time from a submission to the first logged EMAIL to the lead, when at least 3 leads
//   have one (an even count takes the mean of the two middle values);
// - the number of leads with no logged outbound email (shown with its % of the lead count only when
//   the portal has logged EMAILs at all and the email scope is granted: the caller decides that).

/** The median needs at least this many measured leads. */
export const MIN_MEDIAN_SAMPLES = 3;

/** The median of `values`, or null for an empty list. Even length: the mean of the two middle values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

export interface BaselineFigures {
  leadsCounted: number;
  /** Null when fewer than MIN_MEDIAN_SAMPLES leads had a logged outbound email. */
  medianSecondsToFirstOutbound: number | null;
  withoutOutboundCount: number;
}

/** `waits`: one entry per lead, the seconds to its first logged outbound email, or null for none. */
export function baselineFigures(waits: readonly (number | null)[]): BaselineFigures {
  const measured = waits.filter((wait): wait is number => wait !== null);
  return {
    leadsCounted: waits.length,
    medianSecondsToFirstOutbound: measured.length >= MIN_MEDIAN_SAMPLES ? median(measured) : null,
    withoutOutboundCount: waits.length - measured.length,
  };
}

/**
 * The share of leads without a logged outbound email, as a whole percent; null without leads. The
 * Monday report's rounding (never 0% while one lead is without, never 100% while one has one, D-77).
 */
export function percentWithout(withoutOutboundCount: number, leadsCounted: number): number | null {
  return wholePercent(withoutOutboundCount, leadsCounted);
}
