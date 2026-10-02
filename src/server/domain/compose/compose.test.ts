import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildCompose, buildMailto, fitsComposeLimit, InvalidRecipientError, pct, type ComposeClient, type ComposeInput, type ComposeMessage } from '.';

// Golden vectors (D-13, PLAN §12 "compose vectors"): TV1–TV3 from docs/research/06-compose-urls.md
// 06.2 byte for byte, the default-form variants derived from them, and the hand-computed lone
// surrogate, IDN, '+', '&' and CRLF cases.

const messageSchema = z.object({ to: z.array(z.string()), bcc: z.array(z.string()), subject: z.string(), body: z.string() });
const fixture = z
  .object({
    config: z.object({ outlookWorkBase: z.string(), outlookPersonalBase: z.string(), limit: z.number() }),
    vectors: z.array(
      z.object({
        id: z.string(),
        input: messageSchema,
        gmailAccount: z.string(),
        expected: z.record(z.string(), z.string()),
        lengths: z.record(z.string(), z.number()),
      }),
    ),
    cases: z.array(
      z.object({ id: z.string(), input: messageSchema, gmailAccount: z.string().optional(), expected: z.record(z.string(), z.string()) }),
    ),
  })
  .parse(JSON.parse(readFileSync(path.join(process.cwd(), 'test/fixtures/compose-vectors.json'), 'utf8')));

const { outlookWorkBase, outlookPersonalBase } = fixture.config;

/** How each expected key is built: the client and the configuration it names. */
const VARIANTS: Readonly<Record<string, { client: ComposeClient; gmailForm?: 'u' | 'view'; outlookMode?: 'mailtouri' | 'params'; account?: boolean }>> = {
  mailto: { client: 'mailto' },
  gmail_view: { client: 'gmail', gmailForm: 'view' },
  gmail_view_account: { client: 'gmail', gmailForm: 'view', account: true },
  gmail_u: { client: 'gmail', gmailForm: 'u' },
  gmail_u_account: { client: 'gmail', gmailForm: 'u', account: true },
  outlook_work: { client: 'outlook_work' },
  outlook_personal: { client: 'outlook_personal' },
  outlook_params_work: { client: 'outlook_work', outlookMode: 'params' },
};

function build(message: ComposeMessage, variant: string, gmailAccount: string | undefined): string {
  const spec = VARIANTS[variant];
  if (spec === undefined) throw new Error(`unknown variant ${variant}`);
  const input: ComposeInput = {
    ...message,
    client: spec.client,
    gmailForm: spec.gmailForm ?? 'u',
    outlookMode: spec.outlookMode ?? 'mailtouri',
    outlookWorkBase,
    outlookPersonalBase,
    gmailAccount: spec.account === true ? gmailAccount : undefined,
  };
  const link = buildCompose(input);
  expect(link.length).toBe(link.url.length);
  return link.url;
}

/** RFC 6068 decode: hfvalues percent-decoded once, '+' literal. */
function decodeMailto(uri: string): Record<string, string> {
  const rest = uri.slice('mailto:'.length);
  const q = rest.indexOf('?');
  const out: Record<string, string> = { to: decodeURIComponent(q < 0 ? rest : rest.slice(0, q)) };
  if (q >= 0) {
    for (const part of rest.slice(q + 1).split('&')) {
      const eq = part.indexOf('=');
      out[decodeURIComponent(part.slice(0, eq)).toLowerCase()] = decodeURIComponent(part.slice(eq + 1));
    }
  }
  return out;
}

const lf = (s: string): string => s.replace(/\r\n|\r|\n/g, '\n');

