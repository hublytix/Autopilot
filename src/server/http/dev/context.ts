import 'server-only';
import type { FakeAdapters } from '@/server/adapters/fake';
import type { Deps } from '@/server/ports';

// What the /dev panel works with (fake mode only; PLAN §4, §7.6). The panel's composition lives in
// src/server/actions/dev (getDevPanelContext), which reads the fake container; tests build one
// around a job rig. http/ never imports adapters: it reaches the fakes only through this object.

/** The fake clock as the panel moves it: the DevClock in dev, a FakeClock in tests. */
export interface DevPanelClock {
  /** Moves forward by `ms`; returns the new now. */
  advance(ms: number): Date | Promise<Date>;
  /** Back to real time (the DevClock drops its offset); null when the clock cannot (tests). */
  readonly reset: (() => Promise<void>) | null;
  /** How far the clock runs ahead of real time; null when unknown (tests). */
  readonly offsetMs: number | null;
}

/** The persisted fakes as a fresh fake-mode container starts them: the fixture portal, no subscriptions, no auth users. */
export interface FakeStartingState {
  readonly hubspot: unknown;
  readonly billing: unknown;
  readonly auth: unknown;
}

export interface DevPanelContext {
  readonly deps: Deps;
  readonly fakes: Pick<FakeAdapters, 'hubspot' | 'billing' | 'scheduler' | 'auth'>;
  readonly clock: DevPanelClock;
  /** For "reset fake state": built only when asked (it constructs fresh fakes). */
  readonly startingState: () => Promise<FakeStartingState>;
  /** Whether this process runs the dev job ticker (every 10 s). */
  readonly tickerRunning: boolean;
}

export const DEV_PANEL_PATH = '/dev';
export const DEV_ACTION_PATH = '/dev/actions';
/** One outbox email: /dev/email/{id} (named apart from the simulation's ./outbox directory, which .gitignore ignores). */
export const DEV_EMAIL_PATH = '/dev/email';
export const FAKE_CHECKOUT_BASE_PATH = '/dev/fake-checkout';

export const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' } as const;
