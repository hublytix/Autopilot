import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { isAuthorizedCronRequest } from '@/server/security/cron-auth';
import { runDailyCron } from '@/server/services/daily';

// GET|POST /api/cron/daily (PLAN §7.3, §8.1 `17 3 * * *` UTC, D-16): a Vercel Cron GET with
// `Authorization: Bearer ${CRON_SECRET}`, or a QStash schedule POST signed for this URL; 401
// otherwise. Then, under the daily lease: the DB-local retention steps and prunes, one
// `account_daily` job per account, then (within a time budget) the billing-tombstone reconcile and
// the queued auth-user deletions (services/daily/run.ts). The answer is a JSON summary of counts
// only (no ids, no content).

export const CRON_DAILY_PATH = '/api/cron/daily';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function handleCronDaily(req: Request, deps: Deps): Promise<Response> {
  const authorized = await isAuthorizedCronRequest(req, {
    cronSecret: deps.env.CRON_SECRET,
    currentSigningKey: deps.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: deps.env.QSTASH_NEXT_SIGNING_KEY,
    url: `${deps.env.APP_URL}${CRON_DAILY_PATH}`,
  });
  if (!authorized) return json(401, { ok: false, code: 'unauthorized' });
  try {
    const summary = await runDailyCron(deps);
    return json(200, { ok: summary.errors === 0, ...summary });
  } catch (error) {
    log.error('daily cron failed', { event: 'cron.daily.error', route: CRON_DAILY_PATH, code: errorCode(error) }, error);
    return json(500, { ok: false, code: 'cron_daily_error' });
  }
}
