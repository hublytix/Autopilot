import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRetentionGuard } from '@/server/http/cron-poll';
import { insertJob, publishJobs } from '@/server/jobs/outbox';
import { seedAccount, seedConnection } from '@/server/jobs/testing';
import { seedOwner } from '@/server/services/accounts/testing';
import { runDailyCron } from '@/server/services/daily';
import { disconnectOrphan, reconcileBillingTombstones } from '@/server/services/purge';
import { insertLead, leadContentPurgeAt } from '@/server/services/intake';
import { privacyDeleteJobHandler } from '@/server/services/privacy';
import { useTestDb as setUpTestDb } from '../db/harness';
import {
  accountRowCounts,
  alertCodes,
  bindAndActivate,
  CONTENT_GONE,
  contentOf,
  createRetentionRig,
  DAY,
  installNewPortal,
  installViaOAuth,
  MINUTE,
  OWNER_EMAIL,
  revokeNow,
  runDaily,
  seedInstalledAccount,
  seedLeadContent,
  seedSubscription,
  type RetentionRig,
} from './support';

// PLAN §9.10 step 8 and §12 "Retention purge" (D-48, D-49): content never outlives 30 d + 1 h (24 h
// for test data); a revoked account is purged 30 days later, its tombstones kept; a reconnect stops
// that; an orphan install is purged 7 days after its last install (a branch-(b) reinstall restarts
// the clock); live subscriptions are cancelled first, the ones the API cannot cancel are purged with
// a tombstone and an admin alert; the tombstone reconcile catches a tombstoned subscription that
// turns active with no webhook; an orphan purge never deletes another account's auth user; privacy
// deletions survive account-wide cancels.

const getDb = setUpTestDb();
let rig: RetentionRig;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createRetentionRig(getDb());
});

afterEach(() => {
  rig.stop();
  vi.useRealTimers();
});

