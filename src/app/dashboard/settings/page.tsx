import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Alert, Card, LinkButton, Page, SubmitButton } from '@/components/ui';
import type { PreferencesFormValues } from '@/server/actions/onboarding/types';
import { pauseFromSettingsAction, resumeFromSettingsAction, saveSettingsPreferencesAction } from '@/server/actions/settings/settings';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { settingsPageView, type SettingsPageView } from '@/server/views/settings';
import { ownValue } from '@/shared/own-key';
import { PreferencesForm } from '../../onboarding/preferences/preferences-form';
import {
  BILLING_PATH,
  billingSummary,
  changeAlertNote,
  DISCONNECT_BILLING_RESULTS,
  DISCONNECT_UNINSTALL_RESULTS,
  disconnectedLines,
  FOLLOWUPS_OFF_NOTE,
  INSTALL_PATH,
  PAUSE_NOTE,
  preferencesSavedLines,
  RESUME_NOTE,
  SETTINGS_RESULTS,
  STATE_TEXT,
  STATE_TITLE,
} from './copy';

// /dashboard/settings (PLAN §7.5, brief §5.11): Pause all / Resume, the preferences (lead-alert
// addresses 1–3 with confirmation for extras, mail client and Gmail account, quiet hours and
// weekends, follow-ups on/off, BCC address), the forms (changed on their own page, which reads
// HubSpot), billing (a summary and the link) and the HubSpot connection (Disconnect, or Reconnect).
// Owner only; no-store and noindex come from the proxy (D-49).

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function StatusCard({ view }: { view: SettingsPageView }) {
  const paused = view.pausedSince !== null;
  return (
    <Card title="Status">
      <div className="space-y-2" data-testid="settings-status" data-state={view.processingState}>
        <p className="text-xl font-semibold">{STATE_TITLE[view.processingState]}</p>
        <p className="text-neutral-700 dark:text-neutral-300">{STATE_TEXT[view.processingState]}</p>
        {paused ? <p className="text-neutral-700 dark:text-neutral-300">Paused since {view.pausedSince}.</p> : null}
      </div>
      {paused ? (
        <form action={resumeFromSettingsAction} className="space-y-2">
          <SubmitButton pendingLabel="Resuming…">Resume</SubmitButton>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">{RESUME_NOTE}</p>
        </form>
      ) : view.processingState === 'active' ? (
        <form action={pauseFromSettingsAction} className="space-y-2">
          <SubmitButton variant="secondary" pendingLabel="Pausing…">
            Pause all
          </SubmitButton>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">{PAUSE_NOTE}</p>
        </form>
      ) : view.processingState === 'onboarding' ? (
        <LinkButton href="/onboarding/baseline" variant="secondary">
          Finish setup
        </LinkButton>
      ) : view.processingState === 'inactive' ? (
        <LinkButton href={BILLING_PATH} variant="secondary">
          Go to billing
        </LinkButton>
      ) : null}
    </Card>
  );
}

function PreferencesCard({ view }: { view: SettingsPageView }) {
  const { preferences } = view.preferences;
  const notify = preferences.notifyEmails.map((entry) => entry.address);
  const initial: PreferencesFormValues = {
    mail_client: preferences.mailClient,
    gmail_account_email: preferences.gmailAccountEmail ?? '',
    notify_emails: [0, 1, 2].map((index) => notify[index] ?? ''),
    quiet_start_hour: String(preferences.quietStartHour),
    quiet_end_hour: String(preferences.quietEndHour),
    skip_weekends: preferences.skipWeekends,
    followups_enabled: preferences.followupsEnabled,
    bcc_address: preferences.bccAddress ?? '',
    timezone: preferences.timezone ?? '',
  };
  const confirmed = Object.fromEntries(preferences.savedAt === null ? [] : preferences.notifyEmails.map((entry) => [entry.address, entry.verified]));
  return (
    <Card title="Lead alerts, your mail app and follow-ups">
      <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
        <li>{FOLLOWUPS_OFF_NOTE}</li>
        {view.onboardingComplete ? <li>{changeAlertNote(preferences.ownerEmail)}</li> : null}
      </ul>
      <PreferencesForm
        action={saveSettingsPreferencesAction}
        initial={initial}
        ownerEmail={preferences.ownerEmail}
        confirmed={confirmed}
        timezone={{ current: preferences.timezone, source: preferences.timezoneSource, editable: preferences.timezoneEditable, options: view.preferences.timezones }}
      />
    </Card>
  );
}

