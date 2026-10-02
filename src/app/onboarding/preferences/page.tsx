import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Alert, Card, LinkButton, Page } from '@/components/ui';
import { savePreferencesAction } from '@/server/actions/onboarding/preferences';
import type { PreferencesFormValues } from '@/server/actions/onboarding/types';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { preferencesPageView } from '@/server/views/onboarding/preferences';
import { PreferencesForm } from './preferences-form';

// /onboarding/preferences (PLAN §7.5, D-13, D-33, D-46): mail client, lead-alert addresses (extras
// confirmed by email), quiet hours, weekends, timezone, BCC address and follow-ups. Saving during
// onboarding sends no change alert.

export const metadata: Metadata = {
  title: 'Preferences',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function OnboardingPreferencesPage({ searchParams }: { searchParams: SearchParams }) {
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, await headers());
  const params = await searchParams;
  const view = await preferencesPageView(scope, deps);
  const { preferences } = view;

  const saved = params.saved === '1' && preferences.savedAt !== null;
  const sentRaw = typeof params.sent === 'string' && /^\d{1,2}$/.test(params.sent) ? Number(params.sent) : 0;
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
  const waiting = preferences.notifyEmails.filter((entry) => !entry.verified).length;

  return (
    <Page title="Your preferences" description="How you reply, where lead alerts go, and when follow-up drafts may arrive. You can change these later.">
      {saved ? (
        <Alert tone="success" title="Preferences saved">
          {sentRaw > 0 ? (
            <p>
              We sent a confirmation email to {sentRaw === 1 ? '1 address' : `${sentRaw} addresses`}. {sentRaw === 1 ? 'It gets' : 'They get'} lead
              alerts once confirmed; the link works for 7 days.
            </p>
          ) : null}
          {sentRaw === 0 && waiting > 0 ? <p>Addresses waiting for confirmation get lead alerts once someone opens their confirmation email.</p> : null}
          <LinkButton href="/onboarding/inbox">Continue</LinkButton>
        </Alert>
      ) : null}
      {saved && params.limited === '1' ? (
        <Alert tone="warning">
          We didn&apos;t send every confirmation email because of today&apos;s limit. Save your preferences again tomorrow to send the rest.
        </Alert>
      ) : null}
      {saved && params.bcc === '1' ? (
        <Alert tone="warning" title="Check your BCC address">
          <p>
            It doesn&apos;t look like a HubSpot BCC or forwarding address, which usually ends in bcc.hubspot.com or forward.hubspot.com (sometimes
            with a region in between). We saved it anyway.
          </p>
        </Alert>
      ) : null}
      <Card>
        <PreferencesForm
          action={savePreferencesAction}
          initial={initial}
          ownerEmail={preferences.ownerEmail}
          confirmed={confirmed}
          timezone={{ current: preferences.timezone, source: preferences.timezoneSource, editable: preferences.timezoneEditable, options: view.timezones }}
        />
      </Card>
    </Page>
  );
}
