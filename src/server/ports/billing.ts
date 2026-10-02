import 'server-only';

// Razorpay subscriptions over REST with `fetch` (D-20). Times are converted from Unix seconds to Date.
// Fake: subscriptions whose `shortUrl` is `/dev/fake-checkout/{id}`; a future-start subscription stays
// `created` until `startAt`, as Razorpay documents.
//
// Errors: TransientError (429, 5xx, network), PermanentError (other 4xx, including 400
// `BAD_REQUEST_ERROR` for an unknown id), ConfigError (401: key pair or key mode mismatch).

export interface CreateSubscriptionInput {
  planId: string;
  /** Billing cycles (120 per D-20). */
  totalCount: number;
  quantity: number;
  customerNotify: boolean;
  /** Trial end, when more than 1 day of trial is left (D-20). */
  startAt?: Date | undefined;
  /** Deadline for authorising the subscription. */
  expireBy: Date;
  /** At most 15 pairs; ids only, e.g. `autopilot_account_id`. */
  notes: Readonly<Record<string, string>>;
}

export interface RazorpaySubscription {
  id: string;
  planId: string;
  /**
   * Razorpay's status as sent. Usually one of RAZORPAY_SUBSCRIPTION_STATUSES, but it may be `resumed`
   * or something new; the domain maps it (D-18).
   */
  status: string;
  /** The hosted subscription link (checkout, and "Update payment method"). */
  shortUrl: string;
  startAt?: Date | undefined;
  expireBy?: Date | undefined;
  currentStart?: Date | undefined;
  currentEnd?: Date | undefined;
  chargeAt?: Date | undefined;
  /** Razorpay's creation time (not our logical `subscriptions.created_at`). */
  createdAt: Date;
  /** Values normalised to strings. */
  notes: Record<string, string>;
}

export interface RazorpayPlan {
  id: string;
  /** `daily`, `weekly`, `monthly`, `quarterly` or `yearly`. */
  period: string;
  interval: number;
  /** In currency subunits (USD cents). */
  amount: number;
  currency: string;
}

export interface Billing {
  /** `POST /v1/subscriptions`; the new subscription is `created` and carries its `shortUrl`. */
  createSubscription(input: CreateSubscriptionInput): Promise<RazorpaySubscription>;

  /** `GET /v1/subscriptions/{id}`: the source of truth applied by webhooks and reconciles (D-19). */
  fetchSubscription(id: string): Promise<RazorpaySubscription>;

  /** Cancels now (`atCycleEnd` false, from `authenticated`) or at the end of the cycle (true, from `active`) (D-20). */
  cancelSubscription(id: string, atCycleEnd: boolean): Promise<RazorpaySubscription>;

  /** Resumes a `paused` subscription now (`resume_at: now`) (D-18). */
  resumeSubscription(id: string): Promise<RazorpaySubscription>;

  /** `GET /v1/plans/{id}`: the WIRE_UP smoke check that the key pair and plan match (D-20). */
  fetchPlan(planId: string): Promise<RazorpayPlan>;
}
