import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '@/server/ports';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { recordStatements } from '../../../../test/db/intercept';
import { accountRowCounts, createRetentionRig, DAY, installNewPortal, MINUTE, revokeNow, seedInstalledAccount, type RetentionRig } from '../../../../test/retention/support';
import { scheduleAccountDailyJobs } from '@/server/services/daily';
import { disconnectOrphan } from './orphan';
import { purgeAccountIfDue } from './purge';

// Lock order and the job that purges its own account (docs/ARCHITECTURE.md, PLAN §8.3, §9.10).
// PGlite serialises transactions, so the order of statements is what the test can prove.

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

function firstIndex(statements: readonly string[], pattern: RegExp): number {
  return statements.findIndex((sql) => pattern.test(sql));
}

describe('lock order', () => {
  it('the orphan disconnect locks the account row before it writes the connection', async () => {
    const accountId = await installNewPortal(rig);
    rig.clock.advance({ days: 7, minutes: 1 });
    const recorded = recordStatements(getDb());
    const deps: Deps = { ...rig.deps, db: recorded.db };
    expect(await disconnectOrphan(deps, accountId, { sleep: rig.sleep })).toBe('disconnected');
    const lock = firstIndex(recorded.statements, /from accounts where id = \$1 for no key update/);
    const write = firstIndex(recorded.statements, /update hubspot_connections\s+set status = 'disconnected'/);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(lock);
  });

  it('the purge locks the account row before the tombstones and the delete', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    await revokeNow(rig, accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    const recorded = recordStatements(getDb());
    expect(await purgeAccountIfDue({ ...rig.deps, db: recorded.db }, accountId)).toMatchObject({ status: 'purged' });
    const lock = firstIndex(recorded.statements, /from accounts where id = \$1 for update/);
    const history = firstIndex(recorded.statements, /insert into portal_history/);
    const remove = firstIndex(recorded.statements, /delete from accounts where id = \$1/);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(history).toBeGreaterThan(lock);
    expect(remove).toBeGreaterThan(history);
  });
});

describe('the account_daily job that purges its own account', () => {
  it('finishes the delivery cleanly although the purge deletes its row', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    await revokeNow(rig, accountId);
    rig.clock.advance({ days: 30, minutes: 1 });
    await scheduleAccountDailyJobs(rig.deps);
    rig.clock.advance({ seconds: 1 });
    await rig.fakes.scheduler.runDue();
    expect((await accountRowCounts(getDb(), accountId)).accounts).toBe(0);
    expect(rig.fakes.scheduler.failures).toEqual([]);
    expect(rig.fakes.scheduler.pending()).toEqual([]);
    expect(rig.alerts.map((alert) => alert.code)).toEqual([]);
  });

  it('is not purged before its date', async () => {
    const { accountId } = await seedInstalledAccount(rig);
    await revokeNow(rig, accountId);
    rig.clock.advance(30 * DAY - MINUTE);
    expect(await purgeAccountIfDue(rig.deps, accountId)).toEqual({ status: 'not_due' });
  });
});
