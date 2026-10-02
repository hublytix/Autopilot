import 'server-only';
import { errorCode } from '@/server/domain/errors';
import { log } from '@/server/obs/log';
import type { Deps } from '@/server/ports';
import { isAuthorizedCronRequest } from '@/server/security/cron-auth';
import { scheduleWeeklyReports } from '@/server/services/reports/schedule';

// GET|POST /api/cron/weekly-report (PLAN §7.3, §8.1 `0 * * * *`, D-16, D-17): a Vercel Cron GET with
// `Authorization: Bearer ${CRON_SECRET}`, or a QStash schedule POST signed for this URL; 401
// otherwise. Then the due-check: for each due account without this week's report, the report row
// and its staggered `weekly_report` job in one transaction, published after commit. Idempotent (a
// second run in the same hour creates nothing). The answer is a JSON summary of counts only.

export const CRON_WEEKLY_REPORT_PATH = '/api/cron/weekly-report';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function handleCronWeeklyReport(req: Request, deps: Deps): Promise<Response> {
  const authorized = await isAuthorizedCronRequest(req, {
    cronSecret: deps.env.CRON_SECRET,
    currentSigningKey: deps.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: deps.env.QSTASH_NEXT_SIGNING_KEY,
    url: `${deps.env.APP_URL}${CRON_WEEKLY_REPORT_PATH}`,
  });
  if (!authorized) return json(401, { ok: false, code: 'unauthorized' });
  try {
    const summary = await scheduleWeeklyReports(deps);
    return json(200, { ok: true, ...summary });
  } catch (error) {
    log.error('weekly report cron failed', { event: 'cron.weekly_report.error', route: CRON_WEEKLY_REPORT_PATH, code: errorCode(error) }, error);
    return json(500, { ok: false, code: 'cron_weekly_report_error' });
  }
}
