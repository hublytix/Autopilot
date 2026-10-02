import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SignOutButton } from '@/components/ui';

// The dashboard shell (PLAN §7.5): the product name, the dashboard pages and Sign out. Every page
// below checks the owner itself (requireOwnerPage); the proxy refreshes the session on /dashboard and
// sends Cache-Control: private, no-store and X-Robots-Tag: noindex (D-49).

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: { default: 'Dashboard', template: `%s · ${productName}` },
  robots: { index: false, follow: false },
};

const NAV = [
  { href: '/dashboard', label: 'Leads' },
  { href: '/dashboard/brief', label: 'Your brief' },
  { href: '/dashboard/settings', label: 'Settings' },
  { href: '/dashboard/billing', label: 'Billing' },
] as const;

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-4 pt-6 sm:px-6">
        <Link href="/dashboard" prefetch={false} className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
          {productName}
        </Link>
        <nav aria-label="Dashboard" className="flex flex-wrap items-center gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium underline-offset-4 hover:underline"
            >
              {item.label}
            </Link>
          ))}
          <SignOutButton />
        </nav>
      </header>
      {children}
    </div>
  );
}
