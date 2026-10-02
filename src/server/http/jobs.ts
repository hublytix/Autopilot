import 'server-only';
import { z } from 'zod';
import { errorCode } from '@/server/domain/errors';
import { jobRunHeaders, runJob } from '@/server/jobs/dispatcher';
import { handleFailureCallback } from '@/server/jobs/failure';
import { ensureJobHandlersRegistered } from '@/server/jobs/handlers';
import type { JobRegistry } from '@/server/jobs/registry';
import { isJobId } from '@/server/jobs/rows';
import { JOB_FAILED_PATH, JOB_RUN_PATH } from '@/server/jobs/types';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { verifyQstashRequest } from '@/server/security/qstash';

// The two QStash endpoints (PLAN §7.3, §8.3, D-15). Both verify the signature on the raw body against
// the route's own configured URL before parsing anything (PLAN §10.1).
// - POST /api/jobs/run: `{jobId}` + `Upstash-Retried` / `Upstash-Message-Id` → runJob → 200, 5xx,
//   489 + Upstash-NonRetryable-Error, or 503 + Retry-After.
// - POST /api/jobs/failed: the failure callback (`sourceMessageId`, base64 `sourceBody` = the
//   original `{jobId}`) → the compare-and-set; only its winner runs the failure path; always 200.
// Bodies are ids only; nothing from them is logged except ids.

export interface JobRouteOptions {
  /** Default: the process registry, with every handler registered. */
  registry?: JobRegistry | undefined;
}

const runBodySchema = z.object({ jobId: z.string().refine(isJobId) });

const failureBodySchema = z.object({
  sourceMessageId: z.string().min(1).max(256),
  sourceBody: z.string().max(65_536).optional(),
});

const MESSAGE_ID = /^[A-Za-z0-9_:.-]{1,256}$/;

function json(status: number, body: Record<string, string | boolean>, headers?: Headers): Response {
  const out = new Headers(headers);
  out.set('Content-Type', 'application/json');
  out.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: out });
}

/** 489 + Upstash-NonRetryable-Error: a verified but malformed request will not get better by retrying. */
function nonRetryable(code: string): Response {
  return json(489, { ok: false, code }, new Headers({ 'Upstash-NonRetryable-Error': 'true' }));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function retriedOf(req: Request): number {
  const value = req.headers.get('upstash-retried');
  return value !== null && /^\d{1,4}$/.test(value) ? Number(value) : 0;
}

function messageIdOf(req: Request): string | null {
  const value = req.headers.get('upstash-message-id');
  return value !== null && MESSAGE_ID.test(value) ? value : null;
}

/** POST /api/jobs/run */
export async function handleJobRun(req: Request, deps: Deps, options: JobRouteOptions = {}): Promise<Response> {
  const raw = await req.text();
  const verified = await verifyQstashRequest(req, raw, {
    currentSigningKey: deps.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: deps.env.QSTASH_NEXT_SIGNING_KEY,
    url: `${deps.env.APP_URL}${JOB_RUN_PATH}`,
  });
  if (!verified.ok) return json(401, { ok: false, code: verified.reason });
  const body = runBodySchema.safeParse(parseJson(raw));
  if (!body.success) return nonRetryable('job_bad_body');

  const registry = options.registry ?? ensureJobHandlersRegistered().jobs;
  try {
    const result = await runJob(deps, { jobId: body.data.jobId, messageId: messageIdOf(req), retried: retriedOf(req) }, registry);
    return json(result.status, { ok: result.status === 200, outcome: result.outcome }, jobRunHeaders(result));
  } catch (error) {
    // Before or around the claim (e.g. the database is unreachable): QStash retries.
    log.error('job run failed', { event: 'job.run_error', jobId: body.data.jobId, code: errorCode(error) }, error);
    return json(500, { ok: false, code: 'job_run_error' });
  }
}

/** The original body's job id, from the callback's base64 `sourceBody`; null when unreadable. */
function jobIdFromSourceBody(sourceBody: string | undefined): string | null {
  if (sourceBody === undefined) return null;
  const decoded = runBodySchema.safeParse(parseJson(Buffer.from(sourceBody, 'base64').toString('utf8')));
  return decoded.success ? decoded.data.jobId : null;
}

/** POST /api/jobs/failed */
export async function handleJobFailed(req: Request, deps: Deps, options: JobRouteOptions = {}): Promise<Response> {
  const raw = await req.text();
  const verified = await verifyQstashRequest(req, raw, {
    currentSigningKey: deps.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: deps.env.QSTASH_NEXT_SIGNING_KEY,
    url: `${deps.env.APP_URL}${JOB_FAILED_PATH}`,
  });
  if (!verified.ok) return json(401, { ok: false, code: verified.reason });
  const body = failureBodySchema.safeParse(parseJson(raw));
  if (!body.success || !MESSAGE_ID.test(body.data.sourceMessageId)) return nonRetryable('job_bad_failure_callback');

  const registry = options.registry ?? ensureJobHandlersRegistered().jobs;
  try {
    const outcome = await handleFailureCallback(
      deps,
      { jobId: jobIdFromSourceBody(body.data.sourceBody), sourceMessageId: body.data.sourceMessageId },
      registry,
    );
    return json(200, { ok: true, outcome });
  } catch (error) {
    log.error('job failure callback failed', { event: 'job.failure_callback_error', messageId: body.data.sourceMessageId, code: errorCode(error) }, error);
    return json(500, { ok: false, code: 'job_failure_callback_error' });
  }
}
