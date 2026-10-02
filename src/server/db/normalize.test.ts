import { describe, expect, it } from 'vitest';
import { DbUsageError } from './errors';
import { normalizeParams, normalizeRows, PGLITE_PARSERS, PG_TYPES, POSTGRES_JS_TYPES } from './normalize';

describe('normalizeParams', () => {
  it('passes scalars and Dates through and sends bigints as strings', () => {
    const at = new Date('2026-10-06T13:00:00.000Z');
    expect(normalizeParams(['a', 1, 1.5, true, null, at, 9007199254740993n])).toEqual([
      'a',
      1,
      1.5,
      true,
      null,
      at,
      '9007199254740993',
    ]);
  });

  it('keeps arrays of scalars as Postgres arrays', () => {
    expect(normalizeParams([['a', 'b'], [], [1, null]])).toEqual([['a', 'b'], [], [1, null]]);
  });

  it('sends plain objects, and arrays holding objects, as JSON text', () => {
    expect(normalizeParams([{ a: 1, b: [1, 2], c: 3n }, [{ x: 1 }]])).toEqual(['{"a":1,"b":[1,2],"c":"3"}', '[{"x":1}]']);
  });

  it('treats a missing parameter list as no parameters', () => {
    expect(normalizeParams(undefined)).toEqual([]);
  });

  it.each([
    ['undefined', undefined, 'db_undefined_param'],
    ['undefined inside an array', ['a', undefined], 'db_undefined_param'],
    ['NaN', Number.NaN, 'db_unsupported_param'],
    ['Infinity', Number.POSITIVE_INFINITY, 'db_unsupported_param'],
    ['an invalid Date', new Date('nope'), 'db_unsupported_param'],
    ['bytes (bytea is never used)', new Uint8Array([1, 2]), 'db_unsupported_param'],
    ['a class instance', new Map([['a', 1]]), 'db_unsupported_param'],
    ['a function', () => 1, 'db_unsupported_param'],
  ])('rejects %s', (_label, value, code) => {
    let error: unknown;
    try {
      normalizeParams([value]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DbUsageError);
    expect((error as DbUsageError).code).toBe(code);
  });
});

describe('normalizeRows', () => {
  it('turns any top-level bigint into a string and leaves the rest alone', () => {
    const at = new Date('2026-10-06T13:00:00.000Z');
    expect(normalizeRows([{ id: 5n, n: 1, at, j: { a: 1 } }])).toEqual([{ id: '5', n: 1, at, j: { a: 1 } }]);
  });
});

describe('driver type configuration', () => {
  it('keeps int8, numeric and date as strings on PGlite', () => {
    expect(PGLITE_PARSERS[PG_TYPES.INT8]?.('9007199254740993')).toBe('9007199254740993');
    expect(PGLITE_PARSERS[PG_TYPES.NUMERIC]?.('1.50')).toBe('1.50');
    expect(PGLITE_PARSERS[PG_TYPES.DATE]?.('2026-10-05')).toBe('2026-10-05');
  });

  it('keeps date as a string on Postgres.js (its default parses it to a Date)', () => {
    const dateOnly = POSTGRES_JS_TYPES['date_only'];
    expect(dateOnly?.from).toEqual([PG_TYPES.DATE]);
    expect(dateOnly?.parse('2026-10-05')).toBe('2026-10-05');
  });
});
