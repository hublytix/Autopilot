import 'server-only';

// Quiet hours as the owner sets them (D-33): whole hours 0–23 in the portal's timezone, quiet from
// `start` up to `end` (wrapping past midnight when start > end); start = end means no quiet hours.
// Quiet hours apply to follow-ups only. A setting that leaves no allowed hour in a week is refused.
// The follow-up scheduler (M5) owns shifting times into the allowed hours; this is only the
// validation the preferences form needs.

export const DEFAULT_QUIET_START_HOUR = 19;
export const DEFAULT_QUIET_END_HOUR = 8;

export function isValidHour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23;
}

/** Whether `hour` (0–23) falls in the quiet window. */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Hours in a week at which a follow-up may be sent. */
export function allowedHoursPerWeek(start: number, end: number, skipWeekends: boolean): number {
  let perDay = 0;
  for (let hour = 0; hour < 24; hour += 1) if (!isQuietHour(hour, start, end)) perDay += 1;
  return perDay * (skipWeekends ? 5 : 7);
}
