import 'server-only';
import { z } from 'zod';
import { errorCode, isAppError, isRetryable, isRevoked, TransientError } from '@/server/domain/errors';
import { CONNECTION_STATUSES, isDraftableClassification, type BaselineStatus, type EmailMetadataProperty } from '@/server/domain/types';
import type { Db } from '@/server/db';
import { canReadEmails } from '@/server/hubspot/scopes';
import { JobOutcomes, type JobContext, type JobFailureInfo, type JobHandler, type JobOutcome, type JobRow, type Registration } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { Deps, EmailEngagement, FormSubmission } from '@/server/ports';
import { classifyLead } from '@/server/services/classification';
import { forAccount, type PortalHubSpotClient, type Sleep } from '@/server/services/hubspot';
import { submissionContent } from '@/server/services/intake/submission';
import { baselineFigures } from './figures';
import { insertBaseline, MAX_BASELINE_SUBMISSIONS, type NewBaseline } from './repository';

// The `baseline` job (PLAN §8.2, §9.7, D-38): how the owner answered leads in the 30 days before
// Autopilot, from HubSpot data only (law 3: never estimate).
// 1. Read the last 30 days of submissions on the selected forms; above 500, "Not enough data"
//    (`insufficient`) without classifying anything.
// 2. Classify each one with the fast model, in memory: nothing about a submission is stored (only
//    the `ai_calls` rows, which hold no content). Keep `lead`/`unclear`; a submission without an
//    email address cannot be followed and is left out, as intake leaves it out.
// 3. Without the email scope the logged emails cannot be read: `unavailable`. Without any logged
//    outbound EMAIL in the portal in 30 days: `insufficient` ("Not enough logged history").
// 4. For each lead, the contact's associated emails (metadata only: time, direction, status,
//    recipients) give the first EMAIL sent TO the lead after the submission; a contact that no
//    longer exists is left out.
// 5. Store the lead count, the median wait (≥ 3 measured, D-38) and the number of leads without a
//    logged outbound email (`ok`, with the % available).
// A HubSpot or LLM failure that may pass retries (QStash backs off); after the last delivery the
// failure path stores `unavailable`. A revoked connection skips the job. Logs carry counts only.

export const BASELINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Inside the run route's 300 s maxDuration. */
export const BASELINE_JOB_BUDGET_MS = 270_000;
/** Classification calls in flight at once. */
export const BASELINE_CLASSIFY_CONCURRENCY = 4;
const SUBMISSIONS_PAGE_SIZE = 50;
/** Pages per form: more than enough to pass 500 submissions. */
const MAX_SUBMISSION_PAGES = 20;
const MAX_ASSOCIATION_PAGES = 50;
const EMAIL_PROPERTIES = ['hs_timestamp', 'hs_email_direction', 'hs_email_status', 'hs_email_to_email'] as const satisfies readonly EmailMetadataProperty[];

export interface BaselineJobOptions {
  /** For the portal limiter; tests advance their FakeClock instead of waiting. */
  sleep?: Sleep | undefined;
  /** Default BASELINE_JOB_BUDGET_MS. */
  budgetMs?: number | undefined;
}

class BudgetSpent extends Error {
  override readonly name: string = 'BaselineBudgetSpent';
}

const contextRow = z.object({
  connection_status: z.enum(CONNECTION_STATUSES).nullable(),
  scopes: z.array(z.string()).nullable(),
});

interface SelectedForm {
  id: string;
  name: string;
}

interface Context {
  connectionActive: boolean;
  scopes: string[];
  forms: SelectedForm[];
}

async function loadContext(db: Db, accountId: string): Promise<Context | null> {
  const raw = await db.maybeOne(
    `select c.status as connection_status, c.scopes
       from accounts a left join hubspot_connections c on c.account_id = a.id
      where a.id = $1`,
    [accountId],
  );
  if (raw === null) return null;
  const row = contextRow.parse(raw);
  const forms = await db.query<{ form_id: string; form_name: string | null }>(
    `select form_id, form_name from selected_forms where account_id = $1 and selected order by form_id`,
    [accountId],
  );
  return {
    connectionActive: row.connection_status === 'active',
    scopes: row.scopes ?? [],
    forms: forms.map((form) => ({ id: form.form_id, name: form.form_name ?? '' })),
  };
}

interface Submission {
  form: SelectedForm;
  submission: FormSubmission;
}

type Measured = Omit<NewBaseline, 'accountId' | 'now' | 'notBefore'>;

