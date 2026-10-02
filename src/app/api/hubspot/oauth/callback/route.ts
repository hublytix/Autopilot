import { getDeps } from '@/server/container';
import { handleHubSpotCallback } from '@/server/http/hubspot-callback';

// HubSpot's OAuth redirect (PLAN §7.3, §9.1): state check, code exchange, branches (a)-(d).
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleHubSpotCallback(req, await getDeps());
}
