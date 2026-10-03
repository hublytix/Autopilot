import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import './globals.css';

// Every page renders per request: the proxy's CSP carries a per-request nonce (script-src 'nonce-…'
// 'strict-dynamic'), and Next puts it on its scripts only when the page renders with the request.
// A prerendered page's framework scripts would carry no nonce and be blocked.

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: { default: productName, template: `%s · ${productName}` },
  // Not brief §1's one-liner: that stays word for word on / only (§5.13), with its qualifier; every
  // other page's snippet says what the product does (laws 1 and 5, D-86).
  description:
    'Drafts your replies and day-2 and day-5 follow-ups for new HubSpot form leads; you send them from your own mail app. $49 a month after a 14-day free trial.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  await connection();
  return (
    <html lang="en">
      <body className="min-h-dvh bg-white font-sans text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        {children}
      </body>
    </html>
  );
}
