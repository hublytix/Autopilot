import { describe, expect, it, vi } from 'vitest';
import { armGestureBeacon } from './PageBeacon';

// D-26 / law 3: the copy page's beacon posts only on a person's gesture, once, and never when
// automation drives the browser. Events dispatched by a script are untrusted (isTrusted false),
// so a trusted gesture is simulated by calling the listener with { isTrusted: true }.

type Listener = (event: Event) => void;

function fakeDocument() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    },
    fire(type: string, isTrusted: boolean) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, isTrusted } as Event);
    },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

describe('armGestureBeacon', () => {
  it('posts nothing on load, then once on the first trusted click', () => {
    const doc = fakeDocument();
    const post = vi.fn();
    armGestureBeacon({ target: doc as unknown as EventTarget, automated: false, post });
    expect(post).not.toHaveBeenCalled();
    doc.fire('click', true);
    doc.fire('click', true);
    doc.fire('copy', true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(doc.count()).toBe(0);
  });

  it('counts a copy made by hand as a gesture', () => {
    const doc = fakeDocument();
    const post = vi.fn();
    armGestureBeacon({ target: doc as unknown as EventTarget, automated: false, post });
    doc.fire('copy', true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('ignores clicks a script synthesises (untrusted)', () => {
    const doc = fakeDocument();
    const post = vi.fn();
    armGestureBeacon({ target: doc as unknown as EventTarget, automated: false, post });
    doc.fire('click', false);
    expect(post).not.toHaveBeenCalled();
  });

  it('never posts when automation drives the browser (navigator.webdriver)', () => {
    const doc = fakeDocument();
    const post = vi.fn();
    armGestureBeacon({ target: doc as unknown as EventTarget, automated: true, post });
    doc.fire('click', true);
    expect(post).not.toHaveBeenCalled();
    expect(doc.count()).toBe(0);
  });

  it('stops listening when the page goes away', () => {
    const doc = fakeDocument();
    const post = vi.fn();
    const disarm = armGestureBeacon({ target: doc as unknown as EventTarget, automated: false, post });
    disarm();
    doc.fire('click', true);
    expect(post).not.toHaveBeenCalled();
  });
});
