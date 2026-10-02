// Browser Sentry (D-23): errors only, with the shared restrictive options. Off without
// NEXT_PUBLIC_SENTRY_DSN, and never on owner action links (/a/*) or auth pages (/auth/*),
// whose URLs carry tokens and whose pages show lead content (PLAN §7.4).
import * as Sentry from '@sentry/nextjs';
import { buildSentryOptions, isBrowserSentryAllowedPath, sentryDsn } from './shared/observability/sentry-options';

const dsn = sentryDsn(process.env.NEXT_PUBLIC_SENTRY_DSN);

if (dsn !== undefined && isBrowserSentryAllowedPath(window.location.pathname)) {
  const shared = buildSentryOptions({ dsn });
  Sentry.init({
    ...shared,
    // A client-side navigation can still reach /a/* or /auth/* after init: send nothing from there.
    beforeSend: (event, hint) => (isBrowserSentryAllowedPath(window.location.pathname) ? shared.beforeSend(event, hint) : null),
  });
}

// A no-op without the BrowserTracing integration (removed); exported so Sentry does not warn.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
