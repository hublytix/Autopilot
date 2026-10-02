import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyConflictError, TransientError } from '@/server/domain/errors';
import type { NotificationKind } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { onAlert, type RaisedAlert } from '@/server/jobs/alert';
import { insertJob } from '@/server/jobs/outbox';
import { createJobRegistry } from '@/server/jobs/registry';
import { createJobTestRig, seedAccount, seedActiveAccount, seedConnection, seedLead, seedSettings, type JobTestRig } from '@/server/jobs/testing';
import type { Deps, Mailer } from '@/server/ports';
import { hashActionToken, verifyActionToken, type MintedTokens } from '@/server/security/action-tokens';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { interceptBefore } from '../../../../test/db/intercept';
import { NotificationKeys, NotificationPredicates, type NotificationPredicate } from './predicates';
import { createNotificationRegistry, type NotificationRegistry } from './renderers';
import { getNotification, reserveInTx, takeOver } from './reserve';
import { reserveAndSend, resumeReservation, sendReserved } from './send';
import type { RenderedMail, ReserveAndSendInput } from './types';

const getDb = setUpTestDb();

let rig: JobTestRig;
let alerts: RaisedAlert[];
let stopAlerts: () => void;
let registry: NotificationRegistry;

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  registry = createNotificationRegistry();
  alerts = [];
  stopAlerts = onAlert((alert) => alerts.push(alert));
});

afterEach(() => {
  stopAlerts();
});

function render(subject: string) {
  return (tokens: MintedTokens): RenderedMail => ({
    to: ['owner@example.com'],
    replyTo: 'owner@example.com',
    subject,
    html: `<p>${subject}</p><a href="https://app.example/a/${tokens.send ?? 'none'}/send">Send from my email</a>`,
    text: `${subject}\nSend from my email: https://app.example/a/${tokens.send ?? 'none'}/send`,
    tags: [{ name: 'lead', value: 'L1' }],
  });
}

interface LeadSetup {
  accountId: string;
  leadId: string;
  key: string;
}

async function activeLead(): Promise<LeadSetup> {
  const db = getDb();
  const now = rig.deps.clock.now();
  const { accountId } = await seedActiveAccount(db, now);
  const leadId = await seedLead(db, { accountId, now });
  return { accountId, leadId, key: NotificationKeys.initial(leadId, 0) };
}

function initialSend(setup: LeadSetup, kind: 'new_lead' | 'needs_touch', overrides: Partial<ReserveAndSendInput> = {}): ReserveAndSendInput {
  return {
    kind,
    dedupeKey: setup.key,
    accountId: setup.accountId,
    leadId: setup.leadId,
    predicates: NotificationPredicates.initial({ accountId: setup.accountId, leadId: setup.leadId }),
    buttons: ['send', 'edit', 'dismiss'],
    render: render(kind === 'new_lead' ? 'New lead: Asha — your reply is ready' : 'New lead — needs your touch'),
    ...overrides,
  };
}

async function tokenRows(db: Db, key: string): Promise<{ token_hash: string; purpose: string; revoked_at: Date | null }[]> {
  return db.query(`select token_hash, purpose, revoked_at from action_tokens where notification_key = $1 order by purpose`, [key]);
}

