import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { Alert, Card, LinkButton, Page, SubmitButton } from '@/components/ui';
import { finishOnboardingAction } from '@/server/actions/onboarding/finish';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import type { BaselinePageView } from '@/server/views/onboarding/baseline';
import { baselinePageView } from '@/server/views/onboarding/baseline';
import { StatusPoller } from '../brief/status-poller';

// /onboarding/baseline (PLAN §6.1, §7.5, §9.7, D-38): starts the baseline job and shows its status;
// Finish is enabled only when the onboarding-complete conditions hold, otherwise the page says what
// is missing, with links. The baseline may still be running when the owner finishes.

export const metadata: Metadata = {
  title: 'Finish',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** "3 h 30 m", "45 m", "2 d 3 h" (whole minutes). */
function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

const REQUIREMENTS = {
  brief: { done: 'Your business brief is saved.', todo: 'Finish your brief first', href: '/onboarding/brief' },
  forms: { done: 'At least one form is selected.', todo: 'Choose at least one form', href: '/onboarding/forms' },
  preferences: { done: 'Your preferences are saved.', todo: 'Save your preferences', href: '/onboarding/preferences' },
} as const;

function BaselineStatus({ view }: { view: BaselinePageView }) {
  if (view.start === 'no_forms') {
    return (
      <p>
        We measure your history on the forms you choose.{' '}
        <Link href="/onboarding/forms" prefetch={false} className="font-medium underline underline-offset-4">
          Choose your forms
        </Link>{' '}
        first.
      </p>
    );
  }
  if (view.start === 'not_connected' && view.baseline.state !== 'done') {
    return <p>Your HubSpot connection isn&apos;t active, so we can&apos;t read your history. This doesn&apos;t stop you finishing.</p>;
  }
  const { baseline } = view;
  if (baseline.state === 'running') {
    return (
      <>
        <StatusPoller watch="baseline" />
        <p>We&apos;re reading the last 30 days of submissions on your forms and the emails logged in HubSpot. You can finish setup while this runs.</p>
        <p>
          <Link href="/onboarding/baseline" prefetch={false} className="underline underline-offset-4">
            Check again
          </Link>
        </p>
      </>
    );
  }
  if (baseline.state === 'not_started') {
    return <p>We couldn&apos;t measure your history today. This doesn&apos;t stop you finishing; your Monday reports will say &ldquo;Not enough data&rdquo; for the comparison.</p>;
  }
  const record = baseline.baseline;
  switch (baseline.reason) {
    case 'too_many_submissions':
      return <p>Not enough data: your forms had more than 500 submissions in the last 30 days, more than we read for a baseline.</p>;
    case 'no_leads':
      return <p>Not enough data: we found no leads on your forms in the last 30 days.</p>;
    case 'no_logged_email':
    case 'not_readable':
      return (
        <p>
          Not enough logged history: {record.leadsCounted > 0 ? `we found ${record.leadsCounted} leads in the last 30 days, but ` : ''}
          we couldn&apos;t find emails logged in your HubSpot account to compare with.
        </p>
      );
    case null:
      return (
        <>
          <dl className="grid grid-cols-1 gap-3">
            <div>
              <dt className="text-sm text-neutral-700 dark:text-neutral-300">Leads in the last 30 days</dt>
              <dd className="text-lg font-semibold">{record.leadsCounted}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-700 dark:text-neutral-300">Median time to the first logged email to a lead</dt>
              <dd className="text-lg font-semibold">
                {record.medianSecondsToFirstOutbound === null ? 'Not enough data' : formatDuration(record.medianSecondsToFirstOutbound)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-700 dark:text-neutral-300">Leads with no logged email to them</dt>
              <dd className="text-lg font-semibold">
                {record.withoutOutboundCount ?? 0} of {record.leadsCounted}
                {baseline.percentWithout === null ? '' : ` (${baseline.percentWithout}%)`}
              </dd>
            </div>
          </dl>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">Logged emails from anyone in your HubSpot account count, not only yours.</p>
        </>
      );
  }
}

export default async function OnboardingBaselinePage({ searchParams }: { searchParams: SearchParams }) {
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, await headers());
  const params = await searchParams;
  const view = await baselinePageView(scope, deps);
  const { gate } = view;

  if (gate.completedAt !== null) {
    return (
      <Page
        title="Setup is complete"
        description={
          gate.processingState === 'active'
            ? 'New leads on your chosen forms now get a draft reply sent to your alert addresses.'
            : "Your dashboard shows your account's status and anything that needs your attention."
        }
      >
        <LinkButton href="/dashboard">Go to your dashboard</LinkButton>
      </Page>
    );
  }

  return (
    <Page title="Almost done" description="Here's how you've been answering leads, so your Monday reports can show what changes.">
      <Card title="Your last 30 days" description="From HubSpot data only. Nothing about these leads is stored.">
        <BaselineStatus view={view} />
      </Card>

      <Card title="Ready to finish?">
        {params.error === 'not_ready' && !gate.ready ? <Alert tone="error">Setup isn&apos;t finished yet. Complete the steps below first.</Alert> : null}
        <ul className="flex flex-col gap-3">
          {(Object.keys(REQUIREMENTS) as (keyof typeof REQUIREMENTS)[]).map((requirement) => {
            const copy = REQUIREMENTS[requirement];
            const missing = gate.missing.includes(requirement);
            return (
              <li key={requirement} className="flex items-start gap-3">
                <span aria-hidden="true" className={missing ? 'text-amber-700 dark:text-amber-400' : 'text-green-700 dark:text-green-400'}>
                  {missing ? '○' : '✓'}
                </span>
                {missing ? (
                  <Link href={copy.href} prefetch={false} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">
                    {copy.todo}
                  </Link>
                ) : (
                  <span>{copy.done}</span>
                )}
              </li>
            );
          })}
        </ul>
        {gate.noConfirmedNotifyAddress ? (
          <Alert tone="warning">None of your alert addresses is confirmed yet. Lead alerts start once one of them is confirmed.</Alert>
        ) : null}
        <form action={finishOnboardingAction}>
          <SubmitButton pendingLabel="Finishing…" disabled={!gate.ready}>
            Finish setup
          </SubmitButton>
        </form>
        {gate.ready ? null : <p className="text-sm text-neutral-700 dark:text-neutral-300">Finish is available once every step above is done.</p>}
      </Card>
    </Page>
  );
}
