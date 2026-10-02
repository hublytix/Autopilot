import { cn } from '@/components/ui';
import type { LeadDisplayStatus } from '@/server/domain/types';

// One lead status as a small labelled badge (D-32). Colour only supports the words, never replaces them.

const TONES: Readonly<Record<LeadDisplayStatus, string>> = {
  dismissed: 'border-neutral-300 bg-neutral-100 text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200',
  replied: 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-100',
  filtered: 'border-neutral-300 bg-neutral-100 text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200',
  not_processed: 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50',
  no_reply: 'border-neutral-300 bg-white text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200',
  send_confirmed: 'border-blue-300 bg-blue-50 text-blue-950 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-50',
  send_clicked: 'border-blue-200 bg-white text-blue-950 dark:border-blue-900 dark:bg-neutral-900 dark:text-blue-100',
  drafted: 'border-neutral-300 bg-white text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100',
  processing: 'border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300',
};

export function StatusBadge({ status, label }: { status: LeadDisplayStatus; label: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-sm font-medium', TONES[status])} data-status={status}>
      {label}
    </span>
  );
}
