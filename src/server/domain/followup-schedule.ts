import 'server-only';
import { DateTime } from 'luxon';
import { QuietHoursError, shiftToAllowed, type QuietHoursSettings } from './quiet-hours';

// When the two follow-ups run (brief §5.6, PLAN §8.5, D-33, D-42). Pure.
//
// - Follow-up n runs `days(n)` calendar days after T0 = `first_notified_at`, in the portal's zone
//   (so a DST change keeps the local time of day), shifted out of quiet hours and weekends:
//   shiftToAllowed(T0.setZone(tz).plus({days})). Follow-up 1 is day 2, follow-up 2 is day 5.
// - "Resume follow-ups" (D-42, PLAN §9.6) reschedules only the follow-ups not yet sent, at
//   shiftToAllowed(max(T0 + n days, now + 1 h)).
// - A target beyond the scheduler's maximum delay is returned as it is; the jobs layer hops.

export const FOLLOW_UP_NUMBERS = [1, 2] as const;
export type FollowUpNumber = (typeof FOLLOW_UP_NUMBERS)[number];

/** Calendar days after the first notification (brief §5.6: day 2 and day 5). */
export const FOLLOW_UP_DAYS: Readonly<Record<FollowUpNumber, number>> = { 1: 2, 2: 5 };

/** A resumed follow-up never runs sooner than this after the owner's "Resume follow-ups" (D-42). */
export const RESUME_MIN_DELAY_MS = 60 * 60 * 1000;

export interface FollowUpTarget {
  readonly n: FollowUpNumber;
  readonly runAt: Date;
  /** True when quiet hours or weekends moved the time (and the account's offset was added). */
  readonly shifted: boolean;
}

function zoned(at: Date, zone: string): DateTime {
  const local = DateTime.fromJSDate(at, { zone });
  if (!local.isValid) throw new QuietHoursError('quiet_hours_invalid_time');
  return local;
}

function target(n: FollowUpNumber, at: DateTime, settings: QuietHoursSettings, accountId: string): FollowUpTarget {
  const { at: runAt, shifted } = shiftToAllowed(at, settings, accountId);
  return { n, runAt, shifted };
}

/** Follow-up n's unshifted time: T0 plus n's calendar days in `zone`. */
export function followUpDueAt(firstNotifiedAt: Date, n: FollowUpNumber, zone: string): DateTime {
  return zoned(firstNotifiedAt, zone).plus({ days: FOLLOW_UP_DAYS[n] });
}

/** Both follow-up targets, written with the "notified" transaction (PLAN §9.3 step 6, §8.5). */
export function followUpTargets(
  firstNotifiedAt: Date,
  settings: QuietHoursSettings,
  zone: string,
  accountId: string,
): readonly [FollowUpTarget, FollowUpTarget] {
  return [
    target(1, followUpDueAt(firstNotifiedAt, 1, zone), settings, accountId),
    target(2, followUpDueAt(firstNotifiedAt, 2, zone), settings, accountId),
  ];
}

/**
 * "Resume follow-ups" (D-42): a target for each follow-up not in `sent`, at
 * shiftToAllowed(max(T0 + n days, now + 1 h)), in follow-up order.
 */
export function resumeTargets(
  firstNotifiedAt: Date,
  now: Date,
  sent: readonly FollowUpNumber[],
  settings: QuietHoursSettings,
  zone: string,
  accountId: string,
): FollowUpTarget[] {
  const earliest = zoned(new Date(now.getTime() + RESUME_MIN_DELAY_MS), zone);
  const targets: FollowUpTarget[] = [];
  for (const n of FOLLOW_UP_NUMBERS) {
    if (sent.includes(n)) continue;
    const due = followUpDueAt(firstNotifiedAt, n, zone);
    targets.push(target(n, due.toMillis() >= earliest.toMillis() ? due : earliest, settings, accountId));
  }
  return targets;
}
