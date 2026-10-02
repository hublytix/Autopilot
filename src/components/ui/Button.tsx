import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

// Buttons and button-styled links share one look: at least 44 px tall (a comfortable tap target),
// full width on phones, a visible focus ring, and a clear disabled state.

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BASE =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-5 py-2.5 text-base font-semibold transition-colors ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400 ' +
  'disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300',
  secondary:
    'border border-neutral-400 bg-white text-neutral-900 hover:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800',
  danger: 'bg-red-700 text-white hover:bg-red-800 dark:bg-red-600 dark:hover:bg-red-500',
  ghost: 'text-neutral-900 underline-offset-4 hover:underline dark:text-neutral-100',
};

/** The classes of a button of `variant` (also for links styled as buttons). */
export function buttonClasses(variant: ButtonVariant = 'primary', fullWidth = true, className?: string): string {
  return cn(BASE, VARIANTS[variant], fullWidth ? 'w-full sm:w-auto' : 'w-auto', className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Full width on phones, natural width from `sm` up (default true). */
  fullWidth?: boolean;
}

/** A native button. `type` defaults to "button": pass type="submit" inside a form. */
export function Button({ variant = 'primary', fullWidth = true, className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClasses(variant, fullWidth, className)} {...props} />;
}
