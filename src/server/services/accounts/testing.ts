import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SubscriptionStatus } from '@/server/domain/types';
import type { Db } from '@/server/db';
import type { FakeHubSpot } from '@/server/adapters/fake/hubspot';
import type { Deps } from '@/server/ports';
import { encryptTokens } from '@/server/services/hubspot/tokens';

// Test support for account, token and install tests (Vitest only; nothing in the app imports this).
// Builds on src/server/jobs/testing.ts (createJobTestRig, seedAccount, …).

/** Binds an owner: a `users` row and `accounts.owner_user_id`. Returns the auth user id. */
export async function seedOwner(db: Db, accountId: string, email = 'owner@brightside-plumbing.example', authUserId: string = randomUUID()): Promise<string> {
  await db.query(`insert into users (auth_user_id, account_id, email) values ($1, $2, $3)`, [authUserId, accountId, email]);
  await db.query(`update accounts set owner_user_id = $2 where id = $1`, [accountId, authUserId]);
  return authUserId;
}

export interface SeedSubscriptionInput {
  accountId: string;
  status: SubscriptionStatus;
  createdAt: Date;
  graceUntil?: Date | undefined;
}

export async function seedSubscription(db: Db, input: SeedSubscriptionInput): Promise<string> {
  const row = await db.one<{ id: string }>(
    `insert into subscriptions (account_id, provider_subscription_id, plan_id, status, status_changed_at, grace_until, created_at)
     values ($1, $2, 'plan_fakeonly', $3, $4, $5, $4) returning id`,
    [input.accountId, `sub_${randomUUID().replaceAll('-', '')}`, input.status, input.createdAt, input.graceUntil ?? null],
  );
  return row.id;
}

export async function setSubscriptionStatus(db: Db, subscriptionId: string, status: SubscriptionStatus, graceUntil: Date | null = null): Promise<void> {
  await db.query(`update subscriptions set status = $2, grace_until = $3 where id = $1`, [subscriptionId, status, graceUntil]);
}

export async function seedSelectedForm(db: Db, input: { accountId: string; formId: string; floor: Date }): Promise<void> {
  await db.query(
    `insert into selected_forms (account_id, form_id, form_name, form_type, intake_floor_at, cursor_submitted_at)
     values ($1, $2, 'Contact us', 'hubspot', $3, $3)`,
    [input.accountId, input.formId, input.floor],
  );
}

/**
 * An active connection holding real (encrypted) tokens from the fake portal, as the OAuth callback
 * would store them. `accessExpiresAt` defaults to the fake token's real expiry.
 */
export async function seedInstalledConnection(
  deps: Deps,
  hubspot: FakeHubSpot,
  input: { accountId: string; now: Date; accessExpiresAt?: Date | undefined },
): Promise<{ connectionId: string; portalId: string }> {
  const tokens = hubspot.installTokens();
  const connectionId = randomUUID();
  const encrypted = encryptTokens(deps.env, connectionId, tokens);
  const portalId = hubspot.portal.portalId;
  await deps.db.query(
    `insert into hubspot_connections
       (id, account_id, portal_id, scopes, access_token_enc, refresh_token_enc, access_expires_at, token_version, status, status_changed_at)
     values ($1, $2, $3, $4, $5, $6, $7, 1, 'active', $8)`,
    [
      connectionId,
      input.accountId,
      portalId,
      tokens.scopes ?? [],
      encrypted.accessTokenEnc,
      encrypted.refreshTokenEnc,
      input.accessExpiresAt ?? new Date(input.now.getTime() + tokens.expiresInSeconds * 1000),
      input.now,
    ],
  );
  await deps.db.query(`update accounts set hubspot_portal_id = $2 where id = $1`, [input.accountId, portalId]);
  return { connectionId, portalId };
}
