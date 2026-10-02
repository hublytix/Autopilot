import 'server-only';

// The inbox-logging check's timings and limits (PLAN §8.2, §9.7, D-14, D-36, D-49).

/** Each leg's window: 10 minutes from its start (the test email for the send, the owner's send for the reply). */
export const LEG_WINDOW_MS = 10 * 60 * 1000;
/** The reply leg can start at the latest when the send window ends, so its first deadline is two windows out. */
export const INITIAL_REPLY_WINDOW_MS = 2 * LEG_WINDOW_MS;
/** The `inbox_check` job re-checks every 60 s (PLAN §8.2). */
export const CHECK_INTERVAL_MS = 60 * 1000;
/** HubSpot's `hs_timestamp` is the mail client's clock: an email up to a minute before the check started still counts (D-08's skew). */
export const CLOCK_SKEW_MS = 60 * 1000;
/** A check still without deadlines this long after creation is closed with its legs skipped; its address is cleared too (D-14, D-49). */
export const INBOX_CHECK_ABANDON_MS = 24 * 60 * 60 * 1000;
/** Test-lead content (lead_messages, drafts) lives 24 h (D-31, D-49). */
export const TEST_LEAD_CONTENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Starts per account in any rolling 24 h: each one emails the owner (bounded like brief generation, D-36). */
export const INBOX_CHECKS_PER_DAY = 5;
/** Defensive bound on runs per check: the windows end after about 20 runs. */
export const MAX_CHECK_RUNS = 30;
/** Association pages read per run (100 ids each), so a long-standing contact cannot make a run unbounded. */
export const MAX_ASSOCIATION_PAGES = 20;
/** RFC 5321's limit on an address. */
export const MAX_ADDRESS_LENGTH = 254;
