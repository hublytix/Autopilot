import 'server-only';
import { DateTime } from 'luxon';
import { QuietHoursError, shiftToAllowed, type QuietHoursSettings } from './quiet-hours';

// When the two follow-ups run (brief §5.6, PLAN §8.5, D-33, D-42). Pure.
//
// - Follow-up n runs `days(n)` calendar days after T0 = `first_notified_at`, in the portal's zone
//   (so a DST change keeps the local time of day), shifted out of quiet hours and weekends:
//   shiftToAllowed(T0.setZone(tz).plus({days})). Follow-up 1 is day 2, follow-up 2 is day 5.
// - "Resume follow-ups" (D-42, PLAN §9.6) reschedules only the follow-ups not yet sent: the earliest
//   at shiftToAllowed(max(T0 + n days, now + 1 h)); a later one also keeps the original gap after the
//   one before it (fu2 − fu1 = 3 calendar days in the portal's zone), so resuming after day 5 with
//   neither sent does not put both at now + 1 h (D-72, closing D-66's open point (1)).
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

function latest(times: readonly DateTime[]): DateTime {
  return times.reduce((a, b) => (b.toMillis() > a.toMillis() ? b : a));
}

/**
 * "Resume follow-ups" (D-42, D-72, D-73): a target for each follow-up not in `sent`, in follow-up order.
 * The earliest at shiftToAllowed(max(T0 + n days, now + 1 h)); each later one at
 * shiftToAllowed(max(T0 + n days, now + 1 h, the previous follow-up + the original gap)), the gap
 * counted from the previous follow-up's shifted target, or, when that one is in `sent`, from when it
 * reached the owner or was first reserved while its email is still being sent (`sentAt`, D-73), so two
 * follow-ups are never closer than 3 days. Resumed before day 2 with no shift, both keep their original
 * days (T0 + 2 + 3 = T0 + 5).
 */
export function resumeTargets(
  firstNotifiedAt: Date,
  now: Date,
  sent: readonly FollowUpNumber[],
  settings: QuietHoursSettings,
  zone: string,
  accountId: string,
  sentAt: Readonly<Partial<Record<FollowUpNumber, Date>>> = {},
): FollowUpTarget[] {
  const earliest = zoned(new Date(now.getTime() + RESUME_MIN_DELAY_MS), zone);
  const targets: FollowUpTarget[] = [];
  let previous: { readonly n: FollowUpNumber; readonly at: DateTime } | null = null;
  for (const n of FOLLOW_UP_NUMBERS) {
    if (sent.includes(n)) {
      const at = sentAt[n];
      previous = at === undefined ? null : { n, at: zoned(at, zone) };
      continue;
    }
    const candidates = [followUpDueAt(firstNotifiedAt, n, zone), earliest];
    if (previous !== null) candidates.push(previous.at.plus({ days: FOLLOW_UP_DAYS[n] - FOLLOW_UP_DAYS[previous.n] }));
    const next = target(n, latest(candidates), settings, accountId);
    targets.push(next);
    previous = { n, at: zoned(next.runAt, zone) };
  }
  return targets;
}