function result(status: BaselineStatus, submissionsRead: number, leadsCounted: number): Measured {
  return { status, submissionsRead, leadsCounted, medianSecondsToFirstOutbound: null, withoutOutboundCount: null, percentAvailable: false };
}

class Run {
  constructor(
    private readonly deps: Deps,
    private readonly accountId: string,
    private readonly portal: PortalHubSpotClient,
    private readonly deadlineMs: number,
    private readonly attempt: number,
  ) {}

  private checkBudget(): void {
    if (this.deps.clock.now().getTime() >= this.deadlineMs) throw new BudgetSpent();
  }

  /** The window's submissions on every selected form; stops early once past the 500 cap. */
  async readSubmissions(forms: readonly SelectedForm[], since: Date): Promise<Submission[]> {
    const found: Submission[] = [];
    const seen = new Set<string>();
    for (const form of forms) {
      let after: string | undefined;
      for (let page = 0; page < MAX_SUBMISSION_PAGES; page += 1) {
        this.checkBudget();
        const result = await this.portal.listSubmissions(form.id, { limit: SUBMISSIONS_PAGE_SIZE, after });
        let inWindow = 0;
        for (const submission of result.results) {
          if (submission.submittedAt.getTime() < since.getTime()) continue;
          inWindow += 1;
          const email = submissionContent(submission).email ?? '';
          const key = `${form.id}|${submission.conversionId ?? ''}|${submission.submittedAt.toISOString()}|${email}`;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({ form, submission });
        }
        if (found.length > MAX_BASELINE_SUBMISSIONS) return found;
        // Pages come newest first; a page with nothing in the window ends this form.
        if (inWindow === 0 || result.nextAfter === undefined) break;
        after = result.nextAfter;
      }
    }
    return found;
  }

  /** Keeps the leads (`lead`/`unclear`) that have an email address; classification is in memory only. */
  async keepLeads(submissions: readonly Submission[]): Promise<{ email: string; submittedAt: Date }[]> {
    const kept: { email: string; submittedAt: Date }[] = [];
    for (let start = 0; start < submissions.length; start += BASELINE_CLASSIFY_CONCURRENCY) {
      this.checkBudget();
      const batch = submissions.slice(start, start + BASELINE_CLASSIFY_CONCURRENCY);
      const classes = await Promise.all(
        batch.map(async ({ form, submission }) => {
          const content = submissionContent(submission);
          if (content.email === null) return null;
          const classified = await classifyLead(this.deps, {
            accountId: this.accountId,
            leadId: null,
            purpose: 'baseline_classify',
            attempt: this.attempt,
            message: content.message,
            formName: form.name,
            firstName: content.firstName,
            company: content.company,
          });
          return isDraftableClassification(classified.classification) ? { email: content.email, submittedAt: submission.submittedAt } : null;
        }),
      );
      for (const lead of classes) if (lead !== null) kept.push(lead);
    }
    return kept;
  }

  /** The logged outbound emails to `email` on its contact; null when the contact cannot be found. */
  async outboundEmailsTo(email: string): Promise<EmailEngagement[] | null> {
    this.checkBudget();
    const contact = await this.portal.getContact(email, { idProperty: 'email', properties: ['email'], associations: ['emails'] });
    if (contact === null) return null;
    const ids = [...(contact.associatedEmailIds ?? [])];
    let after = contact.associationsNextAfter;
    for (let page = 0; after !== undefined && page < MAX_ASSOCIATION_PAGES; page += 1) {
      this.checkBudget();
      const next = await this.portal.listContactEmailIds(contact.id, { after });
      ids.push(...next.ids);
      after = next.nextAfter;
    }
    if (ids.length === 0) return [];
    const emails = await this.portal.batchReadEmails([...new Set(ids)], EMAIL_PROPERTIES);
    // A confirmed send needs the status absent or SENT (D-08); the address must be a recipient.
    return emails.filter(
      (engagement) =>
        engagement.direction === 'EMAIL' && (engagement.status === undefined || engagement.status === 'SENT') && engagement.toEmails.includes(email),
    );
  }

