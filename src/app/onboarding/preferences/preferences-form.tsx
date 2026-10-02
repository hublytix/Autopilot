'use client';

import { useActionState } from 'react';
import { Alert, Checkbox, Field, fieldDescription, Input, Select, SubmitButton } from '@/components/ui';
import type { FieldIssue, PreferencesFormState, PreferencesFormValues } from '@/server/actions/onboarding/types';

// The preferences form (PLAN §7.5, D-13, D-33, D-46). Works without JavaScript; with it, a form
// with an error keeps what the owner typed.

export interface PreferencesFormProps {
  action: (state: PreferencesFormState, formData: FormData) => Promise<PreferencesFormState>;
  initial: PreferencesFormValues;
  ownerEmail: string;
  /** Saved addresses and whether each is confirmed. */
  confirmed: Readonly<Record<string, boolean>>;
  timezone: { current: string | null; source: 'hubspot' | 'utc_offset' | 'owner' | null; editable: boolean; options: readonly string[] };
}

const MAIL_CLIENTS = [
  { value: 'gmail', label: 'Gmail', hint: 'Including Google Workspace.' },
  { value: 'outlook_work', label: 'Outlook for work or school', hint: 'Microsoft 365 accounts.' },
  { value: 'outlook_personal', label: 'Outlook personal', hint: 'Outlook.com, Hotmail and Live addresses.' },
  { value: 'other', label: 'Something else', hint: 'Your device opens its default mail app.' },
] as const;

