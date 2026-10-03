import type { ReactNode } from 'react';
import { LEGAL_TODO } from './legal';
import { SiteFooter } from './SiteFooter';

// The shell of every legal page (PLAN §7.2, law 5): one readable column, the page's h1, a visible
// "TODO: legal review" notice (each page is a placeholder until a lawyer has read it), the sections
// and the footer. Sections are h2s, so the outline stays simple for screen readers.

export interface LegalPageProps {
  title: string;
  productName: string;
  /** One or two sentences under the title. */
  intro: ReactNode;
  children: ReactNode;
}

export function LegalPage({ title, productName, intro, children }: LegalPageProps) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="space-y-3">
        <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">{productName}</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p
          role="note"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-base text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50"
        >
          <strong className="font-semibold">{LEGAL_TODO}.</strong> This page is a placeholder that a lawyer has not reviewed yet.
        </p>
        <div className="text-base leading-relaxed text-neutral-700 dark:text-neutral-300">{intro}</div>
      </header>
      <div className="flex flex-col gap-8 text-base leading-relaxed">{children}</div>
      <SiteFooter productName={productName} />
    </main>
  );
}

export interface LegalSectionProps {
  title: string;
  children: ReactNode;
}

export function LegalSection({ title, children }: LegalSectionProps) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
