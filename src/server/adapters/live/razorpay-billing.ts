import 'server-only';
import { z } from 'zod';
import { AppError, ConfigError, PermanentError, TransientError } from '@/server/domain/errors';
import type { Billing, CreateSubscriptionInput, RazorpayPlan, RazorpaySubscription } from '@/server/ports/billing';

// The live Billing port (PLAN §4, D-18 to D-20, RZP-SDK-PACKAGE): Razorpay's REST API with plain
// fetch, no SDK (the SDK has no request timeout, loses network errors in a TypeError, and its
// cancel() turns any truthy second argument into `cancel_at_cycle_end: 1`).
// - Basic auth `RAZORPAY_KEY_ID:RAZORPAY_KEY_SECRET` (RZP-API-KEYS) on every call;
// - every response is checked with Zod; statuses stay open strings (`resumed`, or something new, is
//   the domain's to map, RZP-SUB-STATUSES); empty `notes` arrive as `[]`;
// - Unix seconds in, Dates out (and back): Razorpay counts whole seconds, so Dates are floored;
// - each call has its own timeout; a redirect is never followed with the credentials;
// - errors carry codes only (domain/errors): never the key, the response body (customer data) or
//   Razorpay's description. 429 and 5xx, timeouts and the network are transient; 401 is the
//   operator's key pair (ConfigError, never retried into a lockout); "Subscriptions not enabled" and
//   an unknown plan are configuration too; any other 4xx is permanent.

export const RAZORPAY_API_ORIGIN = 'https://api.razorpay.com';
/**
 * Each call's bound. A webhook whose fetch outlasts Razorpay's 5-second deadline is retried by
 * Razorpay, and the dedupe answers the retry (D-19).
 */
export const DEFAULT_RAZORPAY_TIMEOUT_MS = 8_000;

export type RazorpayErrorCode =
  | 'razorpay_timeout'
  | 'razorpay_network'
  | 'razorpay_rate_limited'
  | 'razorpay_server_error'
  | 'razorpay_unexpected_redirect'
  | 'razorpay_unauthorized'
  | 'razorpay_subscriptions_not_enabled'
  | 'razorpay_plan_not_found'
  | 'razorpay_not_found'
  | 'razorpay_bad_request'
  | 'razorpay_invalid_response'
  | 'razorpay_invalid_id'
  | 'razorpay_invalid_input';

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export interface RazorpayBillingOptions {
  /** RAZORPAY_KEY_ID (`rzp_test_…` / `rzp_live_…`). */
  readonly keyId: string;
  /** RAZORPAY_KEY_SECRET: only ever sent in the Authorization header. */
  readonly keySecret: string;
  /** Each call's timeout. Default 8 s. */
  readonly timeoutMs?: number | undefined;
  /** Injected in tests; default the global fetch. */
  readonly fetch?: FetchLike | undefined;
}

// Razorpay ids are short base62 strings with a type prefix; anything else never reaches a URL path.
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{1,40}$/;
const PLAN_ID = /^plan_[A-Za-z0-9]{1,40}$/;
const NOTE_KEY = /^[A-Za-z0-9_]{1,64}$/;
const MAX_NOTES = 15;

const unixSeconds = z.number().int().nonnegative();
const optionalSeconds = unixSeconds.nullable().optional();

const notesSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown()).length(0)])
  .nullable()
  .optional();

const subscriptionSchema = z.object({
  id: z.string().regex(SUBSCRIPTION_ID),
  plan_id: z.string().min(1).max(64),
  status: z.string().min(1).max(64),
  short_url: z.string().max(2048).nullable().optional(),
  start_at: optionalSeconds,
  expire_by: optionalSeconds,
  current_start: optionalSeconds,
  current_end: optionalSeconds,
  charge_at: optionalSeconds,
  created_at: unixSeconds,
  notes: notesSchema,
});

const planSchema = z.object({
  id: z.string().regex(PLAN_ID),
  period: z.string().min(1).max(32),
  interval: z.number().int().positive(),
  item: z.object({ amount: z.number().int().nonnegative(), currency: z.string().min(3).max(3) }),
});

const errorBodySchema = z.object({ error: z.object({ code: z.string().optional(), description: z.string().optional() }) });

