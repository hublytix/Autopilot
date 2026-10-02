import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-base text-neutral-700 dark:text-neutral-300">
        This page doesn&apos;t exist, or the link has expired.
      </p>
      <p>
        <Link href="/" className="font-medium underline underline-offset-4">
          Go to the home page
        </Link>
      </p>
    </main>
  );
}
