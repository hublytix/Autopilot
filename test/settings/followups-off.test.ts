import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSavePreferences } from '@/server/actions/settings';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth/owner-scope';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createFollowUpRig, deliverWhenDue, leadRow, NOTIFY_EMAIL, seedFollowUpLead, sent, type FollowUpLeadSeed, type FollowUpRig } from '../followups/support';

// Follow-ups on/off from settings (brief §5.11, PLAN §6.2 "follow-ups off", the M5 hand-off): turning
// them off cancels nothing now; each scheduled follow-up that comes due while they are off is
// skipped by its stop check (and its reservation predicate), with no draft and no email; turning
// them back on before one is due lets it go out at its time.

const getDb = setUpTestDb();
let rig: FollowUpRig;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  for (const method of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  rig = await createFollowUpRig(getDb());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function ownerScope(): Promise<OwnerScope> {
  const row = await getDb().one<{ owner_user_id: string }>(`select owner_user_id from accounts where id = $1`, [rig.accountId]);
  return createOwnerScopeForTest(rig.accountId, row.owner_user_id);
}

function settingsForm(followupsOn: boolean): FormData {
  const data = new FormData();
  data.set('mail_client', 'other');
  data.set('notify_email_0', NOTIFY_EMAIL);
  data.set('quiet_start_hour', '20');
  data.set('quiet_end_hour', '8');
  data.set('skip_weekends', 'on');
  if (followupsOn) data.set('followups_enabled', 'on');
  return data;
}

function fu(lead: FollowUpLeadSeed, n: 1 | 2): { id: string } {
  const job = lead.jobs[n - 1];
  if (job === undefined) throw new Error(`no fu${n} job`);
  return job;
}

async function jobStatuses(leadId: string): Promise<string[]> {
  return (await getDb().query<{ status: string }>(`select status from scheduled_jobs where lead_id = $1 and kind = 'followup' order by seq`, [leadId])).map((row) => row.status);
}

describe('follow-ups switched off in settings', () => {
  it('cancels nothing; follow-up 1 due while off is skipped with no email; switched back on, follow-up 2 goes out', async () => {
    const lead = await seedFollowUpLead(rig);
    const scope = await ownerScope();
    expect(await runSavePreferences(rig.deps, scope, settingsForm(false))).toMatchObject({ redirect: expect.stringContaining('preferences_saved') });
    expect(await jobStatuses(lead.leadId)).toEqual(['scheduled', 'scheduled']);

    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ outcome: 'skipped' });
    expect(sent(rig, 'follow_up')).toEqual([]);
    // Follow-up 2 is still to come, so the stream stays open.
    expect((await leadRow(getDb(), lead.leadId)).stop_reason).toBeNull();

    await runSavePreferences(rig.deps, scope, settingsForm(true));
    expect(await deliverWhenDue(rig, fu(lead, 2))).toMatchObject({ outcome: 'done' });
    expect(sent(rig, 'follow_up').map((mail) => mail.subject)).toEqual(['Follow-up 2 for Maya — your draft is ready']);
  });

  it('left off through both follow-ups: none is emailed and the lead records followups_off', async () => {
    const lead = await seedFollowUpLead(rig);
    await runSavePreferences(rig.deps, await ownerScope(), settingsForm(false));
    expect(await deliverWhenDue(rig, fu(lead, 1))).toMatchObject({ outcome: 'skipped' });
    expect(await deliverWhenDue(rig, fu(lead, 2))).toMatchObject({ outcome: 'skipped' });
    expect(sent(rig, 'follow_up')).toEqual([]);
    expect((await leadRow(getDb(), lead.leadId)).stop_reason).toBe('followups_off');
  });
});
