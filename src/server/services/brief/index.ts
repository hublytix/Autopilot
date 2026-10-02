import 'server-only';

// The business brief (brief §5.3, PLAN §9.7): generation requests, the brief_generate job, the
// crawl and extraction, post-processing, and the owner's saved versions. Import from here.
export { acceptGeneratedBookingLink, bookingLinkHost, parseBookingLink } from './booking-link';
export { crawlSite } from './crawl';
export type { CrawlOptions, CrawlResult, CrawlStats } from './crawl';
export { extractPage } from './extract';
export type { ExtractedPage, ExtractInput, PageLink } from './extract';
export { briefGenerateFailurePath, createBriefGenerateHandler, registerBriefJobs } from './job';
export type { BriefJobOptions } from './job';
export * from './limits';
export { postProcessBrief } from './post-process';
export { PAGE_KEYWORDS, rankLinks } from './rank';
export type { RankedLink } from './rank';
export {
  BRIEF_JOB_LIVE_SQL,
  briefGenerationAllowance,
  getBriefVersion,
  getLatestBrief,
  hasOwnerSavedBrief,
  insertGeneratedVersion,
  latestBriefJob,
  listBriefVersions,
  saveOwnerBrief,
} from './repository';
export type { BriefEditorState, BriefJobView, BriefVersionSummary, BriefVersionView, SaveOwnerBriefResult } from './repository';
export { briefGenerateDedupeKey, requestBriefGeneration } from './request';
export type { BriefRequestRefusal, BriefRequestResult } from './request';
export { BRIEF_FIELD_LIMITS, EMPTY_BRIEF, OWNER_BOOKING_LINK_CHOICES, OwnerBriefInputSchema } from './schema';
export type { BriefFieldIssue, OwnerBriefInput, OwnerBriefParsed } from './schema';
export { isSameSite, normaliseSiteUrl } from './site-url';
export type { SiteUrlResult } from './site-url';
