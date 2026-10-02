// Sentry for the Node.js runtime, imported by register() in src/instrumentation.ts (D-23).
// Errors only, with the shared restrictive options. Without a DSN (fake mode, tests, local dev)
// Sentry is never initialised, so every capture is a no-op.
import * as Sentry from '@sentry/nextjs';
import { buildSentryOptions, sentryDsn, tracingRequestedByEnv } from './shared/observability/sentry-options';

const dsn = sentryDsn(process.env.SENTRY_DSN) ?? sentryDsn(process.env.NEXT_PUBLIC_SENTRY_DSN);
const tracingRequested = tracingRequestedByEnv(process.env.SENTRY_TRACES_SAMPLE_RATE);

if (dsn !== undefined && tracingRequested) {
  // A static line: the variable would turn tracing on, which leaks route tokens and AI content.
  console.error(
    JSON.stringify({ level: 'error', msg: 'sentry disabled because tracing was requested', event: 'obs.sentry_refused', runtime: 'nodejs' }),
  );
} else if (dsn !== undefined) {
  Sentry.init(buildSentryOptions({ dsn }));
}

export const sentryEnabled: boolean = dsn !== undefined && !tracingRequested;