function at(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

async function tombstone(id: string): Promise<{ last_status: string; resolved_at: Date | null; last_checked_at: Date | null } | null> {
  return getDb().maybeOne(`select last_status, resolved_at, last_checked_at from billing_tombstones where provider_subscription_id = $1`, [id]);
}

async function portalHistory(portalId: string): Promise<boolean> {
  return (await getDb().maybeOne(`select 1 as present from portal_history where hubspot_portal_id = $1`, [portalId])) !== null;
}

function authUserExists(userId: string): boolean {
  return rig.fakes.auth.users().some((user) => user.userId === userId);
}

describe('content retention (PLAN §9.10 steps 1-4)', () => {
  it('leaves no content of a lead older than 30 d + 1 h: the 5-minute guard removes it once purge_at is reached', async () => {
    const db = getDb();
    const { accountId } = await seedInstalledAccount(rig);
    const start = rig.clock.now();
    const old = await seedLeadContent(db, { accountId, submittedAt: start });
    const recent = await seedLeadContent(db, { accountId, submittedAt: at(start, 2 * DAY) });

    rig.clock.set(at(old.purgeAt, -MINUTE));
    expect(await runRetentionGuard(rig.deps)).toEqual({ ran: false });
    expect((await contentOf(db, old.leadId)).message).toBe(true);

    rig.clock.set(old.purgeAt);
    expect(await runRetentionGuard(rig.deps)).toMatchObject({ ran: true, leadMessagesDeleted: 1, draftsPurged: 2, submissionKeysCleared: 1 });
    expect(await contentOf(db, old.leadId)).toEqual(CONTENT_GONE);
    // Ids, timestamps and statuses stay (law 4).
    expect(await db.one(`select processing_state, first_notified_at from leads where id = $1`, [old.leadId])).toMatchObject({ processing_state: 'notified' });
    expect((await contentOf(db, recent.leadId)).message).toBe(true);

    rig.clock.set(at(old.purgeAt, 60 * MINUTE));
    expect(await runRetentionGuard(rig.deps)).toEqual({ ran: false });
    rig.clock.set(at(recent.purgeAt, 5 * MINUTE));
    expect(await runRetentionGuard(rig.deps)).toMatchObject({ ran: true, leadMessagesDeleted: 1 });
    expect(await contentOf(db, recent.leadId)).toEqual(CONTENT_GONE);
  });

  it('never keeps content more than 30 d after it was stored, even when HubSpot reports a submittedAt in the future', async () => {
    const db = getDb();
    const { accountId } = await seedInstalledAccount(rig);
    const stored = rig.clock.now();
    const inserted = await insertLead(db, {
      accountId,
      contactId: '9901',
      formId: 'form-future',
      submittedAt: at(stored, DAY),
      conversionId: null,
      submissionKey: 'future-submission-key',
      trigger: 'cron',
      content: { email: 'future.lead@example.net', firstName: 'Fern', lastName: null, company: null, message: 'A message from tomorrow' },
      now: stored,
    });
    if (inserted === null) throw new Error('lead not inserted');
    const row = await db.one<{ purge_at: Date }>(`select purge_at from lead_messages where lead_id = $1`, [inserted.leadId]);
    expect(row.purge_at).toEqual(at(stored, 30 * DAY));
    expect(leadContentPurgeAt(at(stored, -DAY), stored)).toEqual(at(stored, 29 * DAY));

    rig.clock.set(at(stored, 30 * DAY));
    expect(await runRetentionGuard(rig.deps)).toMatchObject({ ran: true, leadMessagesDeleted: 1 });
    expect((await contentOf(db, inserted.leadId)).message).toBe(false);
  });

  it('removes test-lead content and the inbox check test address after 24 h, closing an abandoned check', async () => {
    const db = getDb();
    const { accountId } = await seedInstalledAccount(rig);
    const start = rig.clock.now();
    const test = await seedLeadContent(db, { accountId, submittedAt: start, isTest: true });
    await db.query(
      `insert into inbox_checks (account_id, test_address, test_address_hmac, test_lead_id, created_at) values ($1, 'owner.personal@example.net', $2, $3, $4)`,
      [accountId, randomBytes(32).toString('hex'), test.leadId, start],
    );

    rig.clock.set(at(start, DAY - MINUTE));
    expect(await runRetentionGuard(rig.deps)).toEqual({ ran: false });

    rig.clock.set(at(start, DAY));
    expect(await runRetentionGuard(rig.deps)).toMatchObject({ ran: true, leadMessagesDeleted: 1, draftsPurged: 2, testAddressesCleared: 1, inboxChecksClosed: 1 });
    expect(await contentOf(db, test.leadId)).toEqual({ ...CONTENT_GONE, submissionKey: null });
    expect(await db.one(`select test_address, status, test_address_hmac is not null as hmac_kept from inbox_checks where account_id = $1`, [accountId])).toEqual({
      test_address: null,
      status: 'closed',
      hmac_kept: true,
    });
  });

  it('deletes login intents a day after they expire', async () => {
    const db = getDb();
    const { accountId } = await seedInstalledAccount(rig);
    const start = rig.clock.now();
    for (const [hash, expiresAt] of [
      ['a'.repeat(64), at(start, -DAY - MINUTE)],
      ['b'.repeat(64), at(start, -DAY + MINUTE)],
      ['c'.repeat(64), at(start, 60 * MINUTE)],
    ] as const) {
      await db.query(`insert into login_intents (token_hash_sha256, purpose, account_id, next, expires_at, created_at) values ($1, 'login', $2, '/dashboard', $3, $4)`, [
        hash,
        accountId,
        expiresAt,
        at(expiresAt, -60 * MINUTE),
      ]);
    }
    expect(await runRetentionGuard(rig.deps)).toMatchObject({ ran: true, loginIntentsDeleted: 1 });
    expect((await db.query<{ h: string }>(`select left(token_hash_sha256, 1) as h from login_intents order by 1`)).map((row) => row.h)).toEqual(['b', 'c']);
  });
});

describe('account purge (PLAN §9.10 step 5)', () => {
  it('purges a revoked account 30 days after the revoke: every row gone, the owner auth user deleted, the trial tombstone kept', async () => {
    const db = getDb();
    const account = await seedInstalledAccount(rig);
    const lead = await seedLeadContent(db, { accountId: account.accountId, submittedAt: rig.clock.now() });

    await revokeNow(rig, account.accountId);
    const revokedAt = rig.clock.now();
    expect(await db.one(`select processing_state, purge_after from accounts where id = $1`, [account.accountId])).toEqual({
      processing_state: 'revoked',
      purge_after: at(revokedAt, 30 * DAY),
    });
    expect(rig.fakes.mailer.sent.map((mail) => mail.kind)).toContain('reconnect');

    rig.clock.set(at(revokedAt, 30 * DAY - MINUTE));
    expect((await runDaily(rig, account.accountId)).purge).toEqual({ status: 'not_due' });

    rig.clock.set(at(revokedAt, 30 * DAY + MINUTE));
    const result = await runDaily(rig, account.accountId);
    expect(result.purge).toMatchObject({ status: 'purged', authUser: 'deleted', tombstones: 0 });
    expect(result.failures).toEqual([]);
    expect(Object.values(await accountRowCounts(db, account.accountId)).every((count) => count === 0)).toBe(true);
    expect(await contentOf(db, lead.leadId)).toEqual({ message: false, submissionKey: null, drafts: [] });
    expect(authUserExists(account.ownerUserId)).toBe(false);
    expect(await portalHistory(account.portalId)).toBe(true);
  });

  it('does not purge an account revoked and then reconnected by its owner', async () => {
    const db = getDb();
    const accountId = await installNewPortal(rig);
    const ownerUserId = await bindAndActivate(rig, accountId);
    await revokeNow(rig, accountId);

    rig.clock.advance({ days: 10 });
    const reconnect = await installViaOAuth(rig, { userId: ownerUserId, email: OWNER_EMAIL });
    expect(reconnect).toEqual({ type: 'reconnected', accountId });
    expect(await db.one(`select processing_state, purge_after from accounts where id = $1`, [accountId])).toEqual({ processing_state: 'active', purge_after: null });

    rig.clock.advance({ days: 21 });
    expect((await runDaily(rig, accountId)).purge).toEqual({ status: 'not_due' });
    expect((await accountRowCounts(db, accountId)).accounts).toBe(1);
    expect(authUserExists(ownerUserId)).toBe(true);
  });

  it('uninstalls and purges an orphan install 7 days after its last install', async () => {
    const db = getDb();
    const accountId = await installNewPortal(rig);
    const installedAt = rig.clock.now();
    const portalId = rig.hubspot.portal.portalId;

    rig.clock.set(at(installedAt, 7 * DAY - MINUTE));
    const early = await runDaily(rig, accountId);
    expect(early).toMatchObject({ orphan: 'not_orphan', purge: { status: 'not_due' } });
    expect(rig.hubspot.isInstalled()).toBe(true);

    rig.clock.set(at(installedAt, 7 * DAY + MINUTE));
    const result = await runDaily(rig, accountId);
    expect(result).toMatchObject({ orphan: 'disconnected', purge: { status: 'purged', authUser: 'none' }, failures: [] });
    expect(rig.hubspot.isInstalled()).toBe(false);
    expect((await accountRowCounts(db, accountId)).accounts).toBe(0);
    expect(await portalHistory(portalId)).toBe(true);
  });

  it('restarts the orphan clock on a branch-(b) reinstall: reinstalled on day 6, kept on day 7, purged on day 13', async () => {
    const db = getDb();
    const accountId = await installNewPortal(rig);
    const installedAt = rig.clock.now();

    rig.clock.set(at(installedAt, 6 * DAY));
    const reinstall = await installViaOAuth(rig);
    expect(reinstall).toMatchObject({ type: 'onboarding', branch: 'unbound', accountId });

    rig.clock.set(at(installedAt, 7 * DAY + MINUTE));
    expect(await runDaily(rig, accountId)).toMatchObject({ orphan: 'not_orphan', purge: { status: 'not_due' } });
    expect((await accountRowCounts(db, accountId)).accounts).toBe(1);
    expect(await db.one(`select status from hubspot_connections where account_id = $1`, [accountId])).toEqual({ status: 'active' });

    rig.clock.set(at(installedAt, 13 * DAY + MINUTE));
    expect(await runDaily(rig, accountId)).toMatchObject({ orphan: 'disconnected', purge: { status: 'purged' } });
    expect((await accountRowCounts(db, accountId)).accounts).toBe(0);
  });

  it('cancels a live subscription before anything is deleted, and keeps a resolved tombstone', async () => {
    const db = getDb();
    const account = await seedInstalledAccount(rig);
    const subscriptionId = await seedSubscription(rig, account.accountId, 'active');
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });

    // The cancel fails (and a fresh fetch still says active): nothing is deleted, the job retries.
    rig.billing.injectFailure('cancelSubscription', 'transient', 1);
    const failed = await runDaily(rig, account.accountId);
    expect(failed.failures).toEqual([{ step: 'purge', code: 'purge_subscription_cancel_failed', retryable: true }]);
    expect((await accountRowCounts(db, account.accountId)).accounts).toBe(1);
    expect(authUserExists(account.ownerUserId)).toBe(true);
    expect(await tombstone(subscriptionId)).toBeNull();

    const result = await runDaily(rig, account.accountId);
    expect(result.purge).toMatchObject({ status: 'purged', cancelledSubscriptions: 1, tombstones: 1 });
    expect((await rig.billing.fetchSubscription(subscriptionId)).status).toBe('cancelled');
    expect(await tombstone(subscriptionId)).toMatchObject({ last_status: 'cancelled', resolved_at: rig.clock.now() });
    expect(alertCodes(rig)).not.toContain('billing_purge_cancel_in_dashboard');
    expect(authUserExists(account.ownerUserId)).toBe(false);
  });

  it.each(['paused', 'pending', 'halted'] as const)('purges an account whose subscription is %s, with an open tombstone and an admin alert', async (status) => {
    const db = getDb();
    const account = await seedInstalledAccount(rig);
    const subscriptionId = await seedSubscription(rig, account.accountId, status);
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });

    const result = await runDaily(rig, account.accountId);
    expect(result.purge).toMatchObject({ status: 'purged', cancelledSubscriptions: 0, tombstones: 1 });
    expect((await accountRowCounts(db, account.accountId)).accounts).toBe(0);
    expect(await tombstone(subscriptionId)).toMatchObject({ last_status: status, resolved_at: null });
    const alert = rig.alerts.find((raised) => raised.code === 'billing_purge_cancel_in_dashboard');
    expect(alert?.fields).toEqual({ subscriptionId, status });
    expect((await rig.billing.fetchSubscription(subscriptionId)).status).toBe(status);
  });

  it('never deletes, in an orphan purge, an auth user that owns another account or is pending on one', async () => {
    const db = getDb();
    const orphan = await installNewPortal(rig);
    const installedAt = rig.clock.now();
    // The orphan's email step created this user; it now owns another account.
    const { userId: owner } = await rig.fakes.auth.createUser('shared@brightside-plumbing.example');
    await db.query(`update accounts set pending_owner_email = 'shared@brightside-plumbing.example', pending_owner_expires_at = $2, pending_owner_auth_user_id = $3 where id = $1`, [
      orphan,
      at(installedAt, DAY),
      owner,
    ]);
    const other = await seedAccount(db, { now: installedAt });
    await seedConnection(db, { accountId: other, now: installedAt });
    await seedOwner(db, other, 'shared@brightside-plumbing.example', owner);

    rig.clock.set(at(installedAt, 7 * DAY + MINUTE));
    expect(await runDaily(rig, orphan)).toMatchObject({ orphan: 'disconnected', purge: { status: 'purged', authUser: 'kept' } });
    expect(authUserExists(owner)).toBe(true);
    expect((await accountRowCounts(db, other)).users).toBe(1);
  });

  it('keeps, in an orphan purge, a pending auth user another unbound install is waiting on, and deletes one nobody else refers to', async () => {
    const db = getDb();
    const orphan = await installNewPortal(rig);
    const installedAt = rig.clock.now();
    const { userId: pending } = await rig.fakes.auth.createUser('pending@brightside-plumbing.example');
    await db.query(`update accounts set pending_owner_email = 'pending@brightside-plumbing.example', pending_owner_expires_at = $2, pending_owner_auth_user_id = $3 where id = $1`, [
      orphan,
      at(installedAt, DAY),
      pending,
    ]);
    const other = await seedAccount(db, { now: installedAt, processingState: 'onboarding' });
    await db.query(`update accounts set pending_owner_auth_user_id = $2 where id = $1`, [other, pending]);

    rig.clock.set(at(installedAt, 7 * DAY + MINUTE));
    expect(await runDaily(rig, orphan)).toMatchObject({ purge: { status: 'purged', authUser: 'kept' } });
    expect(authUserExists(pending)).toBe(true);

    // Once nothing else refers to it, the other install's own purge deletes it.
    await db.query(`update accounts set last_install_at = $2 where id = $1`, [other, installedAt]);
    expect(await runDaily(rig, other)).toMatchObject({ orphan: 'disconnected', purge: { status: 'purged', authUser: 'deleted' } });
    expect(authUserExists(pending)).toBe(false);
  });
});

