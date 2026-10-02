'use client';

import { usePathname } from 'next/navigation';
import { currentStepIndex, Steps, type Step } from './Steps';

// Steps whose current step is the one whose `href` the current path starts with, so a layout can
// render the indicator once for every page of a flow.

export interface PathStepsProps {
  steps: readonly Step[];
  label?: string | undefined;
}

export function PathSteps({ steps, label }: PathStepsProps) {
  const pathname = usePathname();
  return <Steps steps={steps} current={currentStepIndex(steps, pathname)} label={label} />;
}
