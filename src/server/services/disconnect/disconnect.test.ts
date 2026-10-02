import { describe, expect, it } from 'vitest';
import { pauseAll } from '@/server/services/owner-controls';
import { revokeConnection } from '@/server/services/hubspot';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { insertSubscription, onlySubscription } from '../../../../test/billing/support';
import {
  accountState,
  auditActions,
  connectionState,
  DAY,
  jobStates,
  seedDisconnectFixtures,
  seedSettingsAccount,
  setUpSettingsRig,
  subscribe,
  subscribeAndPay,
  type SettingsRig,
} from '../../../../test/settings/support';
import { disconnectHubSpot } from './disconnect';

// Disconnect (PLAN §9.1 step 5, D-10, D-48): best effort (billing cancel, uninstall, token revoke),
// then always the local disconnect in one transaction: tokens wiped, connection disconnected,
// → disconnected (purge_after +30 d, jobs cancelled except privacy deletions, action tokens revoked,
// stop_reason account_inactive on leads whose follow-ups were cancelled).

const getDb = setUpTestDb();
const getRig = setUpSettingsRig(getDb);

async function tokenRows(rig: SettingsRig, accountId: string) {
  return rig.deps.db.query<{ purpose: string; revoked_at: Date | null }>(`select purpose, revoked_at from action_tokens where account_id = $1 order by purpose`, [accountId]);
}

async function leadStop(rig: SettingsRig, leadId: string): Promise<string | null> {
  return (await rig.deps.db.one<{ stop_reason: string | null }>(`select stop_reason from leads where id = $1`, [leadId])).stop_reason;
}

