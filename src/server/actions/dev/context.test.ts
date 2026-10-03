import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getContainer, resetContainer } from '@/server/container';
import { handleDevAction } from '@/server/http/dev';
import { getDevPanelContext } from './context';

// The /dev panel's composition over the real fake-mode container (PGlite, every fake, the DevClock):
// null outside fake mode (the live container is never built), the DevClock moves and reports its
// offset, and "reset fake state" leaves nothing behind that a restart could bring back.

beforeEach(() => {
  for (const method of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(async () => {
  await resetContainer();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const APP = 'http://localhost:3000';

function post(fields: Record<string, string>): Request {
  return new Request(`${APP}/dev/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP },
    body: new URLSearchParams(fields).toString(),
  });
}

describe('getDevPanelContext', () => {
  it('is null outside fake mode, without building a container', async () => {
    vi.stubEnv('APP_MODE', 'live');
    expect(await getDevPanelContext()).toBeNull();
    vi.stubEnv('APP_MODE', '');
    expect(await getDevPanelContext()).toBeNull();
    expect((globalThis as { __autopilot?: unknown }).__autopilot).toBeUndefined();
  });

  it("fake mode: the container's fakes, its DevClock (advance moves it ahead of real time) and the fakes' starting state", async () => {
    vi.stubEnv('APP_MODE', 'fake');
    vi.stubEnv('FAKE_DB_DIR', 'memory://');
    const ctx = await getDevPanelContext();
    const container = await getContainer();
    expect(ctx?.deps).toBe(container.deps);
    expect(ctx?.fakes.hubspot).toBe(container.fakes?.hubspot);
    expect(ctx?.tickerRunning).toBe(false);
    expect(ctx?.clock.offsetMs).toBe(0);

    await ctx?.clock.advance(3_600_000);
    expect((await getDevPanelContext())?.clock.offsetMs).toBe(3_600_000);

    const start = await ctx?.startingState();
    expect(start?.hubspot).toMatchObject({ version: 1, oauth: { installed: false } });
    expect(start?.billing).toEqual({ version: 1, subscriptions: [] });
    expect(start?.auth).toEqual({ version: 1, users: [], tokens: [], sessions: [] });
  });

  it('a reset survives a restart: the next boot finds the starting state, not the old one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'autopilot-dev-reset-'));
    try {
      vi.stubEnv('APP_MODE', 'fake');
      vi.stubEnv('FAKE_DB_DIR', dir);
      const before = await getDevPanelContext();
      if (before === null) throw new Error('no dev context');
      before.fakes.hubspot.installTokens();
      await before.fakes.auth.createUser('owner@brightside-plumbing.example');
      await before.clock.advance(86_400_000);
      // Let the debounced snapshot writes land, as they would in a running server.
      await resetContainer();

      const ctx = await getDevPanelContext();
      if (ctx === null) throw new Error('no dev context');
      expect(ctx.fakes.hubspot.isInstalled()).toBe(true);
      const res = await handleDevAction(post({ action: 'reset', confirm: 'yes' }), ctx);
      expect(res.headers.get('location')).toBe('/dev?done=reset#result');
      expect(ctx.clock.offsetMs).toBe(86_400_000);
      expect((await getContainer()).devClock?.offsetMs).toBe(0);
      await resetContainer();

      const after = await getDevPanelContext();
      expect(after?.fakes.hubspot.isInstalled()).toBe(false);
      expect(after?.fakes.auth.users()).toEqual([]);
      expect(after?.clock.offsetMs).toBe(0);
      // What fake.state holds now (written after the reset, if at all) is the starting state.
      const stored = await after?.deps.db.query<{ key: string; value: { oauth?: { installed: boolean }; users?: unknown[] } }>(
        'select key, value from fake.state order by key',
      );
      for (const row of stored ?? []) {
        if (row.key === 'hubspot_snapshot') expect(row.value.oauth?.installed).toBe(false);
        if (row.key === 'auth_snapshot') expect(row.value.users).toEqual([]);
      }
      expect(stored?.map((row) => row.key)).not.toContain('clock_offset_ms');
    } finally {
      await resetContainer();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
