import type { Metadata } from 'next';
import Link from 'next/link';

// Where a failed HubSpot install lands (PLAN §7.3): a neutral page with the permission note (D-35).
// `reason` is one of the callback's failure codes; anything else shows the generic line.

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Install didn’t finish',
  robots: { index: false, follow: false },
};

const REASONS: Readonly<Record<string, string>> = {
  state: 'The install link expired, or it was finished in a different browser. Please start again.',
  denied: 'The install was cancelled in HubSpot. Nothing was connected.',
  bad_code: 'HubSpot’s approval expired before we could finish. Please try again.',
  missing_scopes: `HubSpot didn’t grant every permission ${productName} needs, so nothing was connected.`,
  config: 'Something is wrong on our side, and we have been alerted. Please try again later.',
  unavailable: 'We couldn’t reach HubSpot to finish the install. Please try again.',
};

const GENERIC = 'The install didn’t finish. Please try again.';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function InstallFailedPage({ searchParams }: { searchParams: SearchParams }) {
  const reason = (await searchParams).reason;
  const message = typeof reason === 'string' && Object.hasOwn(REASONS, reason) ? REASONS[reason] : GENERIC;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Install didn’t finish</h1>
      <p className="text-base text-neutral-700 dark:text-neutral-300">{message}</p>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Installing needs a HubSpot Super Admin, or a user with App Marketplace Access.
      </p>
      {/* A plain link: the install route redirects to HubSpot, so it must not be prefetched. */}
      <a
        href="/api/hubspot/install"
        className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-neutral-900 px-5 py-3 text-base font-semibold text-white hover:bg-neutral-700 sm:w-auto dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        Try again
      </a>
      <p className="text-sm">
        <Link href="/" className="font-medium underline underline-offset-4">
          Back to the home page
        </Link>
      </p>
    </main>
  );
}
