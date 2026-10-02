import 'server-only';
import { z } from 'zod';

// toClaudeJsonSchema: our own Zod → JSON Schema converter for structured outputs
// (`output_config.format = {type: 'json_schema', schema}`, D-24). The SDK's helpers move `enum` and
// `const` into description text, so the grammar would not constrain category, tone or flag values
// [AI-SO-TS-ENUM]. This converter keeps them and refuses, rather than silently demotes, anything the
// API cannot enforce or the design does not want [AI-SO-SCHEMA-LIMITS]:
// - kept: type, properties, required, items, enum, const, anyOf, allOf, description, title,
//   default, the supported string formats and minItems 0|1;
// - every object gets `additionalProperties: false`, and every property must be required (optional
//   fields are written `.nullable()`), so the 24-optional-property limit can never be reached;
// - at most 16 union types (anyOf branches or `["x","null"]` type arrays) per schema;
// - string enum/const values must be lower case: model output is lower-cased before Zod parses it;
// - refused: $ref/$defs (and so recursion), oneOf, not, patterns, numeric bounds, string length
//   bounds, maxItems and minItems > 1, tuples, open objects, unsupported formats.
// Limits the grammar cannot express (FAQs ≤ 8, word counts) are enforced in code after parsing.

/** A JSON Schema object as sent to the API. Deeply frozen. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** Thrown at build time (module load) for a schema the API cannot take as written. */
export class UnsupportedJsonSchemaError extends Error {
  override readonly name: string = 'UnsupportedJsonSchemaError';
  /** JSON pointer-ish path of the offending node, e.g. `/properties/faqs`. */
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`unsupported_json_schema at ${path === '' ? '/' : path}: ${reason}`);
    this.path = path;
    this.reason = reason;
  }
}

/** String formats structured outputs support [AI-SO-SCHEMA-LIMITS]. */
const SUPPORTED_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);
const TYPE_NAMES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const ALLOWED_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'allOf',
  'description',
  'title',
  'default',
  'format',
  'minItems',
]);

/** Per-request limits from the structured-outputs docs. */
export const MAX_UNION_TYPES = 16;

