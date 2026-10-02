import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, PermanentError, TransientError } from '@/server/domain/errors';
import type { CreateSubscriptionInput } from '@/server/ports/billing';
import { FakeClock } from '../clock';
import { FAKE_RAZORPAY_PLAN_ID, FakeBilling } from './fake-billing';
import { razorpayWebhookRequest, signRazorpayBody, type FakeRazorpayWebhook } from './webhook';

const START = new Date('2026-10-06T14:00:00.000Z');
const SECRET = 'fake-razorpay-webhook-secret';
const DAY = 86_400_000;

let clock: FakeClock;
let billing: FakeBilling;

function input(overrides: Partial<CreateSubscriptionInput> = {}): CreateSubscriptionInput {
  return {
    planId: FAKE_RAZORPAY_PLAN_ID,
    totalCount: 120,
    quantity: 1,
    customerNotify: true,
    expireBy: new Date(START.getTime() + 7 * DAY),
    notes: { autopilot_account_id: 'acc-1' },
    ...overrides,
  };
}

interface Envelope {
  entity: string;
  account_id: string;
  event: string;
  contains: string[];
  payload: { subscription: { entity: Record<string, unknown> }; payment?: { entity: Record<string, unknown> } };
  created_at: number;
}

function body(webhook: FakeRazorpayWebhook): Envelope {
  return JSON.parse(webhook.rawBody) as Envelope;
}

