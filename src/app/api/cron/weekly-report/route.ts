import { getDeps } from '@/server/container';
import { handleCronWeeklyReport } from '@/server/http/cron-weekly-report';

// The hourly Monday-report due-check (PLAN §7.3, §8.1): Vercel Cron GET (Bearer CRON_SECRET) or a
// signed QStash schedule POST.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleCronWeeklyReport(req, await getDeps());
}

export async function POST(req: Request): Promise<Response> {
  return handleCronWeeklyReport(req, await getDeps());
}
