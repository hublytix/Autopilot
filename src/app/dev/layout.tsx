import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { devToolsEnabled } from '@/server/http/dev';

// Every /dev page exists only in fake mode (PLAN §7.6, D-29); elsewhere it is a 404. Each page and
// route handler under /dev checks again: layouts don't wrap route handlers.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Dev tools',
  robots: { index: false, follow: false },
};

export default function DevLayout({ children }: Readonly<{ children: ReactNode }>) {
  if (!devToolsEnabled()) notFound();
  return children;
}
