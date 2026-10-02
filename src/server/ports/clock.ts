import 'server-only';

/**
 * The only source of time (D-28). Live: SystemClock. Fake: settable and advanceable, drives Luxon's
 * `Settings.now` and the fake scheduler. SQL binds `clock.now()` as `$now`.
 */
export interface Clock {
  /** The current instant. Each call returns a fresh Date the caller may keep. */
  now(): Date;
}
