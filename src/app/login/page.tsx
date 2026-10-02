import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Sign in',
};

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p id="login-status" className="text-base text-neutral-700 dark:text-neutral-300">
        Sign-in arrives soon. You will get a one-time link by email; there is no password.
      </p>

      {/* Placeholder until the magic-link flow lands (M3): the fieldset is disabled, so nothing is submitted. */}
      <form method="post" aria-describedby="login-status" className="space-y-4">
        <fieldset disabled className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="email" className="block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              className="block min-h-11 w-full rounded-md border border-neutral-400 bg-white px-3 py-2 text-base text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </div>
          <button
            type="submit"
            className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-neutral-900 px-5 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Email me a sign-in link
          </button>
        </fieldset>
      </form>

      <p className="text-sm">
        <Link href="/" className="font-medium underline underline-offset-4">
          Back to the home page
        </Link>
      </p>
    </main>
  );
}
