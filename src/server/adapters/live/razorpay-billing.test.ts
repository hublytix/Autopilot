import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAppError } from '@/server/domain/errors';
import { DEFAULT_RAZORPAY_TIMEOUT_MS, RazorpayBilling, type FetchLike } from './razorpay-billing';

// The live Billing adapter against a stubbed fetch (no network, PLAN §12): request shape (method,
// URL, Basic auth, JSON body), response parsing (Unix seconds, `notes: []`, open statuses), the
// error mapping, and that neither the key secret nor the response body ever reaches an error.

const KEY_ID = 'rzp_test_FakeKeyForTests1';
const KEY_SECRET = 'fake-key-secret-for-tests-only';
const AUTH = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: string | undefined;
}

function stub(responses: (Response | Error)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: input.toString(),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      redirect: init.redirect,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error('no stubbed response');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A subscription entity as Razorpay serialises it. */
function entity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sub_TESTSUB000001',
    entity: 'subscription',
    plan_id: 'plan_TESTPLAN00001',
    customer_id: null,
    status: 'created',
    current_start: null,
    current_end: null,
    ended_at: null,
    quantity: 1,
    notes: { autopilot_account_id: '4b7f6f7e-31a8-4d55-9f4c-1f0b7e1f3a01' },
    charge_at: 1793491200,
    start_at: 1793491200,
    end_at: null,
    auth_attempts: 0,
    total_count: 120,
    paid_count: 0,
    customer_notify: true,
    created_at: 1792281600,
    expire_by: 1792886400,
    short_url: 'https://rzp.io/rzp/Dqdqx3h',
    has_scheduled_changes: false,
    change_scheduled_at: null,
    source: 'api',
    offer_id: null,
    remaining_count: 120,
    ...overrides,
  };
}

