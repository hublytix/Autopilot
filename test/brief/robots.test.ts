import { describe, expect, it } from 'vitest';
import { ALLOW_ALL_ROBOTS, DISALLOW_ALL_ROBOTS, isAllowedByRobots, parseRobots } from '@/server/domain/robots';

// The robots.txt parser shared by the live and fake WebFetchers (RFC 9309, PLAN §10.4).

const UA = 'HublytixAutopilot';

describe('robots.txt parser', () => {
  it('uses our own group when one names HublytixAutopilot, otherwise the * group', () => {
    const rules = parseRobots(['User-agent: *', 'Disallow: /private', '', 'User-agent: HublytixAutopilot', 'Disallow: /drafts'].join('\n'));
    expect(isAllowedByRobots(rules, UA, '/drafts/1')).toBe(false);
    // Our group replaces the * group entirely.
    expect(isAllowedByRobots(rules, UA, '/private')).toBe(true);
    expect(isAllowedByRobots(rules, 'SomeOtherBot', '/private')).toBe(false);
    expect(isAllowedByRobots(rules, 'SomeOtherBot', '/drafts/1')).toBe(true);
  });

  it('matches the product token case-insensitively and combines every group that names it', () => {
    const rules = parseRobots(['User-agent: hublytixautopilot', 'Disallow: /a', '', 'User-agent: HUBLYTIXAUTOPILOT', 'Disallow: /b'].join('\n'));
    expect(isAllowedByRobots(rules, UA, '/a')).toBe(false);
    expect(isAllowedByRobots(rules, UA, '/b')).toBe(false);
    expect(isAllowedByRobots(rules, UA, '/c')).toBe(true);
  });

  it('lets several user-agent lines share one group', () => {
    const rules = parseRobots(['User-agent: Googlebot', 'User-agent: HublytixAutopilot', 'Disallow: /x'].join('\n'));
    expect(isAllowedByRobots(rules, UA, '/x')).toBe(false);
  });

  it('applies the longest match, Allow winning a tie', () => {
    const rules = parseRobots(['User-agent: *', 'Disallow: /shop', 'Allow: /shop/about', 'Allow: /page', 'Disallow: /page'].join('\n'));
    expect(isAllowedByRobots(rules, UA, '/shop/cart')).toBe(false);
    expect(isAllowedByRobots(rules, UA, '/shop/about-us')).toBe(true);
    expect(isAllowedByRobots(rules, UA, '/page')).toBe(true);
  });

  it('supports * wildcards and the $ end anchor, with the query string part of the path', () => {
    const rules = parseRobots(['User-agent: *', 'Disallow: /*.pdf$', 'Disallow: /*?session=', 'Disallow: /tmp*/cache'].join('\n'));
    expect(isAllowedByRobots(rules, UA, '/files/a.pdf')).toBe(false);
    expect(isAllowedByRobots(rules, UA, '/files/a.pdf?download=1')).toBe(true);
    expect(isAllowedByRobots(rules, UA, '/cart?session=abc')).toBe(false);
    expect(isAllowedByRobots(rules, UA, '/tmp-2/cache/x')).toBe(false);
  });

  it('ignores comments, blank Disallow lines, a BOM, CRLF line ends and rules before any user-agent', () => {
    const text = '﻿Disallow: /orphan\r\n# comment\r\nUser-agent: * # everyone\r\nDisallow:\r\nDisallow: /admin # staff only\r\n';
    const rules = parseRobots(text);
    expect(isAllowedByRobots(rules, UA, '/orphan')).toBe(true);
    expect(isAllowedByRobots(rules, UA, '/admin/x')).toBe(false);
    expect(isAllowedByRobots(rules, UA, '/')).toBe(true);
  });

  it('allows everything for an empty file or one without a matching group, and always allows /robots.txt', () => {
    expect(isAllowedByRobots(parseRobots(''), UA, '/anything')).toBe(true);
    expect(isAllowedByRobots(parseRobots('User-agent: OtherBot\nDisallow: /'), UA, '/anything')).toBe(true);
    expect(isAllowedByRobots(parseRobots('User-agent: *\nDisallow: /'), UA, '/robots.txt')).toBe(true);
  });

  it('has fixed allow-all and disallow-all rule sets for missing and unreachable files', () => {
    expect(isAllowedByRobots(ALLOW_ALL_ROBOTS, UA, '/x')).toBe(true);
    expect(isAllowedByRobots(DISALLOW_ALL_ROBOTS, UA, '/')).toBe(false);
    expect(isAllowedByRobots(DISALLOW_ALL_ROBOTS, UA, '/x?y=1')).toBe(false);
  });

  it('reads the fixture site: /private and /admin/ are off limits, everything else is open', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private\nDisallow: /admin/\n\nUser-agent: GreedyScraper\nDisallow: /\n');
    expect(isAllowedByRobots(rules, UA, '/private')).toBe(false);
    expect(isAllowedByRobots(rules, UA, '/admin/')).toBe(false);
    expect(isAllowedByRobots(rules, UA, '/services')).toBe(true);
    expect(isAllowedByRobots(rules, 'GreedyScraper/2.0', '/services')).toBe(false);
  });
});
