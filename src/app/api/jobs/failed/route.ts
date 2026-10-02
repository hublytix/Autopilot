import { getDeps } from '@/server/container';
import { handleJobFailed } from '@/server/http/jobs';

// QStash failure callbacks (PLAN §7.3, §8.3 step 6).
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleJobFailed(req, await getDeps());
}
