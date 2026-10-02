import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Alert, Card, Page, SubmitButton } from '@/components/ui';
import { dismissLeadAction } from '@/server/actions/action-links/dismiss';
import { getDeps } from '@/server/container';
import { dismissPageState, dismissResultAlert } from '@/server/http/action-links/dismiss';

// /a/[token]/dismiss (PLAN §7.4, D-26): "Not a real lead". Opening the link only shows this page
// (mail scanners open every link in an email); the button posts the dismissal, which uses the link
// once. Afterwards the page says it is done, however often it is opened or posted again. No sign-in;
// no browser Sentry on /a/*; the proxy sends no-store + noindex. Nothing changes in HubSpot (law 2).

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Not a real lead',
  robots: { index: false, follow: false },
  referrer: 'same-origin',
};

type Params = Promise<{ token: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const MUTED = 'text-base text-neutral-700 dark:text-neutral-300';

export default async function DismissLeadPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { token } = await params;
  const { result } = await searchParams;
  const state = await dismissPageState(await getDeps(), token, await headers());

  switch (state.type) {
    case 'confirm': {
      const alert = dismissResultAlert(typeof result === 'string' ? result : undefined);
      return (
        <Page centered eyebrow={productName} title="Mark this as not a real lead?" description="Follow-ups for this lead will stop.">
          {alert === null ? null : <Alert tone="error">{alert}</Alert>}
          <Card>
            <p className={MUTED}>You won&apos;t get follow-up drafts for this lead. Nothing changes in HubSpot: the contact stays as it is.</p>
            <form action={dismissLeadAction} className="flex flex-col gap-3">
              <input type="hidden" name="token" value={token} />
              <SubmitButton pendingLabel="Marking…">Yes, it&apos;s not a real lead</SubmitButton>
            </form>
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              Changed your mind? Close this page: nothing changes unless you tap the button.
            </p>
          </Card>
        </Page>
      );
    }
    case 'dismissed':
      return (
        <Page centered eyebrow={productName} title="Done — this lead won't get follow-ups">
          <p className={MUTED}>It&apos;s marked as not a real lead. Nothing changed in HubSpot: the contact is still there.</p>
        </Page>
      );
    case 'message':
      return (
        <Page centered eyebrow={productName} title={state.message.title}>
          {state.message.paragraphs.map((text) => (
            <p key={text} className={MUTED}>
              {text}
            </p>
          ))}
        </Page>
      );
  }
}
