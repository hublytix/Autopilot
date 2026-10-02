import 'server-only';
import { createHmac } from 'node:crypto';

/** The ten `subscription.*` events Razorpay documents (RZP-SUB-WEBHOOK-EVENTS-PAYLOAD). */
export const RAZORPAY_SUBSCRIPTION_EVENTS = [
  'subscription.authenticated',
  'subscription.activated',
  'subscription.charged',
  'subscription.completed',
  'subscription.updated',
  'subscription.pending',
  'subscription.halted',
  'subscription.cancelled',
  'subscription.paused',
  'subscription.resumed',
] as const;
export type RazorpaySubscriptionEvent = (typeof RAZORPAY_SUBSCRIPTION_EVENTS)[number];

/** A webhook delivery as Razorpay would POST it: the raw body plus its headers. */
export interface FakeRazorpayWebhook {
  /** `x-razorpay-event-id` (unsigned; unique per event, format undocumented). */
  eventId: string;
  event: RazorpaySubscriptionEvent;
  subscriptionId: string;
  /** The exact bytes that were signed; deliver them unchanged. */
  rawBody: string;
  /** `x-razorpay-signature`: lowercase hex HMAC-SHA256 of `rawBody` with the webhook secret. */
  signature: string;
  headers: Record<string, string>;
  /** The envelope's `created_at`. */
  createdAt: Date;
}

/** Razorpay's webhook signature (RZP-WH-SIGNATURE): hex HMAC-SHA256 of the raw body. */
export function signRazorpayBody(rawBody: string, secret: string): string {
  if (secret.length === 0) throw new RangeError('fake_billing_empty_webhook_secret');
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** A POST `Request` carrying the webhook, for route-handler tests and the dev checkout page. */
export function razorpayWebhookRequest(webhook: FakeRazorpayWebhook, url: string): Request {
  return new Request(url, { method: 'POST', headers: webhook.headers, body: webhook.rawBody });
}
