import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/server/db';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, seedAccount, seedConnection, seedLead, seedSettings, type JobTestRig } from '@/server/jobs/testing';
import { mintActionTokens } from '@/server/security/action-tokens';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { applyProcessingState, PURGE_AFTER_MS } from './apply-processing-state';
import { seedOwner, seedSelectedForm, seedSubscription, setSubscriptionStatus } from './testing';

const getDb = setUpTestDb();
const DAY = 86_400_000;

let rig: JobTestRig;

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
});

interface Account {
  accountId: string;
  connectionId: string;
}

/** An onboarded, owned account in its trial (ends 14 days after the rig's start). */
async function activeAccount(db: Db = getDb()): Promise<Account> {
  const now = rig.clock.now();
  const accountId = await seedAccount(db, { now });
  const connectionId = await seedConnection(db, { accountId, now });
  await seedSettings(db, { accountId, now });
  await seedOwner(db, accountId);
  return { accountId, connectionId };
}

async function accountRow(accountId: string) {
  return getDb().one<{
    processing_state: string;
    processing_state_changed_at: Date;
    entitlement_lost_at: Date | null;
    purge_after: Date | null;
    disconnected_at: Date | null;
  }>(`select processing_state, processing_state_changed_at, entitlement_lost_at, purge_after, disconnected_at from accounts where id = $1`, [
    accountId,
  ]);
}

async function setAccount(accountId: string, set: string, params: unknown[] = []): Promise<void> {
  await getDb().query(`update accounts set ${set} where id = $1`, [accountId, ...params]);
}

function billingEmails() {
  return rig.fakes.mailer.sent.filter((mail) => mail.kind === 'billing_inactive');
}

