'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { buttonClasses, type ButtonVariant } from './Button';

// A form's submit button that says what is happening while the form posts (and cannot be pressed
// twice). Without JavaScript it is a plain submit button.

export interface SubmitButtonProps {
  children: ReactNode;
  /** Shown while the form is submitting, e.g. "Sending…". */
  pendingLabel?: ReactNode;
  variant?: ButtonVariant;
  fullWidth?: boolean;
  className?: string;
  disabled?: boolean;
  name?: string;
  value?: string;
}

export function SubmitButton({ children, pendingLabel, variant = 'primary', fullWidth = true, className, disabled, name, value }: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={disabled === true || pending}
      aria-busy={pending}
      className={buttonClasses(variant, fullWidth, className)}
    >
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
}
