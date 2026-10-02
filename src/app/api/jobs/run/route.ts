import { getDeps } from '@/server/container';
import { handleJobRun } from '@/server/http/jobs';

// QStash job deliveries (PLAN §7.3, §8.3). Longer than any handler; the job lease (6 min) outlives it.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleJobRun(req, await getDeps());
}