describe('applyProcessingState', () => {
  it('returns null for an account that does not exist (purged)', async () => {
    expect(await applyProcessingState(rig.deps, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('changes nothing when the derived state equals the stored one', async () => {
    const { accountId } = await activeAccount();
    const before = await accountRow(accountId);
    rig.clock.advance({ minutes: 5 });
    const result = await applyProcessingState(rig.deps, accountId);
    expect(result).toMatchObject({ previous: 'active', next: 'active', transitioned: false, entitled: true, entitlementLostAt: null });
    expect((await accountRow(accountId)).processing_state_changed_at).toEqual(before.processing_state_changed_at);
  });

  it('onboarding → active moves every form floor and cursor to now and clears the purge fields', async () => {
    const db = getDb();
    const start = rig.clock.now();
    const accountId = await seedAccount(db, { now: start, processingState: 'onboarding' });
    await seedConnection(db, { accountId, now: start });
    await seedOwner(db, accountId);
    await seedSelectedForm(db, { accountId, formId: 'form-a', floor: start });
    await seedSelectedForm(db, { accountId, formId: 'form-b', floor: start });
    await setAccount(accountId, 'purge_after = $2, disconnected_at = $2', [new Date(start.getTime() + 20 * DAY)]);

    rig.clock.advance({ minutes: 4, seconds: 30 });
    const completedAt = rig.clock.now();
    await setAccount(accountId, 'onboarding_completed_at = $2', [completedAt]);
    const result = await applyProcessingState(rig.deps, accountId);

    expect(result).toMatchObject({ previous: 'onboarding', next: 'active', transitioned: true });
    const forms = await db.query<{ intake_floor_at: Date; cursor_submitted_at: Date }>(
      `select intake_floor_at, cursor_submitted_at from selected_forms where account_id = $1`,
      [accountId],
    );
    expect(forms).toHaveLength(2);
    for (const form of forms) {
      expect(form.intake_floor_at).toEqual(completedAt);
      expect(form.cursor_submitted_at).toEqual(completedAt);
    }
    const row = await accountRow(accountId);
    expect(row).toMatchObject({ processing_state: 'active', purge_after: null, disconnected_at: null });
    expect(row.processing_state_changed_at).toEqual(completedAt);
  });

  it('active → paused cancels nothing and sends nothing', async () => {
    const { accountId } = await activeAccount();
    const job = await insertJob(getDb(), { kind: 'portal_poll', accountId, dedupeKey: `poll:${accountId}:1:a`, runAt: rig.clock.now(), now: rig.clock.now() });
    await setAccount(accountId, 'paused_at = $2', [rig.clock.now()]);
    const result = await applyProcessingState(rig.deps, accountId);
    expect(result).toMatchObject({ previous: 'active', next: 'paused', transitioned: true });
    expect((await getDb().one<{ status: string }>(`select status from scheduled_jobs where id = $1`, [job?.id])).status).toBe('scheduled');
    expect(rig.fakes.mailer.sent).toHaveLength(0);
  });

  it('→ inactive reserves and sends one billing-inactive email keyed by entitlement_lost_at', async () => {
    const { accountId } = await activeAccount();
    rig.clock.advance({ days: 14, minutes: 5 });
    const lostAt = rig.clock.now();
    const result = await applyProcessingState(rig.deps, accountId);

    expect(result).toMatchObject({ previous: 'active', next: 'inactive', transitioned: true, entitled: false, entitlementLostAt: lostAt });
    expect(billingEmails()).toHaveLength(1);
    const mail = billingEmails()[0];
    expect(mail?.to).toEqual(['owner@brightside-plumbing.example']);
    expect(mail?.replyTo).toBe(rig.deps.env.EMAIL_REPLY_TO);
    expect(mail?.idempotencyKey).toBe(`${rig.deps.env.ENV_NAMESPACE}:billing-inactive:${accountId}:${lostAt.toISOString()}`);
    expect(mail?.text).toContain('stopped drafting replies');
    const reservation = await getDb().one<{ status: string }>(`select status from notifications_sent where kind = 'billing_inactive'`);
    expect(reservation.status).toBe('sent');

    rig.clock.advance({ minutes: 5 });
    await applyProcessingState(rig.deps, accountId);
    expect(billingEmails()).toHaveLength(1);
  });

  it('pause → trial ends → resume sends exactly one billing-inactive email', async () => {
    const { accountId } = await activeAccount();
    await setAccount(accountId, 'paused_at = $2', [rig.clock.now()]);
    await applyProcessingState(rig.deps, accountId);

    rig.clock.advance({ days: 15 });
    const whilePaused = await applyProcessingState(rig.deps, accountId);
    expect(whilePaused).toMatchObject({ next: 'paused', transitioned: false, entitled: false });
    const lostAt = rig.clock.now();
    expect((await accountRow(accountId)).entitlement_lost_at).toEqual(lostAt);
    expect(billingEmails()).toHaveLength(0);

    rig.clock.advance({ days: 1 });
    await setAccount(accountId, 'paused_at = null');
    const resumed = await applyProcessingState(rig.deps, accountId);
    expect(resumed).toMatchObject({ previous: 'paused', next: 'inactive', transitioned: true, entitlementLostAt: lostAt });
    expect(billingEmails()).toHaveLength(1);

    // Pausing and resuming again inside the same non-entitled period sends nothing more.
    await setAccount(accountId, 'paused_at = $2', [rig.clock.now()]);
    await applyProcessingState(rig.deps, accountId);
    await setAccount(accountId, 'paused_at = null');
    await applyProcessingState(rig.deps, accountId);
    expect(billingEmails()).toHaveLength(1);
  });

  it('pending → grace ends → halted sends exactly one billing-inactive email', async () => {
    const { accountId } = await activeAccount();
    rig.clock.advance({ days: 20 });
    const graceUntil = new Date(rig.clock.now().getTime() + 3 * DAY);
    const subscriptionId = await seedSubscription(getDb(), { accountId, status: 'pending', createdAt: new Date(rig.clock.now().getTime() - 6 * DAY), graceUntil });
    expect(await applyProcessingState(rig.deps, accountId)).toMatchObject({ next: 'active', entitled: true });

    rig.clock.set(graceUntil);
    expect(await applyProcessingState(rig.deps, accountId)).toMatchObject({ next: 'inactive', transitioned: true, entitlementLostAt: graceUntil });
    expect(billingEmails()).toHaveLength(1);

    rig.clock.advance({ days: 2 });
    await setSubscriptionStatus(getDb(), subscriptionId, 'halted');
    expect(await applyProcessingState(rig.deps, accountId)).toMatchObject({ next: 'inactive', transitioned: false, entitlementLostAt: graceUntil });
    expect(billingEmails()).toHaveLength(1);
  });

  it('clears entitlement_lost_at when entitled again, so a later lapse sends a new email', async () => {
    const { accountId } = await activeAccount();
    rig.clock.advance({ days: 15 });
    await applyProcessingState(rig.deps, accountId);
    expect(billingEmails()).toHaveLength(1);

    rig.clock.advance({ days: 1 });
    const subscriptionId = await seedSubscription(getDb(), { accountId, status: 'active', createdAt: rig.clock.now() });
    expect(await applyProcessingState(rig.deps, accountId)).toMatchObject({ next: 'active', entitlementLostAt: null });
    expect((await accountRow(accountId)).entitlement_lost_at).toBeNull();

    rig.clock.advance({ days: 30 });
    await setSubscriptionStatus(getDb(), subscriptionId, 'halted');
    const lapsed = await applyProcessingState(rig.deps, accountId);
    expect(lapsed).toMatchObject({ next: 'inactive', transitioned: true, entitlementLostAt: rig.clock.now() });
    expect(billingEmails()).toHaveLength(2);
  });

  it('→ revoked sets purge_after to now + 30 d, cancels the jobs (QStash after commit) and revokes action tokens', async () => {
    const db = getDb();
    const { accountId, connectionId } = await activeAccount();
    const now = rig.clock.now();
    const job = await insertJob(db, { kind: 'portal_poll', accountId, dedupeKey: `poll:${accountId}:7:a`, runAt: now, now });
    await publishJobs(rig.deps, [job]);
    const published = await db.one<{ external_id: string }>(`select external_id from scheduled_jobs where id = $1`, [job?.id]);
    const leadId = await seedLead(db, { accountId, now });
    await mintActionTokens(db, { accountId, leadId, notificationKey: `notify:${leadId}:initial:r0`, purposes: ['send', 'dismiss'], now });

    rig.clock.advance({ hours: 1 });
    await db.query(`update hubspot_connections set status = 'revoked', status_changed_at = $2, access_token_enc = null, refresh_token_enc = null where id = $1`, [
      connectionId,
      rig.clock.now(),
    ]);
    const result = await applyProcessingState(rig.deps, accountId);

    expect(result).toMatchObject({ previous: 'active', next: 'revoked', transitioned: true });
    const row = await accountRow(accountId);
    expect(row.purge_after).toEqual(new Date(rig.clock.now().getTime() + PURGE_AFTER_MS));
    expect(row.disconnected_at).toBeNull();
    const jobRow = await db.one<{ status: string; cancel_reason: string }>(`select status, cancel_reason from scheduled_jobs where id = $1`, [job?.id]);
    expect(jobRow).toEqual({ status: 'cancelled', cancel_reason: 'revoked' });
    expect(rig.fakes.scheduler.cancelled).toContain(published.external_id);
    const tokens = await db.query<{ revoked_at: Date | null }>(`select revoked_at from action_tokens where account_id = $1`, [accountId]);
    expect(tokens).toHaveLength(2);
    expect(tokens.every((token) => token.revoked_at !== null)).toBe(true);
    expect(rig.fakes.mailer.sent).toHaveLength(0);
  });

  it('→ disconnected also records disconnected_at', async () => {
    const { accountId, connectionId } = await activeAccount();
    await getDb().query(`update hubspot_connections set status = 'disconnected', access_token_enc = null, refresh_token_enc = null where id = $1`, [connectionId]);
    const result = await applyProcessingState(rig.deps, accountId);
    expect(result).toMatchObject({ next: 'disconnected', transitioned: true });
    const row = await accountRow(accountId);
    expect(row.disconnected_at).toEqual(rig.clock.now());
    expect(row.purge_after).toEqual(new Date(rig.clock.now().getTime() + PURGE_AFTER_MS));
  });

  it('pause → revoke → reconnect stays paused, and resume then moves the floors at once', async () => {
    const db = getDb();
    const { accountId, connectionId } = await activeAccount();
    const installedAt = rig.clock.now();
    await seedSelectedForm(db, { accountId, formId: 'form-a', floor: installedAt });

    rig.clock.advance({ hours: 1 });
    await setAccount(accountId, 'paused_at = $2', [rig.clock.now()]);
    expect(await applyProcessingState(rig.deps, accountId)).toMatchObject({ next: 'paused' });

    rig.clock.advance({ hours: 1 });
    await db.query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null where id = $1`, [connectionId]);
    expect(await applyProcessingState(rig.deps, accountId)).toMatchObject({ previous: 'paused', next: 'revoked', transitioned: true });

    rig.clock.advance({ hours: 1 });
    await db.query(`update hubspot_connections set status = 'active', access_token_enc = $2, refresh_token_enc = $2 where id = $1`, [
      connectionId,
      'v1.0123abcd.aaaa.bbbb.cccc',
    ]);
    expect(await applyProcessingState(rig.deps, accountId)).toMatchObject({ previous: 'revoked', next: 'paused', transitioned: true });
    const whilePaused = await db.one<{ intake_floor_at: Date }>(`select intake_floor_at from selected_forms where account_id = $1`, [accountId]);
    expect(whilePaused.intake_floor_at).toEqual(installedAt);

    rig.clock.advance({ hours: 1 });
    const resumedAt = rig.clock.now();
    await setAccount(accountId, 'paused_at = null');
    expect(await applyProcessingState(rig.deps, accountId)).toMatchObject({ previous: 'paused', next: 'active', transitioned: true });
    const resumed = await db.one<{ intake_floor_at: Date; cursor_submitted_at: Date }>(
      `select intake_floor_at, cursor_submitted_at from selected_forms where account_id = $1`,
      [accountId],
    );
    expect(resumed).toEqual({ intake_floor_at: resumedAt, cursor_submitted_at: resumedAt });
  });

  it('sends no billing email to an account without a bound owner', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const accountId = await seedAccount(db, { now });
    await seedConnection(db, { accountId, now });
    rig.clock.advance({ days: 15 });
    expect(await applyProcessingState(rig.deps, accountId)).toMatchObject({ next: 'inactive', transitioned: true });
    expect(await db.query(`select 1 from notifications_sent`)).toHaveLength(0);
  });
});
