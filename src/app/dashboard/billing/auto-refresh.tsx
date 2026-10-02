'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// While a checkout is open the billing page has no return URL to wait for (Razorpay's hosted page
// leaves the customer there, D-20): it re-reads our own database every few seconds instead (a
// server refresh, no full reload, focus kept), for a while, then stops. Without JavaScript the page's
// "Check again" link does the same.

export interface AutoRefreshProps {
  /** Seconds between refreshes. */
  everySeconds: number;
  /** Stop after this many minutes. */
  forMinutes: number;
}

export function AutoRefresh({ everySeconds, forMinutes }: AutoRefreshProps) {
  const router = useRouter();
  useEffect(() => {
    let elapsed = 0;
    const id = window.setInterval(() => {
      elapsed += everySeconds;
      if (elapsed > forMinutes * 60) {
        window.clearInterval(id);
        return;
      }
      if (document.visibilityState === 'visible') router.refresh();
    }, everySeconds * 1000);
    return () => window.clearInterval(id);
  }, [router, everySeconds, forMinutes]);
  return null;
}
