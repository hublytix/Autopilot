'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import './globals.css';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// Next's server-error digest is an opaque hash; anything else is not reported as a tag.
const DIGEST = /^[A-Za-z0-9_-]{1,64}$/;

// Replaces the root layout on an uncaught error, so it renders its own <html> and <body>.
// Never render error.message: it can carry lead content or tokens (law 4).
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    // A no-op unless browser Sentry was initialised (never on /a/* or /auth/*). The shared
    // beforeSend replaces any message that is not an error code and strips the URL (D-23).
    const digest = error.digest !== undefined && DIGEST.test(error.digest) ? error.digest : undefined;
    Sentry.captureException(error, digest !== undefined ? { tags: { digest } } : undefined);
  }, [error]);

  return (
    <html lang="en">
      <head>
        <title>Something went wrong</title>
      </head>
      <body className="min-h-dvh bg-white font-sans text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-12 sm:px-6">
          <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
          <p className="text-base text-neutral-700 dark:text-neutral-300">
            The page couldn&apos;t load. Please try again in a moment.
          </p>
          <div>
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-neutral-900 px-5 py-3 text-base font-semibold text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
