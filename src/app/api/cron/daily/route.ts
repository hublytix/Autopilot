import { getDeps } from '@/server/container';
import { handleCronDaily } from '@/server/http/cron-daily';

// The daily maintenance cron (PLAN §7.3, §8.1, `17 3 * * *` UTC): Vercel Cron GET (Bearer
// CRON_SECRET) or a signed QStash schedule POST. The daily lease (6 min) outlives maxDuration.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleCronDaily(req, await getDeps());
}

export async function POST(req: Request): Promise<Response> {
  return handleCronDaily(req, await getDeps());
}
