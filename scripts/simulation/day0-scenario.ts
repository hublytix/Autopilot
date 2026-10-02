// The Day 0 scenario (PLAN §13 calendar, D-39): the six submissions, who gets an email, and how
// the simulation finds the lead each one created. Shared by the Day 0 stages.
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
    expected: { classification: 'lead', processingState: 'notified', trigger: 'webhook' },
  },
  {
    n: 2,
    at: '2026-10-06T10:05:00',
    form: CONTACT_US,
    email: 'alex.morgan@example.org',
    firstName: 'Alex',
    lastName: 'Morgan',
    webhook: true,
    expected: { classification: 'unclear', processingState: 'notified', trigger: 'webhook' },
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
    email: 'riley.chen@example.net',
    firstName: 'Riley',
    lastName: 'Chen',
    message: 'Our kitchen sink drains very slowly and gurgles when the dishwasher runs. Could someone come by Thursday or Friday?',
    webhook: true,
    expected: { classification: 'lead', processingState: 'notified', trigger: 'webhook' },
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
    expected: { classification: 'lead', processingState: 'notified', trigger: 'cron' },
  },
];

/** End of Day 0's intake window (the last owner action of Day 0 is at 10:41). */
export const DAY0_END = '2026-10-06T10:41:00';

/** The submission #n of Day 0. */
export function day0Submission(n: number): ScenarioSubmission {
  const submission = DAY0_SUBMISSIONS.find((candidate) => candidate.n === n);
  if (submission === undefined) throw new Error(`simulation: no Day 0 submission #${n}`);
  return submission;
}

/** The lead submission #n created (by its contact and submission time), or null. */
export async function day0LeadId(sim: Simulation, n: number): Promise<string | null> {
  const submission = day0Submission(n);
  const contactId = sim.fakes.hubspot.contactIdByEmail(submission.email);
  if (contactId === null) return null;
  const row = await sim.db.maybeOne<{ id: string }>(
    'select id from public.leads where hubspot_contact_id = $1 and submitted_at = $2 and not is_test',
    [contactId, sim.local(submission.at)],
  );
  return row?.id ?? null;
}

/** The leads Day 0 drafts and emails (PLAN §13: `new_lead` ×4). */
export const DAY0_NOTIFIED = [1, 2, 5, 6] as const;

