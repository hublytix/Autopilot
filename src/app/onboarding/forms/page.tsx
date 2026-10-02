import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Alert, Card, Checkbox, LinkButton, Page, SubmitButton } from '@/components/ui';
import { saveFormsAction } from '@/server/actions/onboarding/forms';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { formsPageView } from '@/server/views/onboarding/forms';
import { ownValue } from '@/shared/own-key';

// /onboarding/forms (PLAN §7.5, D-07): the portal's HubSpot forms and pop-up forms. Newsletter-like
// forms start unticked. Only submissions made after a form is ticked become leads.

export const metadata: Metadata = {
  title: 'Forms',
  robots: { index: false, follow: false },
};

const ERRORS: Readonly<Record<string, string>> = {
  none_selected: 'Tick at least one form. Leads come only from the forms you tick.',
  unknown_form: 'Your forms changed in HubSpot while this page was open. Check the list and save again.',
  invalid: 'Something was wrong with that request. Check the list and save again.',
  hubspot_unavailable: "We couldn't reach HubSpot just now. Please try again in a minute.",
  connection_inactive: 'Your HubSpot connection has stopped working. Reconnect HubSpot, then come back to this step.',
};

const TYPE_LABELS: Readonly<Record<string, string>> = { hubspot: 'Form', flow: 'Pop-up form' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function OnboardingFormsPage({ searchParams }: { searchParams: SearchParams }) {
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, await headers());
  const params = await searchParams;
  const errorCode = typeof params.error === 'string' ? params.error : undefined;
  const error = errorCode === undefined ? undefined : (ownValue(ERRORS, errorCode) ?? ERRORS.invalid);
  const view = await formsPageView(scope, deps);

  if (!view.ok) {
    return (
      <Page title="Choose your forms">
        <Alert tone="error">{ERRORS[view.reason]}</Alert>
        <LinkButton href="/onboarding/forms">Try again</LinkButton>
      </Page>
    );
  }

  return (
    <Page
      title="Which forms bring you leads?"
      description="We draft a reply for each new enquiry on the forms you tick (spam and sales pitches are filtered out). Submissions made before you tick a form are never drafted."
    >
      {error === undefined ? null : <Alert tone="error">{error}</Alert>}
      {view.forms.length === 0 ? (
        <Alert tone="warning" title="No forms found">
          <p>We didn&apos;t find any HubSpot forms or pop-up forms in your account. Create a form in HubSpot, then reload this page.</p>
        </Alert>
      ) : (
        <Card>
          <form action={saveFormsAction} className="flex flex-col gap-5">
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
                    form.newsletterDetected
                      ? `${TYPE_LABELS[form.formType] ?? 'Form'}. Looks like a newsletter sign-up, so it starts unticked. Tick it if people send enquiries through it.`
                      : (TYPE_LABELS[form.formType] ?? 'Form')
                  }
                />
              ))}
            </fieldset>
            <SubmitButton pendingLabel="Saving…">Save and continue</SubmitButton>
          </form>
        </Card>
      )}
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        Forms from other tools that HubSpot only collects (non-HubSpot forms) aren&apos;t supported yet.
      </p>
    </Page>
  );
}
