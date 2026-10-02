import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Card, Page, SignOutButton } from '@/components/ui';
import { getDeps } from '@/server/container';
import { requireAdminPage } from '@/server/http/auth/guards';
import { adminPageView, type AdminPageView } from '@/server/views/admin';

// /admin (PLAN §7.5, brief §5.12): for ADMIN_EMAILS only (requireAdminPage answers 404 to everyone
// else, as if the page did not exist). Portals with their processing states, trial and billing, the
// last webhooks received, failed jobs, error counts, AI refusals and cost, the re-encryption backlog
// and failed notifications. Ids, states, codes, counts and times only: no names, addresses, messages
// or drafts. Every view writes an `admin.view` audit row. No-store and noindex come from the proxy.

export const metadata: Metadata = {
  title: 'Admin',
  robots: { index: false, follow: false },
};

interface Column<T> {
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
}

function Table<T>({ caption, rows, columns, rowKey, empty }: { caption: string; rows: readonly T[]; columns: readonly Column<T>[]; rowKey: (row: T) => string; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-neutral-700 dark:text-neutral-300">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.header} scope="col" className="border-b border-neutral-300 px-2 py-2 font-semibold dark:border-neutral-700">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.header} className="border-b border-neutral-200 px-2 py-2 align-top font-mono text-xs dark:border-neutral-800">
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CODE_COUNT_COLUMNS: readonly Column<{ code: string; count: number }>[] = [
  { header: 'Code', cell: (row) => row.code },
  { header: 'Count', cell: (row) => row.count },
];

function CodeCounts({ caption, rows, empty }: { caption: string; rows: readonly { code: string; count: number }[]; empty: string }) {
  return <Table caption={caption} rows={rows} columns={CODE_COUNT_COLUMNS} rowKey={(row) => row.code} empty={empty} />;
}

type Portal = AdminPageView['portals'][number];
const PORTAL_COLUMNS: readonly Column<Portal>[] = [
  { header: 'Portal', cell: (row) => row.portalId },
  { header: 'Account', cell: (row) => row.accountId },
  { header: 'State', cell: (row) => row.processingState },
  { header: 'HubSpot', cell: (row) => row.connectionStatus },
  { header: 'Setup', cell: (row) => row.onboarding },
  { header: 'Owner', cell: (row) => (row.ownerBound ? 'bound' : 'unbound') },
  { header: 'Paused', cell: (row) => (row.paused ? 'yes' : 'no') },
  { header: 'Trial ends', cell: (row) => `${row.trialEnds}${row.trialActive ? '' : ' (ended)'}` },
  { header: 'Subscription', cell: (row) => (row.graceUntil === null ? row.subscriptionStatus : `${row.subscriptionStatus} (grace until ${row.graceUntil})`) },
  { header: 'Last webhook', cell: (row) => row.lastWebhook },
  { header: 'Last poll', cell: (row) => row.lastPolled },
  { header: 'Purge after', cell: (row) => row.purgeAfter ?? '—' },
];

type FailedJob = AdminPageView['failedJobs']['recent'][number];
const FAILED_JOB_COLUMNS: readonly Column<FailedJob>[] = [
  { header: 'Job', cell: (row) => row.jobId },
  { header: 'Kind', cell: (row) => row.kind },
  { header: 'Error code', cell: (row) => row.errorCode },
  { header: 'Account', cell: (row) => row.accountId },
  { header: 'Failed at', cell: (row) => row.finishedAt },
];

export default async function AdminPage() {
  const deps = await getDeps();
  const admin = await requireAdminPage(deps, await headers());
  const view = await adminPageView(deps, admin);

  return (
    <Page title="Admin" description={`Generated ${view.generatedAt}. No lead content is shown here. This view was recorded in the audit log.`} width="wide">
      <div className="flex justify-end">
        <SignOutButton />
      </div>
      <Card title="Portals" description={view.portalsTruncated ? 'The newest 200 accounts.' : 'Every account, newest first.'}>
        <CodeCounts caption="Accounts by processing state" rows={view.processingStateCounts} empty="No accounts." />
        <Table caption="Portals" rows={view.portals} columns={PORTAL_COLUMNS} rowKey={(row) => row.accountId} empty="No portals." />
      </Card>
      <Card title="Last webhook received">
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2" data-testid="last-webhooks">
          <div>
            <dt className="font-semibold">HubSpot</dt>
            <dd className="font-mono text-xs">{view.webhooks.hubspot}</dd>
          </div>
          <div>
            <dt className="font-semibold">Razorpay</dt>
            <dd className="font-mono text-xs">{view.webhooks.razorpay}</dd>
          </div>
        </dl>
      </Card>
      <Card title="Failed jobs" description={`${view.failedJobs.total7d} in the last 7 days.`}>
        <CodeCounts caption="Failed jobs by kind, last 7 days" rows={view.failedJobs.byKind7d} empty="No failed jobs in the last 7 days." />
        <h3 className="text-base font-semibold">Most recent failures</h3>
        <Table caption="Most recent failed jobs" rows={view.failedJobs.recent} columns={FAILED_JOB_COLUMNS} rowKey={(row) => row.jobId} empty="No failed jobs." />
      </Card>
      <Card title="Errors, last 7 days" description="Job error codes (the last error of each job), and AI calls that did not succeed, by outcome.">
        <CodeCounts caption="Job error codes, last 7 days" rows={view.jobErrorCodes7d} empty="No job errors." />
        <CodeCounts caption="AI call outcomes other than ok, last 7 days" rows={view.aiOutcomes7d} empty="Every AI call succeeded." />
      </Card>
      <Card title="AI">
        <Table
          caption="AI calls, refusals and cost"
          rows={[
            { window: 'Last 7 days', ...view.ai.last7d },
            { window: 'Last 30 days', ...view.ai.last30d },
          ]}
          columns={[
            { header: 'Window', cell: (row) => row.window },
            { header: 'Calls', cell: (row) => row.calls },
            { header: 'Refusals', cell: (row) => row.refusals },
            { header: 'Cost', cell: (row) => row.cost },
          ]}
          rowKey={(row) => row.window}
          empty="No AI calls."
        />
      </Card>
      <Card title="Re-encryption backlog" description="HubSpot connections holding a token under a key that isn't the current one. The daily job re-encrypts them.">
        <p className="text-xl font-semibold" data-testid="reencrypt-backlog">
          {view.reencryptBacklog}
        </p>
      </Card>
      <Card
        title="Owner emails that failed"
        description="Last 7 days, by kind. Failed covers both permanent send errors and reservations the sweeper gave up on after 23 hours; the database doesn't record which."
      >
        <CodeCounts caption="Failed owner emails by kind, last 7 days" rows={view.notifications.failed7dByKind} empty="No failed owner emails." />
        <p className="text-sm text-neutral-700 dark:text-neutral-300" data-testid="stuck-sending">
          Still sending after an hour: {view.notifications.stuckSending}
        </p>
      </Card>
    </Page>
  );
}
