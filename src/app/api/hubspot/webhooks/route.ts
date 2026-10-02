import { getDeps } from '@/server/container';
import { handleHubSpotWebhook } from '@/server/http/hubspot-webhook';

// HubSpot webhook deliveries (PLAN §7.3): v3 signature on the raw body, dedupe, privacy deletions,
// debounced polls. Answers fast: the work happens in jobs.
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleHubSpotWebhook(req, await getDeps());
}
