import 'server-only';
import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { ConfigError, PermanentError, TransientError } from '@/server/domain/errors';
import type { Billing, CreateSubscriptionInput, RazorpayPlan, RazorpaySubscription } from '@/server/ports/billing';
import type { Clock } from '@/server/ports/clock';
import { signRazorpayBody, type FakeRazorpayWebhook, type RazorpaySubscriptionEvent } from './webhook';

/** Documented fake values (fake mode only). */
export const FAKE_RAZORPAY_PLAN_ID = 'plan_FakeAutopilot1';
export const FAKE_RAZORPAY_ACCOUNT_ID = 'acc_FakeAutopilot1';
/** $49/month in USD cents (RZP-PLAN-CREATE). */
export const FAKE_RAZORPAY_PLAN: RazorpayPlan = { id: FAKE_RAZORPAY_PLAN_ID, period: 'monthly', interval: 1, amount: 4900, currency: 'USD' };
/** Razorpay's limit on `notes` pairs. */
export const MAX_NOTES = 15;

export const FAKE_BILLING_OPERATIONS = ['createSubscription', 'fetchSubscription', 'cancelSubscription', 'resumeSubscription', 'fetchPlan'] as const;
export type FakeBillingOperation = (typeof FAKE_BILLING_OPERATIONS)[number];
export type FakeBillingFailureKind = 'transient' | 'permanent' | 'config';

export interface FakeBillingOptions {
  clock: Clock;
  /** APP_URL: `shortUrl` is `${appUrl}/dev/fake-checkout/{id}`. */
  appUrl: string;
  /** RAZORPAY_WEBHOOK_SECRET: every emitted webhook is signed with it. */
  webhookSecret: string;
  /** Default FAKE_RAZORPAY_PLAN (its `id` is the only plan id the fake knows). */
  plan?: RazorpayPlan | undefined;
  /**
   * Razorpay sometimes sends `subscription.authenticated` for a future-start authentication and its
   * test guide says it sends nothing; default true (send it).
   */
  emitAuthenticatedEvent?: boolean | undefined;
  /** Charge each new cycle automatically when its time comes; default true. */
  autoRenew?: boolean | undefined;
}

const subscriptionStateSchema = z.object({
  id: z.string(),
  planId: z.string(),
  status: z.string(),
  totalCount: z.number().int(),
  quantity: z.number().int(),
  customerNotify: z.boolean(),
  notes: z.record(z.string(), z.string()),
  createdAtMs: z.number(),
  expireByMs: z.number(),
  startAtMs: z.number().nullable(),
  currentStartMs: z.number().nullable(),
  currentEndMs: z.number().nullable(),
  chargeAtMs: z.number().nullable(),
  endedAtMs: z.number().nullable(),
  paidCount: z.number().int(),
  authAttempts: z.number().int(),
  cancelAtCycleEnd: z.boolean(),
  pauseInitiatedBy: z.string().nullable(),
  cancelInitiatedBy: z.string().nullable(),
});
type SubscriptionState = z.infer<typeof subscriptionStateSchema>;

const snapshotSchema = z.object({ version: z.literal(1), subscriptions: z.array(subscriptionStateSchema) });
/** Plain JSON for fake-mode persistence. */
export type FakeBillingSnapshot = z.infer<typeof snapshotSchema>;

const TERMINAL = new Set(['cancelled', 'completed', 'expired']);
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomId(prefix: string): string {
  const bytes = randomBytes(14);
  let out = '';
  for (const b of bytes) out += BASE62[b % BASE62.length] ?? '0';
  return `${prefix}${out}`;
}

function seconds(ms: number | null): number | null {
  return ms === null ? null : Math.floor(ms / 1000);
}

function optionalDate(ms: number | null): Date | undefined {
  return ms === null ? undefined : new Date(ms);
}

function badRequest(): PermanentError {
  return new PermanentError('razorpay_bad_request', { httpStatus: 400 });
}

/** Thrown by the test helpers for a transition Razorpay would not make. */
function invalidTransition(): Error {
  return new Error('fake_billing_invalid_transition');
}

/**
 * Fake Razorpay subscriptions implementing `Billing` (PLAN §4, D-18 to D-20). Statuses follow
 * RZP-SUB-STATUSES: a future-start subscription stays `created` until `startAt` (no expiry at
 * `expireBy`) and then becomes `expired` with no webhook; `authenticated` becomes `active` at
 * `startAt`. Every transition queues a signed webhook (`takeWebhooks()`); the helpers below play the
 * customer and Razorpay's billing engine and also return the webhooks they caused.
 */
