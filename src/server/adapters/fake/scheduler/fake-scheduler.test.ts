import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermanentError } from '@/server/domain/errors';
import type { PublishRequest } from '@/server/ports/scheduler';
import { FakeClock } from '../clock';
import {
  FakeScheduler,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  type FakeDelivery,
  type FakeDispatchResult,
  type FakeFailureCallback,
} from './fake-scheduler';

const START = new Date('2026-10-06T14:00:00.000Z');

let clock: FakeClock;
let deliveries: FakeDelivery[];
let failures: FakeFailureCallback[];
let respond: (d: FakeDelivery) => FakeDispatchResult | Promise<FakeDispatchResult>;

function scheduler(options: { maxDelaySeconds?: number | null } = {}): FakeScheduler {
  return new FakeScheduler({
    clock,
    dispatch: (d) => {
      deliveries.push(d);
      return respond(d);
    },
    onFailure: (f) => {
      failures.push(f);
    },
    ...options,
  });
}

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    jobId: 'job-1',
    kind: 'followup',
    runAt: new Date(START.getTime() + 60_000),
    dedupeId: 'test:lead:1:fu:1:s0',
    retries: 4,
    ...overrides,
  };
}

function at(ms: number): Date {
  return new Date(START.getTime() + ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  clock = new FakeClock(START);
  deliveries = [];
  failures = [];
  respond = () => undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FakeScheduler.publish', () => {
  it('queues by runAt, then by publish order', async () => {
    const s = scheduler();
    await s.publish(request({ jobId: 'late', dedupeId: 'a', runAt: at(120_000) }));
    await s.publish(request({ jobId: 'early-1', dedupeId: 'b', runAt: at(60_000) }));
    await s.publish(request({ jobId: 'early-2', dedupeId: 'c', runAt: at(60_000) }));
    expect(s.pending().map((m) => m.jobId)).toEqual(['early-1', 'early-2', 'late']);
    expect(s.nextRunAt()).toEqual(at(60_000));
  });

  it('deduplicates the same id within 10 minutes and returns the original message id', async () => {
    const s = scheduler();
    const first = await s.publish(request());
    clock.advance({ minutes: 9, seconds: 59 });
    const again = await s.publish(request({ jobId: 'other' }));
    expect(again).toEqual({ messageId: first.messageId, deduplicated: true });
    expect(s.pending()).toHaveLength(1);
    clock.advance({ seconds: 1 });
    const later = await s.publish(request());
    expect(later.deduplicated).toBe(false);
    expect(later.messageId).not.toBe(first.messageId);
  });

  // The M2 hop/re-publish logic relies on QStash deduplicating whatever state the first message is
  // in (PLAN §12: deduplicated:true is an error there).
  it('still deduplicates within the window after the first message was delivered', async () => {
    const s = scheduler();
    const first = await s.publish(request({ runAt: START }));
    expect(await s.runDue(at(0))).toBe(1);
    clock.advance({ minutes: 5 });
    expect(await s.publish(request({ jobId: 'other', runAt: at(6 * 60_000) }))).toEqual({ messageId: first.messageId, deduplicated: true });
    expect(await s.runDue(at(9 * 60_000))).toBe(0);
    expect(deliveries).toHaveLength(1);
  });

  it('still deduplicates within the window after the first message was cancelled', async () => {
    const s = scheduler();
    const first = await s.publish(request());
    await s.cancel(first.messageId);
    clock.advance({ minutes: 9 });
    expect(await s.publish(request({ jobId: 'other' }))).toEqual({ messageId: first.messageId, deduplicated: true });
    expect(s.pending()).toEqual([]);
    expect(await s.runDue(at(30 * 60_000))).toBe(0);
    expect(deliveries).toEqual([]);
  });

  it('still deduplicates within the window after the failure callback fired', async () => {
    const s = scheduler();
    respond = () => new Response(null, { status: 489, headers: { 'Upstash-NonRetryable-Error': 'true' } });
    const first = await s.publish(request({ runAt: START }));
    await s.runDue(at(0));
    expect(failures).toHaveLength(1);
    clock.advance({ minutes: 2 });
    expect(await s.publish(request({ jobId: 'other', runAt: at(3 * 60_000) }))).toEqual({ messageId: first.messageId, deduplicated: true });
    expect(await s.runDue(at(9 * 60_000))).toBe(0);
    expect(deliveries).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it('refuses a runAt beyond the maximum delay and malformed requests', async () => {
    const s = scheduler({ maxDelaySeconds: 600 });
    await expect(s.publish(request({ runAt: at(601_000) }))).rejects.toMatchObject({ code: 'qstash_delay_too_long', httpStatus: 400 });
    await expect(s.publish(request({ dedupeId: '' }))).rejects.toBeInstanceOf(PermanentError);
    await expect(s.publish(request({ retries: -1 }))).rejects.toMatchObject({ code: 'qstash_bad_request' });
    await expect(scheduler({ maxDelaySeconds: null }).publish(request({ runAt: at(10 * 86_400_000) }))).resolves.toMatchObject({
      deduplicated: false,
    });
  });
});

describe('FakeScheduler.runDue', () => {
  it('delivers only what is due, in order, through the injected dispatch', async () => {
    const s = scheduler();
    const a = await s.publish(request({ jobId: 'a', dedupeId: 'a', runAt: at(60_000) }));
    await s.publish(request({ jobId: 'b', dedupeId: 'b', runAt: at(30_000), kind: 'lead_process' }));
    await s.publish(request({ jobId: 'c', dedupeId: 'c', runAt: at(90_000) }));
    expect(await s.runDue(at(60_000))).toBe(2);
    expect(deliveries.map((d) => [d.jobId, d.kind, d.retried])).toEqual([
      ['b', 'lead_process', 0],
      ['a', 'followup', 0],
    ]);
    expect(deliveries[1]).toMatchObject({ messageId: a.messageId, retries: 4, deliveredAt: at(60_000) });
    expect(s.pending().map((m) => m.jobId)).toEqual(['c']);
  });

  it("defaults to the Clock's now and never reads the wall clock", async () => {
    const s = scheduler();
    await s.publish(request());
    expect(await s.runDue()).toBe(0);
    clock.advance({ minutes: 1 });
    expect(await s.runDue()).toBe(1);
  });

  it('retries failures with pow(2, retried) * 10 s, then calls the failure callback once', async () => {
    const s = scheduler();
    respond = () => 500;
    const { messageId } = await s.publish(request({ runAt: START }));
    const times = [0, 10_000, 30_000, 70_000, 150_000];
    for (const t of times) {
      expect(await s.runDue(at(t))).toBe(1);
      expect(await s.runDue(at(t + 9_999))).toBe(0);
    }
    expect(deliveries.map((d) => [d.retried, d.deliveredAt])).toEqual(times.map((t, i) => [i, at(t)]));
    expect(failures).toEqual([{ messageId, jobId: 'job-1', kind: 'followup', retried: 4, nonRetryable: false }]);
    expect(s.pending()).toEqual([]);
  });

  it('treats a thrown handler as a 5xx and succeeds on a later retry', async () => {
    const s = scheduler();
    let calls = 0;
    respond = () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return new Response(null, { status: 200 });
    };
    await s.publish(request({ runAt: START }));
    await s.runDue(at(0));
    await s.runDue(at(10_000));
    expect(deliveries.map((d) => d.retried)).toEqual([0, 1]);
    expect(failures).toEqual([]);
    expect(s.events.filter((e) => e.type === 'delivery').map((e) => (e.type === 'delivery' ? e.outcome : null))).toEqual(['retry', 'ok']);
  });

  it('honours Retry-After from the handler response', async () => {
    const s = scheduler();
    respond = (d) => (d.retried === 0 ? new Response(null, { status: 503, headers: { 'Retry-After': '120' } }) : 200);
    await s.publish(request({ runAt: START }));
    await s.runDue(at(0));
    expect(s.nextRunAt()).toEqual(at(120_000));
  });

  // QS-RETRIES-SUCCESS: seconds, an RFC 1123 date or a duration, from Retry-After or X-RateLimit-Reset*; max 1 day.
  it.each<[string, Record<string, string>, number]>([
    ['Retry-After as an HTTP date (relative to the Clock)', { 'Retry-After': 'Tue, 06 Oct 2026 14:05:00 GMT' }, 5 * 60_000],
    ['Retry-After as a duration', { 'Retry-After': '1h30m' }, 90 * 60_000],
    ['Retry-After far in the future, capped at one day', { 'Retry-After': '999999' }, MAX_RETRY_AFTER_MS],
    ['X-RateLimit-Reset seconds', { 'X-RateLimit-Reset': '45' }, 45_000],
    ['the longest of several X-RateLimit-Reset-* headers', { 'X-RateLimit-Reset-Requests': '30s', 'X-RateLimit-Reset-Tokens': '2m' }, 120_000],
    ['Retry-After before X-RateLimit-Reset', { 'Retry-After': '10', 'X-RateLimit-Reset': '600' }, 10_000],
    ['an unreadable Retry-After (the default backoff)', { 'Retry-After': 'soon' }, 10_000],
  ])('schedules the retry from %s', async (_name, headers, delayMs) => {
    const s = scheduler();
    respond = (d) => (d.retried === 0 ? new Response(null, { status: 429, headers }) : 200);
    await s.publish(request({ runAt: START }));
    await s.runDue(at(0));
    expect(s.nextRunAt()).toEqual(at(delayMs));
  });

  it('retries at once when Retry-After is a date already past', async () => {
    const s = scheduler();
    respond = (d) => (d.retried === 0 ? new Response(null, { status: 503, headers: { 'Retry-After': 'Tue, 06 Oct 2026 13:00:00 GMT' } }) : 200);
    await s.publish(request({ runAt: START }));
    expect(await s.runDue(at(0))).toBe(2);
    expect(deliveries.map((d) => [d.retried, d.deliveredAt])).toEqual([
      [0, at(0)],
      [1, at(0)],
    ]);
  });

  it('parses Retry-After values without reading the wall clock', () => {
    const now = START.getTime();
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter(' 120 ', now)).toBe(120_000);
    expect(parseRetryAfter('250ms', now)).toBe(250);
    expect(parseRetryAfter('2d', now)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('Tue, 06 Oct 2026 14:00:30 GMT', now)).toBe(30_000);
    for (const bad of ['', '-5', '1.5', 'tomorrow', '10 s', '2026-10-06T14:00:30Z']) expect(parseRetryAfter(bad, now), bad).toBeUndefined();
  });

  it('stops at once on 489 with Upstash-NonRetryable-Error', async () => {
    const s = scheduler();
    respond = () => new Response(null, { status: 489, headers: { 'Upstash-NonRetryable-Error': 'true' } });
    await s.publish(request({ runAt: START }));
    await s.runDue(at(0));
    expect(failures).toMatchObject([{ retried: 0, nonRetryable: true }]);
    expect(s.pending()).toEqual([]);
  });

  it('records the failure when no failure callback is wired', async () => {
    const s = new FakeScheduler({ clock, dispatch: () => 500 });
    await s.publish(request({ runAt: START, retries: 0 }));
    await s.runDue(at(0));
    expect(s.failures).toHaveLength(1);
  });

  it('lets the handler publish more jobs, delivering any already due in the same run', async () => {
    const s = scheduler();
    respond = async (d) => {
      if (d.jobId === 'parent') await s.publish(request({ jobId: 'child', dedupeId: 'child', runAt: START }));
    };
    await s.publish(request({ jobId: 'parent', dedupeId: 'parent', runAt: START }));
    expect(await s.runDue(at(0))).toBe(2);
    expect(deliveries.map((d) => d.jobId)).toEqual(['parent', 'child']);
  });

  it('serialises overlapping runs', async () => {
    const s = scheduler();
    await s.publish(request({ runAt: START }));
    const [first, second] = await Promise.all([s.runDue(at(0)), s.runDue(at(0))]);
    expect([first, second]).toEqual([1, 0]);
  });
});

