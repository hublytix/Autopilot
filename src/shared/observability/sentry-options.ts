// The one Sentry options object shared by the server, edge and browser inits (D-23, PLAN §11).
// Client- and server-safe: no `server-only`, no env reads (the DSN is passed in).
//
// Errors only. Layers (docs/research/09-nextjs-sentry.md, SENTRY-RECOMMENDED-CONFIG):
// 1. collect less: every v11 `dataCollection` option off; no tracesSampleRate/tracesSampler (a
//    rate of 0 still counts as "tracing on" for @sentry/node and adds the AI/DB integrations);
//    tracePropagationTargets []; the Anthropic_AI, Console and BrowserTracing integrations removed;
//    no egress besides the DSN and nothing env-switchable: spotlight and debug pinned off (so
//    SENTRY_SPOTLIGHT/SENTRY_DEBUG cannot turn them on), no Spotlight or session integrations
//    (session envelopes bypass beforeSend), no host name, no hostnames appended to fetch errors;
// 2. scrub what remains in beforeSend/beforeBreadcrumb (scrub.ts); never send logs or metrics.
//    (No beforeSendTransaction: v11 streams spans, so it would be ignored with a warning, and
//    there are no transactions without tracing.)
// `sendDefaultPii` no longer exists in v11 (replaced by `dataCollection`), so it is not set.
import type { DataCollection, Integration, Options as CoreOptions } from '@sentry/core';
import { scrubBreadcrumb, scrubEvent } from './scrub';

/** Every v11 data-collection default turned off (SENTRY-V11-DATA-DEFAULTS). */
export function sentryDataCollection(): DataCollection {
  return {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    stackFrameVariables: false,
    frameContextLines: 0,
  };
}

/**
 * Integrations removed from every runtime's defaults (SENTRY-GENAI-ANTHROPIC, SENTRY-HOOKS-STREAMING),
 * plus the session-tracking ones (their envelopes never pass beforeSend) and the Spotlight sidecars.
 */
export const REMOVED_SENTRY_INTEGRATIONS: readonly string[] = [
  'Anthropic_AI',
  'Console',
  'BrowserTracing',
  'BrowserSession',
  'ProcessSession',
  'Spotlight',
  'SpotlightBrowser',
];

export function filterSentryIntegrations(integrations: Integration[]): Integration[] {
  return integrations.filter((integration) => !REMOVED_SENTRY_INTEGRATIONS.includes(integration.name));
}

export type SharedSentryOptions = Required<
  Pick<
    CoreOptions,
    | 'dataCollection'
    | 'tracePropagationTargets'
    | 'integrations'
    | 'beforeSend'
    | 'beforeBreadcrumb'
    | 'beforeSendLog'
    | 'beforeSendMetric'
  >
> &
  Pick<CoreOptions, 'dsn' | 'environment' | 'release'> & {
    // Server/browser options outside CoreOptions, pinned so their env switches cannot turn them on.
    spotlight: false;
    debug: false;
    includeServerName: false;
    enhanceFetchErrorMessages: false;
  };

export interface SentryOptionsInput {
  /** Without a DSN Sentry sends nothing; the init files skip Sentry.init entirely. */
  dsn: string | undefined;
  environment?: string | undefined;
  release?: string | undefined;
}

export function buildSentryOptions(input: SentryOptionsInput): SharedSentryOptions {
  return {
    dsn: input.dsn,
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
    ...(input.release !== undefined ? { release: input.release } : {}),
    dataCollection: sentryDataCollection(),
    tracePropagationTargets: [],
    integrations: filterSentryIntegrations,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    spotlight: false,
    debug: false,
    includeServerName: false,
    enhanceFetchErrorMessages: false,
  };
}

/** A usable DSN, or undefined (empty or whitespace counts as unset). */
export function sentryDsn(value: string | undefined): string | undefined {
  const dsn = value?.trim();
  return dsn === undefined || dsn === '' ? undefined : dsn;
}

/**
 * Browser Sentry stays off on owner action links and auth pages (PLAN §7.4, D-23): their URLs
 * carry tokens and the pages show lead content.
 */
export function isBrowserSentryAllowedPath(pathname: string): boolean {
  return !/^\/(?:a|auth)(?:\/|$)/.test(pathname);
}

/**
 * Tracing must stay off (SENTRY-GENAI-ANTHROPIC): @sentry/node turns it on from this variable
 * when no rate is passed, so the server and edge inits refuse to start Sentry when it is set.
 */
export function tracingRequestedByEnv(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}
