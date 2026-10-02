'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDeps } from '@/server/container';
import { dismissResultPath, submitDismissForm } from '@/server/http/action-links/dismiss';
import { isActionTokenFormat } from '@/server/security/action-tokens';

// The button on /a/[token]/dismiss (PLAN §7.4, D-26): no sign-in, the dismiss token is the
// authorisation, and it works once. Then back to the page (post/redirect/get), which shows the
// result. Sentry sees neither the form data (the token) nor the response.

export async function dismissLeadAction(formData: FormData): Promise<void> {
  const token = formData.get('token');
  if (typeof token !== 'string' || !isActionTokenFormat(token)) redirect('/');
  const path = await withServerActionInstrumentation('action_link.dismiss', { recordResponse: false }, async () =>
    dismissResultPath(token, await submitDismissForm(await getDeps(), token, await headers())),
  );
  redirect(path);
}
