import 'server-only';
import { errorCode } from '@/server/domain/errors';
import type { QuietHoursSettings } from '@/server/domain/quiet-hours';
import { log } from '@/server/obs/log';
import { DEFAULT_QUIET_END_HOUR, DEFAULT_QUIET_START_HOUR } from '@/server/services/onboarding/quiet-hours';

// The settings every follow-up schedule reads (D-33): the account's quiet hours and weekends, and
// the portal's zone. Shared by the "notified" rows (schedule.ts), the follow-up job (lead.ts) and
// "Resume follow-ups" (owner-controls), so all three fall back the same way.

/** The `settings` columns a follow-up schedule needs (null when the account has no settings row). */
export interface QuietHoursColumns {
  readonly quiet_start_hour: number | null;
  readonly quiet_end_hour: number | null;
  readonly skip_weekends: boolean | null;
}

/** D-33's defaults, for an account without a settings row (cannot happen once it is active). */
export const DEFAULT_FOLLOW_UP_QUIET_HOURS: QuietHoursSettings = {
  quietStartHour: DEFAULT_QUIET_START_HOUR,
  quietEndHour: DEFAULT_QUIET_END_HOUR,
  skipWeekends: true,
};

export function quietHoursOf(row: QuietHoursColumns): QuietHoursSettings {
  if (row.quiet_start_hour === null || row.quiet_end_hour === null || row.skip_weekends === null) return DEFAULT_FOLLOW_UP_QUIET_HOURS;
  return { quietStartHour: row.quiet_start_hour, quietEndHour: row.quiet_end_hour, skipWeekends: row.skip_weekends };
}

/**
 * Runs `compute` in the account's zone (`accounts.timezone`, UTC when unknown). An unusable stored
 * zone (`quiet_hours_invalid_time`) means the portal's local time is unknown, so it runs again in UTC
 * with a warning, as the daily cap does. Any other error is thrown.
 */
export function inPortalZone<T>(timezone: string | null, accountId: string, compute: (zone: string) => T): T {
  try {
    return compute(timezone ?? 'UTC');
  } catch (error) {
    if (timezone === null || errorCode(error) !== 'quiet_hours_invalid_time') throw error;
    log.warn('account timezone unusable for follow-ups: using UTC', { event: 'followup.zone_fallback', accountId });
    return compute('UTC');
  }
}