export class FakeBilling implements Billing {
  readonly #clock: Clock;
  readonly #appUrl: string;
  readonly #webhookSecret: string;
  readonly #plan: RazorpayPlan;
  readonly #emitAuthenticated: boolean;
  readonly #autoRenew: boolean;
  readonly #subs = new Map<string, SubscriptionState>();
  readonly #outbox: FakeRazorpayWebhook[] = [];
  readonly #failures: { op: FakeBillingOperation | '*'; kind: FakeBillingFailureKind; remaining: number }[] = [];

  constructor(options: FakeBillingOptions) {
    if (options.webhookSecret.length === 0) throw new RangeError('fake_billing_empty_webhook_secret');
    this.#clock = options.clock;
    this.#appUrl = options.appUrl.replace(/\/+$/, '');
    this.#webhookSecret = options.webhookSecret;
    this.#plan = options.plan ?? FAKE_RAZORPAY_PLAN;
    this.#emitAuthenticated = options.emitAuthenticatedEvent ?? true;
    this.#autoRenew = options.autoRenew ?? true;
  }

  // ── Billing port ──────────────────────────────────────────────────────────────────────────────

  async createSubscription(input: CreateSubscriptionInput): Promise<RazorpaySubscription> {
    this.#maybeFail('createSubscription');
    const nowMs = this.#nowMs();
    const expireByMs = input.expireBy.getTime();
    const startAtMs = input.startAt?.getTime() ?? null;
    if (
      input.planId !== this.#plan.id ||
      !Number.isInteger(input.totalCount) ||
      input.totalCount < 1 ||
      !Number.isInteger(input.quantity) ||
      input.quantity < 1 ||
      !(expireByMs > nowMs) ||
      (startAtMs !== null && !(startAtMs > nowMs)) ||
      Object.keys(input.notes).length > MAX_NOTES
    ) {
      throw badRequest();
    }
    const sub: SubscriptionState = {
      id: randomId('sub_'),
      planId: input.planId,
      status: 'created',
      totalCount: input.totalCount,
      quantity: input.quantity,
      customerNotify: input.customerNotify,
      notes: { ...input.notes },
      createdAtMs: nowMs,
      expireByMs,
      startAtMs,
      currentStartMs: null,
      currentEndMs: null,
      chargeAtMs: startAtMs,
      endedAtMs: null,
      paidCount: 0,
      authAttempts: 0,
      cancelAtCycleEnd: false,
      pauseInitiatedBy: null,
      cancelInitiatedBy: null,
    };
    this.#subs.set(sub.id, sub);
    return this.#toPort(sub);
  }

  async fetchSubscription(id: string): Promise<RazorpaySubscription> {
    this.#maybeFail('fetchSubscription');
    return this.#toPort(this.#settled(id));
  }

  async cancelSubscription(id: string, atCycleEnd: boolean): Promise<RazorpaySubscription> {
    this.#maybeFail('cancelSubscription');
    const sub = this.#settled(id);
    if (TERMINAL.has(sub.status)) throw badRequest();
    if (atCycleEnd) {
      if (sub.status !== 'active') throw badRequest();
      sub.cancelAtCycleEnd = true;
      return this.#toPort(sub);
    }
    this.#cancelNow(sub, this.#nowMs(), 'self');
    return this.#toPort(sub);
  }

  async resumeSubscription(id: string): Promise<RazorpaySubscription> {
    this.#maybeFail('resumeSubscription');
    const sub = this.#settled(id);
    if (sub.status !== 'paused') throw badRequest();
    this.#resume(sub);
    return this.#toPort(sub);
  }

