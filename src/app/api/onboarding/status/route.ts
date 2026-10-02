import { getDeps } from '@/server/container';
import { ownerFromHeaders } from '@/server/http/auth/guards';
import { PRIVATE_HEADERS } from '@/server/http/auth/request';
import { onboardingStatus } from '@/server/views/onboarding/status';

// GET /api/onboarding/status (PLAN §7.3): owner only, database only. The onboarding pages poll it
// while the brief, inbox-check and baseline jobs run.

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const deps = await getDeps();
  const scope = await ownerFromHeaders(deps, request.headers);
  if (scope === null) return Response.json({ error: 'auth_owner_required' }, { status: 401, headers: PRIVATE_HEADERS });
  return Response.json(await onboardingStatus(scope, deps), { headers: PRIVATE_HEADERS });
}
