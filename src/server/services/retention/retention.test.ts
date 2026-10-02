import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransientError } from '@/server/domain/errors';
import type { Deps } from '@/server/ports';
import { claimOnce, hitFixedWindow, rateLimitKeyHash } from '@/server/security/rate-limit';
import { consumeBeacon, issueBeacon } from '@/server/services/action-links/beacon';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import { reserveAndSend } from '@/server/services/notifications/send';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { CONTENT_GONE, contentOf, createRetentionRig, DAY, MINUTE, seedInstalledAccount, seedLeadContent, type RetentionRig } from '../../../../test/retention/support';
import { catchUpOrphanedContent, purgeExpiredContent } from './content';
import { runDailyRetention } from './guard';
import { pruneExpiredRows, RATE_LIMIT_WINDOW_KEEP_MS } from './prune';

// The retention statements (PLAN §9.10 steps 1-3 and 7, D-31, D-36, D-49): one statement removes a
// lead's message, drafts and submission key together; the daily catch-all and the prunes.

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

describe('purgeExpiredContent', () => {
  it('also purges the drafts of a lead whose message it deletes, whatever their own purge_at', async () => {
    const db = getDb();
    const { accountId } = await seedInstalledAccount(rig);
    const lead = await seedLeadContent(db, { accountId, submittedAt: rig.clock.now() });
    await db.query(`update drafts set purge_at = $2 where lead_id = $1`, [lead.leadId, at(lead.purgeAt, 10 * DAY)]);
    expect(await purgeExpiredContent(db, lead.purgeAt)).toEqual({ leadMessagesDeleted: 1, draftsPurged: 2, submissionKeysCleared: 1 });
    expect(await contentOf(db, lead.leadId)).toEqual(CONTENT_GONE);
  });

  it('purges drafts past their own purge_at even while the message is kept', async () => {
    const db = getDb();
    const { accountId } = await seedInstalledAccount(rig);
    const lead = await seedLeadContent(db, { accountId, submittedAt: rig.clock.now() });
    await db.query(`update drafts set purge_at = $2 where lead_id = $1 and kind = 'fu1'`, [lead.leadId, at(rig.clock.now(), DAY)]);
    expect(await purgeExpiredContent(db, at(rig.clock.now(), DAY))).toEqual({ leadMessagesDeleted: 0, draftsPurged: 1, submissionKeysCleared: 0 });
    const content = await contentOf(db, lead.leadId);
    expect(content.message).toBe(true);
    expect(content.drafts.map((d) => d.purged)).toEqual([true, false]);
  });
});

describe('catchUpOrphanedContent', () => {
  it('clears drafts and keys of leads whose message is already gone, but keeps a privacy deletion’s random key', async () => {
    const db = getDb();
    const { accountId } = await seedInstalledAccount(rig);
    const now = rig.clock.now();
    const stray = await seedLeadContent(db, { accountId, submittedAt: now });
    const privacy = await seedLeadContent(db, { accountId, submittedAt: now });
    await db.query(`delete from lead_messages where lead_id = any($1::uuid[])`, [[stray.leadId, privacy.leadId]]);
    const randomKey = randomBytes(32).toString('hex');
    await db.query(`update leads set stop_reason = 'privacy_deletion', submission_key = $2 where id = $1`, [privacy.leadId, randomKey]);
    await db.query(`update drafts set subject = null, body = null, flags = '{}', purged_at = $2 where lead_id = $1`, [privacy.leadId, now]);

    expect(await catchUpOrphanedContent(db, now)).toEqual({ draftsPurged: 2, submissionKeysCleared: 1 });
    expect(await contentOf(db, stray.leadId)).toEqual(CONTENT_GONE);
    expect((await contentOf(db, privacy.leadId)).submissionKey).toBe(randomKey);
  });
});

