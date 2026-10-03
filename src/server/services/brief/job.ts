import 'server-only';
import { z } from 'zod';
import type { Db } from '@/server/db';
import { JobOutcomes, type JobContext, type JobFailureInfo, type JobOutcome, type JobRow, type Registration } from '@/server/jobs';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import type { LlmResult, BriefDraft } from '@/server/ports/llm';
import { aiCallRecord, isAiDailyBudgetTripped, recordAiCall } from '@/server/services/classification';
import { crawlSite, type CrawlOptions } from './crawl';
import type { ExtractedPage } from './extract';
import { BRIEF_JOB_BUDGET_MS, CRAWL_BUDGET_MS, MIN_LLM_BUDGET_MS } from './limits';
import { postProcessBrief } from './post-process';
import { insertGeneratedVersion } from './repository';

// The `brief_generate` job (PLAN §8.2, §8.3, §9.7, D-24, D-47). `brief_jobs.attempts` counts
// deliveries; each delivery:
// 1. marks the brief job `running` and counts itself (the previous count is read in the same
//    statement); a brief job already `done` or `failed` ends the delivery as `skipped`;
// 2. crawls the site the owner gave (briefs.source_url) inside the 60 s crawl budget;
// 3. asks the draft model for the brief with what is left of the job's budget as the call's
//    timeout and signal: the first delivery with adaptive thinking / ANTHROPIC_BRIEF_EFFORT / 16000,
//    any later one (a previous delivery counted, the job was claimed before, or the last attempt
//    aborted) with between_tools / high / 4096;
// 4. post-processes the answer (FAQs ≤ 8, allow_pricing false, the booking link only if https and
//    visible in the pages, never_promise trimmed) and stores it as a `generated` version.
// A refusal, invalid output, an unreadable homepage (blocked, robots.txt, not HTML, 4xx), a
// missing website or a tripped AI budget breaker (D-36, checked before the crawl) ends the brief
// job `failed` at once: the editor opens empty (or on the saved brief). A timeout, max_tokens, a 5xx or a transient API error is retried by QStash; after the final
// delivery (or the failure callback, or the sweeper) the failure path marks the brief job `failed`.
// A fatal configuration error fails the job permanently, with the admin alert every failure raises.
// Logs carry ids, counts and codes only: never the website address, page text or the brief.

const PayloadSchema = z.object({ briefJobId: z.uuid() });

interface Delivery {
  briefJobId: string;
  /** Deliveries counted before this one. */
  previousDeliveries: number;
  sourceUrl: string | null;
}

function briefJobIdOf(job: JobRow): string | null {
  const parsed = PayloadSchema.safeParse(job.payload);
  return parsed.success ? parsed.data.briefJobId : null;
}

/** Marks the brief job running and counts this delivery, while this attempt holds the job. */
async function startDelivery(deps: Deps, job: JobRow, ctx: JobContext, briefJobId: string, accountId: string): Promise<Delivery | null> {
  return deps.db.tx(async (tx) => {
    await ctx.assertOwned(tx);
    const row = await tx.maybeOne<{ previous_deliveries: number; source_url: string | null }>(
      `update brief_jobs b set status = 'running', attempts = b.attempts + 1
        where b.id = $1 and b.account_id = $2 and b.status in ('queued', 'running')
        returning b.attempts - 1 as previous_deliveries,
                  (select source_url from briefs where account_id = b.account_id) as source_url`,
      [briefJobId, accountId],
    );
    return row === null ? null : { briefJobId, previousDeliveries: row.previous_deliveries, sourceUrl: row.source_url };
  });
}

/** Records why this delivery stopped short, so the next one knows (no status change). */
async function noteError(deps: Deps, ctx: JobContext, briefJobId: string, code: string): Promise<void> {
  await deps.db.tx(async (tx) => {
    await ctx.assertOwned(tx);
    await tx.query(`update brief_jobs set error_code = $2 where id = $1 and status = 'running'`, [briefJobId, code]);
  });
}

/** Ends the brief job `failed` (the empty editor), guarded so a finished job is never reopened. */
async function markBriefFailed(db: Db, briefJobId: string, code: string, now: Date): Promise<void> {
  await db.query(
    `update brief_jobs set status = 'failed', error_code = $2, finished_at = $3
      where id = $1 and status in ('queued', 'running')`,
    [briefJobId, code, now],
  );
}

async function failNow(deps: Deps, ctx: JobContext, delivery: Delivery, accountId: string, code: string): Promise<JobOutcome> {
  await deps.db.tx(async (tx) => {
    await ctx.assertOwned(tx);
    await markBriefFailed(tx, delivery.briefJobId, code, deps.clock.now());
  });
  log.warn('brief generation failed', { event: 'brief.failed', accountId, briefJobId: delivery.briefJobId, code });
  return JobOutcomes.done();
}

function pagesForModel(pages: readonly ExtractedPage[]): { url: string; text: string }[] {
  return pages.map((page) => {
    const firstLine = page.text.split('\n', 1)[0] ?? '';
    const text = page.title !== '' && page.title !== firstLine ? `${page.title}\n${page.text}` : page.text;
    return { url: page.url, text };
  });
}

export interface BriefJobOptions {
  /** Crawl overrides for tests (timeouts); default the PLAN §10.4 limits. */
  crawl?: Omit<CrawlOptions, 'signal'> | undefined;
}

