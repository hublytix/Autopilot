import type { Metadata } from 'next';
import { LinkButton, Page } from '@/components/ui';

// Branch (d) of the OAuth callback when the installer is the owner but has no session (D-35, PLAN
// §9.1 (d)): "Sign in to finish reconnecting". Nothing changed yet; reconnecting happens from the
// dashboard once signed in. The callback emails a sign-in link (next=/dashboard?reconnect=1, at
// most 3 per 15 minutes per email) and adds `?sent=1` only when one went out, so the page never
// claims an email that was not sent (law 5).

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Sign in to finish reconnecting',
  robots: { index: false, follow: false },
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SignInToReconnectPage({ searchParams }: Props) {
  const sent = (await searchParams).sent === '1';
  return (
    <Page
      centered
      title="Sign in to finish reconnecting"
      description={`This HubSpot account is already connected to your ${productName} account. Nothing has changed yet.`}
    >
      {sent ? (
        <p className="text-base text-neutral-700 dark:text-neutral-300">
          We’ve emailed a sign-in link to your {productName} email. Open it, then tap Reconnect on your dashboard. The
          link works once and expires in 1 hour.
        </p>
      ) : (
        <p className="text-base text-neutral-700 dark:text-neutral-300">
          Sign in with your {productName} email, then tap Reconnect on your dashboard.
        </p>
      )}
      <LinkButton href="/login" variant={sent ? 'secondary' : 'primary'}>
        {sent ? 'Go to sign in' : 'Sign in'}
      </LinkButton>
    </Page>
  );
}
