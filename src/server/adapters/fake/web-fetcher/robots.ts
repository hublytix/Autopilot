import 'server-only';

// The robots.txt parser is shared with the live HttpWebFetcher; it lives in the pure domain layer.
export { isAllowedByRobots, parseRobots } from '@/server/domain/robots';
export type { RobotsRules } from '@/server/domain/robots';
