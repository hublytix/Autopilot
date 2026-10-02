import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Alert, Card, Page, SubmitButton } from '@/components/ui';
import { pauseAllAction, resumeAllAction } from '@/server/actions/dashboard/account';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { dashboardView, RECENT_LEADS_LIMIT, type StatusCardView } from '@/server/views/dashboard';
import { ownValue } from '@/shared/own-key';
import { Banners } from './banners';
import { DASHBOARD_RESULTS, STATUS_TEXT, statusTitle, trialText } from './copy';
import { LeadList } from './lead-list';

// /dashboard (PLAN §7.5, §6.1, §9.6, D-32, D-42, D-48): the status card (the account's processing
// state in plain words, trial days left, Pause all / Resume), the banners (reconnect with the days
// left before the data is deleted, billing, the pause, the daily cap and deferred leads, drafts that
// need the owner's touch, what HubSpot's logging lets us confirm), and the most recent leads, each
// with one status. Owner only; an owner who has not finished setup goes back to it (unless HubSpot
// needs reconnecting first). `?reconnect=1` (the reconnect sign-in link, M3) always shows Reconnect
// HubSpot. No-store and noindex come from the proxy (D-49).

export const metadata: Metadata = {
  title: 'Dashboard',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function StatusCard({ status }: { status: StatusCardView }) {
  return (
    <Card title="Status">
      <div className="space-y-2" data-testid="status-card" data-state={status.state}>
        <p className="text-xl font-semibold">{statusTitle(status)}</p>
        <p className="text-neutral-700 dark:text-neutral-300">{STATUS_TEXT[status.state]}</p>
        {status.state === 'disconnected' && status.purgeOn !== null ? (
          <p className="text-neutral-700 dark:text-neutral-300">If you don&apos;t reconnect by {status.purgeOn}, we delete your account&apos;s data.</p>
        ) : null}
        {status.pausedSince === null ? null : <p className="text-neutral-700 dark:text-neutral-300">Paused since {status.pausedSince}.</p>}
        {status.trialDaysLeft === null ? null : <p className="text-neutral-700 dark:text-neutral-300">{trialText(status.trialDaysLeft)}</p>}
      </div>
      {status.pausedSince !== null ? (
        <form action={resumeAllAction}>
          <SubmitButton pendingLabel="Resuming…">Resume</SubmitButton>
        </form>
      ) : status.state === 'active' ? (
        <form action={pauseAllAction}>
          <SubmitButton variant="secondary" pendingLabel="Pausing…">
            Pause all
          </SubmitButton>
        </form>
      ) : null}
    </Card>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, await headers());
  const params = await searchParams;
  const reconnectRequested = single(params.reconnect) === '1';
  const view = await dashboardView(scope, deps, { reconnectRequested });

  // Setup comes first; only a broken HubSpot connection (or a reconnect link) keeps the owner here.
  if (!view.onboardingComplete && view.connectionActive && !reconnectRequested) redirect('/onboarding/baseline');

  const result = ownValue(DASHBOARD_RESULTS, single(params.result));
  const reconnected = single(params.reconnected) === '1' && view.connectionActive;

  return (
    <Page title="Dashboard" width="wide">
      {result === undefined ? null : <Alert tone={result.tone}>{result.text}</Alert>}
      {reconnected ? <Alert tone="success">HubSpot is reconnected.</Alert> : null}
      <StatusCard status={view.status} />
      <Banners banners={view.banners} />
      <Card title="Recent leads" description={`Up to the latest ${RECENT_LEADS_LIMIT}, newest first. Times are in ${view.zone}.`}>
        {view.leads.length === 0 ? (
          <p className="text-neutral-700 dark:text-neutral-300">
            {view.onboardingComplete ? 'No leads yet. Setup is complete: new leads will appear here as they arrive.' : 'No leads yet.'}
          </p>
        ) : (
          <LeadList leads={view.leads} />
        )}
      </Card>
    </Page>
  );
}
