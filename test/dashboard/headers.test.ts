import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefreshedSession } from '@/server/ports/auth';

// Every owner page of the dashboard is personal data (D-49, PLAN §7.5, §10.7): the proxy answers
// `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`, and each page also declares
// `robots: noindex, nofollow` in its metadata. Without a session the proxy sends the owner to /login.

type Refresh = (request: Request, response: Response) => Promise<RefreshedSession>;
const fakeRefresh = vi.fn<Refresh>();

vi.mock('@/server/adapters/fake/auth/proxy-session', () => ({ checkFakeProxySession: fakeRefresh }));
vi.mock('@/server/adapters/live/auth', () => ({ refreshLiveProxySession: vi.fn() }));

const { proxy } = await import('@/proxy');

const PATHS = ['/dashboard', '/dashboard?reconnect=1', '/dashboard/leads/7fb4bd35-be1c-49eb-a15c-d4661a00c7ea', '/dashboard/leads/7fb4bd35-be1c-49eb-a15c-d4661a00c7ea?result=dismiss.dismissed', '/dashboard/brief'];

beforeEach(() => {
  fakeRefresh.mockReset();
  vi.stubEnv('APP_MODE', 'fake');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dashboard response headers', () => {
  it.each(PATHS)('%s is private, no-store and noindex for a signed-in owner', async (path) => {
    fakeRefresh.mockImplementation(async (_req, res) => ({ response: res, user: { userId: 'u-1', email: 'owner@example.com' } }));
    const res = await proxy(new NextRequest(`http://localhost:3000${path}`));
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it.each(PATHS)('%s without a session goes to /login, still private and noindex', async (path) => {
    fakeRefresh.mockImplementation(async (_req, res) => ({ response: res, user: null }));
    const res = await proxy(new NextRequest(`http://localhost:3000${path}`));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });
});

describe('dashboard page metadata', () => {
  it.each([
    ['@/app/dashboard/layout', () => import('@/app/dashboard/layout')],
    ['@/app/dashboard/page', () => import('@/app/dashboard/page')],
    ['@/app/dashboard/leads/[id]/page', () => import('@/app/dashboard/leads/[id]/page')],
    ['@/app/dashboard/brief/page', () => import('@/app/dashboard/brief/page')],
  ] as const)('%s asks robots not to index or follow', async (_name, load) => {
    const { metadata } = await load();
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
