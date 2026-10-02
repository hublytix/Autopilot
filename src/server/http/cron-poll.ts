import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { runSweeper } from '@/server/jobs/sweeper';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { isAuthorizedCronRequest } from '@/server/security/cron-auth';
import type { Sleep } from '@/server/services/hubspot';
import { runPollCron, type PollCronOptions, type RetentionGuardSummary } from '@/server/services/intake';
import { runRetentionGuardSteps } from '@/server/services/retention';

// GET|POST /api/cron/poll (PLAN §7.3, §8.1 `*/5 * * * *`, D-16): a Vercel Cron GET with
// `Authorization: Bearer ${CRON_SECRET}`, or a QStash schedule POST signed for this URL; 401
// otherwise. Then runPollCron (global lease → processing states → polls → sweeper → retention
// guard). The answer is a JSON summary of counts only.

export const CRON_POLL_PATH = '/api/cron/poll';

/**
 * The cheap retention guard run every 5 minutes (D-49, PLAN §9.10 steps 1-4): one existence check,
 * and the content purge only when something is due, so content never outlives 30 d + 1 h.
 * `{ran: false}` when nothing was due; otherwise the counts.
 */
export async function runRetentionGuard(deps: Deps): Promise<RetentionGuardSummary> {
  return { ...(await runRetentionGuardSteps(deps)) };
}

export interface CronPollRouteOptions {
  /** Default: the job sweeper with every handler registered. */
  sweep?: PollCronOptions['sweep'] | undefined;
  /** Default: runRetentionGuard. */
  retentionGuard?: PollCronOptions['retentionGuard'] | undefined;
  budgetMs?: number | undefined;
  sleep?: Sleep | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function handleCronPoll(req: Request, deps: Deps, options: CronPollRouteOptions = {}): Promise<Response> {
  const authorized = await isAuthorizedCronRequest(req, {
    cronSecret: deps.env.CRON_SECRET,
    currentSigningKey: deps.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: deps.env.QSTASH_NEXT_SIGNING_KEY,
    url: `${deps.env.APP_URL}${CRON_POLL_PATH}`,
  });
  if (!authorized) return json(401, { ok: false, code: 'unauthorized' });
  try {
    const summary = await runPollCron(deps, {
      sweep: options.sweep ?? ((d) => runSweeper(d)),
      retentionGuard: options.retentionGuard ?? runRetentionGuard,
      budgetMs: options.budgetMs,
      sleep: options.sleep,
    });
    return json(200, { ok: true, ...summary });
  } catch (error) {
    log.error('poll cron failed', { event: 'cron.poll.error', route: CRON_POLL_PATH, code: errorCode(error) }, error);
    return json(500, { ok: false, code: 'cron_poll_error' });
  }
}
