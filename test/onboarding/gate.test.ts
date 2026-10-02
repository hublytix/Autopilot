import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_SITE_URL } from '@/server/adapters/fake/web-fetcher';
import { requestBriefGeneration } from '@/server/services/brief';
import { completeOnboarding, getOnboardingGate } from '@/server/services/onboarding';
import { onboardingStatus } from '@/server/views/onboarding/status';
import { useTestDb as setUpTestDb } from '../db/harness';
import { createOnboardingRig, MINUTE, saveBrief, savePrefs, selectForms, type OnboardingRig } from './support';

// The onboarding-complete gate (PLAN §6.1, §7.5): an owner-saved brief with a booking-link choice,
// at least one selected form, saved preferences with an address. Finish → onboarding_completed_at
// and applyProcessingState (→ active, floors at $now).

const getDb = setUpTestDb();

let rig: OnboardingRig;

beforeEach(async () => {
  rig = await createOnboardingRig(getDb());
});

async function account(): Promise<{ processing_state: string; onboarding_completed_at: Date | null }> {
  return getDb().one(`select processing_state, onboarding_completed_at from accounts where id = $1`, [rig.accountId]);
}

describe('the onboarding gate', () => {
  it('lists every step that is missing on a fresh account', async () => {
    const gate = await getOnboardingGate(rig.scope, rig.deps);
    expect(gate).toMatchObject({ ready: false, missing: ['brief', 'forms', 'preferences'], completedAt: null, processingState: 'onboarding' });
  });

  it('keeps Finish disabled while the brief job is still running, and the account stays onboarding', async () => {
    const requested = await requestBriefGeneration(rig.scope, rig.deps, { websiteUrl: FIXTURE_SITE_URL });
    expect(requested.ok).toBe(true);
    await selectForms(rig);
    await savePrefs(rig);

    const status = await onboardingStatus(rig.scope, rig.deps);
    expect(status.brief.status).toBe('queued');
    expect(status.gate).toEqual({ ready: false, missing: ['brief'], completed: false });

    expect(await completeOnboarding(rig.scope, rig.deps)).toEqual({ ok: false, missing: ['brief'] });
    expect(await account()).toEqual({ processing_state: 'onboarding', onboarding_completed_at: null });
  });

  it('does not count a generated brief: the owner must save one with a booking-link choice', async () => {
    await getDb().query(
      `with b as (insert into briefs (account_id, version) values ($1, 1) returning id)
       insert into brief_versions (brief_id, account_id, version, source, brief, booking_link_choice, created_at)
       select b.id, $1, 1, 'generated', '{}'::jsonb, 'link', $2 from b`,
      [rig.accountId, rig.clock.now()],
    );
    await selectForms(rig);
    await savePrefs(rig);
    expect((await getOnboardingGate(rig.scope, rig.deps)).missing).toEqual(['brief']);
  });

  it('needs at least one selected form', async () => {
    await saveBrief(rig);
    await selectForms(rig, [rig.contactUs]);
    await getDb().query(`update selected_forms set selected = false where account_id = $1`, [rig.accountId]);
    await savePrefs(rig);
    expect(await completeOnboarding(rig.scope, rig.deps)).toEqual({ ok: false, missing: ['forms'] });
  });

  it('needs saved preferences', async () => {
    await saveBrief(rig);
    await selectForms(rig);
    expect(await completeOnboarding(rig.scope, rig.deps)).toEqual({ ok: false, missing: ['preferences'] });
  });

  it('completes onboarding, makes the account active and moves every floor to the finish time', async () => {
    await saveBrief(rig);
    await selectForms(rig);
    await savePrefs(rig);
    rig.clock.advance(3 * MINUTE);
    const finishedAt = rig.clock.now();

    expect(await completeOnboarding(rig.scope, rig.deps)).toEqual({ ok: true, alreadyComplete: false, processingState: 'active' });
    expect(await account()).toEqual({ processing_state: 'active', onboarding_completed_at: finishedAt });
    const floors = await getDb().query<{ intake_floor_at: Date; cursor_submitted_at: Date }>(
      `select intake_floor_at, cursor_submitted_at from selected_forms where account_id = $1`,
      [rig.accountId],
    );
    expect(floors).toHaveLength(2);
    for (const floor of floors) expect(floor).toEqual({ intake_floor_at: finishedAt, cursor_submitted_at: finishedAt });
    expect(await getDb().query(`select actor, action from audit_log where account_id = $1`, [rig.accountId])).toEqual([
      { actor: 'owner', action: 'onboarding.completed' },
    ]);
    expect((await onboardingStatus(rig.scope, rig.deps)).gate).toEqual({ ready: true, missing: [], completed: true });
  });

  it('changes nothing when Finish is pressed again', async () => {
    await saveBrief(rig);
    await selectForms(rig);
    await savePrefs(rig);
    const finishedAt = rig.clock.now();
    await completeOnboarding(rig.scope, rig.deps);
    rig.clock.advance(MINUTE);
    expect(await completeOnboarding(rig.scope, rig.deps)).toEqual({ ok: true, alreadyComplete: true, processingState: 'active' });
    expect((await account()).onboarding_completed_at).toEqual(finishedAt);
  });

  it('warns when no alert address is confirmed yet, without blocking Finish', async () => {
    await saveBrief(rig);
    await selectForms(rig);
    await savePrefs(rig, { notify_emails: ['office@example.com'] });
    expect(await getOnboardingGate(rig.scope, rig.deps)).toMatchObject({ ready: true, noConfirmedNotifyAddress: true });
  });
});

describe('GET /api/onboarding/status (view)', () => {
  it('reports nothing started on a fresh account', async () => {
    expect(await onboardingStatus(rig.scope, rig.deps)).toEqual({
      brief: { status: 'none', errorCode: null },
      inboxCheck: { status: 'none', sendLeg: null, replyLeg: null },
      baseline: { state: 'not_started', status: null },
      gate: { ready: false, missing: ['brief', 'forms', 'preferences'], completed: false },
    });
  });

  it("reports the newest inbox check's legs", async () => {
    await getDb().query(
      `insert into inbox_checks (account_id, test_address_hmac, send_leg, reply_leg, status, created_at) values ($1, $2, 'passed', 'pending', 'open', $3)`,
      [rig.accountId, 'a'.repeat(64), rig.clock.now()],
    );
    expect((await onboardingStatus(rig.scope, rig.deps)).inboxCheck).toEqual({ status: 'open', sendLeg: 'passed', replyLeg: 'pending' });
  });
});