function billing(fetch: FetchLike, timeoutMs?: number): RazorpayBilling {
  return new RazorpayBilling({ keyId: KEY_ID, keySecret: KEY_SECRET, fetch, timeoutMs });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createSubscription', () => {
  it('POSTs the D-20 body with Basic auth and returns the created subscription with its link', async () => {
    const { fetch, calls } = stub([json(200, entity())]);
    const sub = await billing(fetch).createSubscription({
      planId: 'plan_TESTPLAN00001',
      totalCount: 120,
      quantity: 1,
      customerNotify: true,
      startAt: new Date(1793491200_000 + 999),
      expireBy: new Date(1792886400_000),
      notes: { autopilot_account_id: '4b7f6f7e-31a8-4d55-9f4c-1f0b7e1f3a01' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://api.razorpay.com/v1/subscriptions', method: 'POST', redirect: 'manual' });
    expect(calls[0]?.headers.authorization).toBe(AUTH);
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toEqual({
      plan_id: 'plan_TESTPLAN00001',
      total_count: 120,
      quantity: 1,
      customer_notify: true,
      expire_by: 1792886400,
      // Whole seconds, floored.
      start_at: 1793491200,
      notes: { autopilot_account_id: '4b7f6f7e-31a8-4d55-9f4c-1f0b7e1f3a01' },
    });
    expect(sub).toEqual({
      id: 'sub_TESTSUB000001',
      planId: 'plan_TESTPLAN00001',
      status: 'created',
      shortUrl: 'https://rzp.io/rzp/Dqdqx3h',
      startAt: new Date(1793491200_000),
      expireBy: new Date(1792886400_000),
      currentStart: undefined,
      currentEnd: undefined,
      chargeAt: new Date(1793491200_000),
      createdAt: new Date(1792281600_000),
      notes: { autopilot_account_id: '4b7f6f7e-31a8-4d55-9f4c-1f0b7e1f3a01' },
    });
  });

  it('omits start_at for an immediate start', async () => {
    const { fetch, calls } = stub([json(200, entity({ start_at: null }))]);
    await billing(fetch).createSubscription({ planId: 'plan_TESTPLAN00001', totalCount: 120, quantity: 1, customerNotify: true, expireBy: new Date(1792886400_000), notes: {} });
    expect(calls[0]?.body).not.toHaveProperty('start_at');
  });

  it('refuses a response without a usable https link', async () => {
    for (const shortUrl of [null, 'http://rzp.io/i/x', 'javascript:alert(1)']) {
      const { fetch } = stub([json(200, entity({ short_url: shortUrl }))]);
      const error = await caught(
        billing(fetch).createSubscription({ planId: 'plan_TESTPLAN00001', totalCount: 120, quantity: 1, customerNotify: true, expireBy: new Date(1792886400_000), notes: {} }),
      );
      expect(error).toMatchObject({ kind: 'permanent', code: 'razorpay_invalid_response' });
    }
  });

  it('refuses bad input before calling Razorpay', async () => {
    const { fetch, calls } = stub([]);
    const base = { planId: 'plan_TESTPLAN00001', totalCount: 120, quantity: 1, customerNotify: true, expireBy: new Date(1792886400_000), notes: {} };
    for (const input of [
      { ...base, planId: 'plan_../../x' },
      { ...base, totalCount: 0 },
      { ...base, quantity: 1.5 },
      { ...base, notes: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'])) },
      { ...base, notes: { 'bad key': 'v' } },
    ]) {
      expect(await caught(billing(fetch).createSubscription(input))).toMatchObject({ code: 'razorpay_invalid_input' });
    }
    expect(calls).toHaveLength(0);
  });

  it('maps an unknown plan and a disabled Subscriptions feature to configuration errors', async () => {
    const input = { planId: 'plan_TESTPLAN00001', totalCount: 120, quantity: 1, customerNotify: true, expireBy: new Date(1792886400_000), notes: {} };
    const noPlan = stub([json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } })]);
    expect(await caught(billing(noPlan.fetch).createSubscription(input))).toMatchObject({ kind: 'config', code: 'razorpay_plan_not_found', httpStatus: 400 });
    const off = stub([json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The requested URL was not found on the server.' } })]);
    expect(await caught(billing(off.fetch).createSubscription(input))).toMatchObject({ kind: 'config', code: 'razorpay_subscriptions_not_enabled' });
  });
});

describe('fetchSubscription', () => {
  it('GETs one subscription and keeps an unexpected status as sent (the domain maps it)', async () => {
    const { fetch, calls } = stub([json(200, entity({ status: 'resumed', notes: [], short_url: null, current_start: 1793491200, current_end: 1796083200 }))]);
    const sub = await billing(fetch).fetchSubscription('sub_TESTSUB000001');
    expect(calls[0]).toMatchObject({ url: 'https://api.razorpay.com/v1/subscriptions/sub_TESTSUB000001', method: 'GET', body: undefined });
    expect(calls[0]?.headers.authorization).toBe(AUTH);
    expect(sub).toMatchObject({ status: 'resumed', notes: {}, shortUrl: '', currentStart: new Date(1793491200_000), currentEnd: new Date(1796083200_000) });
  });

  it('turns note values into strings', async () => {
    const { fetch } = stub([json(200, entity({ notes: { autopilot_account_id: 'abc', count: 3, flag: true, nested: { a: 1 } } }))]);
    expect((await billing(fetch).fetchSubscription('sub_TESTSUB000001')).notes).toEqual({ autopilot_account_id: 'abc', count: '3', flag: 'true' });
  });

  it('never puts an id that is not a subscription id into a URL', async () => {
    const { fetch, calls } = stub([]);
    for (const id of ['sub_../plans/x', '../v1/plans/plan_X', 'sub_', 'sub_a/b', 'SUB_abc']) {
      expect(await caught(billing(fetch).fetchSubscription(id))).toMatchObject({ code: 'razorpay_invalid_id' });
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a body that is not a subscription', async () => {
    for (const body of [{ id: 'sub_X' }, entity({ created_at: 'yesterday' }), entity({ id: 'pay_X' }), []]) {
      const { fetch } = stub([json(200, body)]);
      expect(await caught(billing(fetch).fetchSubscription('sub_TESTSUB000001'))).toMatchObject({ kind: 'permanent', code: 'razorpay_invalid_response' });
    }
    const { fetch } = stub([new Response('<html>oops</html>', { status: 200 })]);
    expect(await caught(billing(fetch).fetchSubscription('sub_TESTSUB000001'))).toMatchObject({ code: 'razorpay_invalid_response' });
  });
});

describe('cancelSubscription and resumeSubscription', () => {
  it('sends cancel_at_cycle_end as a real boolean, both ways', async () => {
    const { fetch, calls } = stub([json(200, entity({ status: 'cancelled' })), json(200, entity({ status: 'active' }))]);
    expect((await billing(fetch).cancelSubscription('sub_TESTSUB000001', false)).status).toBe('cancelled');
    expect((await billing(fetch).cancelSubscription('sub_TESTSUB000001', true)).status).toBe('active');
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', 'https://api.razorpay.com/v1/subscriptions/sub_TESTSUB000001/cancel', { cancel_at_cycle_end: false }],
      ['POST', 'https://api.razorpay.com/v1/subscriptions/sub_TESTSUB000001/cancel', { cancel_at_cycle_end: true }],
    ]);
  });

  it('resumes now', async () => {
    const { fetch, calls } = stub([json(200, entity({ status: 'active' }))]);
    expect((await billing(fetch).resumeSubscription('sub_TESTSUB000001')).status).toBe('active');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.razorpay.com/v1/subscriptions/sub_TESTSUB000001/resume', body: { resume_at: 'now' } });
  });

  it('maps a refused cancel (expired) to a permanent error', async () => {
    const { fetch } = stub([json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Subscription is not cancellable in expired status.' } })]);
    expect(await caught(billing(fetch).cancelSubscription('sub_TESTSUB000001', false))).toMatchObject({ kind: 'permanent', code: 'razorpay_bad_request', httpStatus: 400 });
  });

  it('maps an unknown subscription to not found (not a configuration error)', async () => {
    const { fetch } = stub([json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } })]);
    expect(await caught(billing(fetch).cancelSubscription('sub_TESTSUB000001', false))).toMatchObject({ kind: 'permanent', code: 'razorpay_not_found' });
  });
});