/** Razorpay's hosted link: https only. Anything else is not a link we send an owner to. */
export function httpsUrlOrEmpty(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw.length === 0) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.toString() : '';
  } catch {
    return '';
  }
}

function toDate(seconds: number | null | undefined): Date | undefined {
  return seconds === null || seconds === undefined ? undefined : new Date(seconds * 1000);
}

function toSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** `notes` as strings: numbers and booleans stringified, anything else dropped; `[]` is no notes. */
function normaliseNotes(notes: z.infer<typeof notesSchema>): Record<string, string> {
  const out: Record<string, string> = {};
  if (notes === null || notes === undefined || Array.isArray(notes)) return out;
  for (const [key, value] of Object.entries(notes)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

function toSubscription(raw: z.infer<typeof subscriptionSchema>): RazorpaySubscription {
  return {
    id: raw.id,
    planId: raw.plan_id,
    status: raw.status,
    shortUrl: httpsUrlOrEmpty(raw.short_url),
    startAt: toDate(raw.start_at),
    expireBy: toDate(raw.expire_by),
    currentStart: toDate(raw.current_start),
    currentEnd: toDate(raw.current_end),
    chargeAt: toDate(raw.charge_at),
    createdAt: new Date(raw.created_at * 1000),
    notes: normaliseNotes(raw.notes),
  };
}

type Operation = 'create' | 'fetch' | 'cancel' | 'resume' | 'plan';

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')?.trim();
  return raw !== undefined && /^\d{1,6}$/.test(raw) ? Number(raw) * 1000 : undefined;
}

/** A failed response as a typed error (codes only: the description is matched, never kept). */
function apiError(operation: Operation, status: number, headers: Headers, body: unknown): AppError {
  if (status === 429) return new TransientError<RazorpayErrorCode>('razorpay_rate_limited', { httpStatus: status, retryAfterMs: retryAfterMs(headers) });
  if (status >= 500) return new TransientError<RazorpayErrorCode>('razorpay_server_error', { httpStatus: status });
  if (status >= 300 && status < 400) return new TransientError<RazorpayErrorCode>('razorpay_unexpected_redirect', { httpStatus: status });
  if (status === 401) return new ConfigError<RazorpayErrorCode>('razorpay_unauthorized', { httpStatus: status });
  const parsed = errorBodySchema.safeParse(body);
  const description = parsed.success ? (parsed.data.error.description ?? '') : '';
  // "The requested URL was not found on the server." = the Subscriptions feature is off (RZP-SUB-CREATE-FIELDS).
  if (/requested URL was not found/i.test(description)) return new ConfigError<RazorpayErrorCode>('razorpay_subscriptions_not_enabled', { httpStatus: status });
  // "The id provided does not exist": for a plan, the configured RAZORPAY_PLAN_ID (or the other mode's).
  if ((operation === 'create' || operation === 'plan') && /does not exist/i.test(description)) {
    return new ConfigError<RazorpayErrorCode>('razorpay_plan_not_found', { httpStatus: status });
  }
  if (status === 404 || /does not exist/i.test(description)) return new PermanentError<RazorpayErrorCode>('razorpay_not_found', { httpStatus: status });
  return new PermanentError<RazorpayErrorCode>('razorpay_bad_request', { httpStatus: status });
}

function invalidResponse(status: number): PermanentError {
  return new PermanentError<RazorpayErrorCode>('razorpay_invalid_response', { httpStatus: status });
}

function subscriptionPath(id: string, suffix = ''): string {
  if (!SUBSCRIPTION_ID.test(id)) throw new PermanentError<RazorpayErrorCode>('razorpay_invalid_id');
  return `/v1/subscriptions/${id}${suffix}`;
}

interface RequestSpec {
  readonly operation: Operation;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly json?: Record<string, unknown> | undefined;
}

export class RazorpayBilling implements Billing {
  readonly #authorization: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: RazorpayBillingOptions) {
    if (!/^rzp_(?:test|live)_[A-Za-z0-9]+$/.test(options.keyId)) throw new ConfigError('razorpay_key_id_invalid');
    if (options.keySecret.length === 0) throw new ConfigError('razorpay_key_secret_missing');
    const timeoutMs = options.timeoutMs ?? DEFAULT_RAZORPAY_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new ConfigError('razorpay_timeout_invalid');
    this.#authorization = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`, 'utf8').toString('base64')}`;
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<RazorpaySubscription> {
    const notes = Object.entries(input.notes);
    if (
      !PLAN_ID.test(input.planId) ||
      !Number.isInteger(input.totalCount) ||
      input.totalCount < 1 ||
      !Number.isInteger(input.quantity) ||
      input.quantity < 1 ||
      notes.length > MAX_NOTES ||
      !notes.every(([key, value]) => NOTE_KEY.test(key) && value.length <= 256)
    ) {
      throw new PermanentError<RazorpayErrorCode>('razorpay_invalid_input');
    }
    const json: Record<string, unknown> = {
      plan_id: input.planId,
      total_count: input.totalCount,
      quantity: input.quantity,
      customer_notify: input.customerNotify,
      expire_by: toSeconds(input.expireBy),
      notes: Object.fromEntries(notes),
    };
    if (input.startAt !== undefined) json.start_at = toSeconds(input.startAt);
    const subscription = toSubscription(await this.#call({ operation: 'create', method: 'POST', path: '/v1/subscriptions', json }, subscriptionSchema));
    // The hosted link is the whole point of creating one (RZP-CHECKOUT-HOSTED).
    if (subscription.shortUrl === '') throw invalidResponse(200);
    return subscription;
  }

  async fetchSubscription(id: string): Promise<RazorpaySubscription> {
    return toSubscription(await this.#call({ operation: 'fetch', method: 'GET', path: subscriptionPath(id) }, subscriptionSchema));
  }

  async cancelSubscription(id: string, atCycleEnd: boolean): Promise<RazorpaySubscription> {
    // A real boolean, both ways (the SDK sends 1 for any truthy argument, RZP-SUB-CANCEL-PAUSE-RESUME-FETCH).
    const json = { cancel_at_cycle_end: atCycleEnd };
    return toSubscription(await this.#call({ operation: 'cancel', method: 'POST', path: subscriptionPath(id, '/cancel'), json }, subscriptionSchema));
  }

  async resumeSubscription(id: string): Promise<RazorpaySubscription> {
    const json = { resume_at: 'now' };
    return toSubscription(await this.#call({ operation: 'resume', method: 'POST', path: subscriptionPath(id, '/resume'), json }, subscriptionSchema));
  }

  async fetchPlan(planId: string): Promise<RazorpayPlan> {
    if (!PLAN_ID.test(planId)) throw new ConfigError<RazorpayErrorCode>('razorpay_plan_not_found');
    const plan = await this.#call({ operation: 'plan', method: 'GET', path: `/v1/plans/${planId}` }, planSchema);
    return { id: plan.id, period: plan.period, interval: plan.interval, amount: plan.item.amount, currency: plan.item.currency.toUpperCase() };
  }

  /** One exchange: the network bounded by the timeout, then status mapping and the schema. */
  async #call<S extends z.ZodType>(spec: RequestSpec, schema: S): Promise<z.infer<S>> {
    const url = new URL(spec.path, RAZORPAY_API_ORIGIN);
    if (url.origin !== RAZORPAY_API_ORIGIN) throw new PermanentError<RazorpayErrorCode>('razorpay_invalid_id');
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: this.#authorization };
    let body: string | undefined;
    if (spec.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.json);
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    let status: number;
    let responseHeaders: Headers;
    let parsed: unknown;
    try {
      const response = await this.#fetch(url, {
        method: spec.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: deadline.signal,
        redirect: 'manual',
        cache: 'no-store',
      });
      status = response.status;
      responseHeaders = response.headers;
      parsed = parseBody(await response.text());
    } catch (error) {
      if (error instanceof AppError) throw error;
      // The underlying error can quote the URL or the request: only a code leaves this module.
      throw deadline.signal.aborted
        ? new TransientError<RazorpayErrorCode>('razorpay_timeout')
        : new TransientError<RazorpayErrorCode>('razorpay_network');
    } finally {
      clearTimeout(timer);
    }
    if (status < 200 || status >= 300) throw apiError(spec.operation, status, responseHeaders, parsed);
    const result = schema.safeParse(parsed);
    if (!result.success) throw invalidResponse(status);
    return result.data;
  }
}
