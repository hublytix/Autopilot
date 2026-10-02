import type { ReactNode } from 'react';
import { cn } from './cn';

// A short message in a coloured panel. Errors are announced at once (role="alert"); other tones
// politely (role="status"). Colour is never the only signal: every alert has words.

export type AlertTone = 'info' | 'success' | 'warning' | 'error';

const TONES: Record<AlertTone, string> = {
  info: 'border-blue-300 bg-blue-50 text-blue-950 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-50',
  success: 'border-green-300 bg-green-50 text-green-950 dark:border-green-800 dark:bg-green-950 dark:text-green-50',
  warning: 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50',
  error: 'border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-50',
};

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Alert({ tone = 'info', title, children, className }: AlertProps) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('rounded-lg border px-4 py-3 text-base', TONES[tone], className)}>
      {title === undefined ? null : <p className="font-semibold">{title}</p>}
      {children === undefined ? null : <div className={cn('space-y-2', title !== undefined && 'mt-1')}>{children}</div>}
    </div>
  );
}
