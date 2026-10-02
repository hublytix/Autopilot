import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdempotencyConflictError, PermanentError, TransientError } from '@/server/domain/errors';
import type { OutgoingMail } from '@/server/ports/mailer';
import { FakeClock } from '../clock';
import { FakeMailer, type FakeSentMail } from './fake-mailer';

const START = new Date('2026-10-06T14:00:00.000Z');

function mail(overrides: Partial<OutgoingMail> = {}): OutgoingMail {
  return {
    to: ['owner@brightside-plumbing.example'],
    replyTo: 'maya.okafor@example.com',
    subject: 'New lead: Maya — your reply is ready',
    html: '<p>Draft</p>',
    text: 'Draft',
    tags: [
      { name: 'kind', value: 'new_lead' },
      { name: 'lead', value: 'lead_42' },
    ],
    idempotencyKey: 'test:reply:42:s0',
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

let clock: FakeClock;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  clock = new FakeClock(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FakeMailer: memory sink', () => {
  it('stores each email with its tags and the Clock time', async () => {
    const mailer = new FakeMailer({ clock });
    const result = await mailer.send(mail());
    expect(result.providerMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      seq: 1,
      providerMessageId: result.providerMessageId,
      sentAt: START,
      kind: 'new_lead',
      lead: 'lead_42',
      subject: 'New lead: Maya — your reply is ready',
    });
  });

  it('defaults the kind to email when there is no kind tag', async () => {
    const mailer = new FakeMailer({ clock });
    await mailer.send(mail({ tags: undefined }));
    expect(mailer.sent[0]).toMatchObject({ kind: 'email', lead: undefined, tags: [] });
  });
});

describe('FakeMailer: Resend idempotency', () => {
  it('returns the original result for the same key and payload, without a new email', async () => {
    const mailer = new FakeMailer({ clock });
    const first = await mailer.send(mail());
    clock.advance({ hours: 23 });
    const second = await mailer.send(mail());
    expect(second).toEqual(first);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.attempts).toBe(2);
  });

  it('throws the 409 conflict for the same key with a different payload', async () => {
    const mailer = new FakeMailer({ clock });
    await mailer.send(mail());
    const error = await rejection(mailer.send(mail({ subject: 'Different subject' })));
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect(error).toMatchObject({ code: 'invalid_idempotent_request', httpStatus: 409 });
    expect(mailer.sent).toHaveLength(1);
  });

  it('treats tag changes as a different payload', async () => {
    const mailer = new FakeMailer({ clock });
    await mailer.send(mail());
    expect(await rejection(mailer.send(mail({ tags: [{ name: 'kind', value: 'needs_touch' }] })))).toBeInstanceOf(IdempotencyConflictError);
  });

  it('forgets a key after 24 hours of Clock time', async () => {
    const mailer = new FakeMailer({ clock });
    const first = await mailer.send(mail());
    clock.advance({ hours: 24 });
    const second = await mailer.send(mail({ subject: 'Now allowed' }));
    expect(second.providerMessageId).not.toBe(first.providerMessageId);
    expect(mailer.sent).toHaveLength(2);
  });

  it('keeps different keys independent', async () => {
    const mailer = new FakeMailer({ clock });
    await mailer.send(mail());
    await mailer.send(mail({ idempotencyKey: 'test:reply:43:s0' }));
    expect(mailer.sent.map((m) => m.seq)).toEqual([1, 2]);
  });
});

