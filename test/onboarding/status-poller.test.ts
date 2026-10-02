import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UNAUTHORISED, startStatusPolling } from '@/app/onboarding/brief/status-poller';

// The brief and baseline steps' poller: it refreshes the page when the watched work is done, and a
// 401 (expired access token) refreshes the page so the proxy renews the session, then keeps polling.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const running = (): Response => json(200, { brief: { status: 'running' } });
const done = (): Response => json(200, { brief: { status: 'done' } });
const unauthorised = (): Response => json(401, { error: 'unauthorised' });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function poll(responses: (() => Response)[]) {
  const refresh = vi.fn();
  let calls = 0;
  const fetchStatus = vi.fn(async () => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    if (next === undefined) throw new Error('no response');
    return next();
  });
  const stop = startStatusPolling({ watch: 'brief', intervalMs: 3000, fetchStatus, refresh });
  return { refresh, fetchStatus, stop };
}

describe('StatusPoller', () => {
  it('refreshes once when the watched job is done, then stops', async () => {
    const { refresh, fetchStatus } = poll([running, running, done]);
    await vi.advanceTimersByTimeAsync(9000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it('after a 401 refreshes the page (the proxy renews the session) and keeps polling until the job is done', async () => {
    const { refresh, fetchStatus } = poll([running, unauthorised, running, done]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchStatus).toHaveBeenCalledTimes(4);
    // One refresh for the 401, one for the finished job.
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it(`stops after ${MAX_UNAUTHORISED} 401s in a row`, async () => {
    const { refresh, fetchStatus } = poll([unauthorised]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(MAX_UNAUTHORISED);
    expect(refresh).toHaveBeenCalledTimes(MAX_UNAUTHORISED);
  });

  it('stops when the page goes away', async () => {
    const { fetchStatus, stop } = poll([running]);
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });
});
