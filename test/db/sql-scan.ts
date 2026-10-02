// The D-28 wall-clock scan for SQL: every logical timestamp is bound from the Clock ($now), so SQL
// may not read the database's clock. The only exceptions are the audit-only column defaults
// audit_log.at and webhook_events.received_at.

/** (table, column) pairs whose `default now()` is allowed. */
export const WALL_CLOCK_ALLOW_LIST: readonly (readonly [string, string])[] = [
  ['audit_log', 'at'],
  ['webhook_events', 'received_at'],
];

/**
 * Functions, keywords and special date/time input literals that read the database clock
 * ('today'::date, 'tomorrow', 'yesterday' and 'now' are evaluated against it).
 */
const WALL_CLOCK =
  /\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(|\bcurrent_(?:timestamp|date|time)\b|\blocaltime(?:stamp)?\b|'(?:now|today|tomorrow|yesterday)'/gi;

const AGE_CALL = /\bage\s*\(/gi;

/**
 * Indexes of one-argument age(ts) calls, which measure from current_date (the two-argument form
 * is pure). Arguments may nest parentheses; a comma at the top level means two arguments.
 */
function oneArgumentAgeCalls(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(AGE_CALL)) {
    let depth = 0;
    let commas = 0;
    let closed = false;
    for (let i = match.index + match[0].length; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        if (depth === 0) {
          closed = true;
          break;
        }
        depth -= 1;
      } else if (ch === ',' && depth === 0) commas += 1;
    }
    if (closed && commas === 0) found.push(match.index);
  }
  return found;
}

export interface WallClockHit {
  file: string;
  line: number;
  text: string;
}

/** Replaces SQL comments with spaces (keeping newlines), leaving quoted text and dollar quotes intact. */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else {
      const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
      if (dollar !== null) {
        const end = sql.indexOf(dollar[0], i + dollar[0].length);
        const stop = end === -1 ? sql.length : end + dollar[0].length;
        out += sql.slice(i, stop);
        i = stop;
      } else {
        out += sql[i];
        i += 1;
      }
    }
  }
  return out;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Whether a hit is an allow-listed column default: `<column> … default now()` in `create table <table>`. */
function isAllowed(sql: string, index: number): boolean {
  const statementStart = sql.lastIndexOf(';', index) + 1;
  const statement = sql.slice(statementStart, index);
  // The column definition the default belongs to starts after the last `(` or `,` before it.
  const definition = statement.slice(Math.max(statement.lastIndexOf('('), statement.lastIndexOf(',')) + 1);
  const table = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?\w+"?\.)?"?(\w+)"?/i.exec(statement)?.[1];
  const column = /^\s*"?(\w+)"?\s+timestamptz\b[^,]*\bdefault\s*$/i.exec(definition)?.[1];
  if (table !== undefined && column !== undefined) {
    return WALL_CLOCK_ALLOW_LIST.some(([t, c]) => t === table.toLowerCase() && c === column.toLowerCase());
  }
  const alter = /alter\s+table\s+(?:only\s+)?(?:"?\w+"?\.)?"?(\w+)"?\s+alter\s+(?:column\s+)?"?(\w+)"?\s+set\s+default\s*$/i.exec(statement);
  if (alter?.[1] !== undefined && alter[2] !== undefined) {
    const [, t, c] = alter;
    return WALL_CLOCK_ALLOW_LIST.some(([at, ac]) => at === t.toLowerCase() && ac === c.toLowerCase());
  }
  return false;
}

/** Wall-clock reads in a SQL file, minus the allow-listed column defaults. */
export function scanSql(file: string, source: string): WallClockHit[] {
  const sql = stripSqlComments(source);
  const hits: WallClockHit[] = [];
  for (const match of sql.matchAll(WALL_CLOCK)) {
    if (isAllowed(sql, match.index)) continue;
    hits.push({ file, line: lineOf(sql, match.index), text: match[0] });
  }
  for (const index of oneArgumentAgeCalls(sql)) hits.push({ file, line: lineOf(sql, index), text: 'age(' });
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * The string and template literals of a TypeScript source (best effort: comments are skipped, and a
 * `/` that can start a regular expression skips the regex literal).
 */
export function tsStringLiterals(source: string): { text: string; index: number }[] {
  const literals: { text: string; index: number }[] = [];
  let i = 0;
  let lastSignificant = '';
  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        j += source[j] === '\\' ? 2 : 1;
      }
      literals.push({ text: source.slice(i + 1, j), index: i });
      i = j + 1;
      lastSignificant = ch;
    } else if (ch === '/' && (lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant))) {
      // A regular expression literal: skip to its closing slash (outside a character class).
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n') {
        const c = source[j];
        if (c === '\\') j += 1;
        else if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j += 1;
      }
      i = j + 1;
      lastSignificant = '/';
    } else {
      if (!/\s/.test(ch)) lastSignificant = ch;
      i += 1;
    }
  }
  return literals;
}

/** Wall-clock reads inside the string literals of a TypeScript file (no allow-list: code binds $now). */
export function scanTs(file: string, source: string): WallClockHit[] {
  const hits: WallClockHit[] = [];
  for (const literal of tsStringLiterals(source)) {
    for (const match of literal.text.matchAll(WALL_CLOCK)) {
      hits.push({ file, line: lineOf(source, literal.index + 1 + match.index), text: match[0] });
    }
    for (const index of oneArgumentAgeCalls(literal.text)) {
      hits.push({ file, line: lineOf(source, literal.index + 1 + index), text: 'age(' });
    }
  }
  return hits;
}
