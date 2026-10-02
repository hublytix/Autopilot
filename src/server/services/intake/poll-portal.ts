import 'server-only';
import { z } from 'zod';
import { isAppError } from '@/server/domain/errors';
import type { HubSpotContactProperty, IntakeTrigger } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { publishJobs, raiseAlert } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { Deps, FormSubmission, SubmissionPage } from '@/server/ports';
import { insertAuditOnce } from '@/server/services/audit';
import { forAccount, type PortalHubSpotClient, type Sleep } from '@/server/services/hubspot';
import { LeaseNames, withLease } from '@/server/services/leases';
import { insertLead } from './insert-lead';
import { emailHmac, fillFromContact, submissionContent, submissionKey } from './submission';
import { isTestAddressSubmission, loadInboxCheckWindows, type InboxCheckWindow } from './test-address';

// pollPortal (PLAN §9.2, D-07, D-14, D-16, D-31): reads each selected form's submissions and turns
// the new ones into leads. It runs under the per-account lease, for `active` accounts only.
//
// For each selected form:
// 1. page through submissions newest first (50 per page) until a page has nothing newer than
//    `cursor − 60 min`, or 20 pages (alert at the cap). The 60-minute overlap lets a submission
//    whose contact is not visible yet be retried for an hour;
// 2. keep only submissions newer than the floor (`intake_floor_at`) and the overlap; skip inbox-check
//    test addresses (counted as processed);
// 3. for each new submission, oldest first: resolve the contact by email (a 404 waits for a later
//    poll while the submission is under an hour old; after that, an audit entry (form id and
//    instant only) and an alert, and it counts as processed); fill missing fields from the
//    contact; insert the lead, its content and its lead_process job in one transaction; publish
//    after commit;
// 4. cursor = GREATEST(cursor, newest processed or skipped submittedAt), but always less than an
//    hour past the oldest submission still waiting for its contact, so the next poll's overlap
//    still reaches it (otherwise a newer submission at exactly +60 min, or HubSpot's clock running
//    ahead of ours, could push it out unseen and its give-up would never be recorded).
// Then `last_polled_at = $now`. Submissions already stored are recognised by their submission key
// before any contact lookup, so the overlap costs one listing per form, not one lookup per lead.

/** How far below the cursor each poll looks again (D-07). */
export const POLL_OVERLAP_MS = 60 * 60 * 1000;
/** Submissions per page: the endpoint's maximum. */
export const SUBMISSIONS_PAGE_SIZE = 50;
/** Pages per form per poll (1,000 submissions). */
export const MAX_SUBMISSION_PAGES = 20;
/** The per-account lease: longer than one poll, shorter than the job lease (6 min). */
export const ACCOUNT_POLL_LEASE_MS = 5 * 60 * 1000;

/** The contact properties intake reads (D-31): the lead fields only. */
export const INTAKE_CONTACT_PROPERTIES = [
  'firstname',
  'lastname',
  'company',
  'message',
  'email',
] as const satisfies readonly HubSpotContactProperty[];

export type PollTrigger = Exclude<IntakeTrigger, 'inbox_check'>;

export interface PollPortalOptions {
  /** Count refresh failures for the D-11 inline backoff. Default: true for `cron`, false for `webhook` (a job). */
  inline?: boolean | undefined;
  /** For the portal limiter; default real timers (tests advance their FakeClock instead). */
  sleep?: Sleep | undefined;
  /** Bounds every HubSpot call (the poll cron's remaining budget). */
  signal?: AbortSignal | undefined;
}

export interface PollCounts {
  forms: number;
  pages: number;
  /** Submissions newer than the floor and the overlap. */
  considered: number;
  leadsCreated: number;
  /** Already a lead (by submission key, or a unique-key conflict at insert). */
  alreadyKnown: number;
  testAddressSkipped: number;
  /** Contact not visible yet; retried by later polls. */
  contactPending: number;
  /** Contact still missing an hour after the submission: audited, given up. */
  contactMissing: number;
  withoutEmail: number;
  pageCapReached: number;
  /** Selected forms HubSpot no longer knows (404). */
  formsMissing: number;
}

