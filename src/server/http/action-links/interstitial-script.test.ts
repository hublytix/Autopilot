import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { INTERSTITIAL_SCRIPT } from './html';

// The mailto interstitial's constant script (D-13, D-26), run in a bare VM context with a fake
// document: it opens the mail app at once, but posts the beacon only on a person's trusted gesture,
// once, and never under automation, so a link-detonation sandbox that runs the page records no click.

type Listener = (event: { isTrusted: boolean }) => void;

function run(options: { webdriver?: boolean; withBeacon?: boolean } = {}) {
  const listeners: { type: string; listener: Listener }[] = [];
  const attributes: Record<string, string> =
    options.withBeacon === false ? {} : { 'data-beacon': '/a/apt_token/beacon', 'data-nonce': 'NONCE_VALUE_123456' };
  const elements: Record<string, { getAttribute: (name: string) => string | null }> = {
    'ap-send': { getAttribute: (name) => attributes[name] ?? null },
    'ap-open': { getAttribute: (name) => (name === 'href' ? 'mailto:jane@example.com?subject=Hi' : null) },
  };
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      addEventListener: (type: string, listener: Listener) => listeners.push({ type, listener }),
    },
    navigator: { webdriver: options.webdriver ?? false },
    location: { href: 'https://app.example/a/apt_token/send' },
    fetch,
    JSON,
  };
  context.window = context;
  runInNewContext(INTERSTITIAL_SCRIPT, context);
  const fire = (type: string, isTrusted: boolean): void => {
    for (const entry of listeners) if (entry.type === type) entry.listener({ isTrusted });
  };
  return { fetch, fire, location: context.location as { href: string } };
}

describe('interstitial script', () => {
  it('opens the mail app on load and posts no beacon by itself', () => {
    const page = run();
    expect(page.location.href).toBe('mailto:jane@example.com?subject=Hi');
    expect(page.fetch).not.toHaveBeenCalled();
  });

  it('posts the beacon once, same-origin and keepalive, on the first trusted tap', () => {
    const page = run();
    page.fire('click', true);
    page.fire('click', true);
    page.fire('copy', true);
    expect(page.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = page.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/a/apt_token/beacon');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit', referrerPolicy: 'same-origin', body: '{"n":"NONCE_VALUE_123456"}' });
  });

  it('ignores untrusted (scripted) clicks', () => {
    const page = run();
    page.fire('click', false);
    expect(page.fetch).not.toHaveBeenCalled();
  });

  it('never posts under automation (navigator.webdriver)', () => {
    const page = run({ webdriver: true });
    page.fire('click', true);
    expect(page.fetch).not.toHaveBeenCalled();
  });

  it('posts nothing when the page carries no beacon nonce (a HEAD-issued or nonce-less page)', () => {
    const page = run({ withBeacon: false });
    page.fire('click', true);
    expect(page.fetch).not.toHaveBeenCalled();
  });
});
