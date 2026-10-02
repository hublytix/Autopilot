// Next.js instrumentation hook. It must live in src/ next to src/app, or Next silently ignores
// it (NX14-INSTR-LOCATION; test/layout/file-layout.test.ts). register() runs once per server
// instance and only initialises Sentry for the current runtime; it never opens the database or
// reads env.ts (D-29), so `next build` needs no environment.
import * as Sentry from '@sentry/nextjs';

export async function register(): Promise<void> {
  let sentryEnabled = false;
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    ({ sentryEnabled } = await import('./sentry.server.config'));
  } else if (process.env.NEXT_RUNTIME === 'edge') {
    ({ sentryEnabled } = await import('./sentry.edge.config'));
  }
  // One static line per instance, so WIRE_UP can see that the hook ran (NX14-INSTR-LOCATION).
  console.info(
    JSON.stringify({ level: 'info', msg: 'instrumentation registered', event: 'obs.register', runtime: process.env.NEXT_RUNTIME ?? 'unknown', sentry: sentryEnabled }),
  );
}

// Server Component, route handler and Server Action errors (Next 15+). The request headers it
// receives are dropped by the shared scrubber.
export const onRequestError = Sentry.captureRequestError;
