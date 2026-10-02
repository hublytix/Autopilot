import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Alert, Card, Checkbox, LinkButton, Page, SubmitButton } from '@/components/ui';
import { saveSettingsFormsAction } from '@/server/actions/settings/settings';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { formsPageView } from '@/server/views/settings';
import { ownValue } from '@/shared/own-key';

// /dashboard/settings/forms (PLAN §7.5, brief §5.11, D-07): the portal's HubSpot forms and pop-up
// forms with the owner's ticks (the onboarding forms service: a newly ticked form only takes
// submissions made from now on). Reads HubSpot's form list, so it lives on its own page.

export const metadata: Metadata = {
  title: 'Forms',
  robots: { index: false, follow: false },
};

const ERRORS: Readonly<Record<string, string>> = {
  none_selected: 'Tick at least one form. Leads come only from the forms you tick.',
  unknown_form: 'Your forms changed in HubSpot while this page was open. Check the list and save again.',
  invalid: 'Something was wrong with that request. Check the list and save again.',
  hubspot_unavailable: "We couldn't reach HubSpot just now. Please try again in a minute.",
  connection_inactive: "HubSpot is disconnected, so we can't read your forms. Reconnect HubSpot first.",
};

const TYPE_LABELS: Readonly<Record<string, string>> = { hubspot: 'Form', flow: 'Pop-up form' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SettingsFormsPage({ searchParams }: { searchParams: SearchParams }) {
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, await headers());
  const params = await searchParams;
  const errorCode = typeof params.error === 'string' ? params.error : undefined;
  const error = errorCode === undefined ? undefined : (ownValue(ERRORS, errorCode) ?? ERRORS.invalid);
  const view = await formsPageView(scope, deps);

  if (!view.ok) {
    return (
      <Page title="Your forms">
        <Alert tone="error">{ERRORS[view.reason]}</Alert>
        {view.reason === 'connection_inactive' ? (
          <LinkButton href="/api/hubspot/install" plain>
            Reconnect HubSpot
          </LinkButton>
        ) : (
          <LinkButton href="/dashboard/settings/forms">Try again</LinkButton>
        )}
        <LinkButton href="/dashboard/settings" variant="secondary">
          Back to settings
        </LinkButton>
      </Page>
    );
  }

  return (
    <Page
      title="Your forms"
      description="We draft your reply to each new enquiry on the forms you tick (spam and sales pitches are filtered out). Submissions made before you tick a form are never drafted."
    >
      {error === undefined ? null : <Alert tone="error">{error}</Alert>}
      {view.forms.length === 0 ? (
        <Alert tone="warning" title="No forms found">
          <p>We didn&apos;t find any HubSpot forms or pop-up forms in your account. Create a form in HubSpot, then reload this page.</p>
        </Alert>
      ) : (
        <Card>
          <form action={saveSettingsFormsAction} className="flex flex-col gap-5">
            <fieldset className="flex flex-col gap-4">
              <legend className="sr-only">Forms</legend>
              {view.forms.map((form, index) => (
                <Checkbox
                  key={form.id}
                  id={`form_${index}`}
                  name="form_id"
                  value={form.id}
                  defaultChecked={form.checked}
                  label={form.name === '' ? 'Untitled form' : form.name}
                  hint={
                    form.newsletterDetected && !form.stored
                      ? `${TYPE_LABELS[form.formType] ?? 'Form'}. Looks like a newsletter sign-up, so it starts unticked. Tick it if people send enquiries through it.`
                      : (TYPE_LABELS[form.formType] ?? 'Form')
                  }
                />
              ))}
            </fieldset>
            <SubmitButton pendingLabel="Saving…">Save forms</SubmitButton>
          </form>
        </Card>
      )}
      <LinkButton href="/dashboard/settings" variant="secondary">
        Back to settings
      </LinkButton>
    </Page>
  );
}