  async measure(context: Context, since: Date): Promise<Measured> {
    const submissions = await this.readSubmissions(context.forms, since);
    if (submissions.length > MAX_BASELINE_SUBMISSIONS) return result('insufficient', submissions.length, 0);

    const leads = await this.keepLeads(submissions);
    if (leads.length === 0) return result('insufficient', submissions.length, 0);
    if (!canReadEmails(context.scopes)) return result('unavailable', submissions.length, leads.length);

    this.checkBudget();
    const loggedOutbound = await this.portal.searchEmailsCount({ direction: 'outbound', since });
    if (loggedOutbound === 0) return result('insufficient', submissions.length, leads.length);

    const byEmail = new Map<string, EmailEngagement[] | null>();
    const waits: (number | null)[] = [];
    for (const lead of leads) {
      let emails = byEmail.get(lead.email);
      if (emails === undefined) {
        emails = await this.outboundEmailsTo(lead.email);
        byEmail.set(lead.email, emails);
      }
      if (emails === null) continue;
      const after = emails.map((engagement) => engagement.timestamp.getTime()).filter((at) => at > lead.submittedAt.getTime());
      waits.push(after.length === 0 ? null : (Math.min(...after) - lead.submittedAt.getTime()) / 1000);
    }

    const figures = baselineFigures(waits);
    if (figures.leadsCounted === 0) return result('insufficient', submissions.length, 0);
    return {
      status: 'ok',
      submissionsRead: submissions.length,
      leadsCounted: figures.leadsCounted,
      medianSecondsToFirstOutbound: figures.medianSecondsToFirstOutbound,
      withoutOutboundCount: figures.withoutOutboundCount,
      percentAvailable: true,
    };
  }
}

async function store(deps: Deps, job: JobRow, ctx: JobContext, accountId: string, measured: Measured): Promise<boolean> {
  return deps.db.tx(async (tx) => {
    await ctx.assertOwned(tx);
    return insertBaseline(tx, { ...measured, accountId, now: deps.clock.now(), notBefore: job.createdAt });
  });
}

export function createBaselineHandler(options: BaselineJobOptions = {}): JobHandler {
  return async function baselineHandler(deps: Deps, job: JobRow, ctx: JobContext): Promise<JobOutcome> {
    if (job.accountId === null) return { type: 'permanent', code: 'baseline_job_payload_invalid' };
    const accountId = job.accountId;
    const context = await loadContext(deps.db, accountId);
    if (context === null || !context.connectionActive) return JobOutcomes.skipped();

    const since = new Date(deps.clock.now().getTime() - BASELINE_WINDOW_MS);
    const deadlineMs = ctx.claimedAt.getTime() + (options.budgetMs ?? BASELINE_JOB_BUDGET_MS);
    const portal = forAccount(deps, accountId, { sleep: options.sleep });
    const run = new Run(deps, accountId, portal, deadlineMs, Math.max(1, job.attempts));

    let measured: Measured;
    try {
      measured = await run.measure(context, since);
    } catch (error) {
      if (error instanceof BudgetSpent) {
        measured = result('unavailable', 0, 0);
      } else if (isRevoked(error)) {
        log.info('baseline skipped: connection inactive', { event: 'baseline.skipped', accountId, code: errorCode(error) });
        return JobOutcomes.skipped();
      } else if (isAppError(error) && error.code === 'hubspot_missing_scopes') {
        measured = result('unavailable', 0, 0);
      } else if (isRetryable(error)) {
        return { type: 'transient', code: error.code, retryAfterMs: error instanceof TransientError ? error.retryAfterMs : undefined };
      } else if (isAppError(error)) {
        return { type: 'permanent', code: error.code };
      } else {
        throw error;
      }
    }

    const written = await store(deps, job, ctx, accountId, measured);
    log.info('baseline measured', {
      event: 'baseline.done',
      accountId,
      outcome: measured.status,
      total: measured.submissionsRead,
      count: measured.leadsCounted,
      skipped: written ? 0 : 1,
    });
    return JobOutcomes.done();
  };
}

/** After the last delivery: "Not enough logged history" rather than a step that never finishes. */
export async function baselineFailurePath(deps: Deps, job: JobRow, info: JobFailureInfo): Promise<void> {
  if (job.accountId === null) return;
  await insertBaseline(deps.db, { ...result('unavailable', 0, 0), accountId: job.accountId, now: deps.clock.now(), notBefore: job.createdAt });
  log.warn('baseline failed', { event: 'baseline.failed', accountId: job.accountId, code: info.code, reason: info.reason });
}

/** Added to REGISTRATIONS in src/server/jobs/handlers.ts. */
export const registerBaselineJobs: Registration = ({ jobs, limiterSleep }) => {
  jobs.register('baseline', createBaselineHandler({ sleep: limiterSleep }));
  jobs.registerFailurePath('baseline', baselineFailurePath);
};