export function createBriefGenerateHandler(options: BriefJobOptions = {}) {
  return async function briefGenerateHandler(deps: Deps, job: JobRow, ctx: JobContext): Promise<JobOutcome> {
    const briefJobId = briefJobIdOf(job);
    if (briefJobId === null || job.accountId === null) return { type: 'permanent', code: 'brief_job_payload_invalid' };
    const accountId = job.accountId;

    const delivery = await startDelivery(deps, job, ctx, briefJobId, accountId);
    if (delivery === null) return JobOutcomes.skipped();
    const sourceUrl = delivery.sourceUrl;
    if (sourceUrl === null) return failNow(deps, ctx, delivery, accountId, 'site_url_missing');
    // The AI budget breaker (D-36), the global budget and this account's share: no model call, so the
    // brief job fails at once and the owner fills in the empty editor (no crawl either: its only use
    // is the model call). The breaker raises its own once-a-day admin alert.
    if (await isAiDailyBudgetTripped(deps, { accountId })) return failNow(deps, ctx, delivery, accountId, 'ai_budget');

    const deadline = ctx.claimedAt.getTime() + BRIEF_JOB_BUDGET_MS;
    const crawl = await crawlSite(deps.webFetcher, sourceUrl, {
      budgetMs: Math.min(CRAWL_BUDGET_MS, Math.max(1, deadline - deps.clock.now().getTime())),
      ...options.crawl,
    });
    if (!crawl.ok) {
      const code = `site_${crawl.code}`;
      if (!crawl.retryable) return failNow(deps, ctx, delivery, accountId, code);
      await noteError(deps, ctx, briefJobId, code);
      log.info('brief crawl will retry', { event: 'brief.crawl_retry', accountId, briefJobId, code, httpStatus: crawl.httpStatus });
      return { type: 'transient', code: `brief_${code}` };
    }

    const remainingMs = deadline - deps.clock.now().getTime();
    if (remainingMs < MIN_LLM_BUDGET_MS) {
      await noteError(deps, ctx, briefJobId, 'llm_budget_spent');
      return { type: 'transient', code: 'brief_budget_spent' };
    }

    // PLAN §9.7: any delivery after the first, or after an attempt that was cut off, takes the fallback.
    // A cut-off attempt is always an earlier delivery: brief_jobs.error_code is written only by a
    // delivery that already counted itself (previousDeliveries ≥ 1), and a crash before that count is
    // seen as a second claim of the scheduled job (job.attempts > 1).
    const fallback = delivery.previousDeliveries >= 1 || job.attempts > 1;
    const attempt = fallback ? Math.max(1, delivery.previousDeliveries) : 0;
    const startedAt = deps.clock.now();
    const result: LlmResult<BriefDraft> = await deps.llm.generateBrief(
      { pages: pagesForModel(crawl.pages), sourceUrl: crawl.pages[0]?.url ?? sourceUrl },
      { timeoutMs: remainingMs, attempt },
    );
    await recordAiCall(
      deps.db,
      aiCallRecord(
        {
          accountId,
          leadId: null,
          purpose: 'brief',
          attempt: delivery.previousDeliveries + 1,
          requestedModel: deps.env.ANTHROPIC_MODEL_DRAFT,
          startedAt,
          finishedAt: deps.clock.now(),
        },
        result,
      ),
    );

    if (!result.ok) {
      switch (result.failure) {
        case 'refusal':
          return failNow(deps, ctx, delivery, accountId, 'llm_refusal');
        case 'invalid_output':
          return failNow(deps, ctx, delivery, accountId, 'llm_invalid_output');
        case 'max_tokens':
          await noteError(deps, ctx, briefJobId, 'llm_max_tokens');
          return { type: 'transient', code: 'brief_llm_max_tokens' };
        case 'transient': {
          const aborted = result.errorCode === 'aborted' || result.errorCode === 'timeout';
          await noteError(deps, ctx, briefJobId, aborted ? 'llm_aborted' : 'llm_transient');
          return { type: 'transient', code: aborted ? 'brief_llm_aborted' : 'brief_llm_transient', retryAfterMs: result.retryAfterMs };
        }
        case 'fatal_config':
          // The failure path's admin alert carries this code (D-24 FATAL-CONFIG).
          return { type: 'permanent', code: 'brief_llm_fatal_config' };
      }
    }

    const visibleUrls = crawl.pages.flatMap((page) => page.visibleUrls);
    const brief = postProcessBrief(result.value, { visibleUrls });
    const version = await deps.db.tx(async (tx) => {
      await ctx.assertOwned(tx);
      const now = deps.clock.now();
      const updated = await tx.maybeOne(
        `update brief_jobs set status = 'done', error_code = null, finished_at = $2 where id = $1 and status = 'running' returning id`,
        [briefJobId, now],
      );
      if (updated === null) return null;
      return insertGeneratedVersion(tx, { accountId, brief, sourceUrl, now });
    });
    if (version === null) return JobOutcomes.skipped();
    log.info('brief generated', {
      event: 'brief.generated',
      accountId,
      briefJobId,
      pages: crawl.pages.length,
      attempt: delivery.previousDeliveries + 1,
      skipped: Object.values(crawl.stats.skipped).reduce((sum, n) => sum + (n ?? 0), 0),
      bytes: crawl.stats.bytes,
    });
    return JobOutcomes.done();
  };
}

/** The failure path (PLAN §8.3 step 6): the brief job ends `failed`, and the owner gets the empty editable form. */
export async function briefGenerateFailurePath(deps: Deps, job: JobRow, info: JobFailureInfo): Promise<void> {
  const briefJobId = briefJobIdOf(job);
  if (briefJobId === null) return;
  await markBriefFailed(deps.db, briefJobId, info.code, deps.clock.now());
}

/** Added to REGISTRATIONS in src/server/jobs/handlers.ts. */
export const registerBriefJobs: Registration = ({ jobs }) => {
  jobs.register('brief_generate', createBriefGenerateHandler());
  jobs.registerFailurePath('brief_generate', briefGenerateFailurePath);
};
