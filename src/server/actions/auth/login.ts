'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { requestLoginLink } from '@/server/services/auth/login';
import { actionContext } from './context';

// The /login form (PLAN §7.2, D-22): the same neutral page afterwards whatever happened, after the
// service's ~800 ms floor; the sending finishes in `after()`, so its duration never shows in the
// answer. Sentry sees neither the form data nor the headers.

const LOGIN_SENT_PATH = '/login?sent=1';

export async function loginAction(formData: FormData): Promise<void> {
  await withServerActionInstrumentation('auth.login', { recordResponse: false }, async () => {
    const { deps, ip } = await actionContext();
    await requestLoginLink(deps, { email: formData.get('email'), ip }, { defer: (work) => after(work) });
  });
  redirect(LOGIN_SENT_PATH);
}
