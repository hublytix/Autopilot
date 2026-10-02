import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLeadControl } from '@/server/actions/dashboard';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth/owner-scope';
import { leadDetailView, refreshLeadSignals } from '@/server/views/dashboard';
import { useTestDb as setUpTestDb } from '../db/harness';
import { at, createSignalsRig, DAY, HOUR, LEAD_EMAIL, seedNotifiedLead, signalRow, type SignalsRig } from '../signals/support';

// D-68/D-73's M6 gate: the reply_detected email says "you can resume follow-ups" only because the
// lead page offers it. The email links to /dashboard/leads/{id}; that page offers "Resume follow-ups"
// for the replied lead, and the control calls resumeFollowUps (a new stream of follow-ups).

const getDb = setUpTestDb();
let rig: SignalsRig;
let scope: OwnerScope;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  rig = await createSignalsRig(getDb());
  const owner = await getDb().one<{ owner_user_id: string }>(`select owner_user_id from accounts where id = $1`, [rig.accountId]);
  scope = createOwnerScopeForTest(rig.accountId, owner.owner_user_id);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reply_detected → the lead page → Resume follow-ups', () => {
  it('the email links to the lead page, which offers Resume follow-ups, which resumes them', async () => {
    const t0 = rig.clock.now();
    const lead = await seedNotifiedLead(rig);
    rig.clock.set(at(t0, DAY));
    // An out-of-office auto-reply, logged in HubSpot an hour after the owner's email.
    rig.hubspot.logLeadReply({ from: LEAD_EMAIL, at: at(t0, HOUR) });

    // The lead page's refresh finds it, stops the follow-ups and emails the owner.
    expect(await refreshLeadSignals(scope, rig.deps, lead.leadId, { applyOptions: { sleep: rig.sleep, notifications: rig.notifications } })).toMatchObject({
      type: 'checked',
      markedReplied: true,
    });
    const mails = rig.fakes.mailer.sent.filter((mail) => mail.kind === 'reply_detected');
    expect(mails).toHaveLength(1);
    const pageUrl = `${rig.deps.env.APP_URL}/dashboard/leads/${lead.leadId}`;
    expect(mails[0]?.html).toContain(`href="${pageUrl}"`);
    expect(mails[0]?.text).toContain('If it was an automatic reply, such as an out-of-office message, you can resume follow-ups');

    const view = await leadDetailView(scope, rig.deps, lead.leadId);
    expect(view).toMatchObject({ status: 'replied', controls: { resumeFollowUps: 'available' } });

    rig.clock.advance({ minutes: 5 });
    expect(await runLeadControl(rig.deps, scope, 'resume_followups', lead.leadId)).toBe(`/dashboard/leads/${lead.leadId}?result=resume_followups.resumed`);
    expect(await signalRow(getDb(), lead.leadId)).toMatchObject({ replied_at: null, stop_reason: null, followup_stream: 1 });
    expect((await leadDetailView(scope, rig.deps, lead.leadId))?.upcomingFollowUps.map((followUp) => followUp.n)).toEqual([1, 2]);
  });
});
