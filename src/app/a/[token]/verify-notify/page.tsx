import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Alert, Card, Page, SubmitButton } from '@/components/ui';
import { confirmNotifyAddressAction } from '@/server/actions/onboarding/verify-notify';
import { getDeps } from '@/server/container';
import { verifyNotifyPageState } from '@/server/views/onboarding/verify-notify';

// /a/[token]/verify-notify (PLAN §7.4, D-46): confirms an extra lead-alert address. Opening the
// link only shows this page (mail scanners open links); the button posts the confirmation, which
// uses the link once. No sign-in; no browser Sentry on /a/*; the proxy sends no-store + noindex.

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Confirm lead alerts',
  robots: { index: false, follow: false },
  referrer: 'same-origin',
};

type Params = Promise<{ token: string }>;

export default async function VerifyNotifyPage({ params }: { params: Params }) {
  const { token } = await params;
  const state = await verifyNotifyPageState(await getDeps(), token, await headers());

  switch (state.type) {
    case 'confirm':
      return (
        <Page centered eyebrow={productName} title="Confirm lead alerts" description={`Confirm that ${productName} may send alerts about new leads to this address.`}>
          <Card>
            <p className="text-base break-all">
              <strong>{state.address}</strong>
            </p>
            <form action={confirmNotifyAddressAction} className="flex flex-col gap-3">
              <input type="hidden" name="token" value={token} />
              <SubmitButton pendingLabel="Confirming…">Confirm this address</SubmitButton>
            </form>
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              Not expecting this? Close this page: nothing is sent to this address unless you confirm.
            </p>
          </Card>
        </Page>
      );
    case 'confirmed':
      return (
        <Page centered eyebrow={productName} title="Address confirmed">
          <Alert tone="success">
            <p className="break-all">
              {state.address} will now get alerts about new leads. The account owner can remove it at any time.
            </p>
          </Alert>
        </Page>
      );
    case 'used':
      return (
        <Page centered eyebrow={productName} title="This link was already used">
          <p>Each confirmation link works once. If this address still needs confirming, ask the account owner to save their preferences again: a new link can be sent once a day.</p>
        </Page>
      );
    case 'removed':
      return (
        <Page centered eyebrow={productName} title="Nothing to confirm">
          <p>This address is no longer on the account&apos;s alert list, so there&apos;s nothing to confirm.</p>
        </Page>
      );
    case 'expired':
      return (
        <Page centered eyebrow={productName} title="This link has expired">
          <p>Confirmation links work for 7 days. Ask the account owner to save their preferences again: a new link can be sent once a day.</p>
        </Page>
      );
    case 'rate_limited':
      return (
        <Page centered eyebrow={productName} title="Too many attempts">
          <p>Please wait a minute, then reload this page.</p>
        </Page>
      );
    case 'invalid':
      return (
        <Page centered eyebrow={productName} title="This link isn't valid">
          <p>Check that you opened the whole link from the email. Links stop working if the account is disconnected.</p>
        </Page>
      );
  }
}
