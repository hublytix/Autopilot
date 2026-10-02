// The onboarding test lead's exclusions, checked after every later stage has run (PLAN §13 "the
// test lead is absent from every list and metric, has no follow_up or reply_detected email and no
// followup jobs"). Later milestones append their stages before this one; M6 adds the metrics.
import { summaryLeadRows } from './leads';
import type { Simulation } from './types';

const LEAD_EMAIL_KINDS: ReadonlySet<string> = new Set(['new_lead', 'needs_touch', 'follow_up', 'reply_detected']);

export async function checkTestLeadExclusions(sim: Simulation): Promise<void> {
  const testLeads = await sim.db.query<{ id: string; processing_state: string; stop_reason: string | null }>(
    'select id, processing_state, stop_reason from public.leads where is_test',
  );
  const test = testLeads[0];
  sim.check('test_lead.exists_once', testLeads.length === 1, `${testLeads.length} test leads`);
  if (test === undefined) return;

  const listed = await summaryLeadRows(sim.db);
  sim.check('test_lead.absent_from_leads', !listed.some((row) => row.id === test.id), `${listed.length} leads listed`);

  const jobs = await sim.db.query<{ kind: string }>('select kind from public.scheduled_jobs where lead_id = $1 order by kind', [test.id]);
  sim.check('test_lead.no_lead_or_followup_jobs', jobs.length === 0, jobs.map((row) => row.kind).join(', ') || 'none');

  // Lead emails are keyed by the lead (NotificationKeys: `notify:{lead}:…`, `reply:{lead}:…`); the
  // inbox_test email is keyed by its check, so it is not one of them.
  const leadEmails = sim.fakes.mailer.sent.filter((mail) => LEAD_EMAIL_KINDS.has(mail.kind));
  const forTest = sim.fakes.mailer.sent.filter((mail) => mail.lead === test.id || mail.idempotencyKey.includes(`:${test.id}:`));
  sim.check('test_lead.no_lead_emails', forTest.length === 0, forTest.map((mail) => mail.kind).join(', ') || `none (of ${leadEmails.length} lead emails)`);

  const notifications = await sim.db.query<{ kind: string }>(
    `select kind from public.notifications_sent where lead_id = $1 and kind in ('new_lead', 'needs_touch', 'follow_up', 'reply_detected') order by kind`,
    [test.id],
  );
  sim.check('test_lead.no_follow_up_or_reply_detected_reservation', notifications.length === 0, notifications.map((row) => row.kind).join(', ') || 'none');
  sim.check('test_lead.stays_out_of_processing', test.stop_reason === 'test_lead', `stop_reason ${test.stop_reason ?? 'null'}`);
}
