// Simulation stage 2, Day 0 (PLAN §13 calendar, D-39), Tue 2026-10-06 America/New_York:
//   #1 10:00 new contact, normal enquiry      webhook
//   #2 10:05 new contact, no message           webhook
//   #3 10:10 new contact, spam                 webhook
//   #4 10:15 new contact, vendor pitch         webhook
//   #6 10:20 new contact, the future replier   webhook
//   #5 10:31 a baseline-fixture contact again  NO webhook: the 10:35 cron poll finds it
// Each webhook is HubSpot's `object.creation` for the new contact, v3-signed for
// HUBSPOT_WEBHOOK_TARGET_URL, delivered to the real route handler. M2 checks intake and
// classification. Since M4 the real lead_process also drafts #1, #2, #5 and #6 and sends their
// `new_lead` emails, and the owner's Day 0 taps run here too (day0-owner.ts: Send on #1 at 10:12,
// #2 at 10:30, #6 at 10:40); the emails, clicks, follow-up rows and statuses are checked by the
// `day-0-emails` stage (day0-emails.ts).
import { handleHubSpotWebhook } from '@/server/http/hubspot-webhook';
import { scheduleDay0OwnerActions } from './day0-owner';
import { DAY0_END, DAY0_NOTIFIED, DAY0_SUBMISSIONS, type ScenarioSubmission } from './day0-scenario';
import type { Simulation } from './types';

/** One scenario submission through the fake portal, and its signed webhook when HubSpot sends one (the M7 variants reuse it). */
export async function submit(sim: Simulation, submission: ScenarioSubmission): Promise<void> {
  const { hubspot } = sim.fakes;
  const result = hubspot.submitForm({
    formId: hubspot.formIdByName(submission.form),
    email: submission.email,
    firstName: submission.firstName,
    lastName: submission.lastName,
    company: submission.company,
    message: submission.message,
    newContact: submission.webhook,
  });
  const ref = `L${submission.n}`;
  if (result.contactId !== null) sim.declareLead(ref, { contactId: result.contactId, submittedAt: sim.clock.now() });
  sim.record('step', 'portal.form_submitted', {
    lead: ref,
    form: submission.form,
    newContact: result.createdContact,
    hasMessage: submission.message !== undefined,
    webhook: submission.webhook,
  });
  if (!submission.webhook || result.contactId === null) return;

  const env = sim.deps.env;
  const signed = hubspot.signedWebhook([{ subscriptionType: 'object.creation', objectId: result.contactId }], {
    uri: env.HUBSPOT_WEBHOOK_TARGET_URL,
  });
  const response = await handleHubSpotWebhook(
    new Request(env.HUBSPOT_WEBHOOK_TARGET_URL, { method: 'POST', headers: signed.headers, body: signed.body }),
    sim.deps,
  );
  const body = (await response.json()) as Record<string, unknown>;
  const count = (name: string): number | null => (typeof body[name] === 'number' ? body[name] : null);
  sim.record('intake', 'webhook.object_creation', {
    lead: ref,
    httpStatus: response.status,
    events: count('events'),
    pollsQueued: count('pollsQueued'),
    pollsDebounced: count('pollsDebounced'),
  });
}

interface LeadRow {
  hubspot_contact_id: string;
  submitted_at: Date;
  received_at: Date;
  intake_trigger: string;
  classification: string | null;
  processing_state: string;
  is_test: boolean;
}

/** Schedules Day 0's six submissions (and their webhooks) at their PLAN §13 times; the daily-cap variant reuses it. */
export function scheduleDay0Submissions(sim: Simulation): void {
  for (const submission of DAY0_SUBMISSIONS) {
    sim.travel.at(sim.local(submission.at), `submission #${submission.n}`, () => submit(sim, submission));
  }
}

