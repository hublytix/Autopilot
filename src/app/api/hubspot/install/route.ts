import { getDeps } from '@/server/container';
import { handleHubSpotInstall } from '@/server/http/hubspot-install';

// Starts the HubSpot install (PLAN §7.3): rate limit, signed state cookie, consent redirect.
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleHubSpotInstall(req, await getDeps());
}
