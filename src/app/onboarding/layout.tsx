import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LinkButton, Page, PathSteps, SignOutButton, type Step } from '@/components/ui';
import { getDeps } from '@/server/container';
import { onboardingAccess } from '@/server/http/auth/guards';

// The onboarding shell (PLAN §7.5): the step indicator for every onboarding page, behind the
// owner-or-pending guard. A bound owner's verified session, or a genuine pending_install cookie
// (the email step, before anyone is bound), gets in; each page then checks what it needs itself
// (requireOwnerPage, or the email step's install check). Anyone else sees how to start.

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: { default: 'Set up', template: `%s · Set up · ${productName}` },
  robots: { index: false, follow: false },
};

const STEPS: readonly Step[] = [
  { label: 'Your email', href: '/onboarding/email' },
  { label: 'Your business', href: '/onboarding/brief' },
  { label: 'Forms', href: '/onboarding/forms' },
  { label: 'Preferences', href: '/onboarding/preferences' },
  { label: 'Inbox check', href: '/onboarding/inbox' },
  { label: 'Finish', href: '/onboarding/baseline' },
];

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const access = await onboardingAccess(await getDeps(), requestHeaders);
  if (access === 'none') {
    return (
      <Page
        centered
        eyebrow={productName}
        title="Start from HubSpot"
        description={`Setting up ${productName} starts by installing it in HubSpot. If you've already set it up, sign in instead.`}
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <LinkButton href="/">Install {productName}</LinkButton>
          <LinkButton href="/login" variant="secondary">
            Sign in
          </LinkButton>
        </div>
      </Page>
    );
  }
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pt-6 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <Link href="/" className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
            {productName}
          </Link>
          {access === 'owner' ? <SignOutButton /> : null}
        </div>
        <PathSteps steps={STEPS} label="Setup progress" />
      </header>
      {children}
    </div>
  );
}