describe('FakeMailer: concurrent duplicates (RS-IDEMPOTENCY-LIMITS)', () => {
  /** A callback sink that holds each delivery until released. */
  function heldSink(): { sink: { kind: 'callback'; deliver: () => Promise<void> }; release: (error?: Error) => void; delivered: number } {
    const state = { delivered: 0, release: (_error?: Error): void => undefined };
    const sink = {
      kind: 'callback' as const,
      deliver: () =>
        new Promise<void>((resolve, reject) => {
          state.delivered += 1;
          state.release = (error?: Error) => (error === undefined ? resolve() : reject(error));
        }),
    };
    return {
      sink,
      release: (error?: Error) => state.release(error),
      get delivered() {
        return state.delivered;
      },
    };
  }

  it('sends once and answers an overlapping send with the same key with a transient 409', async () => {
    const held = heldSink();
    const mailer = new FakeMailer({ clock, sink: held.sink });
    const first = mailer.send(mail());
    const second = await rejection(mailer.send(mail()));
    expect(second).toBeInstanceOf(TransientError);
    expect(second).toMatchObject({ code: 'concurrent_idempotent_requests', httpStatus: 409 });
    held.release();
    const result = await first;
    expect(mailer.sent).toHaveLength(1);
    expect(held.delivered).toBe(1);
    // Once the first send has finished, a retry gets its result and sends nothing.
    expect(await mailer.send(mail())).toEqual(result);
    expect(mailer.sent).toHaveLength(1);
  });

  it('answers a concurrent send with a different payload the same way while the first is in flight', async () => {
    const held = heldSink();
    const mailer = new FakeMailer({ clock, sink: held.sink });
    const first = mailer.send(mail());
    expect(await rejection(mailer.send(mail({ subject: 'Another subject' })))).toMatchObject({ code: 'concurrent_idempotent_requests' });
    held.release();
    await first;
    expect(await rejection(mailer.send(mail({ subject: 'Another subject' })))).toBeInstanceOf(IdempotencyConflictError);
  });

  it('frees the key when the in-flight send fails, so a retry can send', async () => {
    const held = heldSink();
    const mailer = new FakeMailer({ clock, sink: held.sink });
    const first = rejection(mailer.send(mail()));
    held.release(new Error('sink down'));
    expect(await first).toMatchObject({ code: 'application_error' });
    const retry = mailer.send(mail());
    held.release();
    await retry;
    expect(mailer.sent).toHaveLength(1);
    expect(held.delivered).toBe(2);
  });

  it('runs sends with different keys concurrently', async () => {
    const mailer = new FakeMailer({ clock });
    const results = await Promise.all([mailer.send(mail()), mailer.send(mail({ idempotencyKey: 'test:reply:43:s0' }))]);
    expect(new Set(results.map((r) => r.providerMessageId)).size).toBe(2);
    expect(mailer.sent).toHaveLength(2);
  });
});

describe('FakeMailer: validation', () => {
  it.each([
    ['no recipients', { to: [] }],
    ['a bad address', { to: ['not-an-address'] }],
    ['a bad reply-to', { replyTo: 'nope' }],
    ['an empty subject', { subject: '  ' }],
    ['a multi-line subject', { subject: 'a\nb' }],
    ['a non-ASCII tag', { tags: [{ name: 'kind', value: 'naïve' }] }],
    ['a tag with an address', { tags: [{ name: 'to', value: 'a@b.example' }] }],
  ] satisfies [string, Partial<OutgoingMail>][])('rejects %s with validation_error and sends nothing', async (_, overrides) => {
    const mailer = new FakeMailer({ clock });
    const error = await rejection(mailer.send(mail(overrides)));
    expect(error).toBeInstanceOf(PermanentError);
    expect(error).toMatchObject({ code: 'validation_error', httpStatus: 422 });
    expect(mailer.sent).toHaveLength(0);
  });

  it('rejects an empty or over-long idempotency key', async () => {
    const mailer = new FakeMailer({ clock });
    expect(await rejection(mailer.send(mail({ idempotencyKey: '' })))).toMatchObject({ code: 'invalid_idempotency_key' });
    expect(await rejection(mailer.send(mail({ idempotencyKey: 'k'.repeat(257) })))).toMatchObject({ code: 'invalid_idempotency_key' });
  });
});