function events(webhooks: FakeRazorpayWebhook[]): string[] {
  return webhooks.map((w) => w.event);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  clock = new FakeClock(START);
  billing = new FakeBilling({ clock, appUrl: 'http://localhost:3000/', webhookSecret: SECRET });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FakeBilling: create and fetch', () => {
  it('creates a `created` subscription whose shortUrl is the fake checkout', async () => {
    const sub = await billing.createSubscription(input());
    expect(sub.id).toMatch(/^sub_[0-9A-Za-z]{14}$/);
    expect(sub).toMatchObject({
      planId: FAKE_RAZORPAY_PLAN_ID,
      status: 'created',
      shortUrl: `http://localhost:3000/dev/fake-checkout/${sub.id}`,
      createdAt: START,
      expireBy: new Date(START.getTime() + 7 * DAY),
      notes: { autopilot_account_id: 'acc-1' },
    });
    expect(sub.startAt).toBeUndefined();
    expect(await billing.fetchSubscription(sub.id)).toEqual(sub);
  });

  it.each([
    ['an unknown plan', { planId: 'plan_Unknown0000001' }],
    ['expireBy in the past', { expireBy: new Date(START.getTime() - 1) }],
    ['startAt in the past', { startAt: new Date(START.getTime() - 1) }],
    ['a zero total count', { totalCount: 0 }],
    ['too many notes', { notes: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'])) }],
  ] satisfies [string, Partial<CreateSubscriptionInput>][])('rejects %s with a 400', async (_, overrides) => {
    await expect(billing.createSubscription(input(overrides))).rejects.toMatchObject({ code: 'razorpay_bad_request', httpStatus: 400 });
  });

  it('rejects an unknown subscription id with a 400, as Razorpay does', async () => {
    const error = await billing.fetchSubscription('sub_DoesNotExist00').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermanentError);
    expect(error).toMatchObject({ code: 'razorpay_bad_request', httpStatus: 400 });
  });

  it('fetches the USD plan, and only that plan', async () => {
    expect(await billing.fetchPlan(FAKE_RAZORPAY_PLAN_ID)).toEqual({
      id: FAKE_RAZORPAY_PLAN_ID,
      period: 'monthly',
      interval: 1,
      amount: 4900,
      currency: 'USD',
    });
    await expect(billing.fetchPlan('plan_Other00000001')).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe('FakeBilling: trial (future start) lifecycle', () => {
  const startAt = new Date(START.getTime() + 10 * DAY);

  it('stays created past expireBy until startAt, then expires with no webhook', async () => {
    const sub = await billing.createSubscription(input({ startAt, expireBy: new Date(START.getTime() + 7 * DAY) }));
    clock.advance({ days: 8 });
    expect((await billing.fetchSubscription(sub.id)).status).toBe('created');
    clock.set(startAt);
    expect((await billing.fetchSubscription(sub.id)).status).toBe('expired');
    expect(billing.takeWebhooks()).toEqual([]);
  });

  it('authenticates, then activates and charges at startAt', async () => {
    const sub = await billing.createSubscription(input({ startAt }));
    expect(events(billing.authenticate(sub.id))).toEqual(['subscription.authenticated']);
    expect((await billing.fetchSubscription(sub.id)).status).toBe('authenticated');

    clock.set(new Date(startAt.getTime() + 3_600_000));
    const synced = billing.sync();
    expect(events(synced)).toEqual(['subscription.activated', 'subscription.charged']);
    expect(synced.every((w) => w.createdAt.getTime() === startAt.getTime())).toBe(true);
    const active = await billing.fetchSubscription(sub.id);
    expect(active).toMatchObject({ status: 'active', currentStart: startAt, currentEnd: new Date('2026-11-16T14:00:00.000Z') });
    expect(body(synced[1] as FakeRazorpayWebhook).payload.payment?.entity).toMatchObject({ amount: 4900, currency: 'USD' });
  });

  it('can omit the optional authenticated webhook', async () => {
    const quiet = new FakeBilling({ clock, appUrl: 'http://x.example', webhookSecret: SECRET, emitAuthenticatedEvent: false });
    const sub = await quiet.createSubscription(input({ startAt }));
    expect(quiet.authenticate(sub.id)).toEqual([]);
  });

  it('refuses checkout after expireBy and records a failed authentication without a webhook', async () => {
    const sub = await billing.createSubscription(input({ startAt }));
    billing.failAuthentication(sub.id);
    expect(billing.takeWebhooks()).toEqual([]);
    clock.advance({ days: 7, seconds: 1 });
    expect(() => billing.authenticate(sub.id)).toThrow('fake_billing_invalid_transition');
  });

  it('cancels an authenticated subscription immediately', async () => {
    const sub = await billing.createSubscription(input({ startAt }));
    billing.authenticate(sub.id);
    billing.takeWebhooks();
    const cancelled = await billing.cancelSubscription(sub.id, false);
    expect(cancelled.status).toBe('cancelled');
    expect(events(billing.takeWebhooks())).toEqual(['subscription.cancelled']);
  });

  it('pausing an authenticated subscription cancels it', async () => {
    const sub = await billing.createSubscription(input({ startAt }));
    billing.authenticate(sub.id);
    expect(events(billing.pause(sub.id))).toEqual(['subscription.cancelled']);
  });
});

describe('FakeBilling: immediate start and payment failures', () => {
  it('activates on checkout and renews each month', async () => {
    const sub = await billing.createSubscription(input());
    expect(events(billing.authenticate(sub.id))).toEqual(['subscription.activated', 'subscription.charged']);
    clock.set(new Date('2026-12-06T15:00:00.000Z'));
    expect(events(billing.sync())).toEqual(['subscription.charged', 'subscription.charged']);
    expect((await billing.fetchSubscription(sub.id)).currentEnd).toEqual(new Date('2027-01-06T14:00:00.000Z'));
  });

  it('goes pending on a failed charge, halts, and recovers after a card update', async () => {
    const sub = await billing.createSubscription(input());
    billing.authenticate(sub.id);
    expect(events(billing.failPayment(sub.id))).toEqual(['subscription.pending']);
    expect(events(billing.failPayment(sub.id))).toEqual(['subscription.pending']);
    expect(events(billing.halt(sub.id))).toEqual(['subscription.halted']);
    expect((await billing.fetchSubscription(sub.id)).status).toBe('halted');
    expect(events(billing.activate(sub.id))).toEqual(['subscription.charged', 'subscription.activated']);
    expect((await billing.fetchSubscription(sub.id)).status).toBe('active');
  });

  it('pauses and resumes (the resumed event carries status active)', async () => {
    const sub = await billing.createSubscription(input());
    billing.authenticate(sub.id);
    billing.takeWebhooks();
    const paused = billing.pause(sub.id, 'customer');
    expect(body(paused[0] as FakeRazorpayWebhook).payload.subscription.entity).toMatchObject({ status: 'paused', pause_initiated_by: 'customer' });
    const resumed = await billing.resumeSubscription(sub.id);
    expect(resumed.status).toBe('active');
    const [event] = billing.takeWebhooks().slice(-1);
    expect(event?.event).toBe('subscription.resumed');
    expect(body(event as FakeRazorpayWebhook).payload.subscription.entity.status).toBe('active');
    await expect(billing.resumeSubscription(sub.id)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('cancels at cycle end: stays active until current_end, then cancelled', async () => {
    const sub = await billing.createSubscription(input());
    billing.authenticate(sub.id);
    billing.takeWebhooks();
    expect((await billing.cancelSubscription(sub.id, true)).status).toBe('active');
    expect(billing.takeWebhooks()).toEqual([]);
    clock.set(new Date('2026-11-06T14:00:00.000Z'));
    const synced = billing.sync();
    expect(events(synced)).toEqual(['subscription.cancelled']);
    expect((await billing.fetchSubscription(sub.id)).status).toBe('cancelled');
  });

  it('refuses cancel at cycle end unless active, and any cancel of a terminal subscription', async () => {
    const sub = await billing.createSubscription(input());
    await expect(billing.cancelSubscription(sub.id, true)).rejects.toMatchObject({ httpStatus: 400 });
    await billing.cancelSubscription(sub.id, false);
    await expect(billing.cancelSubscription(sub.id, false)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('completes after the last billing cycle', async () => {
    const sub = await billing.createSubscription(input({ totalCount: 2 }));
    billing.authenticate(sub.id);
    clock.set(new Date('2027-01-06T14:00:00.000Z'));
    expect(events(billing.sync()).slice(-2)).toEqual(['subscription.charged', 'subscription.completed']);
    expect((await billing.fetchSubscription(sub.id)).status).toBe('completed');
  });

  it('supports customer-initiated cancels and explicit completion', async () => {
    const a = await billing.createSubscription(input());
    billing.authenticate(a.id);
    const [cancelled] = billing.cancel(a.id, { initiatedBy: 'customer' });
    expect(body(cancelled as FakeRazorpayWebhook).payload.subscription.entity.cancel_initiated_by).toBe('customer');
    const b = await billing.createSubscription(input());
    billing.authenticate(b.id);
    expect(events(billing.complete(b.id))).toEqual(['subscription.completed']);
    expect(() => billing.complete(b.id)).toThrow('fake_billing_invalid_transition');
  });
});

describe('FakeBilling: webhooks', () => {
  it('signs the raw body with hex HMAC-SHA256 and sends an event id header', async () => {
    const sub = await billing.createSubscription(input());
    const [activated] = billing.authenticate(sub.id);
    if (activated === undefined) throw new Error('expected a webhook');
    const expected = createHmac('sha256', SECRET).update(activated.rawBody).digest('hex');
    expect(activated.signature).toBe(expected);
    expect(activated.headers).toEqual({
      'content-type': 'application/json',
      'x-razorpay-signature': expected,
      'x-razorpay-event-id': activated.eventId,
    });
    const envelope = body(activated);
    expect(envelope).toMatchObject({
      entity: 'event',
      event: 'subscription.activated',
      contains: ['subscription', 'payment'],
      created_at: Math.floor(START.getTime() / 1000),
    });
    expect(envelope.payload.subscription.entity).toMatchObject({
      id: sub.id,
      entity: 'subscription',
      plan_id: FAKE_RAZORPAY_PLAN_ID,
      status: 'active',
      notes: { autopilot_account_id: 'acc-1' },
      total_count: 120,
      paid_count: 1,
      remaining_count: 119,
    });
  });

  it('serialises empty notes as an array, as Razorpay does', async () => {
    const sub = await billing.createSubscription(input({ notes: {} }));
    const [webhook] = billing.authenticate(sub.id);
    expect(body(webhook as FakeRazorpayWebhook).payload.subscription.entity.notes).toEqual([]);
  });

  it('gives every event a unique id and queues them until taken', async () => {
    const sub = await billing.createSubscription(input());
    billing.authenticate(sub.id);
    billing.failPayment(sub.id);
    const queued = billing.takeWebhooks();
    expect(events(queued)).toEqual(['subscription.activated', 'subscription.charged', 'subscription.pending']);
    expect(new Set(queued.map((w) => w.eventId)).size).toBe(3);
    expect(billing.takeWebhooks()).toEqual([]);
  });

  it('builds a POST Request with the exact body and headers', async () => {
    const sub = await billing.createSubscription(input());
    const [webhook] = billing.authenticate(sub.id);
    if (webhook === undefined) throw new Error('expected a webhook');
    const request = razorpayWebhookRequest(webhook, 'http://localhost:3000/api/razorpay/webhook');
    expect(request.method).toBe('POST');
    expect(request.headers.get('x-razorpay-signature')).toBe(webhook.signature);
    expect(await request.text()).toBe(webhook.rawBody);
  });

  it('matches the RESEARCH UTF-8 vector and refuses an empty secret', () => {
    const vectorC =
      '{"entity":"event","event":"subscription.charged","payload":{"subscription":{"entity":{"id":"sub_TESTSUB000001","notes":{"company":"Café Zürich ₹"}}}},"created_at":1790812900}';
    expect(signRazorpayBody(vectorC, 's3cr3t-ütf8')).toBe('4542d47ca6c160fb1323f7650cc30a070241d9d3afe9b2ea1601568bf3b25ac3');
    expect(() => signRazorpayBody('{}', '')).toThrow(RangeError);
    expect(() => new FakeBilling({ clock, appUrl: 'http://x.example', webhookSecret: '' })).toThrow(RangeError);
  });
});

describe('FakeBilling: fault injection and persistence', () => {
  it('injects transient, config and permanent failures per operation', async () => {
    billing.injectFailure('createSubscription', 'transient');
    billing.injectFailure('fetchPlan', 'config');
    billing.injectFailure('*', 'permanent');
    await expect(billing.createSubscription(input())).rejects.toBeInstanceOf(TransientError);
    await expect(billing.fetchPlan(FAKE_RAZORPAY_PLAN_ID)).rejects.toBeInstanceOf(ConfigError);
    await expect(billing.createSubscription(input())).rejects.toMatchObject({ code: 'razorpay_bad_request' });
    await expect(billing.createSubscription(input())).resolves.toMatchObject({ status: 'created' });
    expect(() => billing.injectFailure('*', 'transient', 0)).toThrow(RangeError);
  });

  it('round-trips its state through a JSON snapshot', async () => {
    const sub = await billing.createSubscription(input());
    billing.authenticate(sub.id);
    const copy = new FakeBilling({ clock, appUrl: 'http://localhost:3000', webhookSecret: SECRET });
    copy.restore(JSON.parse(JSON.stringify(billing.snapshot())));
    expect(await copy.fetchSubscription(sub.id)).toEqual(await billing.fetchSubscription(sub.id));
    expect(copy.subscriptionIds()).toEqual([sub.id]);
    expect(() => copy.restore({ version: 2 })).toThrow();
  });
});
