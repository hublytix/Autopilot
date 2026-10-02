import type { NextConfig } from 'next';
import { withSentryConfig, type SentryBuildOptions } from '@sentry/nextjs/config';

// PLAN §14: the display name is the only public value besides the Sentry DSN.
const productName = process.env.PRODUCT_NAME?.trim() || 'Hublytix Autopilot';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // PGlite ships WASM and data files that must be loaded from node_modules at runtime, not bundled.
  serverExternalPackages: ['@electric-sql/pglite'],
  env: {
    NEXT_PUBLIC_PRODUCT_NAME: productName,
  },
};

// Sentry build options (D-23, SENTRY-SETUP-FILES, SENTRY-TUNNEL-CSP). SENTRY_AUTH_TOKEN,
// SENTRY_ORG and SENTRY_PROJECT are build-only variables. Source maps are generated and uploaded
// only when the token is set (and deleted from the output afterwards, the SDK default); without
// it nothing is uploaded and no browser source maps are produced. No tunnel route, no Sentry
// telemetry, and no build-time instrumentation of server dependencies (errors only, no tracing).
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim() || undefined;
const sentryOrg = process.env.SENTRY_ORG?.trim() || undefined;
const sentryProject = process.env.SENTRY_PROJECT?.trim() || undefined;

const sentryBuildOptions: SentryBuildOptions = {
  ...(sentryOrg !== undefined ? { org: sentryOrg } : {}),
  ...(sentryProject !== undefined ? { project: sentryProject } : {}),
  ...(sentryAuthToken !== undefined ? { authToken: sentryAuthToken } : {}),
  telemetry: false,
  silent: sentryAuthToken === undefined,
  tunnelRoute: false,
  buildTimeInstrumentation: false,
  sourcemaps: { disable: sentryAuthToken === undefined },
  release: { create: sentryAuthToken !== undefined, finalize: sentryAuthToken !== undefined },
};

export default withSentryConfig(nextConfig, sentryBuildOptions);
