import type { ReactNode } from 'react';
import { cn } from './cn';

// A bordered panel grouping one task or one piece of status. `title` renders as an h2, so a page
// keeps one h1 and a sensible outline.

export interface CardProps {
  title?: ReactNode;
  /** Plain text under the title. */
  description?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function Card({ title, description, className, children }: CardProps) {
  return (
    <section
      className={cn(
        'flex flex-col gap-4 rounded-xl border border-neutral-300 bg-white p-5 shadow-sm dark:border-neutral-700 dark:bg-neutral-900',
        className,
      )}
    >
      {title === undefined && description === undefined ? null : (
        <div className="space-y-1">
          {title === undefined ? null : <h2 className="text-lg font-semibold">{title}</h2>}
          {description === undefined ? null : <p className="text-sm text-neutral-700 dark:text-neutral-300">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}
