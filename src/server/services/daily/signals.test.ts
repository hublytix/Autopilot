import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { at, createSignalsRig, DAY, MINUTE, seedNotifiedLead, signalRow, type SignalsRig } from '../../../../test/signals/support';
import { refreshFinishedLeadSignals } from './signals';

// The daily signal refresh (PLAN §9.1 step 4, D-08): applySignals ('refresh') for the leads whose
// follow-ups are finished or off and that were emailed to the owner in the last 14 days; never a test
// lead, never a lead whose follow-ups are still pending (their own jobs check it), only for an active
// account.

const getDb = setUpTestDb();
let rig: SignalsRig;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createSignalsRig(getDb());
});

afterEach(() => {
  vi.useRealTimers();
});

function refresh() {
  return refreshFinishedLeadSignals(rig.deps, rig.accountId, { sleep: rig.sleep, notifications: rig.notifications });
}

describe('refreshFinishedLeadSignals', () => {
  it('records a send HubSpot logged after the follow-ups ended, for recent leads whose follow-ups are over', async () => {
    const now = rig.clock.now();
    const finished = await seedNotifiedLead(rig, { email: 'maya@okafor-bakery.example', firstNotifiedAt: at(now, -3 * DAY), followUps: false });
    const pending = await seedNotifiedLead(rig, { email: 'tom@reyes-builders.example', firstNotifiedAt: at(now, -1 * DAY) });
    const old = await seedNotifiedLead(rig, { email: 'ann@lee-design.example', firstNotifiedAt: at(now, -15 * DAY), followUps: false });
    const dismissed = await seedNotifiedLead(rig, { email: 'raj@patel-cafe.example', firstNotifiedAt: at(now, -2 * DAY), followUps: false });
    await getDb().query(`update leads set dismissed_at = $2 where id = $1`, [dismissed.leadId, at(now, -DAY)]);
    const sendAt = at(now, -2 * DAY);
    rig.hubspot.logOwnerSend({ to: 'maya@okafor-bakery.example', at: sendAt });
    rig.hubspot.logOwnerSend({ to: 'ann@lee-design.example', at: at(now, -14 * DAY) });

    expect(await refresh()).toEqual({ candidates: 1, checked: 1, stopped: false });
    expect(await signalRow(getDb(), finished.leadId)).toMatchObject({ send_confirmed_at: sendAt, signals_checked_at: rig.clock.now() });
    for (const lead of [pending, old, dismissed]) expect((await signalRow(getDb(), lead.leadId)).signals_checked_at).toBeNull();
  });

  it('never reads a test lead', async () => {
    const now = rig.clock.now();
    await seedNotifiedLead(rig, { email: 'owner.personal@example.net', firstNotifiedAt: at(now, -MINUTE), isTest: true, followUps: false });
    expect(await refresh()).toEqual({ candidates: 0, checked: 0, stopped: false });
  });

  it('records a reply without emailing the owner (no follow-up was pending)', async () => {
    const now = rig.clock.now();
    const lead = await seedNotifiedLead(rig, { email: 'maya@okafor-bakery.example', firstNotifiedAt: at(now, -4 * DAY), followUps: false });
    rig.hubspot.logOwnerSend({ to: 'maya@okafor-bakery.example', at: at(now, -4 * DAY + 10 * MINUTE) });
    const repliedAt = at(now, -DAY);
    rig.hubspot.logLeadReply({ from: 'maya@okafor-bakery.example', at: repliedAt });

    await refresh();
    expect(await signalRow(getDb(), lead.leadId)).toMatchObject({ replied_at: repliedAt });
    expect(rig.fakes.mailer.sent).toEqual([]);
    // Both are known now: nothing left to learn, so the next run skips it.
    expect(await refresh()).toMatchObject({ candidates: 0 });
  });

  it('does nothing for an account that is not active', async () => {
    const now = rig.clock.now();
    await seedNotifiedLead(rig, { email: 'maya@okafor-bakery.example', firstNotifiedAt: at(now, -3 * DAY), followUps: false });
    await getDb().query(`update accounts set paused_at = $2, processing_state = 'paused' where id = $1`, [rig.accountId, now]);
    expect(await refresh()).toEqual({ candidates: 0, checked: 0, stopped: false });
  });

  it('stops on a HubSpot error without throwing', async () => {
    const now = rig.clock.now();
    await seedNotifiedLead(rig, { email: 'maya@okafor-bakery.example', firstNotifiedAt: at(now, -3 * DAY), followUps: false });
    rig.hubspot.injectFailure('*', { kind: 'server_error', times: 10 });
    expect(await refresh()).toEqual({ candidates: 1, checked: 0, stopped: true });
  });
});
