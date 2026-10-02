'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { isActionTokenFormat } from '@/server/security/action-tokens';
import { confirmNotifyAddress, verifyNotifyPath } from '@/server/services/onboarding';
import { actionContext } from '../auth/context';

// The confirm button on /a/[token]/verify-notify (PLAN §7.4, D-46): no sign-in, the token is the
// authorisation; Server Actions carry Next's same-origin check. Then back to the page (PRG), which
// shows the result. Sentry sees neither the form data (the token) nor the response.

export async function confirmNotifyAddressAction(formData: FormData): Promise<void> {
  const token = formData.get('token');
  if (typeof token !== 'string' || !isActionTokenFormat(token)) redirect('/');
  await withServerActionInstrumentation('action_link.verify_notify', { recordResponse: false }, async () => {
    const { deps, ip } = await actionContext();
    await confirmNotifyAddress(deps, { token, ip });
  });
  redirect(verifyNotifyPath(token));
}
