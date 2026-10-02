import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeRazorpaySignature, verifyRazorpaySignature } from './razorpay-signature';

// The research vectors (RZP-WH-TEST-VECTORS, 08.2): A is Razorpay's own published example; B, C, D
// and the empty-secret forgery were generated with the official helper and cross-checked with
// node:crypto and openssl. The fixture bodies are the exact bytes (no trailing newline).

const DIR = join(process.cwd(), 'test', 'fixtures', 'razorpay');

interface WebhookVector {
  name: string;
  file: string;
  secret: string;
  bodyLength: number;
  bodySha256: string;
  signature: string;
}

const vectors = JSON.parse(readFileSync(join(DIR, 'vectors.json'), 'utf8')) as {
  webhook: WebhookVector[];
  checkoutPayment: { message: string; keySecret: string; signature: string };
  emptySecretForgery: { body: string; secret: string; signature: string };
};

function body(file: string): Buffer {
  return readFileSync(join(DIR, file));
}

function vector(name: string): WebhookVector {
  const found = vectors.webhook.find((v) => v.name.startsWith(name));
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found;
}

describe('the fixtures', () => {
  it.each(vectors.webhook.map((v) => [v.name, v] as const))('%s is byte-for-byte the research body', (_name, v) => {
    const bytes = body(v.file);
    expect(bytes.length).toBe(v.bodyLength);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(v.bodySha256);
    expect(bytes.at(-1)).not.toBe(0x0a);
  });
});

describe('verifyRazorpaySignature with the research vectors', () => {
  it.each(vectors.webhook.map((v) => [v.name, v] as const))('%s verifies with its secret', (_name, v) => {
    expect(verifyRazorpaySignature({ rawBody: body(v.file), signature: v.signature, secrets: [v.secret] })).toEqual({ ok: true, secret: 'current' });
    expect(computeRazorpaySignature(body(v.file), v.secret)).toBe(v.signature);
  });

  it('verifies the same body given as text (UTF-8, vector C)', () => {
    const c = vector('C_');
    expect(verifyRazorpaySignature({ rawBody: body(c.file).toString('utf8'), signature: c.signature, secrets: [c.secret] }).ok).toBe(true);
  });

  it('reproduces vector D with the same HMAC primitive (the checkout payment signature, keyed with the key secret)', () => {
    const d = vectors.checkoutPayment;
    expect(computeRazorpaySignature(d.message, d.keySecret)).toBe(d.signature);
  });
});

describe('verifyRazorpaySignature refuses', () => {
  const b = vector('B_');

  it('a re-serialised (pretty-printed) body', () => {
    const pretty = JSON.stringify(JSON.parse(body(b.file).toString('utf8')), null, 2);
    expect(verifyRazorpaySignature({ rawBody: pretty, signature: b.signature, secrets: [b.secret] })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('a body with a trailing newline', () => {
    expect(verifyRazorpaySignature({ rawBody: `${body(b.file).toString('utf8')}\n`, signature: b.signature, secrets: [b.secret] })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('the wrong secret (the API key secret instead of the webhook secret)', () => {
    expect(verifyRazorpaySignature({ rawBody: body(b.file), signature: b.signature, secrets: [vectors.checkoutPayment.keySecret] })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('an UPPERCASE hex signature', () => {
    expect(verifyRazorpaySignature({ rawBody: body(b.file), signature: b.signature.toUpperCase(), secrets: [b.secret] })).toEqual({
      ok: false,
      reason: 'bad_header',
    });
  });

  it('the empty-secret forgery the SDK helper accepts', () => {
    const forgery = vectors.emptySecretForgery;
    expect(verifyRazorpaySignature({ rawBody: forgery.body, signature: forgery.signature, secrets: [forgery.secret] })).toEqual({
      ok: false,
      reason: 'no_secret',
    });
    expect(verifyRazorpaySignature({ rawBody: forgery.body, signature: forgery.signature, secrets: ['', undefined] })).toEqual({
      ok: false,
      reason: 'no_secret',
    });
    expect(() => computeRazorpaySignature(forgery.body, '')).toThrow('razorpay_signature_empty_secret');
  });

  it('a missing or malformed header', () => {
    for (const signature of [null, undefined, '']) {
      expect(verifyRazorpaySignature({ rawBody: body(b.file), signature, secrets: [b.secret] })).toEqual({ ok: false, reason: 'missing_header' });
    }
    for (const signature of [b.signature.slice(1), `${b.signature}0`, `${b.signature.slice(0, 63)}g`, ` ${b.signature.slice(1)}`, `sha256=${b.signature}`]) {
      expect(verifyRazorpaySignature({ rawBody: body(b.file), signature, secrets: [b.secret] })).toEqual({ ok: false, reason: 'bad_header' });
    }
  });
});

describe('secret rotation', () => {
  const b = vector('B_');

  it('accepts a delivery signed with the previous secret and says so', () => {
    expect(verifyRazorpaySignature({ rawBody: body(b.file), signature: b.signature, secrets: ['the-new-webhook-secret', b.secret] })).toEqual({
      ok: true,
      secret: 'previous',
    });
  });

  it('prefers the current secret when both are set', () => {
    expect(verifyRazorpaySignature({ rawBody: body(b.file), signature: b.signature, secrets: [b.secret, 'the-old-webhook-secret'] })).toEqual({
      ok: true,
      secret: 'current',
    });
  });

  it('skips an empty current secret but still refuses with neither matching', () => {
    expect(verifyRazorpaySignature({ rawBody: body(b.file), signature: b.signature, secrets: ['', b.secret] })).toEqual({ ok: true, secret: 'previous' });
    expect(verifyRazorpaySignature({ rawBody: body(b.file), signature: b.signature, secrets: ['one', 'two'] })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