export type PollPortalResult =
  | { readonly status: 'polled'; readonly counts: PollCounts }
  /** Another poll of this account holds the lease. */
  | { readonly status: 'busy' }
  /** The account (or its connection) is not active: nothing is polled. */
  | { readonly status: 'not_active' };

function emptyCounts(): PollCounts {
  return {
    forms: 0,
    pages: 0,
    considered: 0,
    leadsCreated: 0,
    alreadyKnown: 0,
    testAddressSkipped: 0,
    contactPending: 0,
    contactMissing: 0,
    withoutEmail: 0,
    pageCapReached: 0,
    formsMissing: 0,
  };
}

const targetSchema = z.object({ processing_state: z.string(), connection_status: z.string().nullable() });

const formSchema = z.object({ form_id: z.string(), intake_floor_at: z.date(), cursor_submitted_at: z.date() });

interface SelectedForm {
  formId: string;
  floor: Date;
  cursor: Date;
}

async function isPollable(db: Db, accountId: string): Promise<boolean> {
  const raw = await db.maybeOne(
    `select a.processing_state, c.status as connection_status
       from accounts a left join hubspot_connections c on c.account_id = a.id
      where a.id = $1`,
    [accountId],
  );
  if (raw === null) return false;
  const row = targetSchema.parse(raw);
  return row.processing_state === 'active' && row.connection_status === 'active';
}

async function loadSelectedForms(db: Db, accountId: string): Promise<SelectedForm[]> {
  const rows = await db.query(
    `select form_id, intake_floor_at, cursor_submitted_at from selected_forms
      where account_id = $1 and selected order by form_id`,
    [accountId],
  );
  return rows.map((raw) => {
    const row = formSchema.parse(raw);
    return { formId: row.form_id, floor: row.intake_floor_at, cursor: row.cursor_submitted_at };
  });
}

/** Polls one account. Throws what the HubSpot client throws (revoked, transient), after releasing the lease. */
export async function pollPortal(deps: Deps, accountId: string, trigger: PollTrigger, options: PollPortalOptions = {}): Promise<PollPortalResult> {
  const run = await withLease(
    deps.db,
    { name: LeaseNames.accountPoll(accountId), ttlMs: ACCOUNT_POLL_LEASE_MS, now: deps.clock.now() },
    () => pollUnderLease(deps, accountId, trigger, options),
  );
  if (!run.acquired) {
    log.info('portal poll skipped: lease held', { event: 'intake.poll_busy', accountId, reason: trigger });
    return { status: 'busy' };
  }
  return run.value;
}

async function pollUnderLease(deps: Deps, accountId: string, trigger: PollTrigger, options: PollPortalOptions): Promise<PollPortalResult> {
  if (!(await isPollable(deps.db, accountId))) return { status: 'not_active' };
  const forms = await loadSelectedForms(deps.db, accountId);
  const checks = await loadInboxCheckWindows(deps.db, accountId);
  const client = forAccount(deps, accountId, { inline: options.inline ?? trigger === 'cron', sleep: options.sleep });
  const counts = emptyCounts();
  for (const form of forms) {
    await pollForm(deps, client, { accountId, trigger, form, checks, signal: options.signal }, counts);
  }
  await deps.db.query(`update hubspot_connections set last_polled_at = $2 where account_id = $1`, [accountId, deps.clock.now()]);
  log.info('portal polled', {
    event: 'intake.polled',
    accountId,
    reason: trigger,
    count: counts.leadsCreated,
    pages: counts.pages,
    skipped: counts.testAddressSkipped + counts.contactMissing + counts.withoutEmail,
  });
  return { status: 'polled', counts };
}

interface FormPoll {
  accountId: string;
  trigger: PollTrigger;
  form: SelectedForm;
  checks: readonly InboxCheckWindow[];
  signal: AbortSignal | undefined;
}