describe('FakeMailer: fault injection', () => {
  it('fails transiently without storing the key, so the retry sends once', async () => {
    const mailer = new FakeMailer({ clock });
    mailer.injectFailure({ kind: 'transient', code: 'rate_limit_exceeded', retryAfterMs: 1000, times: 2 });
    const first = await rejection(mailer.send(mail()));
    expect(first).toBeInstanceOf(TransientError);
    expect(first).toMatchObject({ code: 'rate_limit_exceeded', httpStatus: 429, retryAfterMs: 1000 });
    expect(await rejection(mailer.send(mail()))).toMatchObject({ code: 'rate_limit_exceeded' });
    await mailer.send(mail());
    expect(mailer.sent).toHaveLength(1);
  });

  it('injects internal_server_error as a 500', async () => {
    const mailer = new FakeMailer({ clock });
    mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    expect(await rejection(mailer.send(mail()))).toMatchObject({ kind: 'transient', code: 'internal_server_error', httpStatus: 500 });
  });

  it('injects a permanent validation_error', async () => {
    const mailer = new FakeMailer({ clock });
    mailer.injectFailure({ kind: 'permanent', code: 'validation_error' });
    expect(await rejection(mailer.send(mail()))).toMatchObject({ kind: 'permanent', code: 'validation_error' });
    expect(mailer.sent).toHaveLength(0);
  });

  it('simulates a lost response: delivered once, the retry gets the original or a 409', async () => {
    const mailer = new FakeMailer({ clock });
    mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', afterSend: true });
    expect(await rejection(mailer.send(mail()))).toBeInstanceOf(TransientError);
    expect(mailer.sent).toHaveLength(1);
    const retry = await mailer.send(mail());
    expect(retry.providerMessageId).toBe(mailer.sent[0]?.providerMessageId);
    expect(await rejection(mailer.send(mail({ text: 'rebuilt differently' })))).toBeInstanceOf(IdempotencyConflictError);
    expect(mailer.sent).toHaveLength(1);
  });

  it('rejects a non-positive repeat count', () => {
    expect(() => new FakeMailer({ clock }).injectFailure({ kind: 'permanent', code: 'validation_error', times: 0 })).toThrow(RangeError);
  });
});

describe('FakeMailer: directory and callback sinks', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fake-mailer-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes NNN-<kind>-<lead>.html and .txt files', async () => {
    const mailer = new FakeMailer({ clock, sink: { kind: 'directory', dir: path.join(dir, 'outbox') } });
    await mailer.send(mail());
    await mailer.send(mail({ idempotencyKey: 'k2', tags: [{ name: 'kind', value: 'magic_link' }], html: '<p>Link</p>', text: 'Link' }));
    expect((await readdir(path.join(dir, 'outbox'))).sort()).toEqual([
      '001-new_lead-lead_42.html',
      '001-new_lead-lead_42.txt',
      '002-magic_link.html',
      '002-magic_link.txt',
    ]);
    expect(await readFile(path.join(dir, 'outbox', '002-magic_link.txt'), 'utf8')).toBe('Link');
  });

  it('hands each accepted email to the callback once', async () => {
    const delivered: FakeSentMail[] = [];
    const mailer = new FakeMailer({ clock, sink: { kind: 'callback', deliver: (m) => void delivered.push(m) } });
    await mailer.send(mail());
    await mailer.send(mail());
    expect(delivered.map((m) => m.kind)).toEqual(['new_lead']);
  });

  it('turns a callback failure into a retryable error without storing the key', async () => {
    let fail = true;
    const mailer = new FakeMailer({
      clock,
      sink: {
        kind: 'callback',
        deliver: () => {
          if (fail) throw new Error('outbox write failed');
        },
      },
    });
    expect(await rejection(mailer.send(mail()))).toMatchObject({ kind: 'transient', code: 'application_error' });
    fail = false;
    await mailer.send(mail());
    expect(mailer.sent).toHaveLength(1);
  });
});
