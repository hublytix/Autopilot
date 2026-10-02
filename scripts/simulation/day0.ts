// Simulation stage 2, Day 0 intake (PLAN §13 calendar, D-39), Tue 2026-10-06 America/New_York:
//   #1 10:00 new contact, normal enquiry      webhook
//   #2 10:05 new contact, no message           webhook
//   #3 10:10 new contact, spam                 webhook
//   #4 10:15 new contact, vendor pitch         webhook
//   #6 10:20 new contact, the future replier   webhook
//   #5 10:31 a baseline-fixture contact again  NO webhook: the 10:35 cron poll finds it
// Each webhook is HubSpot's `object.creation` for the new contact, v3-signed for
// HUBSPOT_WEBHOOK_TARGET_URL, delivered to the real route handler. M2 checks intake and
// classification only; drafts and the "new lead" emails arrive in M4.
import { handleHubSpotWebhook } from '@/server/http/hubspot-webhook';
import type { Simulation } from './types';

const CONTACT_US = 'Contact us';
const REQUEST_A_QUOTE = 'Request a quote';

/** One scenario submission. Every name, address and message is invented (example domains). */
export interface ScenarioSubmission {
  /** The scenario's number (#1…#6); the lead's ref is `L{n}`. */
  n: number;
  /** Local time on Tue 2026-10-06. */
  at: string;
  form: string;
  email: string;
  firstName: string;
  lastName: string;
  company?: string | undefined;
  /** Omitted: the lead left the message field empty (#2). */
  message?: string | undefined;
  /** HubSpot fires `object.creation` only for a contact the submission created. */
  webhook: boolean;
  expected: { classification: string; processingState: string; trigger: 'webhook' | 'cron' };
}

export const DAY0_SUBMISSIONS: readonly ScenarioSubmission[] = [
  {
    n: 1,
    at: '2026-10-06T10:00:00',
    form: REQUEST_A_QUOTE,
    email: 'jordan.lee@example.com',
    firstName: 'Jordan',
    lastName: 'Lee',
    company: 'Lee Property Management',
    message: 'We manage a small apartment building and need a quote to replace the main water shut-off valve. Is next week possible?',
    webhook: true,
    expected: { classification: 'lead', processingState: 'processing', trigger: 'webhook' },
  },
  {
    n: 2,
    at: '2026-10-06T10:05:00',
    form: CONTACT_US,
    email: 'alex.morgan@example.org',
    firstName: 'Alex',
    lastName: 'Morgan',
    webhook: true,
    expected: { classification: 'unclear', processingState: 'processing', trigger: 'webhook' },
  },
  {
    n: 3,
    at: '2026-10-06T10:10:00',
    form: CONTACT_US,
    email: 'promo.desk@example.net',
    firstName: 'Promo',
    lastName: 'Desk',
    message: 'Earn daily with bitcoin trading from home. Click here to claim your starter bonus today.',
    webhook: true,
    expected: { classification: 'spam', processingState: 'filtered', trigger: 'webhook' },
  },
  {
    n: 4,
    at: '2026-10-06T10:15:00',
    form: REQUEST_A_QUOTE,
    email: 'growth.team@example.com',
    firstName: 'Casey',
    lastName: 'Brandt',
    company: 'Rankwell Digital',
    message: 'We are a marketing agency that helps plumbers reach the first page of Google with our SEO packages. Can we book a call?',
    webhook: true,
    expected: { classification: 'vendor_pitch', processingState: 'filtered', trigger: 'webhook' },
  },
  {
    n: 6,
    at: '2026-10-06T10:20:00',
    form: CONTACT_US,
    email: 'dana.whitfield@example.net',
    firstName: 'Dana',
    lastName: 'Whitfield',
    message: 'Our kitchen sink drains very slowly and gurgles when the dishwasher runs. Could someone come by Thursday or Friday?',
    webhook: true,
    expected: { classification: 'lead', processingState: 'processing', trigger: 'webhook' },
  },
  {
    // Lena Fischer (fixture contact 105) wrote in on 2026-09-29 and never got a logged reply.
    n: 5,
    at: '2026-10-06T10:31:00',
    form: CONTACT_US,
    email: 'lena.fischer@example.org',
    firstName: 'Lena',
    lastName: 'Fischer',
    message: 'Following up on my note from last week: the water pressure upstairs is still low. Can someone come out this week?',
    webhook: false,
    expected: { classification: 'lead', processingState: 'processing', trigger: 'cron' },
  },
];

/** End of Day 0's intake window (the last owner action of Day 0 is at 10:41). */
export const DAY0_END = '2026-10-06T10:41:00';

async function submit(sim: Simulation, submission: ScenarioSubmission): Promise<void> {
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

export async function runDay0(sim: Simulation): Promise<void> {
  for (const submission of DAY0_SUBMISSIONS) {
    sim.travel.at(sim.local(submission.at), `submission #${submission.n}`, () => submit(sim, submission));
  }
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

  sim.check('day0.no_emails_yet', sim.fakes.mailer.sent.length === 0, `${sim.fakes.mailer.sent.length} emails`);

  const unfinished = await sim.db.query<{ kind: string; status: string }>(
    `select kind, status from public.scheduled_jobs where status not in ('done', 'cancelled', 'skipped') order by kind, status`,
  );
  sim.check(
    'day0.every_job_done_cancelled_or_skipped',
    unfinished.length === 0,
    unfinished.length === 0 ? undefined : unfinished.map((row) => `${row.kind}:${row.status}`).join(', '),
  );
  sim.check('day0.no_pending_deliveries', sim.fakes.scheduler.pending().length === 0, `${sim.fakes.scheduler.pending().length} queued`);

  const aiCalls = await sim.db.query<{ purpose: string; model: string; outcome: string }>(
    `select purpose, model, outcome from public.ai_calls order by created_at, purpose`,
  );
  const fast = sim.deps.env.ANTHROPIC_MODEL_FAST;
  sim.check(
    'day0.classification_calls_use_the_fast_model',
    aiCalls.length > 0 && aiCalls.every((call) => call.purpose === 'classify' && call.model === fast && call.outcome === 'ok'),
    aiCalls.map((call) => `${call.purpose}:${call.model}:${call.outcome}`).join(', '),
  );
}
