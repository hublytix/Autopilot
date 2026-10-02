import { getDevContext, handleFakeHubSpotDecision, handleFakeHubSpotDecisionOtherMethod } from '@/server/http/dev';

// The fake HubSpot consent form's target (fake mode only; 404 otherwise; PLAN §7.6).
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleFakeHubSpotDecision(req, await getDevContext());
}

export async function GET(): Promise<Response> {
  return handleFakeHubSpotDecisionOtherMethod(await getDevContext());
}
