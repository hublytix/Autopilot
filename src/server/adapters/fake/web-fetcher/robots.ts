import 'server-only';

// A small robots.txt parser for the fake WebFetcher (the live adapter has its own, PLAN §10.4).
// Groups are selected by user-agent token (case-insensitive substring), falling back to `*`. The
// longest matching rule wins and `Allow` wins a tie; `*` and a trailing `$` are supported.

interface RobotsRule {
  allow: boolean;
  /** The rule's path as written, used for the longest-match comparison. */
  path: string;
  pattern: RegExp;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsRules {
  readonly groups: readonly RobotsGroup[];
}

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
  for (const rawLine of text.split(/\r?\n/)) {
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
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) continue;
    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow allows everything; an empty Allow means nothing.
      if (value.length === 0) continue;
      current.rules.push({ allow: field === 'allow', path: value, pattern: compile(value) });
    }
  }
  return { groups };
}

function groupFor(rules: RobotsRules, userAgentToken: string): RobotsGroup | undefined {
  const token = userAgentToken.toLowerCase();
  const specific = rules.groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  return specific ?? rules.groups.find((g) => g.agents.includes('*'));
}

/** Whether `pathWithQuery` (e.g. `/private?x=1`) may be fetched by `userAgentToken`. */
export function isAllowedByRobots(rules: RobotsRules, userAgentToken: string, pathWithQuery: string): boolean {
  const group = groupFor(rules, userAgentToken);
  if (group === undefined) return true;
  let best: RobotsRule | undefined;
  for (const rule of group.rules) {
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