describe('fetchPlan', () => {
  it('reads the plan the WIRE_UP smoke check compares ($49/month)', async () => {
    const { fetch, calls } = stub([json(200, { id: 'plan_TESTPLAN00001', entity: 'plan', period: 'monthly', interval: 1, item: { amount: 4900, currency: 'USD' } })]);
    expect(await billing(fetch).fetchPlan('plan_TESTPLAN00001')).toEqual({ id: 'plan_TESTPLAN00001', period: 'monthly', interval: 1, amount: 4900, currency: 'USD' });
    expect(calls[0]?.url).toBe('https://api.razorpay.com/v1/plans/plan_TESTPLAN00001');
  });

  it('treats an unknown plan (or one from the other mode) as configuration', async () => {
    const { fetch } = stub([json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } })]);
    expect(await caught(billing(fetch).fetchPlan('plan_TESTPLAN00001'))).toMatchObject({ kind: 'config', code: 'razorpay_plan_not_found' });
  });
});

describe('error mapping', () => {
  it.each([
    [401, 'config', 'razorpay_unauthorized'],
    [429, 'transient', 'razorpay_rate_limited'],
    [500, 'transient', 'razorpay_server_error'],
    [502, 'transient', 'razorpay_server_error'],
    [302, 'transient', 'razorpay_unexpected_redirect'],
    [404, 'permanent', 'razorpay_not_found'],
    [422, 'permanent', 'razorpay_bad_request'],
  ] as const)('HTTP %i → %s %s', async (status, kind, code) => {
    const { fetch } = stub([json(status, { error: { code: 'X', description: `The api key provided is invalid ${KEY_SECRET}` } }, status === 429 ? { 'retry-after': '7' } : {})]);
    const error = await caught(billing(fetch).fetchSubscription('sub_TESTSUB000001'));
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({ kind, code, httpStatus: status });
    if (status === 429) expect(error).toMatchObject({ retryAfterMs: 7000 });
    expect(String((error as Error).message)).toBe(code);
    expect(JSON.stringify(error)).not.toContain(KEY_SECRET);
  });

  it('maps a network failure without quoting it', async () => {
    const { fetch } = stub([new TypeError(`fetch failed for ${KEY_SECRET}`)]);
    const error = await caught(billing(fetch).fetchSubscription('sub_TESTSUB000001'));
    expect(error).toMatchObject({ kind: 'transient', code: 'razorpay_network' });
    expect((error as Error).message).toBe('razorpay_network');
  });

  it('times out a call that does not answer', async () => {
    vi.useFakeTimers();
    const fetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const pending = caught(billing(fetch).fetchSubscription('sub_TESTSUB000001'));
    await vi.advanceTimersByTimeAsync(DEFAULT_RAZORPAY_TIMEOUT_MS);
    expect(await pending).toMatchObject({ kind: 'transient', code: 'razorpay_timeout' });
  });

  it('refuses a malformed key pair at construction', () => {
    expect(() => new RazorpayBilling({ keyId: 'pk_live_x', keySecret: KEY_SECRET })).toThrow('razorpay_key_id_invalid');
    expect(() => new RazorpayBilling({ keyId: KEY_ID, keySecret: '' })).toThrow('razorpay_key_secret_missing');
  });
});
