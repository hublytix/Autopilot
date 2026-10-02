'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Re-renders the inbox-check page from the server every few seconds while the background check
// runs, so the legs update without a reload (form inputs keep their values). Without JavaScript the
// page offers a "Check now" link instead.

export interface AutoRefreshProps {
  intervalMs: number;
}

export function AutoRefresh({ intervalMs }: AutoRefreshProps) {
  const router = useRouter();
  useEffect(() => {
    const handle = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(handle);
  }, [router, intervalMs]);
  return null;
}
