import type { Metadata } from 'next';
import Link from 'next/link';

// Branch (d) of the OAuth callback when the installer is the owner but has no session (D-35):
// "Sign in to finish reconnecting". Nothing changed yet; reconnecting happens from the dashboard
// once signed in. M3 also emails a sign-in link (next=/dashboard?reconnect=1) and says so here.

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Sign in to finish reconnecting',
  robots: { index: false, follow: false },
};

export default function SignInToReconnectPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to finish reconnecting</h1>
      <p className="text-base text-neutral-700 dark:text-neutral-300">
        This HubSpot account is already connected to your {productName} account. Nothing changed yet: sign in with your
        {` ${productName} `}email, then tap Reconnect on your dashboard.
      </p>
      <p>
        <Link
          href="/login"
          className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-neutral-900 px-5 py-3 text-base font-semibold text-white hover:bg-neutral-700 sm:w-auto dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Sign in
        </Link>
      </p>
    </main>
  );
}
