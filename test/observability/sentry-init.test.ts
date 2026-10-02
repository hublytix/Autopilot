import type { ErrorEvent } from '@sentry/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSentryOptions, REMOVED_SENTRY_INTEGRATIONS } from '@/shared/observability/sentry-options';
import { scrubEvent } from '@/shared/observability/scrub';
import { ACTION_TOKEN, LEAD_EMAIL, LEAD_MESSAGE, findForbidden } from './fixtures';

// The three Sentry init files must hand Sentry.init exactly the shared options (D-23). The
// scrubber and envelope tests build those options themselves, so without this test a file that
// called `Sentry.init({ dsn })` would pass every other check.

const sentry = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({
  init: sentry.init,
  captureRouterTransitionStart: vi.fn(),
  captureRequestError: vi.fn(),
}));

const DSN = 'https://publickey@o0.ingest.sentry.invalid/0';

/** An event with content in the places the scrubber cleans. */
function leakyEvent(): ErrorEvent {
  return {
    type: undefined,
    message: `lead ${LEAD_EMAIL}`,
    transaction: `GET /a/${ACTION_TOKEN}/send`,
    exception: { values: [{ type: 'Error', value: LEAD_MESSAGE }] },
    server_name: 'ip-10-0-0-1',
  };
}

type InitOptions = ReturnType<typeof buildSentryOptions>;

function initOptions(): InitOptions {
  expect(sentry.init).toHaveBeenCalledTimes(1);
  return sentry.init.mock.calls[0]?.[0] as InitOptions;
}

/** The shared options minus their functions, which are compared by behaviour instead. */
function dataOf(options: InitOptions): Record<string, unknown> {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => typeof value !== 'function'));
}

/** The module is re-imported per test (vi.resetModules), so compare the filter by behaviour. */
function expectIntegrationFilter(options: InitOptions): void {
  const names = [...REMOVED_SENTRY_INTEGRATIONS, 'Http', 'LinkedErrors'];
  const filter = options.integrations;
  expect(typeof filter).toBe('function');
  const kept = typeof filter === 'function' ? filter(names.map((name) => ({ name }))) : [];
  expect(kept.map((integration) => integration.name)).toEqual(['Http', 'LinkedErrors']);
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  sentry.init.mockReset();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const name of ['SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN', 'SENTRY_TRACES_SAMPLE_RATE']) vi.stubEnv(name, '');
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each([
  ['server', () => import('@/sentry.server.config')],
  ['edge', () => import('@/sentry.edge.config')],
])('sentry.%s.config.ts', (_runtime, load) => {
  it('initialises Sentry with the shared options', async () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    const { sentryEnabled } = await load();
    expect(sentryEnabled).toBe(true);
    const options = initOptions();
    expect(dataOf(options)).toEqual(dataOf(buildSentryOptions({ dsn: DSN })));
    expectIntegrationFilter(options);
    expect(options.beforeSend(leakyEvent(), {})).toEqual(scrubEvent(leakyEvent()));
    expect(findForbidden(JSON.stringify(options.beforeSend(leakyEvent(), {})))).toBeUndefined();
    expect(options.beforeBreadcrumb({ category: 'console', message: LEAD_MESSAGE })).toBeNull();
    expect(options.beforeSendLog({ level: 'info', message: LEAD_MESSAGE })).toBeNull();
  });

  it('does not initialise Sentry without a DSN', async () => {
    const { sentryEnabled } = await load();
    expect(sentryEnabled).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it('refuses to initialise Sentry when SENTRY_TRACES_SAMPLE_RATE is set', async () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '0');
    const { sentryEnabled } = await load();
    expect(sentryEnabled).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('instrumentation-client.ts', () => {
  function stubLocation(pathname: string): { pathname: string } {
    const location = { pathname };
    vi.stubGlobal('window', { location });
    return location;
  }

  it('initialises browser Sentry with the shared options, and sends nothing once on /a/* or /auth/*', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', DSN);
    const location = stubLocation('/dashboard');
    await import('@/instrumentation-client');
    const options = initOptions();
    expect(dataOf(options)).toEqual(dataOf(buildSentryOptions({ dsn: DSN })));
    expectIntegrationFilter(options);
    expect(options.beforeSend(leakyEvent(), {})).toEqual(scrubEvent(leakyEvent()));

    location.pathname = `/a/${ACTION_TOKEN}/send`;
    expect(options.beforeSend(leakyEvent(), {})).toBeNull();
    location.pathname = '/auth/confirm';
    expect(options.beforeSend(leakyEvent(), {})).toBeNull();
  });

  it.each(['/a/token/send', '/auth/confirm'])('does not initialise on %s', async (pathname) => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', DSN);
    stubLocation(pathname);
    await import('@/instrumentation-client');
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it('does not initialise without NEXT_PUBLIC_SENTRY_DSN', async () => {
    stubLocation('/dashboard');
    await import('@/instrumentation-client');
    expect(sentry.init).not.toHaveBeenCalled();
  });
});
