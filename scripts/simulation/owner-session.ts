// The owner opening an owner page later in the week (stage 6): the browser that /auth/confirm signed
// in during the pre-run, through the proxy's session refresh (PLAN §7.7: `/dashboard/*` refreshes
// the session and sets the new cookie) and then requireOwner, exactly as a dashboard page reads it.
// The fake session lasts 7 days and is refreshed inside its last day, so the owner who opens the
// dashboard from Monday's report is still signed in on Wednesday.
import { requireOwner, type OwnerScope } from '@/server/services/auth';
import { OWNER_IP } from './owner-browser';
import type { Simulation } from './types';

/** The owner's scope for a page view of `path`, or null when the browser has no valid session. */
export async function ownerPageScope(sim: Simulation, path: string): Promise<OwnerScope | null> {
  const jar = sim.scenario.ownerJar;
  if (jar === null) return null;
  const url = `${sim.deps.env.APP_URL}${path}`;
  const init = { headers: { 'x-real-ip': OWNER_IP } };
  // The proxy: refresh the session, store whatever cookie the response sets.
  const refreshed = await sim.fakes.auth.refreshSession(jar.request(url, init), new Response(null, { status: 200 }));
  jar.storeFrom(refreshed.response);
  try {
    return await requireOwner(sim.deps, jar.request(url, init));
  } catch {
    return null;
  }
}
