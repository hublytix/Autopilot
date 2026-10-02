import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_UNION_TYPES, toClaudeJsonSchema, UnsupportedJsonSchemaError } from './json-schema';
import { BRIEF_JSON_SCHEMA, CLASSIFICATION_JSON_SCHEMA, DRAFT_JSON_SCHEMA, lowerEnum } from './schemas';

function refusal(build: () => unknown): UnsupportedJsonSchemaError {
  try {
    build();
  } catch (error) {
    if (error instanceof UnsupportedJsonSchemaError) return error;
    throw error;
  }
  throw new Error('expected UnsupportedJsonSchemaError');
}

describe('toClaudeJsonSchema keeps what the grammar can enforce', () => {
  it('keeps enums, closes objects and lists every property as required (TV2)', () => {
    const schema = z.object({
      category: z.enum(['lead', 'spam', 'vendor_pitch', 'job_seeker', 'support_request', 'unclear']),
      confidence: z.enum(['high', 'medium', 'low']),
    });
    expect(toClaudeJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['lead', 'spam', 'vendor_pitch', 'job_seeker', 'support_request', 'unclear'] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['category', 'confidence'],
      additionalProperties: false,
    });
  });

  it('keeps the enum of a lower-casing preprocessor, nullable unions, nested objects and descriptions', () => {
    const schema = z.object({
      style: lowerEnum(['friendly', 'formal']).describe('The voice.'),
      link: z.string().nullable(),
      tags: z.array(z.object({ q: z.string() })).min(1),
      fixed: z.literal('v1'),
    });
    expect(toClaudeJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        style: { type: 'string', enum: ['friendly', 'formal'], description: 'The voice.' },
        link: { type: ['string', 'null'] },
        tags: {
          type: 'array',
          items: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
          minItems: 1,
        },
        fixed: { type: 'string', const: 'v1' },
      },
      required: ['style', 'link', 'tags', 'fixed'],
      additionalProperties: false,
    });
  });

  it('drops the $schema dialect and returns a frozen object', () => {
    const schema = toClaudeJsonSchema(z.object({ a: z.boolean() }));
    expect(schema).not.toHaveProperty('$schema');
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.properties)).toBe(true);
  });
});

describe('toClaudeJsonSchema refuses what the API cannot enforce', () => {
  it.each([
    ['an array maxItems (FAQs ≤ 8 is enforced in code)', () => z.object({ faqs: z.array(z.string()).max(8) }), 'maxItems'],
    ['minItems above 1', () => z.object({ a: z.array(z.string()).min(2) }), 'minItems'],
    ['string length bounds', () => z.object({ subject: z.string().max(120) }), 'maxLength'],
    ['numeric bounds', () => z.object({ n: z.number().int() }), 'minimum'],
    ['an optional property', () => z.object({ a: z.string(), b: z.string().optional() }), 'every property must be required'],
    ['an open object', () => z.object({ a: z.string() }).passthrough(), 'additionalProperties'],
    ['a record (open keys)', () => z.object({ a: z.record(z.string(), z.string()) }), 'propertyNames'],
    ['a regex pattern', () => z.object({ a: z.string().regex(/^x+$/) }), 'pattern'],
    ['an unsupported format', () => z.object({ a: z.base64() }), 'contentEncoding'],
    ['upper-case enum values (output is lower-cased before parsing)', () => z.object({ a: z.enum(['Lead', 'spam']) }), 'lower case'],
    ['a tuple', () => z.object({ a: z.tuple([z.string(), z.string()]) }), 'prefixItems'],
    ['a non-object root', () => z.array(z.string()), 'root'],
  ])('refuses %s', (_label, build, reason) => {
    expect(refusal(() => toClaudeJsonSchema(build())).message).toContain(reason);
  });

  it('refuses recursive schemas', () => {
    interface Node {
      children: Node[];
    }
    const node: z.ZodType<Node> = z.object({
      get children() {
        return z.array(node);
      },
    });
    expect(refusal(() => toClaudeJsonSchema(z.object({ root: node })))).toBeInstanceOf(UnsupportedJsonSchemaError);
  });

  it('refuses transforms, which have no JSON Schema output', () => {
    expect(refusal(() => toClaudeJsonSchema(z.object({ a: z.string().transform((s) => s.length) })))).toBeInstanceOf(UnsupportedJsonSchemaError);
  });

  it(`refuses more than ${MAX_UNION_TYPES} union types`, () => {
    const shape: Record<string, z.ZodType> = {};
    for (let i = 0; i <= MAX_UNION_TYPES; i += 1) shape[`f${i}`] = z.string().nullable();
    expect(refusal(() => toClaudeJsonSchema(z.object(shape))).message).toContain('union types');
    delete shape[`f${MAX_UNION_TYPES}`];
    expect(() => toClaudeJsonSchema(z.object(shape))).not.toThrow();
  });

  it('names the offending path', () => {
    const error = refusal(() => toClaudeJsonSchema(z.object({ tone: z.object({ note: z.string().min(3) }) })));
    expect(error.path).toBe('/properties/tone/properties/note');
  });
});