describe('pruneExpiredRows (PLAN §9.10 step 7)', () => {
  it('prunes webhook events 30 days after the Clock recorded them, expired action tokens and AI calls after 13 months', async () => {
    const db = getDb();
    const { accountId } = await seedInstalledAccount(rig);
    const now = rig.clock.now();
    // The audit column (the database's wall clock) says the opposite on purpose: the prune follows
    // the logical recorded_at only (D-28, D-82).
    await db.query(
      `insert into webhook_events (provider, dedupe_key, recorded_at, received_at) values ('hubspot', 'old', $1, $3), ('hubspot', 'recent', $2, $4)`,
      [at(now, -30 * DAY - MINUTE), at(now, -29 * DAY), at(now, DAY), at(now, -400 * DAY)],
    );
    await db.query(
      `insert into action_tokens (token_hash, account_id, purpose, expires_at) values ($1, $3, 'verify_notify', $4), ($2, $3, 'verify_notify', $5)`,
      [randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), accountId, at(now, -MINUTE), at(now, MINUTE)],
    );
    await db.query(
      `insert into ai_calls (account_id, purpose, model, outcome, created_at) values ($1, 'draft', 'claude-sonnet-5-5', 'ok', $2), ($1, 'draft', 'claude-sonnet-5-5', 'ok', $3)`,
      [accountId, new Date('2025-09-06T13:59:00.000Z'), new Date('2025-09-06T14:01:00.000Z')],
    );
    expect(await pruneExpiredRows(db, rig.deps.env, now)).toEqual({
      webhookEventsDeleted: 1,
      actionTokensDeleted: 1,
      rateLimitRowsDeleted: 0,
      aiCallsDeleted: 1,
      devOutboxDeleted: 0,
    });
    expect(await db.query(`select dedupe_key from webhook_events`)).toEqual([{ dedupe_key: 'recent' }]);
  });

  it('in fake mode, prunes the dev outbox’s copies of emails 30 days after they were sent (law 4)', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const mail = (createdAt: Date, subject: string) =>
      db.query(`insert into fake.dev_outbox (created_at, "to", subject, html, text, kind, meta) values ($1, $2, $3, '<p>x</p>', 'x', 'new_lead', '{}')`, [
        createdAt,
        ['owner@brightside-plumbing.example'],
        subject,
      ]);
    await mail(at(now, -30 * DAY - MINUTE), 'old');
    await mail(at(now, -30 * DAY + MINUTE), 'recent');
    expect(rig.deps.env.APP_MODE).toBe('fake');
    expect(await pruneExpiredRows(db, rig.deps.env, now)).toMatchObject({ devOutboxDeleted: 1 });
    expect(await db.query(`select subject from fake.dev_outbox`)).toEqual([{ subject: 'recent' }]);
    // Live mode has no fake schema: the step is skipped.
    expect(await pruneExpiredRows(db, { ...rig.deps.env, APP_MODE: 'live' }, at(now, 10 * DAY))).toMatchObject({ devOutboxDeleted: 0 });
    expect(await db.query(`select subject from fake.dev_outbox`)).toEqual([{ subject: 'recent' }]);
  });

  it('prunes rate-limit windows two days after they started, the lead-page refresh markers included', async () => {
    const db = getDb();
    const now = rig.clock.now();
    const key = rateLimitKeyHash(rig.deps.env, 'lead_refresh_account:some-account');
    await hitFixedWindow(db, { keyHash: key, windowMs: 5 * MINUTE, now: at(now, -RATE_LIMIT_WINDOW_KEEP_MS - 5 * MINUTE) });
    await hitFixedWindow(db, { keyHash: key, windowMs: 5 * MINUTE, now: at(now, -DAY) });
    await claimOnce(db, { keyHash: rateLimitKeyHash(rig.deps.env, 'lead_refresh:some-lead'), windowStart: at(now, -3 * DAY) });
    expect(await pruneExpiredRows(db, rig.deps.env, now)).toMatchObject({ rateLimitRowsDeleted: 2 });
    expect(await db.query(`select count(*)::int as n from rate_limits`)).toEqual([{ n: 1 }]);
  });

  it('keeps a beacon nonce usable for its 15 minutes and prunes it later', async () => {
    const db = getDb();
    const tokenId = '11111111-1111-4111-8111-111111111111';
    const nonce = await issueBeacon(rig.deps, tokenId);
    await runDailyRetention(rig.deps);
    rig.clock.advance({ minutes: 10 });
    expect(await consumeBeacon(rig.deps, tokenId, nonce)).toBe(true);

    const unused = await issueBeacon(rig.deps, tokenId);
    rig.clock.advance({ days: 3 });
    await runDailyRetention(rig.deps);
    expect(await db.query(`select count(*)::int as n from rate_limits`)).toEqual([{ n: 0 }]);
    expect(await consumeBeacon(rig.deps, tokenId, unused)).toBe(false);
  });

  it('keeps the Resend monthly-quota marker for the month, so the alert still fires once per month', async () => {
    const db = getDb();
    const { accountId } = await seedInstalledAccount(rig);
    const quota: Deps = { ...rig.deps, mailer: { send: () => Promise.reject(new TransientError('monthly_quota_exceeded', { httpStatus: 429 })) } };
    const send = (id: string) =>
      reserveAndSend(quota, {
        kind: 'owner_alert',
        dedupeKey: NotificationKeys.ownerAlert(accountId, 'retention_test', id),
        accountId,
        predicates: NotificationPredicates.ownerAlert(),
        render: () => ({ to: ['owner@brightside-plumbing.example'], subject: 'Test', html: '<p>Test</p>', text: 'Test' }),
      });
    rig.clock.set(new Date('2026-10-02T10:00:00.000Z'));
    await expect(send('a')).rejects.toMatchObject({ code: 'monthly_quota_exceeded' });
    rig.clock.set(new Date('2026-10-20T10:00:00.000Z'));
    await runDailyRetention(rig.deps);
    await expect(send('b')).rejects.toMatchObject({ code: 'monthly_quota_exceeded' });
    expect(rig.alerts.filter((alert) => alert.code === 'resend_quota_exceeded')).toHaveLength(1);

    // The old marker goes once its month is over; a new month is a new episode.
    rig.clock.set(new Date('2026-11-03T10:00:00.000Z'));
    await runDailyRetention(rig.deps);
    expect(await db.query(`select count(*)::int as n from rate_limits`)).toEqual([{ n: 0 }]);
    await expect(send('c')).rejects.toMatchObject({ code: 'monthly_quota_exceeded' });
    expect(rig.alerts.filter((alert) => alert.code === 'resend_quota_exceeded')).toHaveLength(2);
  });
});

describe('runDailyRetention', () => {
  it('runs the content steps, the catch-all and the prunes, and answers counts only', async () => {
    const db = getDb();
    const { accountId } = await seedInstalledAccount(rig);
    const lead = await seedLeadContent(db, { accountId, submittedAt: rig.clock.now() });
    rig.clock.set(at(lead.purgeAt, MINUTE));
    const summary = await runDailyRetention(rig.deps);
    expect(summary).toMatchObject({ leadMessagesDeleted: 1, draftsPurged: 2, submissionKeysCleared: 1, actionTokensDeleted: 1, orphanedDraftsPurged: 0 });
    expect(Object.values(summary).every((value) => typeof value === 'number')).toBe(true);
  });
});
