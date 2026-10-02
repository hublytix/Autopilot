import { afterEach, describe, expect, it, vi } from 'vitest';
import { onAlert, raiseAlert, type RaisedAlert } from './alert';

// raiseAlert: one error log line whose `code` is the alert code; the underlying error code a caller
// passes is kept under `errorCode` instead of being overwritten.

afterEach(() => {
  vi.restoreAllMocks();
});

function loggedLines(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const method of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    });
  }
  return lines;
}

describe('raiseAlert', () => {
  it('keeps a caller’s `code` as errorCode, so the alert line says which error fired', () => {
    const lines = loggedLines();
    raiseAlert('hubspot_install_oauth_config', { code: 'hubspot_oauth_config', accountId: 'acct-1' });
    expect(lines).toEqual([
      expect.objectContaining({ level: 'error', msg: 'alert raised', event: 'alert', code: 'hubspot_install_oauth_config', errorCode: 'hubspot_oauth_config', accountId: 'acct-1' }),
    ]);
  });

  it('prefers an explicit errorCode and notifies listeners with the caller’s fields', () => {
    const lines = loggedLines();
    const seen: RaisedAlert[] = [];
    const stop = onAlert((alert) => seen.push(alert));
    try {
      raiseAlert('hubspot_oauth_config', { errorCode: 'hubspot_oauth_config', connectionId: 'conn-1' });
    } finally {
      stop();
    }
    expect(lines[0]).toMatchObject({ code: 'hubspot_oauth_config', errorCode: 'hubspot_oauth_config', connectionId: 'conn-1' });
    expect(seen).toEqual([{ code: 'hubspot_oauth_config', fields: { errorCode: 'hubspot_oauth_config', connectionId: 'conn-1' } }]);
  });
});
