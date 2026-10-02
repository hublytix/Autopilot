import 'server-only';
import { allowedHoursPerWeek as allowedHoursPerWeekOf, isQuietHour } from '@/server/domain/quiet-hours';

// Quiet hours as the owner sets them (D-33): whole hours 0–23 in the portal's timezone, quiet from
// `start` up to `end` (wrapping past midnight when start > end); start = end means no quiet hours.
// Quiet hours apply to follow-ups only. A setting that leaves no allowed hour in a week is refused.
// The rules live in domain/quiet-hours (which also shifts follow-up times into the allowed hours,
// D-33); this module keeps the preferences form's defaults and its argument order.

export const DEFAULT_QUIET_START_HOUR = 19;
export const DEFAULT_QUIET_END_HOUR = 8;

export { isQuietHour };

export function isValidHour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23;
}

/** Hours in a week at which a follow-up may be sent. */
export function allowedHoursPerWeek(start: number, end: number, skipWeekends: boolean): number {
  return allowedHoursPerWeekOf({ quietStartHour: start, quietEndHour: end, skipWeekends });
}