  async fetchPlan(planId: string): Promise<RazorpayPlan> {
    this.#maybeFail('fetchPlan');
    if (planId !== this.#plan.id) throw badRequest();
    return { ...this.#plan };
  }

  // ── Test and dev helpers ──────────────────────────────────────────────────────────────────────

  /** The hosted-checkout URL every subscription carries. */
  checkoutUrl(id: string): string {
    return `${this.#appUrl}/dev/fake-checkout/${encodeURIComponent(id)}`;
  }

  /** Queues a failure for the next `times` (default 1) calls of `op` (`*`: any port method). */
  injectFailure(op: FakeBillingOperation | '*', kind: FakeBillingFailureKind, times = 1): void {
    if (!Number.isInteger(times) || times < 1) throw new RangeError('fake_billing_invalid_times');
    this.#failures.push({ op, kind, remaining: times });
  }

  /** Drains the queued webhooks, oldest first. */
  takeWebhooks(): FakeRazorpayWebhook[] {
    return this.#outbox.splice(0, this.#outbox.length);
  }

  /** Applies every time-based transition due at the Clock's now; returns the webhooks it caused. */
  sync(): FakeRazorpayWebhook[] {
    return this.#capture(() => {
      for (const sub of this.#subs.values()) this.#settle(sub);
    });
  }

  /**
   * The customer completes checkout. Future start: `authenticated` (token charge refunded). Immediate
   * start: the first charge succeeds and the subscription is `active`.
   */
  authenticate(id: string): FakeRazorpayWebhook[] {
    return this.#capture(() => {
      const sub = this.#settled(id);
      const nowMs = this.#nowMs();
      if (sub.status !== 'created' || nowMs > sub.expireByMs) throw invalidTransition();
      sub.authAttempts += 1;
      if (sub.startAtMs !== null) {
        sub.status = 'authenticated';
        if (this.#emitAuthenticated) this.#emit(sub, 'subscription.authenticated', nowMs, false);
      } else {
        this.#startCycle(sub, nowMs);
        this.#emit(sub, 'subscription.activated', nowMs, true);
        this.#emit(sub, 'subscription.charged', nowMs, true);
      }
    });
  }

  /** A failed authentication payment: the subscription stays `created` and no webhook fires (08.1 V1). */
  failAuthentication(id: string): void {
    const sub = this.#settled(id);
    if (sub.status !== 'created') throw invalidTransition();
    sub.authAttempts += 1;
  }