describe('billing tombstones (PLAN §9.10 step 6)', () => {
  it('cancels a tombstoned pending subscription that turned active with no webhook, and resolves it', async () => {
    const account = await seedInstalledAccount(rig);
    const subscriptionId = await seedSubscription(rig, account.accountId, 'pending');
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    await runDaily(rig, account.accountId);
    expect(await tombstone(subscriptionId)).toMatchObject({ last_status: 'pending', resolved_at: null });

    // The customer updates the card at Razorpay; the webhook never arrives.
    rig.billing.activate(subscriptionId);
    rig.billing.takeWebhooks();
    rig.clock.advance({ days: 1 });
    const summary = await runDailyCron(rig.deps);
    expect(summary.tombstones).toMatchObject({ checked: 1, cancelled: 1 });
    expect((await rig.billing.fetchSubscription(subscriptionId)).status).toBe('cancelled');
    expect(await tombstone(subscriptionId)).toMatchObject({ last_status: 'cancelled', resolved_at: rig.clock.now() });
    expect(alertCodes(rig)).toContain('billing_tombstone_cancelled_refund');
  });

  it('reaches it within 2 runs with 60 unresolvable tombstones ahead of it', async () => {
    const db = getDb();
    const purgedEarlier = at(rig.clock.now(), -DAY);
    for (let i = 0; i < 60; i += 1) {
      const sub = await rig.billing.createSubscription({
        planId: rig.deps.env.RAZORPAY_PLAN_ID,
        totalCount: 120,
        quantity: 1,
        customerNotify: true,
        expireBy: at(rig.clock.now(), 7 * DAY),
        notes: {},
      });
      rig.billing.authenticate(sub.id);
      rig.billing.failPayment(sub.id);
      await db.query(`insert into billing_tombstones (provider_subscription_id, last_status, purged_at) values ($1, 'pending', $2)`, [sub.id, purgedEarlier]);
    }
    rig.billing.takeWebhooks();
    const account = await seedInstalledAccount(rig);
    const subscriptionId = await seedSubscription(rig, account.accountId, 'pending');
    await revokeNow(rig, account.accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    await runDaily(rig, account.accountId);
    rig.billing.activate(subscriptionId);
    rig.billing.takeWebhooks();

    // The next daily runs: the never-checked tombstones come first, then the least recently checked.
    rig.clock.advance({ days: 1 });
    const first = await reconcileBillingTombstones(rig.deps);
    expect(first).toMatchObject({ checked: 50, open: 50, cancelled: 0 });
    expect(await tombstone(subscriptionId)).toMatchObject({ resolved_at: null });
    rig.clock.advance({ days: 1 });
    const second = await reconcileBillingTombstones(rig.deps);
    expect(second).toMatchObject({ checked: 50, open: 49, cancelled: 1 });
    expect(await tombstone(subscriptionId)).toMatchObject({ last_status: 'cancelled' });
    expect((await tombstone(subscriptionId))?.resolved_at).not.toBeNull();
  });

  it('leaves a tombstone whose fetch failed transiently first in line for the next day, and rotates one Razorpay refuses', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const sub = await rig.billing.createSubscription({ planId: rig.deps.env.RAZORPAY_PLAN_ID, totalCount: 120, quantity: 1, customerNotify: true, expireBy: at(now, 7 * DAY), notes: {} });
    await db.query(`insert into billing_tombstones (provider_subscription_id, last_status, purged_at) values ($1, 'created', $2)`, [sub.id, at(now, -DAY)]);
    // Razorpay answers 400 for an id it does not know.
    await db.query(`insert into billing_tombstones (provider_subscription_id, last_status, purged_at) values ('sub_Unknown000000x', 'pending', $1)`, [now]);

    rig.billing.injectFailure('fetchSubscription', 'transient', 1);
    const summary = await reconcileBillingTombstones(rig.deps);
    expect(summary).toMatchObject({ checked: 2, failed: 2 });
    expect(await tombstone('sub_Unknown000000x')).toMatchObject({ last_checked_at: now, resolved_at: null });
    expect(await tombstone(sub.id)).toMatchObject({ last_checked_at: null, resolved_at: null });

    // A `created` link past its expire_by can no longer be authorised: resolved.
    rig.clock.advance({ days: 8 });
    await reconcileBillingTombstones(rig.deps, { limit: 1 });
    expect((await tombstone(sub.id))?.resolved_at).not.toBeNull();
  });
});