describe('compose golden vectors (research 06.2)', () => {
  for (const vector of fixture.vectors) {
    describe(vector.id, () => {
      for (const [variant, expected] of Object.entries(vector.expected)) {
        it(`builds the ${variant} URL byte for byte`, () => {
          const url = build(vector.input, variant, vector.gmailAccount);
          expect(url).toBe(expected);
          expect(url.length).toBe(vector.lengths[variant]);
        });
      }

      it('leaves every URL unchanged under WHATWG URL parsing (what a redirect Location goes through)', () => {
        for (const variant of Object.keys(vector.expected)) {
          const url = build(vector.input, variant, vector.gmailAccount);
          expect(new URL(url).href).toBe(url);
        }
      });

      it('round-trips the recipients, subject and body through each consumer', () => {
        const mailto = decodeMailto(build(vector.input, 'mailto', undefined));
        expect(mailto.to).toBe(vector.input.to.join(','));
        expect(mailto.bcc ?? '').toBe(vector.input.bcc.join(','));
        expect(mailto.subject).toBe(vector.input.subject);
        expect(mailto.body).toBe(lf(vector.input.body).replace(/\n/g, '\r\n'));

        // Gmail reads its query as application/x-www-form-urlencoded ('+' would be a space).
        const gmail = new URL(build(vector.input, 'gmail_u', undefined)).searchParams;
        expect(gmail.get('to')).toBe(vector.input.to.join(','));
        expect(gmail.get('bcc') ?? '').toBe(vector.input.bcc.join(','));
        expect(gmail.get('su')).toBe(vector.input.subject);
        expect(gmail.get('body')).toBe(lf(vector.input.body));
        expect(gmail.get('tf')).toBe('cm');

        // Outlook: the outer parameter decodes to exactly the mailto URI.
        const outlook = new URL(build(vector.input, 'outlook_work', undefined));
        expect(decodeURIComponent(outlook.search.slice('?mailtouri='.length))).toBe(build(vector.input, 'mailto', undefined));
      });
    });
  }

  it('builds the same mailto URI for the "other" client and for buildMailto', () => {
    const [tv2] = fixture.vectors.filter((v) => v.id === 'TV2');
    if (tv2 === undefined) throw new Error('TV2 missing');
    const other = build(tv2.input, 'mailto', undefined);
    expect(buildCompose({ ...tv2.input, client: 'other', gmailForm: 'u', outlookMode: 'mailtouri', outlookWorkBase, outlookPersonalBase }).url).toBe(other);
    expect(buildMailto(tv2.input).url).toBe(other);
  });
});

describe('compose edge cases (PLAN §12: lone surrogate, IDN, +, &, CRLF)', () => {
  for (const testCase of fixture.cases) {
    for (const [variant, expected] of Object.entries(testCase.expected)) {
      it(`${testCase.id}: builds the ${variant} URL`, () => {
        expect(build(testCase.input, variant, testCase.gmailAccount)).toBe(expected);
      });
    }
  }

  it('never writes a raw "+" or a space: plus signs are %2B, spaces %20', () => {
    const url = build({ to: ['a+b@example.com'], subject: 'a + b', body: 'c + d' }, 'gmail_u', undefined);
    expect(url).not.toMatch(/[+ ]/);
    expect(new URL(url).searchParams.get('to')).toBe('a+b@example.com');
  });

  it("escapes !'()* as RFC 3986 requires", () => {
    expect(pct("!'()*")).toBe('%21%27%28%29%2A');
    expect(pct('a b+c')).toBe('a%20b%2Bc');
  });

  it('turns a lone surrogate into U+FFFD instead of throwing', () => {
    expect(() => encodeURIComponent('a\uD800b')).toThrow(URIError);
    expect(pct('a\uD800b')).toBe('a%EF%BF%BDb');
  });

  it('leaves out an empty subject and body', () => {
    expect(buildMailto({ to: ['jane@example.com'], subject: '', body: '' }).url).toBe('mailto:jane@example.com');
    expect(build({ to: ['jane@example.com'], subject: '', body: '' }, 'gmail_u', undefined)).toBe(
      'https://mail.google.com/mail/u/0/?to=jane@example.com&tf=cm',
    );
  });

  it('puts cc before bcc in every form', () => {
    const message = { to: ['jane@example.com'], cc: ['c@example.com'], bcc: ['b@example.com'], subject: 'S', body: 'B' };
    expect(build(message, 'mailto', undefined)).toBe('mailto:jane@example.com?cc=c@example.com&bcc=b@example.com&subject=S&body=B');
    expect(build(message, 'gmail_view', undefined)).toBe(
      'https://mail.google.com/mail/?view=cm&fs=1&to=jane@example.com&cc=c@example.com&bcc=b@example.com&su=S&body=B',
    );
    expect(build(message, 'outlook_params_work', undefined)).toBe(
      `${outlookWorkBase}?to=jane@example.com&cc=c@example.com&bcc=b@example.com&subject=S&body=B`,
    );
  });

  it('ignores a Gmail account that is not one bare address', () => {
    const message = { to: ['jane@example.com'], subject: 'S', body: 'B' };
    expect(build(message, 'gmail_u_account', 'not an address')).toBe('https://mail.google.com/mail/u/0/?to=jane@example.com&su=S&body=B&tf=cm');
  });

  it('appends to a configured base that already has a query string', () => {
    const url = buildCompose({
      to: ['jane@example.com'],
      subject: 'S',
      body: 'B',
      client: 'outlook_personal',
      gmailForm: 'u',
      outlookMode: 'mailtouri',
      outlookWorkBase,
      outlookPersonalBase: 'https://outlook.live.com/mail/deeplink/compose?realm=x',
    }).url;
    expect(url).toBe('https://outlook.live.com/mail/deeplink/compose?realm=x&mailtouri=mailto%3Ajane%40example.com%3Fsubject%3DS%26body%3DB');
  });
});