function isNotFound(error: unknown): boolean {
  return isAppError(error) && error.code === 'hubspot_not_found';
}

/** Step 1: the pages that reach back to `cursor − 60 min` (or the cap). Null when the form is gone. */
async function readSubmissions(client: PortalHubSpotClient, poll: FormPoll, counts: PollCounts): Promise<FormSubmission[] | null> {
  const threshold = poll.form.cursor.getTime() - POLL_OVERLAP_MS;
  const submissions: FormSubmission[] = [];
  let after: string | undefined;
  for (let pages = 1; ; pages += 1) {
    let page: SubmissionPage;
    try {
      page = await client.listSubmissions(poll.form.formId, { limit: SUBMISSIONS_PAGE_SIZE, after, signal: poll.signal });
    } catch (error) {
      if (pages === 1 && isNotFound(error)) return null;
      throw error;
    }
    counts.pages += 1;
    submissions.push(...page.results);
    if (!page.results.some((s) => s.submittedAt.getTime() > threshold)) break;
    if (page.nextAfter === undefined) break;
    if (pages >= MAX_SUBMISSION_PAGES) {
      counts.pageCapReached += 1;
      log.warn('submission page cap reached', { event: 'intake.page_cap', accountId: poll.accountId, formId: poll.form.formId, pages });
      raiseAlert('intake_page_cap_reached', { accountId: poll.accountId, formId: poll.form.formId, pages });
      break;
    }
    after = page.nextAfter;
  }
  return submissions;
}

interface Candidate {
  submission: FormSubmission;
  key: string;
}

/** Step 2's filter: newer than the floor and the overlap, each submission once, oldest first. */
function candidatesOf(deps: Deps, poll: FormPoll, submissions: readonly FormSubmission[]): Candidate[] {
  const lowerBound = Math.max(poll.form.floor.getTime(), poll.form.cursor.getTime() - POLL_OVERLAP_MS);
  const byKey = new Map<string, Candidate>();
  for (const submission of submissions) {
    if (submission.submittedAt.getTime() <= lowerBound) continue;
    const key = submissionKey(deps.env, poll.form.formId, submission, submissionContent(submission).email);
    if (!byKey.has(key)) byKey.set(key, { submission, key });
  }
  return [...byKey.values()].sort((a, b) => a.submission.submittedAt.getTime() - b.submission.submittedAt.getTime());
}

async function knownSubmissionKeys(db: Db, accountId: string, formId: string, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db.query<{ submission_key: string }>(
    `select submission_key from leads where account_id = $1 and form_id = $2 and submission_key = any($3::text[])`,
    [accountId, formId, [...keys]],
  );
  return new Set(rows.map((row) => row.submission_key));
}

async function pollForm(deps: Deps, client: PortalHubSpotClient, poll: FormPoll, counts: PollCounts): Promise<void> {
  const { accountId } = poll;
  const { formId } = poll.form;
  counts.forms += 1;
  const submissions = await readSubmissions(client, poll, counts);
  if (submissions === null) {
    counts.formsMissing += 1;
    log.warn('selected form not found in HubSpot', { event: 'intake.form_missing', accountId, formId });
    return;
  }
  const candidates = candidatesOf(deps, poll, submissions);
  counts.considered += candidates.length;
  const known = await knownSubmissionKeys(deps.db, accountId, formId, candidates.map((c) => c.key));

  let processedUpTo: Date | null = null;
  let oldestPending: Date | null = null;
  for (const { submission, key } of candidates) {
    const outcome = await processSubmission(deps, client, poll, submission, key, known, counts);
    if (outcome === 'processed') processedUpTo = submission.submittedAt;
    else oldestPending ??= submission.submittedAt;
  }
  const cursor = cappedCursor(processedUpTo, oldestPending);
  if (cursor !== null) {
    await deps.db.query(
      `update selected_forms set cursor_submitted_at = greatest(cursor_submitted_at, $3) where account_id = $1 and form_id = $2`,
      [accountId, formId, cursor],
    );
  }
}