describe('reserveAndSend', () => {
  it('reserves, mints tokens, sends once with the namespaced idempotency key and commits sent with onSent', async () => {
    const { deps, fakes } = rig;
    const setup = await activeLead();
    const result = await reserveAndSend(
      deps,
      initialSend(setup, 'new_lead', {
        onSent: async (tx, providerMessageId) => {
          expect(providerMessageId).not.toBeNull();
          await tx.query(`update leads set first_notified_at = $2, processing_state = 'notified' where id = $1`, [setup.leadId, deps.clock.now()]);
          const now = deps.clock.now();
          return [
            await insertJob(tx, {
              kind: 'followup',
              accountId: setup.accountId,
              leadId: setup.leadId,
              dedupeKey: `lead:${setup.leadId}:fu:1:s0`,
              runAt: new Date(now.getTime() + 2 * 86_400_000),
              now,
              seq: 1,
            }),
          ];
        },
      }),
    );
    expect(result).toMatchObject({ status: 'sent', viaIdempotencyConflict: false });
    expect(fakes.mailer.sent).toHaveLength(1);
    const mail = fakes.mailer.sent[0];
    expect(mail?.idempotencyKey).toBe(`fake-local:${setup.key}`);
    expect(mail?.tags).toEqual([
      { name: 'kind', value: 'new_lead' },
      { name: 'lead', value: 'L1' },
    ]);
    expect(await getNotification(deps.db, setup.key)).toMatchObject({
      status: 'sent',
      kind: 'new_lead',
      sendAttempts: 1,
      recipientsCount: 1,
      providerMessageId: mail?.providerMessageId,
      sentAt: deps.clock.now(),
    });
    expect((await tokenRows(deps.db, setup.key)).map((t) => t.purpose)).toEqual(['dismiss', 'edit', 'send']);
    expect(await deps.db.one(`select processing_state from leads where id = $1`, [setup.leadId])).toEqual({ processing_state: 'notified' });
    // The follow-up row from onSent was published after commit.
    expect(fakes.scheduler.pending().map((m) => m.dedupeId)).toEqual([`fake-local:lead:${setup.leadId}:fu:1:s0`]);
    // Only `sent` blocks: a second call sends nothing.
    expect(await reserveAndSend(deps, initialSend(setup, 'new_lead'))).toEqual({ status: 'already_sent' });
    expect(fakes.mailer.sent).toHaveLength(1);
  });

  it('commits the button tokens before the email is sent', async () => {
    const db = getDb();
    const seen: string[][] = [];
    rig = createJobTestRig(db, createJobRegistry(), {
      mailSink: {
        kind: 'callback',
        deliver: async (mail) => {
          const token = /\/a\/(apt_[A-Za-z0-9_-]{43})\/send/.exec(mail.text)?.[1] ?? '';
          const verified = await verifyActionToken(db, token, 'send', rig.deps.clock.now());
          seen.push([String(verified.ok), hashActionToken(token)]);
        },
      },
    });
    const setup = await activeLead();
    await reserveAndSend(rig.deps, initialSend(setup, 'new_lead'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe('true');
  });

  it('skips without a row when a predicate fails (the lead was dismissed while drafting)', async () => {
    const { deps, fakes } = rig;
    const setup = await activeLead();
    await deps.db.query(`update leads set dismissed_at = $2 where id = $1`, [setup.leadId, deps.clock.now()]);
    expect(await reserveAndSend(deps, initialSend(setup, 'new_lead'))).toEqual({ status: 'skipped', reason: 'predicates' });
    expect(await getNotification(deps.db, setup.key)).toBeNull();
    expect(fakes.mailer.sent).toEqual([]);
  });

  it('a Resend 500 leaves the row sending and throws; the retry sends exactly one email', async () => {
    const { deps, fakes } = rig;
    const setup = await activeLead();
    fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    await expect(reserveAndSend(deps, initialSend(setup, 'new_lead'))).rejects.toBeInstanceOf(TransientError);
    expect(await getNotification(deps.db, setup.key)).toMatchObject({ status: 'sending', sendAttempts: 1 });
    rig.clock.advance({ seconds: 10 });
    expect(await reserveAndSend(deps, initialSend(setup, 'new_lead'))).toMatchObject({ status: 'sent' });
    expect(fakes.mailer.sent).toHaveLength(1);
    expect(await getNotification(deps.db, setup.key)).toMatchObject({ status: 'sent', sendAttempts: 2, sweeperResumes: 0 });
    // A resumed reservation mints fresh tokens and leaves the earlier ones valid.
    const tokens = await tokenRows(deps.db, setup.key);
    expect(tokens).toHaveLength(6);
    expect(tokens.every((t) => t.revoked_at === null)).toBe(true);
  });

  it('needs-touch takes over an unsent new-lead reservation: exactly one email', async () => {
    const { deps, fakes } = rig;
    const setup = await activeLead();
    fakes.mailer.injectFailure({ kind: 'transient', code: 'rate_limit_exceeded' });
    await expect(reserveAndSend(deps, initialSend(setup, 'new_lead'))).rejects.toBeInstanceOf(TransientError);
    const result = await reserveAndSend(deps, initialSend(setup, 'needs_touch'));
    expect(result).toMatchObject({ status: 'sent', viaIdempotencyConflict: false });
    expect(fakes.mailer.sent.map((m) => m.subject)).toEqual(['New lead — needs your touch']);
    expect(await getNotification(deps.db, setup.key)).toMatchObject({ status: 'sent', kind: 'needs_touch' });
  });

  it('a takeover re-checks the new kind’s predicates: a dismissed lead fails the reservation and nothing is sent', async () => {
    const { deps, fakes } = rig;
    const setup = await activeLead();
    fakes.mailer.injectFailure({ kind: 'transient', code: 'rate_limit_exceeded' });
    await expect(reserveAndSend(deps, initialSend(setup, 'new_lead'))).rejects.toBeInstanceOf(TransientError);
    await deps.db.query(`update leads set dismissed_at = $2 where id = $1`, [setup.leadId, deps.clock.now()]);
    expect(await reserveAndSend(deps, initialSend(setup, 'needs_touch'))).toEqual({ status: 'skipped', reason: 'predicates' });
    expect(await getNotification(deps.db, setup.key)).toMatchObject({ status: 'failed', kind: 'new_lead' });
    expect(fakes.mailer.sent).toEqual([]);
    expect(await reserveAndSend(deps, initialSend(setup, 'needs_touch'))).toEqual({ status: 'skipped', reason: 'failed_earlier' });
  });

  it('crash after send: the retry’s 409 marks it sent, revokes only the new tokens, and the owner gets one email', async () => {
    const { deps, fakes } = rig;
    const setup = await activeLead();
    let onSentCalls = 0;
    const onSent = async () => {
      onSentCalls += 1;
    };
    // Resend accepted the email but the response was lost.
    fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error', afterSend: true });
    await expect(reserveAndSend(deps, initialSend(setup, 'new_lead', { onSent }))).rejects.toBeInstanceOf(TransientError);
    const firstTokens = (await tokenRows(deps.db, setup.key)).map((t) => t.token_hash);
    // The retry (here: the needs-touch fallback) renders different content with fresh tokens.
    const result = await reserveAndSend(deps, initialSend(setup, 'needs_touch', { onSent }));
    expect(result).toEqual({ status: 'sent', providerMessageId: null, viaIdempotencyConflict: true });
    expect(fakes.mailer.sent.map((m) => m.subject)).toEqual(['New lead: Asha — your reply is ready']);
    expect(onSentCalls).toBe(1);
    const tokens = await tokenRows(deps.db, setup.key);
    expect(tokens.filter((t) => firstTokens.includes(t.token_hash)).every((t) => t.revoked_at === null)).toBe(true);
    expect(tokens.filter((t) => !firstTokens.includes(t.token_hash)).every((t) => t.revoked_at !== null)).toBe(true);
    expect(await getNotification(deps.db, setup.key)).toMatchObject({ status: 'sent' });
  });

  it('a permanent Resend error fails the reservation with one alert, revokes the new tokens, and is never resumed', async () => {
    const { deps, fakes } = rig;
    const setup = await activeLead();
    fakes.mailer.injectFailure({ kind: 'permanent', code: 'validation_error' });
    expect(await reserveAndSend(deps, initialSend(setup, 'new_lead'))).toEqual({ status: 'failed', code: 'validation_error' });
    expect(alerts.map((a) => a.code)).toEqual(['notification_send_failed']);
    expect(await getNotification(deps.db, setup.key)).toMatchObject({ status: 'failed' });
    expect((await tokenRows(deps.db, setup.key)).every((t) => t.revoked_at !== null)).toBe(true);
    expect(await reserveAndSend(deps, initialSend(setup, 'needs_touch'))).toEqual({ status: 'skipped', reason: 'failed_earlier' });
    expect(fakes.mailer.sent).toEqual([]);
  });

  it('raises one alert for a quota error and keeps the reservation for a retry', async () => {
    const { deps } = rig;
    const setup = await activeLead();
    const quotaMailer: Mailer = {
      send: () => Promise.reject(new TransientError('daily_quota_exceeded', { httpStatus: 429 })),
    };
    const quota: Deps = { ...deps, mailer: quotaMailer };
    await expect(reserveAndSend(quota, initialSend(setup, 'new_lead'))).rejects.toMatchObject({ code: 'daily_quota_exceeded' });
    expect(alerts.map((a) => a.code)).toEqual(['resend_quota_exceeded']);
    expect((await getNotification(deps.db, setup.key))?.status).toBe('sending');
  });

  it('alerts once per quota episode, however many sends and retries hit the quota (D-36)', async () => {
    const { deps, clock } = rig;
    let code: 'daily_quota_exceeded' | 'monthly_quota_exceeded' = 'daily_quota_exceeded';
    const quota: Deps = { ...deps, mailer: { send: () => Promise.reject(new TransientError(code, { httpStatus: 429 })) } };
    const quotaAlerts = () => alerts.filter((a) => a.code === 'resend_quota_exceeded').map((a) => a.fields.errorCode);

    const first = await activeLead();
    const second = await activeLead();
    for (const setup of [first, second, first]) {
      await expect(reserveAndSend(quota, initialSend(setup, 'new_lead'))).rejects.toMatchObject({ code: 'daily_quota_exceeded' });
      clock.advance({ minutes: 20 });
    }
    expect(quotaAlerts()).toEqual(['daily_quota_exceeded']);

    // The next UTC day is a new episode; the monthly quota is its own.
    clock.advance({ days: 1 });
    await expect(reserveAndSend(quota, initialSend(second, 'new_lead'))).rejects.toMatchObject({ code: 'daily_quota_exceeded' });
    code = 'monthly_quota_exceeded';
    await expect(reserveAndSend(quota, initialSend(first, 'new_lead'))).rejects.toMatchObject({ code: 'monthly_quota_exceeded' });
    clock.advance({ days: 2 });
    await expect(reserveAndSend(quota, initialSend(first, 'new_lead'))).rejects.toMatchObject({ code: 'monthly_quota_exceeded' });
    expect(quotaAlerts()).toEqual(['daily_quota_exceeded', 'daily_quota_exceeded', 'monthly_quota_exceeded']);
  });

  it('treats an unexpected mailer error as transient', async () => {
    const { deps } = rig;
    const setup = await activeLead();
    const broken: Deps = { ...deps, mailer: { send: () => Promise.reject(new Error('boom')) } };
    await expect(reserveAndSend(broken, initialSend(setup, 'new_lead'))).rejects.toMatchObject({ code: 'notification_send_unexpected' });
    expect((await getNotification(deps.db, setup.key))?.status).toBe('sending');
  });

  it('refuses a takeover by an unpaired kind', async () => {
    const { deps, fakes } = rig;
    const setup = await activeLead();
    fakes.mailer.injectFailure({ kind: 'transient', code: 'rate_limit_exceeded' });
    await expect(reserveAndSend(deps, initialSend(setup, 'new_lead'))).rejects.toBeInstanceOf(TransientError);
    const result = await reserveAndSend(deps, { ...initialSend(setup, 'needs_touch'), kind: 'reply_detected' });
    expect(result).toEqual({ status: 'skipped', reason: 'kind_mismatch' });
  });

  it('maps an IdempotencyConflictError on a first send to sent (an earlier process sent with this key)', async () => {
    const { deps } = rig;
    const setup = await activeLead();
    const conflicting: Deps = { ...deps, mailer: { send: () => Promise.reject(new IdempotencyConflictError()) } };
    expect(await reserveAndSend(conflicting, initialSend(setup, 'new_lead'))).toMatchObject({ status: 'sent', viaIdempotencyConflict: true });
  });
});

describe('reserveInTx + sendReserved', () => {
  function registerRenderer(kind: NotificationKind, predicates: (accountId: string, leadId: string | null) => NotificationPredicate, subject: string): void {
    registry.register(kind, async (_deps, row) => ({
      predicates: predicates(row.accountId ?? '', row.leadId),
      render: render(subject),
    }));
  }

  it('reply_detected: reserved in the markReplied transaction, sent after commit', async () => {
    const { deps, fakes } = rig;
    const setup = await activeLead();
    registerRenderer('reply_detected', (accountId, leadId) => NotificationPredicates.replyDetected({ accountId, leadId: leadId ?? '' }), 'Asha replied — follow-ups stopped');
    const key = NotificationKeys.replyDetected(setup.leadId, 0);
    const reserved = await deps.db.tx(async (tx) => {
      const marked = await tx.query(`update leads set replied_at = $2 where id = $1 and replied_at is null and not is_test returning id`, [
        setup.leadId,
        deps.clock.now(),
      ]);
      expect(marked).toHaveLength(1);
      return reserveInTx(tx, {
        kind: 'reply_detected',
        dedupeKey: key,
        accountId: setup.accountId,
        leadId: setup.leadId,
        predicates: NotificationPredicates.replyDetected({ accountId: setup.accountId, leadId: setup.leadId }),
        now: deps.clock.now(),
      });
    });
    expect(reserved?.status).toBe('sending');
    expect(await sendReserved(deps, key, registry)).toMatchObject({ status: 'sent' });
    expect(fakes.mailer.sent.map((m) => m.subject)).toEqual(['Asha replied — follow-ups stopped']);
    expect(await sendReserved(deps, key, registry)).toEqual({ status: 'already_sent' });
  });

  it('reply_detected: a transient Resend error, then exactly one email on the retry', async () => {
    const { deps, fakes } = rig;
    const setup = await activeLead();
    registerRenderer('reply_detected', (accountId, leadId) => NotificationPredicates.replyDetected({ accountId, leadId: leadId ?? '' }), 'Asha replied');
    const key = NotificationKeys.replyDetected(setup.leadId, 0);
    await deps.db.tx(async (tx) => {
      await tx.query(`update leads set replied_at = $2 where id = $1`, [setup.leadId, deps.clock.now()]);
      await reserveInTx(tx, {
        kind: 'reply_detected',
        dedupeKey: key,
        accountId: setup.accountId,
        leadId: setup.leadId,
        predicates: NotificationPredicates.replyDetected({ accountId: setup.accountId, leadId: setup.leadId }),
        now: deps.clock.now(),
      });
    });
    fakes.mailer.injectFailure({ kind: 'transient', code: 'internal_server_error' });
    await expect(sendReserved(deps, key, registry)).rejects.toBeInstanceOf(TransientError);
    expect(await sendReserved(deps, key, registry)).toMatchObject({ status: 'sent' });
    expect(fakes.mailer.sent).toHaveLength(1);
  });

  it('inbox_test: sent during onboarding for the test lead', async () => {
    const { deps, fakes } = rig;
    const db = getDb();
    const now = deps.clock.now();
    const accountId = await seedAccount(db, { now, processingState: 'onboarding' });
    await seedConnection(db, { accountId, now });
    const testLeadId = await seedLead(db, { accountId, now, isTest: true });
    const result = await reserveAndSend(deps, {
      kind: 'inbox_test',
      dedupeKey: NotificationKeys.inboxTest('check-1'),
      accountId,
      leadId: testLeadId,
      predicates: NotificationPredicates.inboxTest({ accountId, leadId: testLeadId }),
      buttons: ['send', 'edit', 'dismiss'],
      render: render('Test: your inbox check'),
    });
    expect(result).toMatchObject({ status: 'sent' });
    expect(fakes.mailer.sent).toHaveLength(1);
  });

  it('reconnect: a resume after the owner reconnected sends nothing', async () => {
    const { deps, fakes } = rig;
    const db = getDb();
    const now = deps.clock.now();
    const accountId = await seedAccount(db, { now, processingState: 'revoked' });
    const connectionId = await seedConnection(db, { accountId, now, status: 'revoked' });
    const key = NotificationKeys.reconnect(connectionId, now);
    registry.register('reconnect', async () => ({ predicates: NotificationPredicates.reconnect(connectionId, now), render: render('Reconnect HubSpot') }));
    await db.tx((tx) => reserveInTx(tx, { kind: 'reconnect', dedupeKey: key, accountId, predicates: NotificationPredicates.reconnect(connectionId, now), now }));
    rig.clock.advance({ minutes: 1 });
    await db.query(`update hubspot_connections set status = 'active', status_changed_at = $2, access_token_enc = 'v1.0123abcd.a.b.c', refresh_token_enc = 'v1.0123abcd.a.b.c' where id = $1`, [
      connectionId,
      deps.clock.now(),
    ]);
    expect(await sendReserved(deps, key, registry)).toEqual({ status: 'skipped', reason: 'predicates' });
    expect(fakes.mailer.sent).toEqual([]);
  });

  it('skips a reservation whose kind has no renderer, and a key that was never reserved', async () => {
    const { deps } = rig;
    const setup = await activeLead();
    await deps.db.tx((tx) => reserveInTx(tx, { kind: 'new_lead', dedupeKey: setup.key, accountId: setup.accountId, leadId: setup.leadId, now: deps.clock.now() }));
    expect(await sendReserved(deps, setup.key, registry)).toEqual({ status: 'skipped', reason: 'no_renderer' });
    expect(await sendReserved(deps, 'notify:unknown:initial:r0', registry)).toEqual({ status: 'skipped', reason: 'not_reserved' });
  });
});

describe('predicates per kind', () => {
  async function reserves(predicate: NotificationPredicate, key: string, accountId: string | null, leadId: string | null = null): Promise<boolean> {
    const row = await getDb().tx((tx) =>
      reserveInTx(tx, { kind: 'owner_alert', dedupeKey: key, accountId, leadId, predicates: predicate, now: rig.deps.clock.now() }),
    );
    return row !== null;
  }

  it('initial: active lead only', async () => {
    const setup = await activeLead();
    const p = NotificationPredicates.initial({ accountId: setup.accountId, leadId: setup.leadId });
    expect(await reserves(p, 'alert:t:initial:1', setup.accountId)).toBe(true);
    await getDb().query(`update leads set stop_reason = 'privacy_deletion'`);
    expect(await reserves(p, 'alert:t:initial:2', setup.accountId)).toBe(false);
  });

  it('initial: refuses a paused account, a revoked connection and a test lead', async () => {
    const setup = await activeLead();
    const p = NotificationPredicates.initial({ accountId: setup.accountId, leadId: setup.leadId });
    await getDb().query(`update accounts set processing_state = 'paused'`);
    expect(await reserves(p, 'alert:t:paused:1', setup.accountId)).toBe(false);
    await getDb().query(`update accounts set processing_state = 'active'`);
    await getDb().query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null`);
    expect(await reserves(p, 'alert:t:revoked:1', setup.accountId)).toBe(false);
    const db = getDb();
    const now = rig.deps.clock.now();
    const other = await seedActiveAccount(db, now);
    const testLead = await seedLead(db, { accountId: other.accountId, now, isTest: true });
    expect(await reserves(NotificationPredicates.initial({ accountId: other.accountId, leadId: testLead }), 'alert:t:test:1', other.accountId)).toBe(false);
  });

  it('followUp: adds replied, superseded and follow-ups off', async () => {
    const db = getDb();
    const now = rig.deps.clock.now();
    const { accountId } = await seedActiveAccount(db, now);
    const older = await seedLead(db, { accountId, now, contactId: '501', submittedAt: new Date(now.getTime() - 3_600_000) });
    const p = NotificationPredicates.followUp({ accountId, leadId: older }, 1);
    expect(await reserves(p, 'alert:f:1', accountId)).toBe(true);
    // A newer lead for the same contact that has not been notified yet does not supersede.
    const newer = await seedLead(db, { accountId, now, contactId: '501' });
    expect(await reserves(p, 'alert:f:2', accountId)).toBe(true);
    await db.query(`update leads set first_notified_at = $2 where id = $1`, [newer, now]);
    expect(await reserves(p, 'alert:f:3', accountId)).toBe(false);
    await db.query(`update leads set first_notified_at = null where id = $1`, [newer]);
    await db.query(`update settings set followups_enabled = false`);
    expect(await reserves(p, 'alert:f:4', accountId)).toBe(false);
    await db.query(`update settings set followups_enabled = true`);
    await db.query(`update leads set replied_at = $2 where id = $1`, [older, now]);
    expect(await reserves(p, 'alert:f:5', accountId)).toBe(false);
  });

  it('followUp n: refused once follow-up n was emailed (any stream), the other one still allowed (D-73)', async () => {
    const setup = await activeLead();
    const scope = { accountId: setup.accountId, leadId: setup.leadId };
    expect(await reserves(NotificationPredicates.followUp(scope, 1), 'alert:n:1', setup.accountId)).toBe(true);
    await getDb().query(`update leads set fu1_notified_at = $2 where id = $1`, [setup.leadId, rig.deps.clock.now()]);
    expect(await reserves(NotificationPredicates.followUp(scope, 1), 'alert:n:2', setup.accountId)).toBe(false);
    expect(await reserves(NotificationPredicates.followUp(scope, 2), 'alert:n:3', setup.accountId)).toBe(true);
    await getDb().query(`update leads set fu2_notified_at = $2 where id = $1`, [setup.leadId, rig.deps.clock.now()]);
    expect(await reserves(NotificationPredicates.followUp(scope, 2), 'alert:n:4', setup.accountId)).toBe(false);
  });

  it('replyDetected: needs replied_at', async () => {
    const setup = await activeLead();
    const p = NotificationPredicates.replyDetected({ accountId: setup.accountId, leadId: setup.leadId });
    expect(await reserves(p, 'alert:r:1', setup.accountId)).toBe(false);
    await getDb().query(`update leads set replied_at = $1`, [rig.deps.clock.now()]);
    expect(await reserves(p, 'alert:r:2', setup.accountId)).toBe(true);
  });

  it('replyDetected: never for a test lead (D-08, D-14)', async () => {
    const db = getDb();
    const now = rig.deps.clock.now();
    const { accountId } = await seedActiveAccount(db, now);
    const testLead = await seedLead(db, { accountId, now, isTest: true });
    await db.query(`update leads set replied_at = $2 where id = $1`, [testLead, now]);
    expect(await reserves(NotificationPredicates.replyDetected({ accountId, leadId: testLead }), 'alert:r:t', accountId)).toBe(false);
  });

  it('inboxTest: onboarding or active only, test lead only', async () => {
    const db = getDb();
    const now = rig.deps.clock.now();
    const accountId = await seedAccount(db, { now, processingState: 'onboarding' });
    await seedConnection(db, { accountId, now });
    const testLead = await seedLead(db, { accountId, now, isTest: true });
    const realLead = await seedLead(db, { accountId, now });
    expect(await reserves(NotificationPredicates.inboxTest({ accountId, leadId: testLead }), 'alert:i:1', accountId)).toBe(true);
    expect(await reserves(NotificationPredicates.inboxTest({ accountId, leadId: realLead }), 'alert:i:2', accountId)).toBe(false);
    await db.query(`update accounts set processing_state = 'paused'`);
    expect(await reserves(NotificationPredicates.inboxTest({ accountId, leadId: testLead }), 'alert:i:3', accountId)).toBe(false);
  });

  it('weeklyReport and leadCap: active account (weekly report also needs an active connection)', async () => {
    const db = getDb();
    const now = rig.deps.clock.now();
    const { accountId } = await seedActiveAccount(db, now);
    expect(await reserves(NotificationPredicates.weeklyReport(accountId), 'alert:w:1', accountId)).toBe(true);
    expect(await reserves(NotificationPredicates.leadCap(accountId), 'alert:c:1', accountId)).toBe(true);
    await db.query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null`);
    expect(await reserves(NotificationPredicates.weeklyReport(accountId), 'alert:w:2', accountId)).toBe(false);
    await db.query(`update accounts set processing_state = 'inactive'`);
    expect(await reserves(NotificationPredicates.leadCap(accountId), 'alert:c:2', accountId)).toBe(false);
  });

  it('billingInactive: account still inactive', async () => {
    const db = getDb();
    const now = rig.deps.clock.now();
    const accountId = await seedAccount(db, { now, processingState: 'inactive' });
    expect(await reserves(NotificationPredicates.billingInactive(accountId), 'alert:b:1', accountId)).toBe(true);
    await db.query(`update accounts set processing_state = 'active'`);
    expect(await reserves(NotificationPredicates.billingInactive(accountId), 'alert:b:2', accountId)).toBe(false);
  });

  it('reconnect: connection still revoked at that status_changed_at', async () => {
    const db = getDb();
    const now = rig.deps.clock.now();
    const accountId = await seedAccount(db, { now, processingState: 'revoked' });
    const connectionId = await seedConnection(db, { accountId, now, status: 'revoked' });
    expect(await reserves(NotificationPredicates.reconnect(connectionId, now), 'alert:x:1', accountId)).toBe(true);
    expect(await reserves(NotificationPredicates.reconnect(connectionId, new Date(now.getTime() + 1)), 'alert:x:2', accountId)).toBe(false);
  });

  it('verifyNotify: the address is listed and not yet verified', async () => {
    const db = getDb();
    const now = rig.deps.clock.now();
    const accountId = await seedAccount(db, { now });
    await seedSettings(db, { accountId, now });
    await db.query(`update settings set notify_emails = array['owner@example.com', 'team@example.com']`);
    expect(await reserves(NotificationPredicates.verifyNotify(accountId, 'team@example.com'), 'alert:v:1', accountId)).toBe(true);
    expect(await reserves(NotificationPredicates.verifyNotify(accountId, 'owner@example.com'), 'alert:v:2', accountId)).toBe(false);
    expect(await reserves(NotificationPredicates.verifyNotify(accountId, 'gone@example.com'), 'alert:v:3', accountId)).toBe(false);
  });

  it('magicLink and ownerAlert: no predicate', async () => {
    expect(await reserves(NotificationPredicates.magicLink(), 'magic:intent-9', null)).toBe(true);
    expect(await reserves(NotificationPredicates.ownerAlert(), 'alert:a:settings:1', null)).toBe(true);
  });

  it('builds the PLAN §8.4 keys', () => {
    const at = new Date('2026-10-06T14:00:00.000Z');
    expect(NotificationKeys.initial('L', 2)).toBe('notify:L:initial:r2');
    expect(NotificationKeys.followUp('L', 1, 3)).toBe('notify:L:fu1:s3');
    expect(NotificationKeys.replyDetected('L', 0)).toBe('reply:L:s0');
    expect(NotificationKeys.inboxTest('C')).toBe('inbox-test:C');
    expect(NotificationKeys.weeklyReport('A', '2026-10-05')).toBe('report:A:2026-10-05');
    expect(NotificationKeys.reconnect('K', at)).toBe('reconnect:K:2026-10-06T14:00:00.000Z');
    expect(NotificationKeys.billingInactive('A', at)).toBe('billing-inactive:A:2026-10-06T14:00:00.000Z');
    expect(NotificationKeys.magicLink('I')).toBe('magic:I');
    expect(NotificationKeys.verifyNotify('A', 'abc')).toBe('verify-notify:A:abc');
    expect(NotificationKeys.leadCap('A', '2026-10-06')).toBe('cap:A:2026-10-06');
    expect(NotificationKeys.ownerAlert('A', 'settings', 'X')).toBe('alert:A:settings:X');
  });
});

// Sequential replays of two resumers of one `sending` row (a job retry or sendReserved after commit
// racing the sweeper, PLAN §8.4 step 2, §12): only the one whose takeover matched `reserved_at`
// mints tokens and sends.
describe('takeover and delivery replays', () => {
  async function sendingRow(setup: LeadSetup) {
    const predicates = NotificationPredicates.initial({ accountId: setup.accountId, leadId: setup.leadId });
    registry.register('new_lead', async () => ({ predicates, buttons: ['send', 'edit', 'dismiss'], render: render('New lead') }));
    await reserveInTx(rig.deps.db, { kind: 'new_lead', dedupeKey: setup.key, accountId: setup.accountId, leadId: setup.leadId, predicates, now: rig.clock.now() });
    const row = await getNotification(rig.deps.db, setup.key);
    if (row === null) throw new Error('not reserved');
    return { row, predicates };
  }

  it('two resumers holding the same stale row: the second takeover is busy, so nothing is minted or sent twice', async () => {
    const { deps, fakes, clock } = rig;
    const setup = await activeLead();
    const { row: stale, predicates } = await sendingRow(setup);
    clock.advance({ minutes: 11 });

    const first = await takeOver(deps.db, stale, 'new_lead', predicates, clock.now());
    expect(first.type).toBe('taken');
    expect(await takeOver(deps.db, stale, 'new_lead', predicates, clock.now())).toEqual({ type: 'busy' });
    expect(await resumeReservation(deps, stale, { bySweeper: true }, registry)).toEqual({ status: 'skipped', reason: 'busy' });
    expect(fakes.mailer.sent).toEqual([]);
    expect(await tokenRows(deps.db, setup.key)).toEqual([]);

    // The holder's row (or the sweeper, from the current row) sends exactly once.
    expect(await sendReserved(deps, setup.key, registry)).toMatchObject({ status: 'sent' });
    expect(fakes.mailer.sent).toHaveLength(1);
    expect(await tokenRows(deps.db, setup.key)).toHaveLength(3);
  });

  it('a delivery whose reservation was taken over before its attempt count commits mints nothing and sends nothing', async () => {
    const { deps, fakes, clock } = rig;
    const setup = await activeLead();
    const { predicates } = await sendingRow(setup);
    clock.advance({ minutes: 11 });
    const current = await getNotification(deps.db, setup.key);
    if (current === null) throw new Error('missing');

    // Between A's takeover and A's step 3, the sweeper takes the row over.
    const raced = interceptBefore(deps.db, /set send_attempts = send_attempts \+ 1/, async (handle) => {
      const taken = await getNotification(handle, setup.key);
      if (taken === null) throw new Error('missing');
      expect(await takeOver(handle, taken, 'new_lead', predicates, new Date(clock.now().getTime() + 1000))).toMatchObject({ type: 'taken' });
    });
    const a = await resumeReservation({ ...deps, db: raced.db }, current, { bySweeper: false }, registry);
    expect(raced.fired()).toBe(1);
    expect(a).toEqual({ status: 'skipped', reason: 'busy' });
    expect(fakes.mailer.sent).toEqual([]);
    expect(await tokenRows(deps.db, setup.key)).toEqual([]);
    expect(await getNotification(deps.db, setup.key)).toMatchObject({ status: 'sending', sendAttempts: 0 });

    clock.advance({ minutes: 11 });
    expect(await sendReserved(deps, setup.key, registry)).toMatchObject({ status: 'sent' });
    expect(fakes.mailer.sent).toHaveLength(1);
  });
});