function hourLabel(hour: number): string {
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${hour < 12 ? 'am' : 'pm'} (${String(hour).padStart(2, '0')}:00)`;
}

function timezoneHint(current: string | null, source: PreferencesFormProps['timezone']['source']): string {
  if (current === null) return "We couldn't read it from HubSpot, so please choose it.";
  if (source === 'utc_offset') return 'HubSpot gave us only a UTC offset, which may not follow daylight saving time. Choose your time zone.';
  return 'You chose this time zone.';
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function message(issue: FieldIssue): string {
  switch (issue.code) {
    case 'invalid_choice':
      return 'Choose the email app you reply from.';
    case 'invalid_email':
      return issue.path.startsWith('notify_emails') ? 'Enter a valid email address.' : 'Enter a valid email address, or leave this empty.';
    case 'required':
      return 'Enter at least one email address for lead alerts.';
    case 'too_many':
      return 'Use at most 3 addresses.';
    case 'invalid_hour':
      return 'Choose an hour from the list.';
    case 'no_allowed_hours':
      return 'These settings leave no time in the week for follow-ups. Shorten the quiet hours or allow weekends.';
    case 'timezone_required':
      return 'Choose your time zone.';
    case 'invalid_timezone':
      return 'Choose a time zone from the list.';
    default:
      return 'Something was wrong with the form. Check it and save again.';
  }
}

export function PreferencesForm({ action, initial, ownerEmail, confirmed, timezone }: PreferencesFormProps) {
  const [state, formAction] = useActionState(action, { issues: [], values: null });
  const values = state.values ?? initial;
  const issueFor = (path: string): string | undefined => {
    const issue = state.issues.find((candidate) => candidate.path === path);
    return issue === undefined ? undefined : message(issue);
  };
  const generalIssue = state.issues.find((issue) => issue.path === '');
  const mailError = issueFor('mail_client');
  const gmailError = issueFor('gmail_account_email');
  const notifyError = issueFor('notify_emails');
  const startError = issueFor('quiet_start_hour');
  const endError = issueFor('quiet_end_hour');
  const tzError = issueFor('timezone');
  const bccError = issueFor('bcc_address');

  return (
    <form key={JSON.stringify(values)} action={formAction} className="flex flex-col gap-8" noValidate>
      {state.issues.length > 0 ? (
        <Alert tone="error" title="Some fields need a look">
          <p>{generalIssue === undefined ? 'Fix the fields marked below, then save again.' : message(generalIssue)}</p>
        </Alert>
      ) : null}

      <fieldset className="flex flex-col gap-3" aria-describedby={mailError === undefined ? 'mail-hint' : 'mail-hint mail-error'}>
        <legend className="mb-1 text-base font-semibold">Which email app do you reply from?</legend>
        <p id="mail-hint" className="text-sm text-neutral-700 dark:text-neutral-300">
          &ldquo;Send from my email&rdquo; opens your reply, ready to send, in this app. You always send it yourself.
        </p>
        {mailError === undefined ? null : (
          <p id="mail-error" className="text-sm font-medium text-red-700 dark:text-red-400">
            {mailError}
          </p>
        )}
        {MAIL_CLIENTS.map((client) => (
          <div key={client.value} className="flex items-start gap-3">
            <input
              id={`mail_${client.value}`}
              type="radio"
              name="mail_client"
              value={client.value}
              defaultChecked={values.mail_client === client.value}
              aria-describedby={`mail_${client.value}-hint`}
              className="mt-0.5 size-6 shrink-0 cursor-pointer accent-neutral-900 dark:accent-neutral-100"
            />
            <div className="flex min-h-11 flex-col">
              <label htmlFor={`mail_${client.value}`} className="cursor-pointer text-base">
                {client.label}
              </label>
              <p id={`mail_${client.value}-hint`} className="text-sm text-neutral-600 dark:text-neutral-400">
                {client.hint}
              </p>
            </div>
          </div>
        ))}
        <Field
          id="gmail_account_email"
          label="Gmail address you reply from"
          hint="Only for Gmail, and only if you're signed in to more than one Google account in your browser."
          optional
          error={gmailError}
        >
          <Input
            id="gmail_account_email"
            name="gmail_account_email"
            type="email"
            inputMode="email"
            autoComplete="email"
            maxLength={254}
            defaultValue={values.gmail_account_email}
            invalid={gmailError !== undefined}
            describedBy={fieldDescription('gmail_account_email', { hint: true, error: gmailError !== undefined })}
          />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-base font-semibold">Where should lead alerts go?</legend>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          1 to 3 addresses. {ownerEmail} is confirmed already. Any other address gets a confirmation email and receives nothing until
          someone confirms it.
        </p>
        {notifyError === undefined ? null : <p className="text-sm font-medium text-red-700 dark:text-red-400">{notifyError}</p>}
        {values.notify_emails.map((address, index) => {
          const id = `notify_email_${index}`;
          const error = issueFor(`notify_emails.${index}`);
          const saved = confirmed[address.trim().toLowerCase()];
          const hint = saved === undefined ? undefined : saved ? 'Confirmed' : 'Waiting for confirmation';
          return (
            <Field key={id} id={id} label={`Alert address ${index + 1}`} optional={index > 0} hint={hint} error={error}>
              <Input
                id={id}
                name={id}
                type="email"
                inputMode="email"
                autoComplete={index === 0 ? 'email' : 'off'}
                maxLength={254}
                defaultValue={address}
                invalid={error !== undefined}
                describedBy={fieldDescription(id, { hint: hint !== undefined, error: error !== undefined })}
              />
            </Field>
          );
        })}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-base font-semibold">Quiet hours for follow-ups</legend>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          Follow-up drafts wait until quiet hours end. New-lead alerts always come at once. Choose the same hour twice for no quiet hours.
        </p>
        {timezone.editable ? (
          <Field id="timezone" label="Your time zone" hint={timezoneHint(timezone.current, timezone.source)} error={tzError}>
            <Select
              id="timezone"
              name="timezone"
              defaultValue={values.timezone === '' ? (timezone.current ?? '') : values.timezone}
              invalid={tzError !== undefined}
              describedBy={fieldDescription('timezone', { hint: true, error: tzError !== undefined })}
            >
              <option value="">Choose…</option>
              {timezone.options.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replaceAll('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            Times are in <strong>{(timezone.current ?? 'UTC').replaceAll('_', ' ')}</strong>, your HubSpot account&apos;s time zone.
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="quiet_start_hour" label="Quiet from" error={startError}>
            <Select
              id="quiet_start_hour"
              name="quiet_start_hour"
              defaultValue={values.quiet_start_hour}
              invalid={startError !== undefined}
              describedBy={fieldDescription('quiet_start_hour', { error: startError !== undefined })}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={String(hour)}>
                  {hourLabel(hour)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="quiet_end_hour" label="Until" error={endError}>
            <Select
              id="quiet_end_hour"
              name="quiet_end_hour"
              defaultValue={values.quiet_end_hour}
              invalid={endError !== undefined}
              describedBy={fieldDescription('quiet_end_hour', { error: endError !== undefined })}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={String(hour)}>
                  {hourLabel(hour)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Checkbox id="skip_weekends" name="skip_weekends" defaultChecked={values.skip_weekends} label="No follow-ups at weekends" />
        <Checkbox
          id="followups_enabled"
          name="followups_enabled"
          defaultChecked={values.followups_enabled}
          label="Draft follow-ups"
          hint="Up to two follow-up drafts, 2 and 5 days after the first alert. They stop when HubSpot shows the lead replied (this needs your inbox logged in HubSpot; see the inbox check). You can turn this off later."
        />
      </fieldset>

      <Field
        id="bcc_address"
        label="Your HubSpot BCC address"
        hint="If you use HubSpot's BCC address to log emails, enter it here and we'll add it to your reply each time you open one. You can find it in your HubSpot email settings."
        optional
        error={bccError}
      >
        <Input
          id="bcc_address"
          name="bcc_address"
          type="email"
          inputMode="email"
          autoComplete="off"
          maxLength={254}
          defaultValue={values.bcc_address}
          invalid={bccError !== undefined}
          describedBy={fieldDescription('bcc_address', { hint: true, error: bccError !== undefined })}
        />
      </Field>

      <SubmitButton pendingLabel="Saving…">Save preferences</SubmitButton>
    </form>
  );
}
