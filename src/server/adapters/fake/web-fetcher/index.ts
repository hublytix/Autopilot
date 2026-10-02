import 'server-only';

export {
  DEFAULT_FAKE_ROUTES,
  DEFAULT_USER_AGENT_TOKEN,
  FAKE_SSRF_BLOCKED_HOSTS,
  FIXTURE_BOOKING_LINK,
  FIXTURE_SITE_HOST,
  FIXTURE_SITE_URL,
  FakeWebFetcher,
  MAX_REDIRECTS,
} from './fake-web-fetcher';
export type { FakeFetchRecord, FakeRoute, FakeWebFetcherOptions } from './fake-web-fetcher';
export { isAllowedByRobots, parseRobots } from './robots';
export type { RobotsRules } from './robots';
