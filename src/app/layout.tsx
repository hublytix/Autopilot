import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: { default: productName, template: `%s · ${productName}` },
  description:
    'Answers and follows up every new lead automatically for HubSpot Starter users, for $49 a month.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-white font-sans text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        {children}
      </body>
    </html>
  );
}
