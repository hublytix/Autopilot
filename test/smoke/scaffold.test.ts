import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleHealth } from '@/server/http/health';

describe('GET /api/health', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports ok with the fake mode when APP_MODE=fake', async () => {
    vi.stubEnv('APP_MODE', 'fake');
    const res = handleHealth(new Request('http://localhost/api/health'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, mode: 'fake' });
  });

  it('reports mode "unknown" when APP_MODE is missing or not fake/live', async () => {
    vi.stubEnv('APP_MODE', 'staging');
    const res = handleHealth(new Request('http://localhost/api/health'));
    expect(await res.json()).toEqual({ ok: true, mode: 'unknown' });
  });
});