interface WalkState {
  unions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function checkLowerCase(path: string, value: unknown): void {
  if (typeof value === 'string' && value !== value.toLowerCase()) {
    throw new UnsupportedJsonSchemaError(path, 'string enum and const values must be lower case (output is lower-cased before parsing)');
  }
}

function walk(node: unknown, path: string, state: WalkState): Record<string, unknown> {
  if (!isRecord(node)) throw new UnsupportedJsonSchemaError(path, 'a schema node must be an object');
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYS.has(key)) throw new UnsupportedJsonSchemaError(path, `keyword "${key}" is not supported`);
  }
  const out: Record<string, unknown> = {};

  const type = node.type;
  if (type !== undefined) {
    if (typeof type === 'string') {
      if (!TYPE_NAMES.has(type)) throw new UnsupportedJsonSchemaError(path, `unknown type "${type}"`);
    } else if (Array.isArray(type)) {
      if (type.length < 2 || !type.every((t) => typeof t === 'string' && TYPE_NAMES.has(t)) || new Set(type).size !== type.length) {
        throw new UnsupportedJsonSchemaError(path, 'a type array must list two or more distinct known types');
      }
      state.unions += 1;
    } else {
      throw new UnsupportedJsonSchemaError(path, 'type must be a string or an array of strings');
    }
    out.type = Array.isArray(type) ? [...type] : type;
  }
  const types: readonly unknown[] = Array.isArray(type) ? type : [type];

  for (const key of ['description', 'title'] as const) {
    const value = node[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new UnsupportedJsonSchemaError(path, `${key} must be a string`);
    out[key] = value;
  }

  if (node.enum !== undefined) {
    const values = node.enum;
    if (!Array.isArray(values) || values.length === 0 || !values.every(isPrimitive)) {
      throw new UnsupportedJsonSchemaError(path, 'enum must be a non-empty list of strings, numbers, booleans or null');
    }
    values.forEach((value, i) => checkLowerCase(`${path}/enum/${i}`, value));
    out.enum = [...values];
  }
  if (node.const !== undefined) {
    if (!isPrimitive(node.const)) throw new UnsupportedJsonSchemaError(path, 'const must be a string, number, boolean or null');
    checkLowerCase(`${path}/const`, node.const);
    out.const = node.const;
  }
  if (node.default !== undefined) {
    if (!isPrimitive(node.default)) throw new UnsupportedJsonSchemaError(path, 'default must be a string, number, boolean or null');
    out.default = node.default;
  }
  if (node.format !== undefined) {
    if (typeof node.format !== 'string' || !SUPPORTED_FORMATS.has(node.format)) {
      throw new UnsupportedJsonSchemaError(path, `format "${String(node.format)}" is not supported`);
    }
    out.format = node.format;
  }

  for (const key of ['anyOf', 'allOf'] as const) {
    const branches = node[key];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || branches.length === 0) throw new UnsupportedJsonSchemaError(path, `${key} must be a non-empty list`);
    if (key === 'anyOf') state.unions += 1;
    out[key] = branches.map((branch, i) => walk(branch, `${path}/${key}/${i}`, state));
  }

  const isObject = types.includes('object') || node.properties !== undefined;
  if (isObject) {
    if (!types.includes('object')) throw new UnsupportedJsonSchemaError(path, 'an object schema must declare type "object"');
    const properties = node.properties ?? {};
    if (!isRecord(properties)) throw new UnsupportedJsonSchemaError(path, 'properties must be an object');
    const names = Object.keys(properties);
    const required = node.required ?? [];
    if (!Array.isArray(required) || !required.every((r) => typeof r === 'string')) {
      throw new UnsupportedJsonSchemaError(path, 'required must be a list of property names');
    }
    for (const name of names) {
      if (!required.includes(name)) {
        throw new UnsupportedJsonSchemaError(`${path}/properties/${name}`, 'every property must be required (use .nullable() instead of .optional())');
      }
    }
    for (const name of required) {
      if (!names.includes(name)) throw new UnsupportedJsonSchemaError(path, `required names an unknown property "${name}"`);
    }
    const additional = node.additionalProperties;
    if (additional !== undefined && additional !== false) {
      throw new UnsupportedJsonSchemaError(path, 'objects must be closed (additionalProperties false)');
    }
    const walked: Record<string, unknown> = {};
    for (const name of names) walked[name] = walk(properties[name], `${path}/properties/${name}`, state);
    out.properties = walked;
    out.required = [...names];
    out.additionalProperties = false;
  } else if (node.required !== undefined || node.additionalProperties !== undefined) {
    throw new UnsupportedJsonSchemaError(path, 'required/additionalProperties outside an object schema');
  }

  const isArray = types.includes('array') || node.items !== undefined;
  if (isArray) {
    if (!types.includes('array')) throw new UnsupportedJsonSchemaError(path, 'an array schema must declare type "array"');
    if (node.items === undefined) throw new UnsupportedJsonSchemaError(path, 'an array schema must declare its items');
    out.items = walk(node.items, `${path}/items`, state);
    if (node.minItems !== undefined) {
      if (node.minItems !== 0 && node.minItems !== 1) throw new UnsupportedJsonSchemaError(path, 'minItems may only be 0 or 1');
      out.minItems = node.minItems;
    }
  } else if (node.minItems !== undefined) {
    throw new UnsupportedJsonSchemaError(path, 'minItems outside an array schema');
  }

  return out;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The JSON Schema for `schema`, ready for `output_config.format.schema`. Throws
 * UnsupportedJsonSchemaError for any construct listed above, so a bad schema fails at module load
 * (and in the snapshot tests), never as a 400 at request time.
 */
export function toClaudeJsonSchema(schema: z.ZodType): JsonSchema {
  let raw: unknown;
  try {
    raw = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output', reused: 'inline', cycles: 'throw', unrepresentable: 'throw' });
  } catch {
    throw new UnsupportedJsonSchemaError('', 'Zod cannot represent this schema as JSON Schema (recursion, transform or unrepresentable type)');
  }
  if (!isRecord(raw)) throw new UnsupportedJsonSchemaError('', 'the root schema must be an object');
  const { $schema: _dialect, ...root } = raw;
  const state: WalkState = { unions: 0 };
  const out = walk(root, '', state);
  if (out.type !== 'object') throw new UnsupportedJsonSchemaError('', 'the root schema must be an object');
  if (state.unions > MAX_UNION_TYPES) {
    throw new UnsupportedJsonSchemaError('', `at most ${MAX_UNION_TYPES} union types per schema (found ${state.unions})`);
  }
  return deepFreeze(out);
}