describe('compose recipient safety (CMP-RECIPIENT-SAFETY)', () => {
  it.each([
    ['to', { to: ['a@x.com;evil@y.com'], subject: 'S', body: 'B' }],
    ['to', { to: ['Jane <jane@x.com>'], subject: 'S', body: 'B' }],
    ['to', { to: ['jane@x.com\r\nbcc: evil@y.com'], subject: 'S', body: 'B' }],
    ['to', { to: [], subject: 'S', body: 'B' }],
    ['bcc', { to: ['jane@x.com'], bcc: ['a@x.com,b@y.com'], subject: 'S', body: 'B' }],
    ['cc', { to: ['jane@x.com'], cc: ['"c"@x.com'], subject: 'S', body: 'B' }],
  ] as const)('refuses to build with an unsafe %s', (field, message) => {
    for (const client of ['gmail', 'outlook_work', 'mailto'] as const) {
      let caught: unknown;
      try {
        buildCompose({ ...message, client, gmailForm: 'u', outlookMode: 'mailtouri', outlookWorkBase, outlookPersonalBase });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InvalidRecipientError);
      expect((caught as InvalidRecipientError).field).toBe(field);
      // The error carries codes only, never the address.
      expect((caught as InvalidRecipientError).message).toBe('compose_invalid_recipient');
    }
  });
});

describe('compose URL length (CMP-URL-LENGTH-LIMITS, COMPOSE_URL_LIMIT)', () => {
  const WORDS = 'Thanks for reaching out about the kitchen remodel quote and timing for next month'.split(' ');
  const HINDI = 'नमस्ते आपकी पूछताछ के लिए धन्यवाद हम जल्द ही संपर्क करेंगे'.split(' ');
  function messageOf(n: number, vocabulary: readonly string[]): ComposeMessage {
    const words: string[] = [];
    for (let i = 0; words.length < n; i++) words.push(vocabulary[i % vocabulary.length] ?? '');
    return {
      to: ['jane.doe@acme-industries.com'],
      bcc: ['12345678@bcc.example-crm.com'],
      subject: 'Re: Kitchen remodel enquiry',
      body: `Hi Jane,\n\n${words.join(' ')}\n\nBest,\nSam`,
    };
  }
  const lengths = (message: ComposeMessage): number[] =>
    ['mailto', 'gmail_view', 'outlook_work'].map((variant) => build(message, variant, undefined).length);

  it('matches the research length curve (mailto / Gmail / Outlook mailtouri)', () => {
    expect(lengths(messageOf(120, WORDS))).toEqual([1113, 1132, 1467]);
    expect(lengths(messageOf(160, WORDS))).toEqual([1423, 1442, 1857]);
    expect(lengths(messageOf(200, WORDS))).toEqual([1739, 1758, 2253]);
    expect(lengths(messageOf(30, HINDI))).toEqual([1427, 1446, 2381]);
  });

  it('applies the limit per client to the final URL: Outlook reaches it first', () => {
    const limit = fixture.config.limit;
    const message = messageOf(160, WORDS);
    const fits = (variant: string): boolean => {
      const url = build(message, variant, undefined);
      return fitsComposeLimit({ url, length: url.length }, limit);
    };
    expect(fits('mailto')).toBe(true);
    expect(fits('gmail_u')).toBe(true);
    expect(fits('outlook_work')).toBe(false);
    expect(fits('outlook_personal')).toBe(false);
  });

  it('counts a URL of exactly the limit as fitting and one character more as not', () => {
    expect(fitsComposeLimit({ url: 'x'.repeat(1800), length: 1800 }, 1800)).toBe(true);
    expect(fitsComposeLimit({ url: 'x'.repeat(1801), length: 1801 }, 1800)).toBe(false);
  });
});