describe('FakeScheduler.cancel', () => {
  it('removes a queued message and treats unknown ids as success', async () => {
    const s = scheduler();
    const { messageId } = await s.publish(request());
    await s.cancel(messageId);
    await s.cancel(messageId);
    await s.cancel('msg_unknown');
    expect(s.pending()).toEqual([]);
    expect(s.cancelled).toEqual([messageId]);
    await s.runDue(at(3_600_000));
    expect(deliveries).toEqual([]);
  });

  it('does not retry a message cancelled while it is being delivered', async () => {
    const s = scheduler();
    let id = '';
    respond = async () => {
      await s.cancel(id);
      return 500;
    };
    id = (await s.publish(request({ runAt: START }))).messageId;
    await s.runDue(at(0));
    expect(s.pending()).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('refuses an empty id rather than cancelling everything', async () => {
    await expect(scheduler().cancel('')).rejects.toMatchObject({ code: 'qstash_bad_request' });
  });
});

describe('FakeScheduler delivery effects', () => {
  it('delivers a duplicate even after a 2xx', async () => {
    const s = scheduler();
    const { messageId } = await s.publish(request({ runAt: START }));
    s.simulate('duplicate', { messageId });
    expect(await s.runDue(at(0))).toBe(2);
    expect(deliveries.map((d) => [d.messageId, d.retried])).toEqual([
      [messageId, 0],
      [messageId, 0],
    ]);
    expect(s.pending()).toEqual([]);
  });

  it('crash before dispatch: the handler is not called and the message is retried', async () => {
    const s = scheduler();
    await s.publish(request({ runAt: START }));
    s.simulate('crash_before_dispatch', { jobId: 'job-1' });
    expect(await s.runDue(at(0))).toBe(0);
    expect(deliveries).toEqual([]);
    await s.runDue(at(10_000));
    expect(deliveries.map((d) => d.retried)).toEqual([1]);
  });

  it('crash after dispatch: the handler ran, its response is lost, and QStash redelivers', async () => {
    const s = scheduler();
    await s.publish(request({ runAt: START, kind: 'lead_process' }));
    s.simulate('crash_after_dispatch', { kind: 'lead_process' });
    await s.runDue(at(0));
    await s.runDue(at(10_000));
    expect(deliveries.map((d) => d.retried)).toEqual([0, 1]);
    expect(s.pending()).toEqual([]);
  });

  it('a crash on the final delivery exhausts the retries and calls the failure callback', async () => {
    const s = scheduler();
    await s.publish(request({ runAt: START, retries: 1 }));
    s.simulate('crash_after_dispatch', {}, 2);
    await s.runDue(at(0));
    await s.runDue(at(10_000));
    expect(deliveries).toHaveLength(2);
    expect(failures).toMatchObject([{ jobId: 'job-1', retried: 1 }]);
  });

  it('only applies an effect to matching deliveries', async () => {
    const s = scheduler();
    await s.publish(request({ jobId: 'x', dedupeId: 'x', runAt: START }));
    s.simulate('duplicate', { jobId: 'y' });
    expect(await s.runDue(at(0))).toBe(1);
    expect(() => s.simulate('duplicate', {}, 0)).toThrow(RangeError);
  });
});
