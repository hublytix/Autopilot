'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Polls GET /api/onboarding/status (database only) while background work runs, and refreshes the
// page once the watched work has finished, so the server renders the result. Without JavaScript the
// page's own "Check again" link does the same. A 401 (the access token expired: the API path gets no
// proxy refresh) refreshes the page, which lets the proxy renew the session cookies (or send the
// owner to sign in), and polling goes on with the renewed session; it stops after MAX_UNAUTHORISED
// 401s in a row (the session is really gone).

export type PollWatch = 'brief' | 'baseline';

export const MAX_UNAUTHORISED = 3;

function finished(body: unknown, watch: PollWatch): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as Record<string, unknown>;
  const part = record[watch];
  if (typeof part !== 'object' || part === null) return false;
  const value = part as Record<string, unknown>;
  if (watch === 'brief') return value.status !== 'queued' && value.status !== 'running';
  return value.state !== 'running';
}

export interface StatusPollingOptions {
  readonly watch: PollWatch;
  readonly intervalMs: number;
  /** GET /api/onboarding/status. */
  readonly fetchStatus: () => Promise<Response>;
  /** router.refresh(). */
  readonly refresh: () => void;
}

/** Starts polling; returns the function that stops it. */
export function startStatusPolling({ watch, intervalMs, fetchStatus, refresh }: StatusPollingOptions): () => void {
  let stopped = false;
  let unauthorised = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    try {
      const response = await fetchStatus();
      if (response.status === 401) {
        unauthorised += 1;
        if (unauthorised >= MAX_UNAUTHORISED) stopped = true;
        refresh();
      } else {
        unauthorised = 0;
        if (response.ok && finished(await response.json(), watch)) {
          stopped = true;
          refresh();
          return;
        }
      }
    } catch {
      // A network blip: try again on the next tick.
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

export function StatusPoller({ watch, intervalMs = 3000 }: { watch: PollWatch; intervalMs?: number }) {
  const router = useRouter();
  useEffect(
    () =>
      startStatusPolling({
        watch,
        intervalMs,
        fetchStatus: () => fetch('/api/onboarding/status', { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } }),
        refresh: () => router.refresh(),
      }),
    [router, watch, intervalMs],
  );
  return null;
}