export async function runDay0(sim: Simulation): Promise<void> {
  const emailsBefore = sim.fakes.mailer.sent.length;
  const aiCallsBefore = (await sim.db.one<{ n: number }>('select count(*)::int as n from public.ai_calls')).n;
  scheduleDay0Submissions(sim);
  scheduleDay0OwnerActions(sim);
  await sim.travel.advanceTo(sim.local(DAY0_END));

  const accountId = sim.scenario.accountId;
  const rows =
    accountId === null
      ? []
      : await sim.db.query<LeadRow>(
          `select hubspot_contact_id, submitted_at, received_at, intake_trigger, classification, processing_state, is_test
             from public.leads where account_id = $1 order by submitted_at`,
          [accountId],
        );
  const leads = rows.filter((row) => !row.is_test);
  sim.check('day0.six_leads', leads.length === 6, `${leads.length} non-test leads`);

  const { hubspot } = sim.fakes;
  for (const submission of DAY0_SUBMISSIONS) {
    const contactId = hubspot.contactIdByEmail(submission.email);
    const submittedAt = sim.local(submission.at).getTime();
    const lead = leads.find((row) => row.hubspot_contact_id === contactId && row.submitted_at.getTime() === submittedAt);
    const ref = `L${submission.n}`;
    const { expected } = submission;
    sim.check(
      `day0.${ref}.classified_${expected.classification}_${expected.processingState}`,
      lead?.classification === expected.classification && lead.processing_state === expected.processingState,
      lead === undefined ? 'no lead' : `${lead.classification ?? 'unclassified'} / ${lead.processing_state}`,
    );
    sim.check(`day0.${ref}.intake_trigger_${expected.trigger}`, lead?.intake_trigger === expected.trigger, `intake_trigger ${lead?.intake_trigger ?? 'none'}`);
  }

  // #5 had no webhook: the first cron poll after 10:31 (10:35) found it.
  const fifth = DAY0_SUBMISSIONS.find((submission) => submission.n === 5);
  const fifthLead = fifth === undefined ? undefined : leads.find((row) => row.hubspot_contact_id === hubspot.contactIdByEmail(fifth.email) && row.submitted_at.getTime() === sim.local(fifth.at).getTime());
  sim.check(
    'day0.L5.picked_up_by_the_1035_cron_poll',
    fifthLead?.received_at.getTime() === sim.local('2026-10-06T10:35:00').getTime(),
    `received_at ${fifthLead?.received_at.toISOString() ?? 'none'}`,
  );

  const floor = sim.scenario.onboardingCompletedAt;
  const historical = floor === null ? leads.length : leads.filter((row) => row.submitted_at.getTime() <= floor.getTime()).length;
  sim.check('day0.no_historical_lead', floor !== null && historical === 0, `${historical} leads submitted before the floor`);

  // M4: lead_process drafts #1, #2, #5 and #6 and emails each one (the emails are checked in day0-emails.ts).
  const day0Emails = sim.fakes.mailer.sent.slice(emailsBefore).map((mail) => mail.kind);
  sim.check(
    'day0.four_new_lead_emails_and_nothing_else',
    day0Emails.length === DAY0_NOTIFIED.length && day0Emails.every((kind) => kind === 'new_lead'),
    day0Emails.join(', ') || 'no emails',
  );

  // Every job has finished except the follow-up rows of the "notified" transactions (2 per notified
  // lead, Thu and Sun); they wait in the scheduler until M5's follow-up job runs them.
  const unfinished = await sim.db.query<{ kind: string; status: string }>(
    `select kind, status from public.scheduled_jobs where status not in ('done', 'cancelled', 'skipped') order by kind, status`,
  );
  const unfinishedOther = unfinished.filter((row) => !(row.kind === 'followup' && row.status === 'scheduled'));
  const followUps = unfinished.length - unfinishedOther.length;
  sim.check(
    'day0.every_job_done_cancelled_or_skipped_but_the_follow_ups',
    unfinishedOther.length === 0 && followUps === 2 * DAY0_NOTIFIED.length,
    `${followUps} follow-ups scheduled${unfinishedOther.length === 0 ? '' : `; unfinished ${unfinishedOther.map((row) => `${row.kind}:${row.status}`).join(', ')}`}`,
  );
  const pending = sim.fakes.scheduler.pending();
  sim.check(
    'day0.only_the_follow_ups_are_queued',
    pending.length === 2 * DAY0_NOTIFIED.length && pending.every((message) => message.kind === 'followup'),
    `${pending.length} queued: ${[...new Set(pending.map((message) => message.kind))].join(', ') || 'none'}`,
  );

  const aiCalls = (
    await sim.db.query<{ purpose: string; model: string; outcome: string }>(`select purpose, model, outcome from public.ai_calls order by created_at, purpose`)
  ).slice(aiCallsBefore);
  const { ANTHROPIC_MODEL_FAST: fast, ANTHROPIC_MODEL_DRAFT: draftModel } = sim.deps.env;
  const classifyCalls = aiCalls.filter((call) => call.purpose === 'classify');
  sim.check(
    'day0.classification_calls_use_the_fast_model',
    classifyCalls.length === DAY0_SUBMISSIONS.length && classifyCalls.every((call) => call.model === fast && call.outcome === 'ok'),
    classifyCalls.map((call) => `${call.model}:${call.outcome}`).join(', '),
  );
  const draftCalls = aiCalls.filter((call) => call.purpose !== 'classify');
  sim.check(
    'day0.one_draft_call_per_notified_lead_on_the_draft_model',
    draftCalls.length === DAY0_NOTIFIED.length && draftCalls.every((call) => call.purpose === 'draft' && call.model === draftModel && call.outcome === 'ok'),
    draftCalls.map((call) => `${call.purpose}:${call.model}:${call.outcome}`).join(', '),
  );
}
