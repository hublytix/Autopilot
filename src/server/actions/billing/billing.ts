'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { runBillingControl, type BillingControl } from '@/server/services/billing';
import { requireOwnerAction } from '../auth/context';

// The billing page's buttons (PLAN §7.5, §9.9): Subscribe, Cancel and Resume, owner only (Next checks
// the Origin of every Server Action). The body is shared with the POST /api/billing/* route handlers
// (services/billing/controls.ts). Subscribe lands on /dashboard/billing/checkout, which sends the
// owner on to Razorpay's hosted page with a plain link (CSP form-action 'self', D-56); the others
// come back to /dashboard/billing with the outcome code.

async function run(name: string, control: BillingControl): Promise<string> {
  return withServerActionInstrumentation(name, { recordResponse: false }, async () => {
    const { deps, scope } = await requireOwnerAction();
    return runBillingControl(deps, scope, control);
  });
}

export async function startCheckoutAction(): Promise<void> {
  redirect(await run('billing.checkout', 'checkout'));
}

export async function cancelSubscriptionAction(): Promise<void> {
  redirect(await run('billing.cancel', 'cancel'));
}

export async function resumeSubscriptionAction(): Promise<void> {
  redirect(await run('billing.resume', 'resume'));
}
