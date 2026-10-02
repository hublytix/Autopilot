'use server';
import 'server-only';
import { withServerActionInstrumentation } from '@sentry/nextjs';
import { headers } from 'next/headers';
import { getDeps } from '@/server/container';
import { submitEditForm, type EditFormState } from '@/server/http/action-links/edit';

// "Done editing" on /a/[token]/edit (PLAN §7.4, D-13): no sign-in, the edit token is the
// authorisation. Answers with the result page's state (useActionState), so the browser gets a 200
// page with the compose link as a button, never a redirect. Sentry sees neither the form data (the
// token and the edited text) nor the response.

export async function submitEditAction(_previous: EditFormState, formData: FormData): Promise<EditFormState> {
  return withServerActionInstrumentation('action_link.edit', { recordResponse: false }, async () => {
    const token = formData.get('token');
    return submitEditForm(await getDeps(), typeof token === 'string' ? token : '', { headers: await headers(), formData });
  });
}