/** Step 4's cursor: the newest processed submission, kept under `oldest pending + overlap` (strictly). */
export function cappedCursor(processedUpTo: Date | null, oldestPending: Date | null): Date | null {
  if (processedUpTo === null || oldestPending === null) return processedUpTo;
  const limit = oldestPending.getTime() + POLL_OVERLAP_MS - 1;
  return processedUpTo.getTime() > limit ? new Date(limit) : processedUpTo;
}

/** `processed` moves the cursor (a lead, a known one, or a deliberate skip); `retry` leaves it to a later poll. */
async function processSubmission(
  deps: Deps,
  client: PortalHubSpotClient,
  poll: FormPoll,
  submission: FormSubmission,
  key: string,
  known: ReadonlySet<string>,
  counts: PollCounts,
): Promise<'processed' | 'retry'> {
  const { accountId } = poll;
  const { formId } = poll.form;
  if (known.has(key)) {
    counts.alreadyKnown += 1;
    return 'processed';
  }
  const content = submissionContent(submission);
  if (content.email === null) {
    // HubSpot matches submissions to contacts by email only: without one there is no lead.
    counts.withoutEmail += 1;
    log.info('submission without an email skipped', { event: 'intake.no_email', accountId, formId });
    return 'processed';
  }
  if (isTestAddressSubmission(poll.checks, emailHmac(deps.env, content.email), submission.submittedAt)) {
    counts.testAddressSkipped += 1;
    log.info('inbox-check test submission skipped', { event: 'intake.test_address_skipped', accountId, formId });
    return 'processed';
  }

  const contact = await client.getContact(content.email, { idProperty: 'email', properties: INTAKE_CONTACT_PROPERTIES, signal: poll.signal });
  if (contact === null) {
    if (deps.clock.now().getTime() - submission.submittedAt.getTime() <= POLL_OVERLAP_MS) {
      counts.contactPending += 1;
      return 'retry';
    }
    counts.contactMissing += 1;
    await recordContactMissing(deps, { accountId, formId, submittedAt: submission.submittedAt });
    return 'processed';
  }

  const inserted = await insertLead(deps.db, {
    accountId,
    contactId: contact.id,
    formId,
    submittedAt: submission.submittedAt,
    conversionId: submission.conversionId ?? null,
    submissionKey: key,
    trigger: poll.trigger,
    content: fillFromContact(content, contact),
    now: deps.clock.now(),
  });
  if (inserted === null) {
    counts.alreadyKnown += 1;
    return 'processed';
  }
  counts.leadsCreated += 1;
  log.info('lead created', { event: 'intake.lead_created', accountId, leadId: inserted.leadId, formId, contactId: contact.id, reason: poll.trigger });
  await publishJobs(deps, [inserted.job]);
  return 'processed';
}

/**
 * A submission whose contact never became visible within the overlap: one audit entry and one
 * alert, however often later polls see it again. The entry holds the form id and the submission
 * instant only: never content, and never the submission key, which without a conversion id is an
 * HMAC of the lead's email (D-31) and would outlive the 30-day purge and a privacy deletion in a
 * table neither touches. The form and instant identify the submission well enough to dedupe on.
 */
async function recordContactMissing(deps: Deps, input: { accountId: string; formId: string; submittedAt: Date }): Promise<void> {
  const written = await insertAuditOnce(
    deps.db,
    {
      accountId: input.accountId,
      actor: 'system',
      action: 'intake.contact_not_found',
      level: 'warn',
      meta: { formId: input.formId, submittedAt: input.submittedAt.toISOString() },
    },
    ['formId', 'submittedAt'],
  );
  if (!written) return;
  log.warn('submission contact not found', { event: 'intake.contact_not_found', accountId: input.accountId, formId: input.formId });
  raiseAlert('intake_contact_not_found', { accountId: input.accountId, formId: input.formId });
}
