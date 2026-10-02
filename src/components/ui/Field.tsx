import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from './cn';

// Form fields with a visible label, an optional hint and an optional error, all tied to the control
// with ids (aria-describedby, aria-invalid), and 44 px tall controls. Use Field around Input/Select:
//   <Field id="email" label="Email" hint="We'll send a link here." error={…}>
//     <Input id="email" name="email" type="email" describedBy={fieldDescription('email', {hint: true})} />
//   </Field>

export interface FieldDescriptionParts {
  hint?: boolean;
  error?: boolean;
}

/** The aria-describedby value for a control whose Field has a hint and/or an error. */
export function fieldDescription(id: string, parts: FieldDescriptionParts): string | undefined {
  const ids = [parts.hint === true ? `${id}-hint` : null, parts.error === true ? `${id}-error` : null].filter((v): v is string => v !== null);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export interface FieldProps {
  /** The control's id (the label's htmlFor). */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Marks the label "(optional)". */
  optional?: boolean;
  children: ReactNode;
}

export function Field({ id, label, hint, error, optional = false, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {optional ? <span className="font-normal text-neutral-600 dark:text-neutral-400"> (optional)</span> : null}
      </label>
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-sm text-neutral-600 dark:text-neutral-400">
          {hint}
        </p>
      )}
      {children}
      {error === undefined || error === null || error === false ? null : (
        <p id={`${id}-error`} className="text-sm font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL =
  'block min-h-11 w-full rounded-md border bg-white px-3 py-2 text-base text-neutral-900 placeholder:text-neutral-500 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600 dark:bg-neutral-900 dark:text-neutral-100 ' +
  'dark:focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:opacity-60';

function controlClasses(invalid: boolean, className?: string): string {
  return cn(CONTROL, invalid ? 'border-red-700 dark:border-red-400' : 'border-neutral-400 dark:border-neutral-600', className);
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'aria-describedby' | 'aria-invalid'> {
  /** fieldDescription(id, …). */
  describedBy?: string | undefined;
  invalid?: boolean;
}

export function Input({ describedBy, invalid = false, className, ...props }: InputProps) {
  return <input aria-describedby={describedBy} aria-invalid={invalid || undefined} className={controlClasses(invalid, className)} {...props} />;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'aria-describedby' | 'aria-invalid'> {
  describedBy?: string | undefined;
  invalid?: boolean;
}

export function Select({ describedBy, invalid = false, className, children, ...props }: SelectProps) {
  return (
    <select aria-describedby={describedBy} aria-invalid={invalid || undefined} className={controlClasses(invalid, className)} {...props}>
      {children}
    </select>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'aria-describedby'> {
  id: string;
  label: ReactNode;
  /** Plain text under the label. */
  hint?: ReactNode;
}

/** A checkbox whose whole row (label included) is a 44 px tap target. */
export function Checkbox({ id, label, hint, className, ...props }: CheckboxProps) {
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <input
        id={id}
        type="checkbox"
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        className="mt-0.5 size-6 shrink-0 cursor-pointer rounded border-neutral-400 accent-neutral-900 dark:accent-neutral-100"
        {...props}
      />
      <div className="flex min-h-11 flex-col">
        <label htmlFor={id} className="cursor-pointer text-base">
          {label}
        </label>
        {hint === undefined ? null : (
          <p id={`${id}-hint`} className="text-sm text-neutral-600 dark:text-neutral-400">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
