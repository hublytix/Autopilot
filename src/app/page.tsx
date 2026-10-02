import Link from 'next/link';

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-8 px-4 py-12 sm:px-6">
      <header className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{productName}</h1>
        <p className="text-lg leading-relaxed text-neutral-700 dark:text-neutral-300">
          {productName} answers and follows up every new lead automatically for HubSpot Starter users — the
          follow-up HubSpot only offers on Professional — for $49 a month.
        </p>
      </header>

      <section aria-labelledby="pricing-heading" className="space-y-4">
        <h2 id="pricing-heading" className="sr-only">
          Pricing and install
        </h2>
        <p className="text-base font-medium">$49/month after a 14-day free trial</p>
        {/* A plain link: the install route redirects to HubSpot, so it must not be prefetched. */}
        <a
          href="/api/hubspot/install"
          className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-neutral-900 px-5 py-3 text-base font-semibold text-white hover:bg-neutral-700 sm:w-auto dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Install with HubSpot
        </a>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Installing needs a Super Admin or App Marketplace Access
        </p>
      </section>

      <footer className="text-sm text-neutral-600 dark:text-neutral-400">
        Already installed?{' '}
        <Link href="/login" className="font-medium text-neutral-900 underline underline-offset-4 dark:text-neutral-100">
          Sign in
        </Link>
      </footer>
    </main>
  );
}
