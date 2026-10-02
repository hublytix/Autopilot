import { afterEach, beforeEach, vi } from 'vitest';
import type { Db } from '@/server/db';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import { seedAccount, seedSettings } from '@/server/jobs/testing';
import { mintActionTokens } from '@/server/security/action-tokens';
import { seedInstalledConnection, seedOwner, seedSelectedForm } from '@/server/services/accounts/testing';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth/owner-scope';
import { startCheckout } from '@/server/services/billing';
import { createLeadsRig, type LeadsRig } from '../leads/support';
import { deliverQueued } from '../billing/support';
import { seedNotifiedLead, type NotifiedLead } from '../owner-controls/support';

// Test support for the settings page and Disconnect (PLAN §7.5, §9.1 step 5): a rig with every fake
// (the lead-email registries, so follow-up jobs can be scheduled), an owned, onboarded, active
// account (New York) whose connection holds real tokens from the fake portal, and the rows a
// disconnect acts on: a notified lead with its two follow-up jobs, action tokens, a privacy deletion.

export const OWNER_EMAIL = 'owner@brightside-plumbing.example';
export const DAY = 24 * 60 * 60 * 1000;

export interface SettingsRig extends LeadsRig {
  /** Admin alerts raised during the test. */
  readonly alerts: RaisedAlert[];
  /** The limiter's wait: advances the FakeClock instead of sleeping. */
  readonly sleep: (ms: number) => Promise<void>;
}

/** Call at module level: a fresh rig per test, alerts captured, console quiet. */
export function setUpSettingsRig(getDb: () => Db): () => SettingsRig {
  let rig: SettingsRig | undefined;
  let stop: (() => void) | undefined;
  beforeEach(() => {
    for (const method of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
    const alerts: RaisedAlert[] = [];
    stop = onAlert((alert) => alerts.push(alert));
    const base = createLeadsRig(getDb());
    rig = {
      ...base,
      alerts,
      sleep: async (ms: number) => {
        base.clock.advance({ milliseconds: ms });
      },
    };
  });
  afterEach(() => {
    stop?.();
    vi.restoreAllMocks();
  });
  return () => {
    if (rig === undefined) throw new Error('settings rig used outside a test');
    return rig;
  };
}

export interface SettingsAccount {
  readonly accountId: string;
  readonly scope: OwnerScope;
  readonly connectionId: string;
  readonly portalId: string;
}

/**
 * An active, onboarded account (New York) with a bound owner, saved settings, the form `form-1`, and
 * a connection holding the fake portal's real tokens (only one account per test can hold them).
 */
export async function seedSettingsAccount(rig: SettingsRig, input: { email?: string; authUserId?: string; accessExpiresAt?: Date } = {}): Promise<SettingsAccount> {
  const db = rig.deps.db;
  const now = rig.clock.now();
  const accountId = await seedAccount(db, { now });
  await seedSettings(db, { accountId, now });
  await seedSelectedForm(db, { accountId, formId: 'form-1', floor: now });
  const userId = await seedOwner(db, accountId, input.email ?? OWNER_EMAIL, input.authUserId);
  const { connectionId, portalId } = await seedInstalledConnection(rig.deps, rig.fakes.hubspot, { accountId, now, accessExpiresAt: input.accessExpiresAt });
  return { accountId, scope: createOwnerScopeForTest(accountId, userId), connectionId, portalId };
}

export interface DisconnectFixtures {
  readonly lead: NotifiedLead;
  readonly privacyJobId: string;
}

/** A notified lead (two follow-up jobs), send/edit/dismiss tokens for it, and a scheduled privacy deletion. */
export async function seedDisconnectFixtures(rig: SettingsRig, accountId: string): Promise<DisconnectFixtures> {
  const db = rig.deps.db;
  const now = rig.clock.now();
  const lead = await seedNotifiedLead(rig, { accountId, firstNotifiedAt: now });
  await db.tx((tx) => mintActionTokens(tx, { accountId, leadId: lead.leadId, notificationKey: `notify:${lead.leadId}:initial:r0`, purposes: ['send', 'edit', 'dismiss'], now }));
  const job = await db.tx((tx) => insertJob(tx, { kind: 'privacy_delete', accountId, dedupeKey: `privacy:${accountId}:contact-1`, runAt: now, now }));
  if (job === null) throw new Error('privacy job not inserted');
  await publishJobs(rig.deps, [job]);
  return { lead, privacyJobId: job.id };
}

/** Starts a checkout and authorises it at Razorpay (the subscription is then `authenticated`). */
export async function subscribe(rig: SettingsRig, scope: OwnerScope): Promise<string> {
  await startCheckout(rig.deps, scope);
  const id = rig.fakes.billing.subscriptionIds().at(-1) ?? '';
  rig.fakes.billing.authenticate(id);
  await deliverQueued(rig);
  return id;
}

/** subscribe, then the trial ends and Razorpay charges: `active`. */
export async function subscribeAndPay(rig: SettingsRig, scope: OwnerScope): Promise<string> {
  const id = await subscribe(rig, scope);
  rig.clock.advance({ days: 14 });
  rig.fakes.billing.sync();
  await deliverQueued(rig);
  return id;
}

export interface ConnectionState {
  status: string;
  status_reason: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  access_expires_at: Date | null;
  token_version: number;
}

export async function connectionState(db: Db, accountId: string): Promise<ConnectionState> {
  return db.one<ConnectionState>(
    `select status, status_reason, access_token_enc, refresh_token_enc, access_expires_at, token_version from hubspot_connections where account_id = $1`,
    [accountId],
  );
}

export interface AccountState {
  processing_state: string;
  purge_after: Date | null;
  disconnected_at: Date | null;
  paused_at: Date | null;
}

export async function accountState(db: Db, accountId: string): Promise<AccountState> {
  return db.one<AccountState>(`select processing_state, purge_after, disconnected_at, paused_at from accounts where id = $1`, [accountId]);
}

/** Every job of the account: kind, status and cancel reason. */
export async function jobStates(db: Db, accountId: string): Promise<{ kind: string; status: string; cancel_reason: string | null }[]> {
  return db.query(`select kind, status, cancel_reason from scheduled_jobs where account_id = $1 order by kind, seq`, [accountId]);
}

export async function auditActions(db: Db, accountId: string | null): Promise<{ actor: string; action: string; meta: unknown }[]> {
  return db.query(`select actor, action, meta from audit_log where account_id is not distinct from $1 order by id`, [accountId]);
}
