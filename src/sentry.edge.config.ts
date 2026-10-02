// Sentry for edge route segments, imported by register() in src/instrumentation.ts (D-23).
// The proxy runs on Node in Next 16, so this matters only for routes that opt into the edge
// runtime. Same shared options as the server; no DSN means no init.
import * as Sentry from '@sentry/nextjs';
import { buildSentryOptions, sentryDsn, tracingRequestedByEnv } from './shared/observability/sentry-options';

const dsn = sentryDsn(process.env.SENTRY_DSN) ?? sentryDsn(process.env.NEXT_PUBLIC_SENTRY_DSN);
const tracingRequested = tracingRequestedByEnv(process.env.SENTRY_TRACES_SAMPLE_RATE);

if (dsn !== undefined && tracingRequested) {
  console.error(
    JSON.stringify({ level: 'error', msg: 'sentry disabled because tracing was requested', event: 'obs.sentry_refused', runtime: 'edge' }),
  );
} else if (dsn !== undefined) {
  Sentry.init(buildSentryOptions({ dsn }));
}

export const sentryEnabled: boolean = dsn !== undefined && !tracingRequested;