describe('the schemas sent to the API (snapshots)', () => {
  it('classification', () => {
    expect(CLASSIFICATION_JSON_SCHEMA).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "properties": {
          "classification": {
            "description": "lead: a possible customer asking about the business's products or services. spam: junk, scams, link or SEO spam, gibberish. vendor_pitch: someone selling something to the business. job_seeker: someone asking for a job or sending a CV. support_request: an existing customer about an existing order, invoice, account or job already done. unclear: too little to tell, or none of the above.",
            "enum": [
              "lead",
              "spam",
              "vendor_pitch",
              "job_seeker",
              "support_request",
              "unclear",
            ],
            "type": "string",
          },
          "reason_code": {
            "description": "The main signal behind the classification.",
            "enum": [
              "asks_about_services",
              "asks_for_quote_or_booking",
              "sells_to_the_business",
              "job_application",
              "existing_customer_issue",
              "promotional_or_irrelevant",
              "too_little_information",
              "other",
            ],
            "type": "string",
          },
        },
        "required": [
          "classification",
          "reason_code",
        ],
        "type": "object",
      }
    `);
  });

  it('brief: every field required, booking_link nullable, tone.style an enum, faqs unbounded (TV3)', () => {
    expect(BRIEF_JSON_SCHEMA).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "properties": {
          "allow_pricing": {
            "description": "Whether replies may mention prices.",
            "type": "boolean",
          },
          "booking_link": {
            "description": "An https booking or scheduling URL that appears in the pages, exactly as written; null if there is none.",
            "type": [
              "string",
              "null",
            ],
          },
          "company_name": {
            "description": "The business name as the website writes it.",
            "type": "string",
          },
          "faqs": {
            "description": "Up to 8 questions and answers taken from the pages.",
            "items": {
              "additionalProperties": false,
              "properties": {
                "a": {
                  "description": "The answer the pages give.",
                  "type": "string",
                },
                "q": {
                  "description": "A question customers ask.",
                  "type": "string",
                },
              },
              "required": [
                "q",
                "a",
              ],
              "type": "object",
            },
            "type": "array",
          },
          "never_promise": {
            "description": "Things a reply must never promise, as short phrases.",
            "items": {
              "type": "string",
            },
            "type": "array",
          },
          "one_line": {
            "description": "One sentence: what the business does and for whom.",
            "type": "string",
          },
          "services": {
            "description": "The services or products the business offers, as short phrases.",
            "items": {
              "type": "string",
            },
            "type": "array",
          },
          "sign_off_name": {
            "description": "The person who should sign replies, if the pages name one; otherwise an empty string.",
            "type": "string",
          },
          "tone": {
            "additionalProperties": false,
            "properties": {
              "note": {
                "description": "A short note on the voice, e.g. "warm, uses first names".",
                "type": "string",
              },
              "style": {
                "description": "The voice the website uses.",
                "enum": [
                  "friendly",
                  "formal",
                  "direct",
                ],
                "type": "string",
              },
            },
            "required": [
              "style",
              "note",
            ],
            "type": "object",
          },
          "who_we_serve": {
            "description": "The customers the business serves, e.g. area or kind of customer.",
            "type": "string",
          },
        },
        "required": [
          "company_name",
          "one_line",
          "services",
          "who_we_serve",
          "booking_link",
          "tone",
          "sign_off_name",
          "allow_pricing",
          "never_promise",
          "faqs",
        ],
        "type": "object",
      }
    `);
  });

  it('draft: flags is a closed enum', () => {
    expect(DRAFT_JSON_SCHEMA).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "properties": {
          "body": {
            "description": "The plain-text email body.",
            "type": "string",
          },
          "flags": {
            "description": "Short codes for anything the owner should check; empty if none.",
            "items": {
              "enum": [
                "asks_pricing",
                "urgent",
                "non_english",
                "missing_info",
                "possible_spam",
                "sensitive_topic",
                "other",
              ],
              "type": "string",
            },
            "type": "array",
          },
          "subject": {
            "description": "A single-line email subject.",
            "type": "string",
          },
          "used_booking_link": {
            "description": "Whether the body includes the booking link.",
            "type": "boolean",
          },
        },
        "required": [
          "subject",
          "body",
          "used_booking_link",
          "flags",
        ],
        "type": "object",
      }
    `);
  });

  it('carry no length or count constraints and stay within the union limit', () => {
    const text = JSON.stringify([CLASSIFICATION_JSON_SCHEMA, BRIEF_JSON_SCHEMA, DRAFT_JSON_SCHEMA]);
    for (const keyword of ['maxItems', 'maxLength', 'minLength', 'minimum', 'maximum', 'pattern', '$ref', '$defs', '$schema']) {
      expect(text).not.toContain(`"${keyword}"`);
    }
  });
});