  /**
   * `authenticated` → `active` now (as if `startAt` had come), or `pending`/`halted` → `active` after
   * a card update and a successful charge.
   */
  activate(id: string): FakeRazorpayWebhook[] {
    return this.#capture(() => {
      const sub = this.#settled(id);
      const nowMs = this.#nowMs();
      if (sub.status === 'authenticated') {
        this.#startCycle(sub, nowMs);
        this.#emit(sub, 'subscription.activated', nowMs, true);
        this.#emit(sub, 'subscription.charged', nowMs, true);
      } else if (sub.status === 'pending' || sub.status === 'halted') {
        this.#recover(sub, nowMs);
      } else {
        throw invalidTransition();
      }
    });
  }

  /** The next cycle's charge succeeds now (or a `pending`/`halted` subscription recovers). */
  charge(id: string): FakeRazorpayWebhook[] {
    return this.#capture(() => {
      const sub = this.#settled(id);
      const nowMs = this.#nowMs();
      if (sub.status === 'pending' || sub.status === 'halted') this.#recover(sub, nowMs);
      else if (sub.status === 'active') this.#renew(sub, nowMs);
      else throw invalidTransition();
    });
  }

  /** An auto-charge fails: `active` or `pending` → `pending` (the webhook repeats on each failed retry). */
  failPayment(id: string): FakeRazorpayWebhook[] {
    return this.#capture(() => {
      const sub = this.#settled(id);
      if (sub.status !== 'active' && sub.status !== 'pending') throw invalidTransition();
      sub.status = 'pending';
      this.#emit(sub, 'subscription.pending', this.#nowMs(), true);
    });
  }

  /** Retries are exhausted: `pending` → `halted`. */
  halt(id: string): FakeRazorpayWebhook[] {
    return this.#capture(() => {
      const sub = this.#settled(id);
      if (sub.status !== 'pending') throw invalidTransition();
      sub.status = 'halted';
      this.#emit(sub, 'subscription.halted', this.#nowMs(), false);
    });
  }

  /** A pause (by us, or the customer from a UPI app or bank portal): `active` → `paused`; `authenticated` is cancelled instead. */
  pause(id: string, initiatedBy = 'self'): FakeRazorpayWebhook[] {
    return this.#capture(() => {
      const sub = this.#settled(id);
      const nowMs = this.#nowMs();
      if (sub.status === 'authenticated') {
        this.#cancelNow(sub, nowMs, initiatedBy);
      } else if (sub.status === 'active') {
        sub.status = 'paused';
        sub.pauseInitiatedBy = initiatedBy;
        sub.chargeAtMs = null;
        this.#emit(sub, 'subscription.paused', nowMs, false);
      } else {
        throw invalidTransition();
      }
    });
  }

  /** `paused` → `active` (`subscription.resumed`, status `active`). */
  resume(id: string): FakeRazorpayWebhook[] {
    return this.#capture(() => {
      const sub = this.#settled(id);
      if (sub.status !== 'paused') throw invalidTransition();
      this.#resume(sub);
    });
  }

  /** A cancellation from outside the app (dashboard, UPI app, bank portal), now or at cycle end (D-20). */
  cancel(id: string, options: { atCycleEnd?: boolean | undefined; initiatedBy?: string | undefined } = {}): FakeRazorpayWebhook[] {
    return this.#capture(() => {
      const sub = this.#settled(id);
      if (TERMINAL.has(sub.status)) throw invalidTransition();
      if (options.atCycleEnd === true) {
        if (sub.status !== 'active') throw invalidTransition();
        sub.cancelAtCycleEnd = true;
        sub.cancelInitiatedBy = options.initiatedBy ?? 'self';
      } else {
        this.#cancelNow(sub, this.#nowMs(), options.initiatedBy ?? 'self');
      }
    });
  }

  /** All billing cycles done: → `completed`. */
  complete(id: string): FakeRazorpayWebhook[] {
    return this.#capture(() => {
      const sub = this.#settled(id);
      if (TERMINAL.has(sub.status)) throw invalidTransition();
      this.#completeNow(sub, this.#nowMs());
    });
  }

  /** Every subscription id, in creation order. */
  subscriptionIds(): string[] {
    return [...this.#subs.keys()];
  }

  snapshot(): FakeBillingSnapshot {
    return { version: 1, subscriptions: [...this.#subs.values()].map((s) => ({ ...s, notes: { ...s.notes } })) };
  }

  restore(snapshot: unknown): void {
    const parsed = snapshotSchema.parse(snapshot);
    this.#subs.clear();
    for (const sub of parsed.subscriptions) this.#subs.set(sub.id, sub);
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────

  #nowMs(): number {
    return this.#clock.now().getTime();
  }

  #maybeFail(op: FakeBillingOperation): void {
    const index = this.#failures.findIndex((f) => f.op === '*' || f.op === op);
    const failure = this.#failures[index];
    if (failure === undefined) return;
    failure.remaining -= 1;
    if (failure.remaining <= 0) this.#failures.splice(index, 1);
    if (failure.kind === 'transient') throw new TransientError('razorpay_server_error', { httpStatus: 502 });
    if (failure.kind === 'config') throw new ConfigError('razorpay_unauthorized', { httpStatus: 401 });
    throw badRequest();
  }

  #settled(id: string): SubscriptionState {
    const sub = this.#subs.get(id);
    if (sub === undefined) throw badRequest();
    this.#settle(sub);
    return sub;
  }

  /** Time-based transitions up to now, each dated when it happened. */
  #settle(sub: SubscriptionState): void {
    const nowMs = this.#nowMs();
    if (sub.status === 'created' && sub.startAtMs !== null && nowMs >= sub.startAtMs) {
      sub.status = 'expired';
      sub.chargeAtMs = null;
      return;
    }
    if (sub.status === 'authenticated' && sub.startAtMs !== null && nowMs >= sub.startAtMs) {
      this.#startCycle(sub, sub.startAtMs);
      this.#emit(sub, 'subscription.activated', sub.startAtMs, true);
      this.#emit(sub, 'subscription.charged', sub.startAtMs, true);
    }
    for (let guard = 0; sub.status === 'active' && sub.currentEndMs !== null && sub.currentEndMs <= nowMs && guard <= sub.totalCount; guard += 1) {
      const endMs = sub.currentEndMs;
      if (sub.cancelAtCycleEnd) this.#cancelNow(sub, endMs, sub.cancelInitiatedBy ?? 'self');
      else if (sub.paidCount >= sub.totalCount) this.#completeNow(sub, endMs);
      else if (this.#autoRenew) this.#renew(sub, endMs);
      else break;
    }
  }

  /** One billing period later, in calendar units (UTC), as Razorpay bills. */
  #addPeriod(ms: number): number {
    const start = DateTime.fromMillis(ms, { zone: 'utc' });
    const n = this.#plan.interval;
    switch (this.#plan.period) {
      case 'daily':
        return start.plus({ days: n }).toMillis();
      case 'weekly':
        return start.plus({ weeks: n }).toMillis();
      case 'quarterly':
        return start.plus({ quarters: n }).toMillis();
      case 'yearly':
        return start.plus({ years: n }).toMillis();
      default:
        return start.plus({ months: n }).toMillis();
    }
  }

  #startCycle(sub: SubscriptionState, atMs: number): void {
    sub.status = 'active';
    sub.currentStartMs = atMs;
    sub.currentEndMs = this.#addPeriod(atMs);
    sub.chargeAtMs = sub.currentEndMs;
    sub.paidCount += 1;
  }

  #renew(sub: SubscriptionState, atMs: number): void {
    const start = sub.currentEndMs ?? atMs;
    sub.currentStartMs = start;
    sub.currentEndMs = this.#addPeriod(start);
    sub.chargeAtMs = sub.currentEndMs;
    sub.paidCount += 1;
    this.#emit(sub, 'subscription.charged', atMs, true);
  }

  #recover(sub: SubscriptionState, atMs: number): void {
    this.#startCycle(sub, atMs);
    this.#emit(sub, 'subscription.charged', atMs, true);
    this.#emit(sub, 'subscription.activated', atMs, true);
  }

  #resume(sub: SubscriptionState): void {
    sub.status = 'active';
    sub.pauseInitiatedBy = null;
    sub.chargeAtMs = sub.currentEndMs;
    this.#emit(sub, 'subscription.resumed', this.#nowMs(), false);
  }

  #cancelNow(sub: SubscriptionState, atMs: number, initiatedBy: string): void {
    sub.status = 'cancelled';
    sub.cancelInitiatedBy = initiatedBy;
    sub.cancelAtCycleEnd = false;
    sub.endedAtMs = atMs;
    sub.chargeAtMs = null;
    this.#emit(sub, 'subscription.cancelled', atMs, false);
  }

  #completeNow(sub: SubscriptionState, atMs: number): void {
    sub.status = 'completed';
    sub.endedAtMs = atMs;
    sub.chargeAtMs = null;
    this.#emit(sub, 'subscription.completed', atMs, false);
  }

  #capture(run: () => void): FakeRazorpayWebhook[] {
    const before = this.#outbox.length;
    run();
    return this.#outbox.slice(before);
  }

  #emit(sub: SubscriptionState, event: RazorpaySubscriptionEvent, atMs: number, withPayment: boolean): void {
    const createdAt = Math.floor(atMs / 1000);
    const payload: Record<string, unknown> = { subscription: { entity: this.#wireEntity(sub) } };
    if (withPayment) {
      payload.payment = {
        entity: {
          id: randomId('pay_'),
          entity: 'payment',
          amount: this.#plan.amount * sub.quantity,
          currency: this.#plan.currency,
          status: 'captured',
          method: 'card',
          created_at: createdAt,
        },
      };
    }
    const rawBody = JSON.stringify({
      entity: 'event',
      account_id: FAKE_RAZORPAY_ACCOUNT_ID,
      event,
      contains: withPayment ? ['subscription', 'payment'] : ['subscription'],
      payload,
      created_at: createdAt,
    });
    const signature = signRazorpayBody(rawBody, this.#webhookSecret);
    const eventId = randomId('evt_');
    this.#outbox.push({
      eventId,
      event,
      subscriptionId: sub.id,
      rawBody,
      signature,
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature, 'x-razorpay-event-id': eventId },
      createdAt: new Date(createdAt * 1000),
    });
  }

  /** The subscription entity as Razorpay serialises it (Unix seconds; empty notes as `[]`). */
  #wireEntity(sub: SubscriptionState): Record<string, unknown> {
    return {
      id: sub.id,
      entity: 'subscription',
      plan_id: sub.planId,
      customer_id: null,
      status: sub.status,
      current_start: seconds(sub.currentStartMs),
      current_end: seconds(sub.currentEndMs),
      ended_at: seconds(sub.endedAtMs),
      quantity: sub.quantity,
      notes: Object.keys(sub.notes).length === 0 ? [] : { ...sub.notes },
      charge_at: seconds(sub.chargeAtMs),
      start_at: seconds(sub.startAtMs),
      end_at: null,
      auth_attempts: sub.authAttempts,
      total_count: sub.totalCount,
      paid_count: sub.paidCount,
      customer_notify: sub.customerNotify,
      created_at: seconds(sub.createdAtMs),
      expire_by: seconds(sub.expireByMs),
      short_url: null,
      has_scheduled_changes: false,
      change_scheduled_at: null,
      source: 'api',
      offer_id: null,
      remaining_count: Math.max(0, sub.totalCount - sub.paidCount),
      payment_method: 'card',
      pause_initiated_by: sub.pauseInitiatedBy,
      cancel_initiated_by: sub.cancelInitiatedBy,
    };
  }

  #toPort(sub: SubscriptionState): RazorpaySubscription {
    return {
      id: sub.id,
      planId: sub.planId,
      status: sub.status,
      shortUrl: this.checkoutUrl(sub.id),
      startAt: optionalDate(sub.startAtMs),
      expireBy: optionalDate(sub.expireByMs),
      currentStart: optionalDate(sub.currentStartMs),
      currentEnd: optionalDate(sub.currentEndMs),
      chargeAt: optionalDate(sub.chargeAtMs),
      createdAt: new Date(sub.createdAtMs),
      notes: { ...sub.notes },
    };
  }
}