function FormsCard({ view }: { view: SettingsPageView }) {
  return (
    <Card title="Forms" description="Leads come only from the forms you tick, and only from submissions made after you tick them.">
      {view.forms.length === 0 ? (
        <p className="text-neutral-700 dark:text-neutral-300">No forms are ticked, so no new leads are read.</p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-neutral-700 dark:text-neutral-300" data-testid="selected-forms">
          {view.forms.map((form) => (
            <li key={form.id}>{form.name === '' ? 'Untitled form' : form.name}</li>
          ))}
        </ul>
      )}
      <LinkButton href="/dashboard/settings/forms" variant="secondary">
        Change forms
      </LinkButton>
    </Card>
  );
}

function BillingCard({ view }: { view: SettingsPageView }) {
  return (
    <Card title="Billing">
      <p className="text-neutral-700 dark:text-neutral-300" data-testid="billing-summary">
        {billingSummary(view.billing)}
      </p>
      <LinkButton href={BILLING_PATH} variant="secondary">
        Open billing
      </LinkButton>
    </Card>
  );
}

function ConnectionCard({ view }: { view: SettingsPageView }) {
  if (view.connection.status === 'active') {
    return (
      <Card title="HubSpot connection" description="Autopilot reads your HubSpot account and never changes anything in it.">
        <p className="text-neutral-700 dark:text-neutral-300">Connected.</p>
        <LinkButton href="/dashboard/settings/disconnect" variant="danger">
          Disconnect HubSpot
        </LinkButton>
      </Card>
    );
  }
  return (
    <Card title="HubSpot connection">
      {disconnectedLines(view.connection.purgeOn, view.connection.daysLeft).map((line) => (
        <p key={line} className="text-neutral-700 dark:text-neutral-300">
          {line}
        </p>
      ))}
      <LinkButton href={INSTALL_PATH} plain>
        Reconnect HubSpot
      </LinkButton>
    </Card>
  );
}

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const requestHeaders = await headers();
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, requestHeaders);
  const params = await searchParams;
  const view = await settingsPageView(scope, deps);

  const resultCode = single(params.result);
  const result = ownValue(SETTINGS_RESULTS, resultCode);
  const billingResult = resultCode === 'disconnected' || resultCode === 'already_disconnected' ? ownValue(DISCONNECT_BILLING_RESULTS, single(params.billing)) : undefined;
  const uninstallResult = resultCode === 'disconnected' ? ownValue(DISCONNECT_UNINSTALL_RESULTS, single(params.uninstall)) : undefined;
  const sentRaw = single(params.sent);
  const savedLines =
    resultCode === 'preferences_saved'
      ? preferencesSavedLines({
          sent: sentRaw !== undefined && /^\d{1,2}$/.test(sentRaw) ? Number(sentRaw) : 0,
          limited: params.limited === '1',
          bcc: params.bcc === '1',
          alert: params.alert === '1',
        })
      : [];

  return (
    <Page title="Settings" width="wide">
      {result === undefined ? null : (
        <Alert tone={result.tone}>
          <p>{result.text}</p>
          {savedLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </Alert>
      )}
      {billingResult === undefined || billingResult === null ? null : <Alert tone={billingResult.tone}>{billingResult.text}</Alert>}
      {uninstallResult === undefined ? null : <Alert tone={uninstallResult.tone}>{uninstallResult.text}</Alert>}
      <StatusCard view={view} />
      <PreferencesCard view={view} />
      <FormsCard view={view} />
      <BillingCard view={view} />
      <ConnectionCard view={view} />
    </Page>
  );
}
