import 'server-only';

// robots.txt (RFC 9309, PLAN §9.7, §10.4): shared by the live HttpWebFetcher and the fake one.
// - Groups are chosen by user-agent: every group naming our product token (case-insensitive; a
//   group token contained in ours also matches, as common crawlers do) is combined; without one,
//   every `*` group is combined; without either, everything is allowed.
// - The longest matching rule wins and `Allow` wins a tie; `*` matches any run of characters and a
//   trailing `$` anchors the end. Paths are compared as written (percent-encoded).
// - An empty `Disallow` allows everything; an empty `Allow` means nothing. `/robots.txt` itself is
//   always allowed (the callers never check it against itself).

interface RobotsRule {
  readonly allow: boolean;
  /** The rule's path as written, used for the longest-match comparison. */
  readonly path: string;
  readonly pattern: RegExp;
}

interface RobotsGroup {
  readonly agents: string[];
  readonly rules: RobotsRule[];
}

export interface RobotsRules {
  readonly groups: readonly RobotsGroup[];
}

/** Rules that allow everything: no robots.txt, or one that answered 4xx (RFC 9309 §2.3.1.3). */
export const ALLOW_ALL_ROBOTS: RobotsRules = Object.freeze({ groups: [] });

/** Rules that refuse everything: robots.txt unreachable or 5xx (RFC 9309 §2.3.1.4). */
export const DISALLOW_ALL_ROBOTS: RobotsRules = Object.freeze({
  groups: [{ agents: ['*'], rules: [{ allow: false, path: '/', pattern: /^\// }] }],
});

/** A rule path longer than this is ignored (it could only come from a hostile or broken file). */
const MAX_RULE_PATH = 2048;

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function compile(path: string): RegExp {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path).split('*').map(escapeRegex).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      if (value.length > 0) current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) continue;
    if (field === 'allow' || field === 'disallow') {
      if (value.length === 0 || value.length > MAX_RULE_PATH) continue;
      current.rules.push({ allow: field === 'allow', path: value, pattern: compile(value) });
    }
  }
  return { groups };
}

function rulesFor(rules: RobotsRules, userAgentToken: string): RobotsRule[] | null {
  const token = userAgentToken.toLowerCase();
  const specific = rules.groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = specific.length > 0 ? specific : rules.groups.filter((g) => g.agents.includes('*'));
  return chosen.length === 0 ? null : chosen.flatMap((g) => g.rules);
}

/** Whether `pathWithQuery` (e.g. `/private?x=1`) may be fetched by `userAgentToken`. */
export function isAllowedByRobots(rules: RobotsRules, userAgentToken: string, pathWithQuery: string): boolean {
  if (pathWithQuery === '/robots.txt') return true;
  const applicable = rulesFor(rules, userAgentToken);
  if (applicable === null) return true;
  let best: RobotsRule | undefined;
  for (const rule of applicable) {
    if (!rule.pattern.test(pathWithQuery)) continue;
    if (
      best === undefined ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best === undefined || best.allow;
}
