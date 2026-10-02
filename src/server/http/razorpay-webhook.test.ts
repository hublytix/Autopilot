import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Deps } from '@/server/ports';
import { useTestDb as setUpTestDb } from '../../../test/db/harness';
import { alertCodes, setUpBillingRig, WEBHOOK_URL, type BillingRig } from '../../../test/billing/support';
import { handleRazorpayWebhook, RAZORPAY_WEBHOOK_MAX_BODY_BYTES } from './razorpay-webhook';

// The route's own checks (PLAN §7.3, §10.1): the raw body bounded, the signature on its exact bytes
// (the research's vector B end to end), the previous secret during a rotation, 401 for a bad or
// missing signature, and a refusal to accept anything when no secret is configured.

const getDb = setUpTestDb();
const getRig = setUpBillingRig(getDb);

const B_BODY = readFileSync(join(process.cwd(), 'test', 'fixtures', 'razorpay', 'B.body'));
const B_SECRET = 'autopilot_webhook_secret_test';
const B_SIGNATURE = '295edb02518396f42f7568c942c21def25aa3a7bb2a92cff001c25d6344d7bbc';

function withSecrets(rig: BillingRig, current: string, previous?: string): Deps {
  return { ...rig.deps, env: { ...rig.deps.env, RAZORPAY_WEBHOOK_SECRET: current, RAZORPAY_WEBHOOK_SECRET_PREVIOUS: previous } };
}

function vectorB(signature: string | null = B_SIGNATURE, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-razorpay-event-id': 'evt_VectorB00001', ...extra };
  if (signature !== null) headers['x-razorpay-signature'] = signature;
  return new Request(WEBHOOK_URL, { method: 'POST', headers, body: B_BODY });
}

async function outcome(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('POST /api/razorpay/webhook', () => {
  it('accepts the research vector B on its exact bytes (an unknown subscription here: 200 and an admin warning)', async () => {
    const rig = getRig();
    const res = await outcome(await handleRazorpayWebhook(vectorB(), withSecrets(rig, B_SECRET)));
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'unknown_subscription' } });
    expect(alertCodes(rig)).toEqual(['billing_webhook_unknown_subscription']);
    expect(await getDb().query(`select dedupe_key, body_sha256, event_type from webhook_events`)).toEqual([
      { dedupe_key: 'evt_VectorB00001', body_sha256: 'b17497e95dc61a3a75cddd63778f4cf2dd248f4a109d0b3349f11e9193defc56', event_type: 'subscription.activated' },
    ]);
  });

  it('accepts a delivery signed with the previous secret during a rotation', async () => {
    const rig = getRig();
    const res = await handleRazorpayWebhook(vectorB(), withSecrets(rig, 'the-rotated-webhook-secret', B_SECRET));
    expect(res.status).toBe(200);
  });

  it.each([
    ['a signature made with another secret', '8d5d9f09e43d30e59e4bb9610080ca577b42035adb6784d6dbeee5ff186489a2'],
    ['an UPPERCASE signature', B_SIGNATURE.toUpperCase()],
    ['no signature', null],
  ] as const)('refuses %s with 401 and records nothing', async (_name, signature) => {
    const rig = getRig();
    const res = await outcome(await handleRazorpayWebhook(vectorB(signature), withSecrets(rig, B_SECRET)));
    expect(res).toEqual({ status: 401, body: { ok: false, code: 'invalid_signature' } });
    expect(await getDb().query(`select id from webhook_events`)).toHaveLength(0);
  });

  it('never accepts anything without a configured secret (the SDK would accept an empty-secret forgery)', async () => {
    const rig = getRig();
    const forgery = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-razorpay-signature': '8d5d9f09e43d30e59e4bb9610080ca577b42035adb6784d6dbeee5ff186489a2' },
      body: '{"event":"subscription.activated"}',
    });
    const res = await outcome(await handleRazorpayWebhook(forgery, withSecrets(rig, '')));
    expect(res).toEqual({ status: 500, body: { ok: false, code: 'webhook_not_configured' } });
    expect(alertCodes(rig)).toEqual(['billing_webhook_secret_missing']);
    expect(await getDb().query(`select id from webhook_events`)).toHaveLength(0);
  });

  it('refuses an oversized body before reading it (413)', async () => {
    const rig = getRig();
    const big = new Request(WEBHOOK_URL, { method: 'POST', headers: { 'content-length': String(RAZORPAY_WEBHOOK_MAX_BODY_BYTES + 1) }, body: 'x' });
    expect((await handleRazorpayWebhook(big, rig.deps)).status).toBe(413);
    const actual = new Request(WEBHOOK_URL, { method: 'POST', body: 'x'.repeat(RAZORPAY_WEBHOOK_MAX_BODY_BYTES + 1) });
    expect((await handleRazorpayWebhook(actual, rig.deps)).status).toBe(413);
  });

  it('refuses a chunked body without Content-Length as soon as it passes the limit, without reading the rest (413)', async () => {
    const rig = getRig();
    const chunk = new Uint8Array(64 * 1024).fill(0x78);
    let pulled = 0;
    let cancelled = false;
    // An endless stream (a client that never stops sending): it must be cut off, not buffered.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request(WEBHOOK_URL, { method: 'POST', body: endless, duplex: 'half' } as RequestInit & { duplex: 'half' });
    expect(request.headers.get('content-length')).toBeNull();
    const response = await handleRazorpayWebhook(request, rig.deps);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    // 256 KiB is 4 chunks of 64 KiB: it stopped on the 5th (a little read-ahead at most).
    expect(pulled).toBeLessThanOrEqual(7);
    expect(await getDb().query(`select id from webhook_events`)).toHaveLength(0);
  });

  it('accepts a body of exactly the limit (then checks its signature)', async () => {
    const rig = getRig();
    const exact = new Request(WEBHOOK_URL, { method: 'POST', body: 'x'.repeat(RAZORPAY_WEBHOOK_MAX_BODY_BYTES) });
    expect((await handleRazorpayWebhook(exact, rig.deps)).status).toBe(401);
  });

  it('answers no-store JSON', async () => {
    const rig = getRig();
    const res = await handleRazorpayWebhook(vectorB(), withSecrets(rig, B_SECRET));
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
