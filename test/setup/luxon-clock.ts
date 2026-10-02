import { Settings } from 'luxon';

// D-28 in tests: Luxon never reads the wall clock. A Luxon call that fills in "now" implicitly
// (a time-only fromISO, fromFormat('09:00', 'HH:mm'), toRelative() without a base) gets this
// fixed, obviously artificial instant, unless the test points Settings.now at its FakeClock (as the
// simulation and the container do). Code that leans on the implicit "now" therefore shows up as a
// year-2000 date instead of passing or failing with the day the suite runs.
export const TEST_LUXON_NOW_MS = Date.UTC(2000, 0, 1);

Settings.now = () => TEST_LUXON_NOW_MS;
