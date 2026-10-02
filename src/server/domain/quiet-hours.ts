import 'server-only';
import { DateTime } from 'luxon';
import { PermanentError } from './errors';

// Quiet hours and weekends for follow-ups (D-33, PLAN §8.5). Pure.
//
// - Whole hours 0–23 in the portal's timezone: quiet from `quietStartHour` up to `quietEndHour`,
//   wrapping past midnight when start > end (19–08) and not when start < end (12–14);
//   start = end means no quiet hours.
// - Skip weekends: Saturday and Sunday in the portal's timezone are not allowed.
// - Quiet hours apply to follow-ups only; the first "new lead" email is immediate.
// - shiftToAllowed moves a time that is not allowed to the next whole allowed local hour, searching
//   at most 8 days, plus a deterministic per-account offset of 0–10 min (spreads the accounts that
//   share a quiet-hours end). The offset is added only when the time was shifted. A target beyond
//   the scheduler's maximum delay is returned as it is: the jobs layer hops (PLAN §8.3 step 2).

export interface QuietHoursSettings {
  /** 0–23, local. */
  readonly quietStartHour: number;
  /** 0–23, local. Equal to the start: no quiet hours. */
  readonly quietEndHour: number;
  readonly skipWeekends: boolean;
}

/** The longest stretch shiftToAllowed searches for an allowed hour (D-33). */
export const SHIFT_SEARCH_LIMIT_DAYS = 8;
/** The per-account offset added to a shifted time is 0 to this many seconds (0–10 min). */
export const MAX_SHIFT_OFFSET_SECONDS = 600;

// Every local whole hour lies a multiple of 15 minutes (absolute) after any other one, because every
// UTC offset in the tz database is a multiple of 15 minutes (Kathmandu +05:45, Lord Howe's 30-minute
// DST). Stepping in absolute 15-minute steps therefore visits every local whole hour exactly once,
// including both 01:00s of a fall-back night, and never one skipped by a spring-forward gap.
const SEARCH_STEP_MINUTES = 15;
const SEARCH_STEPS = (SHIFT_SEARCH_LIMIT_DAYS * 24 * 60) / SEARCH_STEP_MINUTES;

export type QuietHoursErrorCode = 'quiet_hours_no_allowed_hour' | 'quiet_hours_invalid_time';

/** shiftToAllowed found no allowed hour within the search limit, or the time or zone is invalid. */
export class QuietHoursError extends PermanentError<QuietHoursErrorCode> {
  override readonly name: string = 'QuietHoursError';
  declare readonly code: QuietHoursErrorCode;

  constructor(code: QuietHoursErrorCode) {
    super(code);
  }
}

function isWholeHour(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

/** Whether local `hour` (0–23) falls in the quiet window [start, end). */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Hours in a week at which a follow-up may be sent. */
export function allowedHoursPerWeek(settings: QuietHoursSettings): number {
  let perDay = 0;
  for (let hour = 0; hour < 24; hour += 1) if (!isQuietHour(hour, settings.quietStartHour, settings.quietEndHour)) perDay += 1;
  return perDay * (settings.skipWeekends ? 5 : 7);
}

export type QuietHoursValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'invalid_start_hour' | 'invalid_end_hour' | 'no_allowed_hour' };

/**
 * D-33: hours are whole 0–23, and a setting with no allowed hour in a week is rejected. With whole
 * hours the second rule never fires (a quiet window is at most 23 hours and weekdays always count);
 * it stays as the guard D-33 asks for.
 */
export function validateQuietHours(settings: QuietHoursSettings): QuietHoursValidation {
  if (!isWholeHour(settings.quietStartHour)) return { ok: false, code: 'invalid_start_hour' };
  if (!isWholeHour(settings.quietEndHour)) return { ok: false, code: 'invalid_end_hour' };
  if (allowedHoursPerWeek(settings) === 0) return { ok: false, code: 'no_allowed_hour' };
  return { ok: true };
}

function inZone(dt: Date | DateTime, zone: string): DateTime {
  const local = dt instanceof Date ? DateTime.fromJSDate(dt, { zone }) : dt.setZone(zone);
  if (!local.isValid) throw new QuietHoursError('quiet_hours_invalid_time');
  return local;
}

function allowedLocal(local: DateTime, settings: QuietHoursSettings): boolean {
  if (settings.skipWeekends && local.weekday >= 6) return false;
  return !isQuietHour(local.hour, settings.quietStartHour, settings.quietEndHour);
}

/** Whether a follow-up may be sent at `dt`, read in `zone` (an IANA zone or a Luxon fixed offset). */
export function isAllowed(dt: Date | DateTime, settings: QuietHoursSettings, zone: string): boolean {
  return allowedLocal(inZone(dt, zone), settings);
}

/**
 * The account's offset for shifted times: 0–600 s, a stable function of `seed` (the account id), so
 * the same account always lands at the same minute and different accounts spread out. FNV-1a 32-bit.
 */
export function shiftOffsetSeconds(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % (MAX_SHIFT_OFFSET_SECONDS + 1);
}

export interface ShiftResult {
  readonly at: Date;
  /** False when `target` was already allowed (returned unchanged, no offset). */
  readonly shifted: boolean;
}

/**
 * D-33: `target` (a DateTime in the portal's zone) if a follow-up may be sent then; otherwise the
 * next whole local hour that is allowed, plus the account's offset. Throws QuietHoursError when no
 * hour within 8 days is allowed (impossible for settings validateQuietHours accepts).
 */
export function shiftToAllowed(target: DateTime, settings: QuietHoursSettings, accountOffsetSeed: string): ShiftResult {
  if (!target.isValid) throw new QuietHoursError('quiet_hours_invalid_time');
  if (allowedLocal(target, settings)) return { at: target.toJSDate(), shifted: false };
  const hourStart = target.startOf('hour');
  for (let step = 1; step <= SEARCH_STEPS; step += 1) {
    const candidate = hourStart.plus({ minutes: step * SEARCH_STEP_MINUTES });
    if (candidate.minute !== 0 || !allowedLocal(candidate, settings)) continue;
    return { at: new Date(candidate.toMillis() + shiftOffsetSeconds(accountOffsetSeed) * 1000), shifted: true };
  }
  throw new QuietHoursError('quiet_hours_no_allowed_hour');
}
