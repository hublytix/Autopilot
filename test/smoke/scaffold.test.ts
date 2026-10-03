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

  it('names the invalid variables in the logs once per instance (names only, never a value)', async () => {
    vi.resetModules();
    const { handleHealth: fresh } = await import('@/server/http/health');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    vi.stubEnv('APP_MODE', 'live');
    vi.stubEnv('APP_URL', 'not-a-url-0d1f');
    await fresh(new Request('http://localhost/api/health')).json();
    await fresh(new Request('http://localhost/api/health')).json();
    spy.mockRestore();
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '{}') as { msg?: string; event?: string; codes?: string[]; errorCode?: string };
    expect(line).toMatchObject({ msg: 'health: invalid environment', event: 'health.env_invalid', errorCode: 'env_invalid' });
    expect(line.codes).toContain('APP_URL');
    expect(lines[0]).not.toContain('not-a-url-0d1f');
  });

  it('reports mode "unknown" when APP_MODE is missing or not fake/live', async () => {
    vi.stubEnv('APP_MODE', 'staging');
    const res = handleHealth(new Request('http://localhost/api/health'));
    expect(await res.json()).toEqual({ ok: true, mode: 'unknown' });
  });
});
