import type { Metadata } from 'next';
import Link from 'next/link';

// Branch (d) of the OAuth callback when the installer is not the owner (D-35): nothing changed, and
// the owner has been sent an alert.

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Already connected',
  robots: { index: false, follow: false },
};

export default function ConnectedElsewherePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">This HubSpot account is already connected</h1>
      <p className="text-base text-neutral-700 dark:text-neutral-300">
        This HubSpot account is already connected to {productName} by another user. Nothing changed. We’ve emailed that
        user to let them know someone tried to connect it.
      </p>
      <p className="text-base text-neutral-700 dark:text-neutral-300">
        If the {productName} account is yours, sign in with its email and tap Reconnect.
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