describe('privacy deletions survive account-wide cancels (D-06)', () => {
  it('keeps a privacy_delete job scheduled through the revoke, and it still removes the contact content', async () => {
    const db = getDb();
    rig.registry.register('privacy_delete', privacyDeleteJobHandler);
    const account = await seedInstalledAccount(rig);
    const lead = await seedLeadContent(db, { accountId: account.accountId, submittedAt: rig.clock.now(), contactId: '9001' });
    const rows = await db.tx(async (tx) => [
      await insertJob(tx, { kind: 'privacy_delete', accountId: account.accountId, dedupeKey: `privacy:${account.portalId}:9001:1`, payload: { contactId: '9001' }, runAt: at(rig.clock.now(), MINUTE), now: rig.clock.now() }),
      await insertJob(tx, { kind: 'followup', accountId: account.accountId, leadId: lead.leadId, dedupeKey: `lead:${lead.leadId}:fu:1:s0`, payload: { leadId: lead.leadId, n: 1, followupStream: 0 }, runAt: at(rig.clock.now(), 2 * DAY), now: rig.clock.now(), seq: 1 }),
    ]);
    await publishJobs(rig.deps, rows);

    await revokeNow(rig, account.accountId);
    const jobs = await db.query<{ kind: string; status: string; cancel_reason: string | null }>(
      `select kind, status, cancel_reason from scheduled_jobs where account_id = $1 and kind in ('privacy_delete', 'followup') order by kind`,
      [account.accountId],
    );
    expect(jobs).toEqual([
      { kind: 'followup', status: 'cancelled', cancel_reason: 'revoked' },
      { kind: 'privacy_delete', status: 'scheduled', cancel_reason: null },
    ]);

    rig.clock.advance({ minutes: 2 });
    await rig.fakes.scheduler.runDue();
    expect(await db.one(`select status from scheduled_jobs where kind = 'privacy_delete'`)).toEqual({ status: 'done' });
    expect((await contentOf(db, lead.leadId)).message).toBe(false);
  });

  it('keeps it through an orphan disconnect too', async () => {
    const db = getDb();
    const orphan = await installNewPortal(rig);
    const portalId = rig.hubspot.portal.portalId;
    const [row] = await db.tx(async (tx) => [
      await insertJob(tx, { kind: 'privacy_delete', accountId: orphan, dedupeKey: `privacy:${portalId}:9002:1`, payload: { contactId: '9002' }, runAt: at(rig.clock.now(), 8 * DAY), now: rig.clock.now() }),
    ]);
    await publishJobs(rig.deps, [row ?? null]);
    // The orphan step's disconnect is an account-wide cancel; this checks it before the purge deletes the account.
    rig.clock.advance({ days: 7, minutes: 1 });
    expect(await disconnectOrphan(rig.deps, orphan, { sleep: rig.sleep })).toBe('disconnected');
    expect(await db.one(`select status from scheduled_jobs where kind = 'privacy_delete'`)).toEqual({ status: 'scheduled' });
  });
});
