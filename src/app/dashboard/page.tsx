import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { LinkButton, Page } from '@/components/ui';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { dashboardPlaceholderView } from '@/server/views/dashboard';

// /dashboard, the M3 placeholder (PLAN §7.5; M6 builds the dashboard): where Finish, the completed
// setup page and sign-in links land, so the setup flow never ends on a not-found page. Owner only;
// the proxy sends Cache-Control: private, no-store and X-Robots-Tag: noindex on /dashboard (D-49).
// Honest copy (law 5): it promises nothing the build does not do yet.

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Dashboard',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, await headers());
  const params = await searchParams;
  const { gate } = await dashboardPlaceholderView(scope, deps);
  const reconnect = params.reconnect === '1';

  if (gate.completedAt === null) {
    return (
      <Page eyebrow={productName} title="Setup isn't finished yet" description="Finish the setup steps, then new leads will appear here.">
        <LinkButton href="/onboarding/baseline">Continue setup</LinkButton>
      </Page>
    );
  }

  return (
    <Page eyebrow={productName} title="Setup is complete" description="New leads will appear here.">
      {reconnect ? <LinkButton href="/api/hubspot/install">Reconnect HubSpot</LinkButton> : null}
    </Page>
  );
}
