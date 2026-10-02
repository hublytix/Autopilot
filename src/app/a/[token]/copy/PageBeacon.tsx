'use client';

import { useEffect } from 'react';

// The copy page's beacon (D-26): it posts the page's nonce once, on the first gesture of a person on
// the page (a trusted click, such as a Copy button or "Open in my mail app instead", or a copy), so
// it is the click signal that holds even within 60 s of the email arriving. It never posts on load
// and never under automation (navigator.webdriver): link-detonation sandboxes (Safe Links,
// Proofpoint, Mimecast…) run pages in real browsers, and a load-time beacon would count their
// visits as clicks (law 3). referrerPolicy 'same-origin' (also the page's own policy, D-62) makes
// the browser send a real Origin header, which the beacon's same-origin check needs.

export interface PageBeaconProps {
  url: string;
  nonce: string;
}

export interface GestureBeaconOptions {
  /** Where gestures are listened for (the document). */
  readonly target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** navigator.webdriver: automation drives this browser. */
  readonly automated: boolean;
  /** Posts the beacon. */
  readonly post: () => void;
}

/** Arms the once-only gesture beacon; returns the function that disarms it. */
export function armGestureBeacon({ target, automated, post }: GestureBeaconOptions): () => void {
  if (automated) return () => undefined;
  let sent = false;
  const onGesture = (event: Event): void => {
    if (sent || event.isTrusted !== true) return;
    sent = true;
    post();
    disarm();
  };
  const disarm = (): void => {
    target.removeEventListener('click', onGesture, true);
    target.removeEventListener('copy', onGesture, true);
  };
  target.addEventListener('click', onGesture, true);
  target.addEventListener('copy', onGesture, true);
  return disarm;
}

export function PageBeacon({ url, nonce }: PageBeaconProps) {
  useEffect(
    () =>
      armGestureBeacon({
        target: document,
        automated: navigator.webdriver === true,
        post: () => {
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ n: nonce }),
            keepalive: true,
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'same-origin',
          }).catch(() => undefined);
        },
      }),
    [url, nonce],
  );
  return null;
}