describe('disconnect HubSpot', () => {
  it('uninstalls, revokes the token, and disconnects locally with every side effect', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    const { lead, privacyJobId } = await seedDisconnectFixtures(rig, account.accountId);
    expect(rig.fakes.hubspot.isInstalled()).toBe(true);
    rig.clock.advance({ minutes: 5 });
    const now = rig.clock.now();

    const result = await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep });

    expect(result).toEqual({ type: 'disconnected', billing: 'not_requested', uninstall: 'done', revoke: 'done' });
    expect(rig.fakes.hubspot.isInstalled()).toBe(false);
    expect(await connectionState(getDb(), account.accountId)).toMatchObject({
      status: 'disconnected',
      status_reason: 'owner_disconnected',
      access_token_enc: null,
      refresh_token_enc: null,
      access_expires_at: null,
    });
    expect(await accountState(getDb(), account.accountId)).toEqual({
      processing_state: 'disconnected',
      purge_after: new Date(now.getTime() + 30 * DAY),
      disconnected_at: now,
      paused_at: null,
    });
    // Follow-ups cancelled (reason disconnected), the privacy deletion left to run.
    const jobs = await jobStates(getDb(), account.accountId);
    expect(jobs.filter((job) => job.kind === 'followup')).toEqual([
      { kind: 'followup', status: 'cancelled', cancel_reason: 'disconnected' },
      { kind: 'followup', status: 'cancelled', cancel_reason: 'disconnected' },
    ]);
    expect(await getDb().one(`select status from scheduled_jobs where id = $1`, [privacyJobId])).toEqual({ status: 'scheduled' });
    expect(rig.fakes.scheduler.cancelled).toEqual(expect.arrayContaining(lead.jobs.map((job) => job.externalId)));
    expect((await tokenRows(rig, account.accountId)).every((row) => row.revoked_at?.getTime() === now.getTime())).toBe(true);
    expect(await leadStop(rig, lead.leadId)).toBe('account_inactive');
    expect(await auditActions(getDb(), account.accountId)).toEqual([{ actor: 'owner', action: 'account.disconnected', meta: {} }]);
    // Nothing is emailed: no "Reconnect HubSpot" for the owner's own disconnect.
    expect(rig.fakes.mailer.sent).toEqual([]);
  });

  it('an uninstall failure still disconnects locally (best effort, logged by code)', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    await seedDisconnectFixtures(rig, account.accountId);
    rig.fakes.hubspot.injectFailure('uninstallApp', { kind: 'server_error' });

    const result = await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep });

    expect(result).toEqual({ type: 'disconnected', billing: 'not_requested', uninstall: 'failed', revoke: 'done' });
    // The app is still installed at HubSpot, but our side holds no token and processes nothing.
    expect(rig.fakes.hubspot.isInstalled()).toBe(true);
    expect(await connectionState(getDb(), account.accountId)).toMatchObject({ status: 'disconnected', access_token_enc: null, refresh_token_enc: null });
    expect(await accountState(getDb(), account.accountId)).toMatchObject({ processing_state: 'disconnected' });
    expect((await jobStates(getDb(), account.accountId)).filter((job) => job.kind === 'followup').map((job) => job.status)).toEqual(['cancelled', 'cancelled']);
    const lines = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('disconnect.uninstall_failed') && line.includes('hubspot_server_error'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/na1-|pat-|apt_/);
  });

  it('uninstall and revoke both failing (HubSpot unreachable) still disconnects locally', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    rig.fakes.hubspot.injectFailure('uninstallApp', { kind: 'network' });
    rig.fakes.hubspot.setRefreshMode('config');

    const result = await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep });

    expect(result).toMatchObject({ type: 'disconnected', uninstall: 'failed', revoke: 'failed' });
    expect(await connectionState(getDb(), account.accountId)).toMatchObject({ status: 'disconnected', refresh_token_enc: null });
    expect(await accountState(getDb(), account.accountId)).toMatchObject({ processing_state: 'disconnected' });
  });

  it('a stale access token is refreshed once for the uninstall, never stored, and a revoked refresh token sends no reconnect email', async () => {
    const rig = getRig();
    const stale = await seedSettingsAccount(rig, { accessExpiresAt: new Date(rig.clock.now().getTime() - 60_000) });
    const versionBefore = (await connectionState(getDb(), stale.accountId)).token_version;
    expect(await disconnectHubSpot(rig.deps, stale.scope, { cancelBilling: false }, { sleep: rig.sleep })).toMatchObject({ uninstall: 'done', revoke: 'done' });
    expect(rig.fakes.hubspot.isInstalled()).toBe(false);
    expect((await connectionState(getDb(), stale.accountId)).token_version).toBe(versionBefore);
  });

  it('a refresh token HubSpot already revoked: the uninstall is skipped as failed, the connection ends disconnected (not revoked), no email', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig, { accessExpiresAt: new Date(rig.clock.now().getTime() - 60_000) });
    rig.fakes.hubspot.setRefreshMode('revoked');

    const result = await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep });

    expect(result).toMatchObject({ type: 'disconnected', uninstall: 'failed' });
    expect(await connectionState(getDb(), account.accountId)).toMatchObject({ status: 'disconnected', status_reason: 'owner_disconnected' });
    expect(rig.fakes.mailer.sent).toEqual([]);
    expect(await getDb().query(`select kind from notifications_sent where account_id = $1`, [account.accountId])).toEqual([]);
  });

  it('a second disconnect changes nothing and calls nothing', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep });
    const before = await accountState(getDb(), account.accountId);
    rig.clock.advance({ days: 2 });

    expect(await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep })).toEqual({
      type: 'already_disconnected',
      billing: 'not_requested',
      uninstall: 'skipped',
      revoke: 'skipped',
    });
    expect(await accountState(getDb(), account.accountId)).toEqual(before);
    expect(await auditActions(getDb(), account.accountId)).toHaveLength(1);
  });

  it('a revoked connection is disconnected without HubSpot calls; the 30 days restart (revoked → disconnected)', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    const version = (await connectionState(getDb(), account.accountId)).token_version;
    await revokeConnection(rig.deps, { accountId: account.accountId, connectionId: account.connectionId, tokenVersion: version, reason: 'refresh_revoked' });
    expect(await accountState(getDb(), account.accountId)).toMatchObject({ processing_state: 'revoked' });
    rig.clock.advance({ days: 10 });
    const now = rig.clock.now();

    const result = await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep });

    expect(result).toEqual({ type: 'disconnected', billing: 'not_requested', uninstall: 'skipped', revoke: 'skipped' });
    expect(await accountState(getDb(), account.accountId)).toMatchObject({ processing_state: 'disconnected', purge_after: new Date(now.getTime() + 30 * DAY), disconnected_at: now });
    expect(await connectionState(getDb(), account.accountId)).toMatchObject({ status: 'disconnected', status_reason: 'owner_disconnected' });
  });

  it('a paused account is disconnected too, and keeps its pause intent', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    await pauseAll(rig.deps, account.scope);
    await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep });
    const state = await accountState(getDb(), account.accountId);
    expect(state.processing_state).toBe('disconnected');
    expect(state.paused_at).not.toBeNull();
  });
});

