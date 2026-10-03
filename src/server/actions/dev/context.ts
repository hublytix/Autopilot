import 'server-only';
import { getContainer } from '@/server/container';
import { devToolsEnabled, type DevPanelContext, type FakeStartingState } from '@/server/http/dev';
import type { Deps } from '@/server/ports';
import { currentDevTicker } from '@/server/services/dev-ticker';

// The /dev panel's composition (fake mode only; PLAN §4, §7.6): the fake container's Deps, its
// fakes and its DevClock, for the handlers in src/server/http/dev. Outside fake mode it is null and
// the live container is never built. "Reset fake state" needs the fakes as a fresh container starts
// them: they are built here, on demand, the way the container builds them (createFakeDeps with the
// same environment), because http/ may not import adapters (PLAN §3).

async function startingState(deps: Deps): Promise<FakeStartingState> {
  const { createFakeDeps } = await import('@/server/adapters/fake');
  // Constructing the fakes opens nothing: the Db stays untouched and nothing is sent.
  const { fakes } = createFakeDeps({ env: deps.env, db: deps.db, clock: deps.clock, mailSink: { kind: 'memory' } });
  return { hubspot: fakes.hubspot.snapshot(), billing: fakes.billing.snapshot(), auth: fakes.auth.snapshot() };
}

/** The panel's context in fake mode; null otherwise. */
export async function getDevPanelContext(): Promise<DevPanelContext | null> {
  if (!devToolsEnabled()) return null;
  const container = await getContainer();
  if (container.mode !== 'fake' || container.fakes === null || container.devClock === null) return null;
  const { deps, fakes, devClock } = container;
  return {
    deps,
    fakes,
    clock: { advance: (ms) => devClock.advance(ms), reset: () => devClock.reset(), offsetMs: devClock.offsetMs },
    startingState: () => startingState(deps),
    tickerRunning: currentDevTicker()?.started ?? false,
  };
}
