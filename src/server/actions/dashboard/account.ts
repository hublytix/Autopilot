'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { requireOwnerAction } from '../auth/context';
import { runPauseControl } from './controls';

// Pause all / Resume on the dashboard's status card (PLAN §6.1, §9.6, D-42; M7's settings page has
// them too). Owner only. Back to /dashboard with the outcome code.

export async function pauseAllAction(): Promise<void> {
  const path = await withServerActionInstrumentation('dashboard.pause', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return runPauseControl(deps, scope, true);
  });
  redirect(path);
}

export async function resumeAllAction(): Promise<void> {
  const path = await withServerActionInstrumentation('dashboard.resume', { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return runPauseControl(deps, scope, false);
  });
  redirect(path);
}
