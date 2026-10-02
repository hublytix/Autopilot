import { afterEach, beforeEach, vi } from 'vitest';
import { razorpayWebhookRequest, type FakeRazorpayWebhook } from '@/server/adapters/fake/billing';
import type { Db } from '@/server/db';
import type { EnvSource } from '@/server/env';
import { handleRazorpayWebhook } from '@/server/http/razorpay-webhook';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, seedAccount, seedConnection, seedSettings, type JobTestRig } from '@/server/jobs/testing';
import { seedOwner } from '@/server/services/accounts/testing';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth/owner-scope';
import { loadAccountSubscriptions, type SubscriptionRow } from '@/server/services/billing';

// Test support for billing (PLAN §9.9, §12): a rig with every fake (FakeBilling signs its webhooks
// with the env's RAZORPAY_WEBHOOK_SECRET), an owned, onboarded account whose 14-day trial starts at
// the rig's start, webhook delivery through the real route handler, and captured admin alerts.

export const DAY = 24 * 60 * 60 * 1000;
export const WEBHOOK_URL = 'http://localhost:3000/api/razorpay/webhook';

export interface BillingRig extends JobTestRig {
  /** Admin alerts raised during the test (codes and fields). */
  readonly alerts: RaisedAlert[];
}

/** Call at module level: a fresh rig per test, alerts captured, console quiet. */
export function setUpBillingRig(getDb: () => Db, env: EnvSource = {}): () => BillingRig {
  let rig: BillingRig | undefined;
  let stop: (() => void) | undefined;
  beforeEach(() => {
    for (const method of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
    const alerts: RaisedAlert[] = [];
    stop = onAlert((alert) => alerts.push(alert));
    rig = { ...createJobTestRig(getDb(), createJobRegistry(), { env }), alerts };
  });
  afterEach(() => {
    stop?.();
    vi.restoreAllMocks();
  });
  return () => {
    if (rig === undefined) throw new Error('billing rig used outside a test');
    return rig;
  };
}

export interface BillingAccount {
  readonly accountId: string;
  readonly scope: OwnerScope;
}

/**
 * An active, onboarded account with a bound owner; its trial ends 14 days after `rig.clock.now()`.
 * `authUserId`: an auth user of the fake AuthProvider, for tests that sign in with a cookie.
 */
export async function seedBillingAccount(rig: JobTestRig, owner: { email?: string; authUserId?: string } = {}): Promise<BillingAccount> {
  const db = rig.deps.db;
  const now = rig.clock.now();
  const accountId = await seedAccount(db, { now });
  await seedConnection(db, { accountId, now });
  await seedSettings(db, { accountId, now });
  const userId = await seedOwner(db, accountId, owner.email ?? 'owner@brightside-plumbing.example', owner.authUserId);
  return { accountId, scope: createOwnerScopeForTest(accountId, userId) };
}

/** Delivers webhooks to the real route handler, in order; returns each response's status and outcome. */
export async function deliver(rig: JobTestRig, webhooks: readonly FakeRazorpayWebhook[]): Promise<{ status: number; outcome: string }[]> {
  const out: { status: number; outcome: string }[] = [];
  for (const webhook of webhooks) {
    const response = await handleRazorpayWebhook(razorpayWebhookRequest(webhook, WEBHOOK_URL), rig.deps);
    const body = (await response.json()) as { outcome?: string; code?: string };
    out.push({ status: response.status, outcome: body.outcome ?? body.code ?? '' });
  }
  return out;
}

/** Drains FakeBilling's queue and delivers everything in it. */
export async function deliverQueued(rig: JobTestRig): Promise<{ status: number; outcome: string }[]> {
  return deliver(rig, rig.fakes.billing.takeWebhooks());
}

export async function subscriptions(db: Db, accountId: string): Promise<SubscriptionRow[]> {
  return loadAccountSubscriptions(db, accountId);
}

export async function onlySubscription(db: Db, accountId: string): Promise<SubscriptionRow> {
  const rows = await subscriptions(db, accountId);
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(`expected one subscription, found ${rows.length}`);
  return rows[0];
}

export async function accountState(db: Db, accountId: string): Promise<{ processing_state: string; entitlement_lost_at: Date | null; checkout_lock_until: Date | null }> {
  return db.one(`select processing_state, entitlement_lost_at, checkout_lock_until from accounts where id = $1`, [accountId]);
}

export function billingEmails(rig: JobTestRig): readonly unknown[] {
  return rig.fakes.mailer.sent.filter((mail) => mail.kind === 'billing_inactive');
}

export function alertCodes(rig: BillingRig): string[] {
  return rig.alerts.map((alert) => alert.code);
}

/** A subscriptions row written directly (for states a checkout would not produce). */
export async function insertSubscription(
  db: Db,
  input: {
    accountId: string;
    providerId: string;
    status: string;
    createdAt: Date;
    shortUrl?: string | null;
    startAt?: Date | null;
    expireBy?: Date | null;
    graceUntil?: Date | null;
    lastSyncedAt?: Date | null;
    planId?: string;
  },
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `insert into subscriptions (account_id, provider_subscription_id, plan_id, status, status_changed_at, short_url, start_at, expire_by, grace_until, last_synced_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $5) returning id`,
    [
      input.accountId,
      input.providerId,
      input.planId ?? 'plan_fakeonly',
      input.status,
      input.createdAt,
      input.shortUrl ?? null,
      input.startAt ?? null,
      input.expireBy ?? null,
      input.graceUntil ?? null,
      input.lastSyncedAt ?? null,
    ],
  );
  return row.id;
}
