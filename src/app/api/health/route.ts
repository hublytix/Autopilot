import { handleHealth } from '@/server/http/health';

export const dynamic = 'force-dynamic';

export function GET(req: Request): Response {
  return handleHealth(req);
}
