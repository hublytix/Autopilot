import 'server-only';

// The brief builder's limits (PLAN §9.7, §10.4, D-36, D-47). One place, so the crawl, the job and the
// tests agree.

/** Internal pages fetched besides the homepage (9 pages in all). */
export const MAX_SUBPAGES = 8;
/** Each page's own deadline. */
export const PAGE_TIMEOUT_MS = 10_000;
/** The whole crawl, robots.txt and redirects included. */
export const CRAWL_BUDGET_MS = 60_000;
/** Fetches in flight at once. */
export const MAX_CONCURRENT_FETCHES = 4;
/** One page's body after decompression. */
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** All pages together. */
export const CRAWL_MAX_BYTES = 10 * 1024 * 1024;
/** Candidate links tried at most (failed and refused ones included), so a site full of dead links ends quickly. */
export const MAX_FETCH_ATTEMPTS = 16;

/**
 * The brief_generate job's own budget, inside the run route's 300 s maxDuration; what the crawl
 * leaves is the LLM call's `{timeout, signal}` (D-24).
 */
export const BRIEF_JOB_BUDGET_MS = 280_000;
/** Below this, a delivery does not start the LLM call (it would only be cut off); it retries instead. */
export const MIN_LLM_BUDGET_MS = 20_000;

/** Generations per account in any 24 hours, and one at a time (D-36). */
export const BRIEF_JOBS_PER_DAY = 5;
export const BRIEF_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** At most this many FAQs survive post-processing (brief §5.3). */
export const MAX_FAQS = 8;
