import 'server-only';
import { DbUsageError } from './errors';
import type { DbRow } from './types';

// Driver normalisation (D-28 rule 6). Both drivers are configured so a row reads the same whichever
// one produced it; `normalizeRows` is the last line of defence for anything a driver still returns as
// a bigint. Parameters are normalised here, before either driver sees them.

/** Postgres type OIDs the drivers are configured for. */
export const PG_TYPES = {
  INT8: 20,
  DATE: 1082,
  NUMERIC: 1700,
} as const;

const identity = (value: string): string => value;

/**
 * PGlite parsers: int8 and numeric stay strings (PGlite would otherwise return a number, or a bigint
 * past 2^53), date stays 'YYYY-MM-DD' (not a Date at UTC midnight). timestamptz → Date and jsonb →
 * parsed are PGlite's defaults, as they are Postgres.js's.
 */
export const PGLITE_PARSERS: Readonly<Record<number, (value: string) => unknown>> = {
  [PG_TYPES.INT8]: identity,
  [PG_TYPES.NUMERIC]: identity,
  [PG_TYPES.DATE]: identity,
};

/**
 * Postgres.js custom types: date stays 'YYYY-MM-DD' (its default parses date, timestamp and
 * timestamptz all as Date). int8 and numeric are already strings in Postgres.js.
 */
export const POSTGRES_JS_TYPES: Record<
  string,
  { to: number; from: number[]; serialize: (value: unknown) => string; parse: (raw: string) => string }
> = {
  date_only: {
    to: PG_TYPES.DATE,
    from: [PG_TYPES.DATE],
    serialize: (value: unknown): string => String(value),
    parse: identity,
  },
};

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeScalar(value: unknown): unknown {
  if (value === undefined) throw new DbUsageError('db_undefined_param');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DbUsageError('db_unsupported_param');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new DbUsageError('db_unsupported_param');
    return value;
  }
  throw new DbUsageError('db_unsupported_param');
}

function normalizeParam(value: unknown): unknown {
  if (Array.isArray(value)) {
    // An array holding objects can only be JSON; an array of scalars is a Postgres array.
    if (value.some((item) => typeof item === 'object' && item !== null && !(item instanceof Date) && !Array.isArray(item))) {
      return toJson(value);
    }
    return value.map((item: unknown) => (Array.isArray(item) ? item.map(normalizeScalar) : normalizeScalar(item)));
  }
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    if (value instanceof Uint8Array || !isPlainObject(value)) throw new DbUsageError('db_unsupported_param');
    return toJson(value);
  }
  return normalizeScalar(value);
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    // A cycle: the message would quote nothing, but keep the error contract uniform.
    throw new DbUsageError('db_unsupported_param');
  }
}

/** Validates and converts query parameters (see `Db` rule 6). */
export function normalizeParams(params: readonly unknown[] | undefined): unknown[] {
  return params === undefined ? [] : params.map(normalizeParam);
}

/** Converts any top-level bigint value to a string, in place. */
export function normalizeRows(rows: DbRow[]): DbRow[] {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (typeof value === 'bigint') row[key] = value.toString();
    }
  }
  return rows;
}