describe('disconnect with "also cancel billing"', () => {
  it('an authenticated subscription is cancelled now (nothing charged), then HubSpot is disconnected', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    const id = await subscribe(rig, account.scope);

    const result = await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: true }, { sleep: rig.sleep });

    expect(result).toMatchObject({ type: 'disconnected', billing: 'cancelled' });
    expect((await rig.fakes.billing.fetchSubscription(id)).status).toBe('cancelled');
    expect(await onlySubscription(getDb(), account.accountId)).toMatchObject({ status: 'cancelled' });
    expect(await accountState(getDb(), account.accountId)).toMatchObject({ processing_state: 'disconnected' });
  });

  it('an active subscription is cancelled at the end of its period', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    const id = await subscribeAndPay(rig, account.scope);

    const result = await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: true }, { sleep: rig.sleep });

    expect(result).toMatchObject({ type: 'disconnected', billing: 'cancel_scheduled' });
    expect(await onlySubscription(getDb(), account.accountId)).toMatchObject({ status: 'active', cancelAtCycleEnd: true });
    expect((await rig.fakes.billing.fetchSubscription(id)).status).toBe('active');
  });

  it('without the choice the subscription is left alone', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    const id = await subscribe(rig, account.scope);
    expect(await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: false }, { sleep: rig.sleep })).toMatchObject({ billing: 'not_requested' });
    expect((await rig.fakes.billing.fetchSubscription(id)).status).toBe('authenticated');
  });

  it.each(['paused', 'pending', 'halted'] as const)('a %s subscription is not cancellable: explained, untouched, and HubSpot still disconnected', async (status) => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    await insertSubscription(getDb(), { accountId: account.accountId, providerId: 'sub_NotCancellable1', status, createdAt: rig.clock.now() });

    const result = await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: true }, { sleep: rig.sleep });

    expect(result).toMatchObject({ type: 'disconnected', billing: 'not_cancellable' });
    expect(await onlySubscription(getDb(), account.accountId)).toMatchObject({ status });
    expect(await accountState(getDb(), account.accountId)).toMatchObject({ processing_state: 'disconnected' });
  });

  it('Razorpay refusing or unavailable: billing failed, the disconnect still completes', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    await subscribe(rig, account.scope);
    rig.fakes.billing.injectFailure('cancelSubscription', 'transient');

    const result = await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: true }, { sleep: rig.sleep });

    expect(result).toMatchObject({ type: 'disconnected', billing: 'failed', uninstall: 'done' });
    expect(await onlySubscription(getDb(), account.accountId)).toMatchObject({ status: 'authenticated' });
    expect(await accountState(getDb(), account.accountId)).toMatchObject({ processing_state: 'disconnected' });
  });

  it('nothing to cancel: no subscription at all', async () => {
    const rig = getRig();
    const account = await seedSettingsAccount(rig);
    expect(await disconnectHubSpot(rig.deps, account.scope, { cancelBilling: true }, { sleep: rig.sleep })).toMatchObject({ billing: 'nothing_to_cancel', type: 'disconnected' });
  });
});
