import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationKeys, NotificationPredicates } from '@/server/services/notifications/predicates';
import { reserveAndSend } from '@/server/services/notifications/send';
import { pauseAll, resumeAll } from '@/server/services/owner-controls';
import { useTestDb as setUpTestDb } from '../db/harness';
import { auditRows, createLeadsRig, leadJobs, predicateHolds, seedNotifiedLead, seedOwnedAccount, type LeadsRig } from './support';

// Pause all / Resume (PLAN §6.1, §9.6, D-42): `paused_at` is the owner's intent and the state is
// derived by applyProcessingState in the same transaction. Pause cancels nothing: a follow-up that
// comes due fails its reservation predicate and is skipped. Resume → active moves the intake floors
// to now, so leads that arrived while paused are never drafted.

const getDb = setUpTestDb();
let rig: LeadsRig;

beforeEach(() => {
  // PLAN §12: nothing here may read the wall clock, so the system time is far from the test's Clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = createLeadsRig(getDb());
});

afterEach(() => {
  vi.useRealTimers();
});

async function account(id: string) {
  return getDb().one<{ processing_state: string; paused_at: Date | null }>(`select processing_state, paused_at from accounts where id = $1`, [id]);
}

describe('pauseAll', () => {
  it('sets paused_at and derives paused, cancelling no job and sending nothing', async () => {
    const owned = await seedOwnedAccount(getDb(), { now: rig.clock.now() });
    const lead = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    rig.clock.advance({ hours: 1 });
    const pausedAt = rig.clock.now();

    expect(await pauseAll(rig.deps, owned.scope)).toEqual({ processingState: 'paused', changed: true, pausedAt });

    expect(await account(owned.accountId)).toEqual({ processing_state: 'paused', paused_at: pausedAt });
    expect((await leadJobs(getDb(), lead.leadId)).map((job) => job.status)).toEqual(['scheduled', 'scheduled']);
    expect(rig.fakes.scheduler.cancelled).toEqual([]);
    expect(rig.fakes.mailer.sent).toEqual([]);
    expect(await auditRows(getDb(), owned.accountId)).toEqual([
      { actor: 'owner', action: 'account.paused', meta: { pausedAt: pausedAt.toISOString() } },
    ]);
  });

  it('makes a follow-up that comes due while paused fail its reservation predicate, so it is skipped', async () => {
    const db = getDb();
    const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
    const lead = await seedNotifiedLead(rig, { accountId: owned.accountId, firstNotifiedAt: rig.clock.now() });
    const scope = { accountId: owned.accountId, leadId: lead.leadId };
    expect(await predicateHolds(db, NotificationPredicates.followUp(scope, 1))).toBe(true);

    await pauseAll(rig.deps, owned.scope);
    rig.clock.advance({ days: 2 });

    expect(await predicateHolds(db, NotificationPredicates.followUp(scope, 1))).toBe(false);
    const result = await reserveAndSend(rig.deps, {
      kind: 'follow_up',
      dedupeKey: NotificationKeys.followUp(lead.leadId, 1, 0),
      accountId: owned.accountId,
      leadId: lead.leadId,
      predicates: NotificationPredicates.followUp(scope, 1),
      render: () => {
        throw new Error('a paused account must not render a follow-up');
      },
    });
    expect(result).toEqual({ status: 'skipped', reason: 'predicates' });
    expect(rig.fakes.mailer.sent).toEqual([]);
    expect(await db.query(`select 1 from notifications_sent where lead_id = $1`, [lead.leadId])).toEqual([]);
  });

  it('keeps the first paused_at when pausing again', async () => {
    const owned = await seedOwnedAccount(getDb(), { now: rig.clock.now() });
    const first = rig.clock.now();
    await pauseAll(rig.deps, owned.scope);
    rig.clock.advance({ hours: 3 });

    expect(await pauseAll(rig.deps, owned.scope)).toEqual({ processingState: 'paused', changed: false, pausedAt: null });
    expect((await account(owned.accountId)).paused_at).toEqual(first);
    expect(await auditRows(getDb(), owned.accountId)).toHaveLength(1);
  });

  it('records the intent on a revoked account without changing its state', async () => {
    const owned = await seedOwnedAccount(getDb(), { now: rig.clock.now() });
    await getDb().query(`update hubspot_connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null where account_id = $1`, [
      owned.accountId,
    ]);
    await getDb().query(`update accounts set processing_state = 'revoked' where id = $1`, [owned.accountId]);

    expect(await pauseAll(rig.deps, owned.scope)).toMatchObject({ processingState: 'revoked', changed: true });
    expect((await account(owned.accountId)).paused_at).toEqual(rig.clock.now());
  });
});

describe('resumeAll', () => {
  it('clears paused_at, derives active and moves every intake floor and cursor to now', async () => {
    const db = getDb();
    const installedAt = rig.clock.now();
    const owned = await seedOwnedAccount(db, { now: installedAt });
    rig.clock.advance({ hours: 1 });
    const pausedAt = rig.clock.now();
    await pauseAll(rig.deps, owned.scope);
    rig.clock.advance({ days: 2 });
    const resumedAt = rig.clock.now();

    expect(await resumeAll(rig.deps, owned.scope)).toEqual({ processingState: 'active', changed: true, pausedAt });

    expect(await account(owned.accountId)).toEqual({ processing_state: 'active', paused_at: null });
    const forms = await db.query<{ intake_floor_at: Date; cursor_submitted_at: Date }>(
      `select intake_floor_at, cursor_submitted_at from selected_forms where account_id = $1`,
      [owned.accountId],
    );
    expect(forms).toEqual([{ intake_floor_at: resumedAt, cursor_submitted_at: resumedAt }]);
    expect((await auditRows(db, owned.accountId)).map((row) => [row.action, row.meta])).toEqual([
      ['account.paused', { pausedAt: pausedAt.toISOString() }],
      ['account.resumed', { pausedAt: pausedAt.toISOString() }],
    ]);
  });

  it('changes nothing for an account that is not paused', async () => {
    const db = getDb();
    const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
    const floor = await db.one<{ intake_floor_at: Date }>(`select intake_floor_at from selected_forms where account_id = $1`, [owned.accountId]);
    rig.clock.advance({ hours: 1 });

    expect(await resumeAll(rig.deps, owned.scope)).toEqual({ processingState: 'active', changed: false, pausedAt: null });
    expect(await db.one(`select intake_floor_at from selected_forms where account_id = $1`, [owned.accountId])).toEqual(floor);
    expect(await auditRows(db, owned.accountId)).toEqual([]);
  });

  it('lands on inactive when the trial ended while paused, and sends the one billing email after commit', async () => {
    const db = getDb();
    const owned = await seedOwnedAccount(db, { now: rig.clock.now() });
    await pauseAll(rig.deps, owned.scope);
    rig.clock.advance({ days: 15 });

    expect(await resumeAll(rig.deps, owned.scope)).toMatchObject({ processingState: 'inactive', changed: true });
    expect(rig.fakes.mailer.sent.filter((mail) => mail.kind === 'billing_inactive')).toHaveLength(1);
  });
});
