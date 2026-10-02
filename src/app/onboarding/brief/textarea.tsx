import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/components/ui';

// A multi-line text control matching the UI kit's Input (44 px minimum, visible focus ring, error
// border, aria wiring through `describedBy`).

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'aria-describedby' | 'aria-invalid'> {
  describedBy?: string | undefined;
  invalid?: boolean;
}

export function Textarea({ describedBy, invalid = false, className, ...props }: TextareaProps) {
  return (
    <textarea
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      className={cn(
        'block min-h-24 w-full rounded-md border bg-white px-3 py-2 text-base text-neutral-900 placeholder:text-neutral-500',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600 dark:bg-neutral-900 dark:text-neutral-100',
        'dark:focus-visible:outline-blue-400',
        invalid ? 'border-red-700 dark:border-red-400' : 'border-neutral-400 dark:border-neutral-600',
        className,
      )}
      {...props}
    />
  );
}
