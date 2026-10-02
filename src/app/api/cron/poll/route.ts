import { getDeps } from '@/server/container';
import { handleCronPoll } from '@/server/http/cron-poll';

// The 5-minute poll cron (PLAN §7.3, §8.1): Vercel Cron GET (Bearer CRON_SECRET) or a signed QStash
// schedule POST. The global lease (6 min) outlives maxDuration.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleCronPoll(req, await getDeps());
}

export async function POST(req: Request): Promise<Response> {
  return handleCronPoll(req, await getDeps());
}
