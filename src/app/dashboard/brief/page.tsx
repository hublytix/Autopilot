import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Alert, Card, Page } from '@/components/ui';
import { saveDashboardBriefAction } from '@/server/actions/dashboard/brief';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { dashboardBriefView, type BriefVersionRow } from '@/server/views/dashboard';
import { BriefEditor } from '@/app/onboarding/brief/brief-editor';

// /dashboard/brief (PLAN §7.5): the business brief drafts use, in the same editor as the onboarding
// step. Saving creates a new `owner` version (brief_versions), which drafts use from then on; the
// history lists every version, newest first, with the one in use marked. Owner only. No-store and
// noindex come from the proxy (D-49).

export const metadata: Metadata = {
  title: 'Your brief',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const SOURCE_TEXT: Readonly<Record<BriefVersionRow['source'], string>> = {
  owner: 'Saved by you',
  generated: 'Read from your website (not used until you save)',
};

function History({ versions }: { versions: readonly BriefVersionRow[] }) {
  if (versions.length === 0) return <p className="text-neutral-700 dark:text-neutral-300">No versions yet.</p>;
  return (
    <ol className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800" aria-label="Brief versions" data-testid="brief-history">
      {versions.map((row) => (
        <li key={row.version} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-medium">
            Version {row.version}
            {row.inForce ? <span className="ml-2 rounded-full border border-green-300 px-2 py-0.5 text-sm text-green-900 dark:border-green-800 dark:text-green-100">In use</span> : null}
          </span>
          <span className="text-sm text-neutral-700 dark:text-neutral-300">
            {SOURCE_TEXT[row.source]} · {row.createdAt}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default async function DashboardBriefPage({ searchParams }: { searchParams: SearchParams }) {
  const requestHeaders = await headers();
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, requestHeaders);
  const view = await dashboardBriefView(scope, deps);
  const params = await searchParams;
  const saved = typeof params.saved === 'string' && /^\d{1,9}$/.test(params.saved) ? params.saved : null;
  const { editor } = view;
  const form = editor.editor.form;

  return (
    <Page
      width="wide"
      title="Your business brief"
      description="Drafts use this brief to answer your leads in your voice. Saving creates a new version, which drafts use from then on."
    >
      {saved === null ? null : <Alert tone="success">Saved as version {saved}. New drafts use it from now on.</Alert>}
      <Card
        title="Your brief"
        description={
          form.origin === 'owner' && form.version !== null
            ? `Your saved brief (version ${form.version}). Saving again creates a new version.`
            : form.origin === 'generated'
              ? 'Filled in from your website. Nothing changes until you save.'
              : 'Nothing is used until you save.'
        }
      >
        <BriefEditor action={saveDashboardBriefAction} initial={editor.initialValues} bookingLink={editor.bookingLink} limits={editor.limits} />
      </Card>
      <Card title="Version history" description="Newest first.">
        <History versions={view.versions} />
      </Card>
    </Page>
  );
}
