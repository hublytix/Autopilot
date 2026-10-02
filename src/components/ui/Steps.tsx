import type { ReactNode } from 'react';
import { cn } from './cn';

// A progress indicator for a multi-step flow (onboarding): numbered steps, the current one marked
// with aria-current="step", earlier ones as done. Labels stay short; on phones only the current
// step's label shows, with "Step n of N" for everyone.

export interface Step {
  label: ReactNode;
  /** The step's page; used by PathSteps to find the current step. */
  href?: string | undefined;
}

/** The index of the step whose href is the path or a parent of it; -1 when none matches. */
export function currentStepIndex(steps: readonly Step[], pathname: string): number {
  return steps.findIndex((step) => step.href !== undefined && (pathname === step.href || pathname.startsWith(`${step.href}/`)));
}

export interface StepsProps {
  steps: readonly Step[];
  /** Zero-based index of the current step; -1 when none is current. */
  current: number;
  /** The nav's accessible name. */
  label?: string | undefined;
}

export function Steps({ steps, current, label = 'Progress' }: StepsProps) {
  return (
    <nav aria-label={label} className="w-full">
      {current >= 0 && current < steps.length ? (
        <p className="mb-2 text-sm font-medium text-neutral-600 dark:text-neutral-400">
          Step {current + 1} of {steps.length}
        </p>
      ) : null}
      <ol className="flex w-full items-center gap-2">
        {steps.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'upcoming';
          return (
            <li key={index} aria-current={state === 'current' ? 'step' : undefined} className="flex min-w-0 flex-1 flex-col gap-1">
              <span
                aria-hidden="true"
                className={cn(
                  'h-1.5 w-full rounded-full',
                  state === 'upcoming' ? 'bg-neutral-300 dark:bg-neutral-700' : 'bg-neutral-900 dark:bg-neutral-100',
                )}
              />
              <span
                className={cn(
                  'truncate text-xs',
                  state === 'current' ? 'font-semibold text-neutral-900 dark:text-neutral-100' : 'hidden text-neutral-600 sm:block dark:text-neutral-400',
                )}
              >
                <span className="sr-only">{state === 'done' ? 'Done: ' : state === 'current' ? 'Current: ' : 'Next: '}</span>
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
