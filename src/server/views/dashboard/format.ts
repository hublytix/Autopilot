import 'server-only';
import { DateTime } from 'luxon';

// Times on the dashboard (PLAN §7.5): shown in the portal's zone (D-12; UTC when the stored zone is
// unknown or unusable), the same short form the owner emails use ("Tue 6 Oct, 10:15"), with the year
// only when it is not the current one. Pure; `now` comes from the caller's Clock.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The account's zone when Luxon accepts it, else UTC. */
export function displayZone(timezone: string | null): string {
  if (timezone === null || timezone.trim() === '') return 'UTC';
  return DateTime.fromMillis(0, { zone: timezone }).isValid ? timezone : 'UTC';
}

/** "Tue 6 Oct, 10:15" in `zone`; "Tue 6 Oct 2025, 10:15" outside the current year. */
export function formatInZone(at: Date, zone: string, now: Date): string {
  const local = DateTime.fromJSDate(at, { zone }).setLocale('en-GB');
  const sameYear = local.year === DateTime.fromJSDate(now, { zone }).year;
  return local.toFormat(sameYear ? 'ccc d LLL, HH:mm' : 'ccc d LLL yyyy, HH:mm');
}

/** "6 Oct 2026" in `zone`. */
export function formatDateInZone(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).setLocale('en-GB').toFormat('d LLL yyyy');
}

/** Whole days from `now` until `until`, rounded up (0 once it has passed): "14 days left" on the first trial day. */
export function daysUntil(until: Date, now: Date): number {
  const ms = until.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}
