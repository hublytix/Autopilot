import type { ReactNode } from 'react';
import { cn } from './cn';

// The page shell every app page uses: one centred, mobile-first column with the page's single h1,
// an optional lead paragraph and the content below. `narrow` suits forms (sign-in, onboarding
// steps); `wide` suits tables and dashboards.

export interface PageProps {
  title: ReactNode;
  /** One or two plain sentences under the title. */
  description?: ReactNode;
  /** A small line above the title (the product name, or "Step 2 of 6"). */
  eyebrow?: ReactNode;
  width?: 'narrow' | 'wide';
  /** Vertically centre the content on tall screens (short pages such as sign-in). */
  centered?: boolean;
  children?: ReactNode;
}

export function Page({ title, description, eyebrow, width = 'narrow', centered = false, children }: PageProps) {
  return (
    <main
      className={cn(
        'mx-auto flex w-full flex-col gap-6 px-4 py-10 sm:px-6',
        width === 'narrow' ? 'max-w-md' : 'max-w-3xl',
        centered && 'min-h-dvh justify-center',
      )}
    >
      <header className="space-y-2">
        {eyebrow === undefined ? null : <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">{eyebrow}</p>}
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {description === undefined ? null : (
          <p className="text-base leading-relaxed text-neutral-700 dark:text-neutral-300">{description}</p>
        )}
      </header>
      {children}
    </main>
  );
}
