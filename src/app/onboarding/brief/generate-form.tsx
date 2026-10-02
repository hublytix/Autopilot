'use client';

import { useActionState } from 'react';
import { Alert, Field, fieldDescription, Input, SubmitButton } from '@/components/ui';
import type { GenerateBriefFormState } from '@/server/actions/onboarding/types';

// The website address form: starts a brief_generate job (rate-limited by the brief service, D-36).

const ERRORS: Readonly<Record<string, string>> = {
  site_url_invalid: 'Enter your website address, like example.com.',
  site_url_not_allowed: "That address can't be read. Use your public website address, without a port number or an IP address.",
  in_progress: "We're already reading your website. This page updates when it's done.",
  daily_limit: "You've used today's website reads. Fill in the brief yourself below, or try again tomorrow.",
  account_not_found: 'Something went wrong. Reload the page and try again.',
};

export interface GenerateFormProps {
  action: (state: GenerateBriefFormState, formData: FormData) => Promise<GenerateBriefFormState>;
  initialUrl: string;
  /** A generation is running, or none is left today. */
  disabled: boolean;
  submitLabel: string;
}

export function GenerateForm({ action, initialUrl, disabled, submitLabel }: GenerateFormProps) {
  const [state, formAction] = useActionState(action, { error: null, websiteUrl: initialUrl });
  const message = state.error === null ? undefined : (ERRORS[state.error] ?? ERRORS.account_not_found);
  // Address problems belong to the field; the others (limits, a run in progress) to the form.
  const fieldError = state.error?.startsWith('site_url_') === true ? message : undefined;
  const formError = fieldError === undefined ? message : undefined;
  const error = fieldError;
  return (
    <form action={formAction} className="flex flex-col gap-4">
      {formError === undefined ? null : <Alert tone="error">{formError}</Alert>}
      <Field id="website_url" label="Website address" hint="We read your homepage and up to 8 of its pages, such as services, pricing, about and contact." error={error}>
        <Input
          id="website_url"
          name="website_url"
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          required
          maxLength={2048}
          placeholder="example.com"
          defaultValue={state.websiteUrl}
          invalid={error !== undefined}
          describedBy={fieldDescription('website_url', { hint: true, error: error !== undefined })}
        />
      </Field>
      <SubmitButton pendingLabel="Starting…" disabled={disabled}>
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
