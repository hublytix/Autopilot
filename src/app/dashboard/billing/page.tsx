import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Alert, Card, LinkButton, Page, SubmitButton } from '@/components/ui';
import { cancelSubscriptionAction, resumeSubscriptionAction, startCheckoutAction } from '@/server/actions/billing/billing';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { BILLING_PATH, billingPageView, type BillingPageView } from '@/server/views/billing';
import { ownValue } from '@/shared/own-key';
import { AutoRefresh } from './auto-refresh';
import { ACTION_TEXT, BILLING_RESULTS, CHECKOUT_OPEN_TEXT, PRICE_LINE, RUNNING_TEXT, subscriptionCopy, trialLine } from './copy';

// /dashboard/billing (PLAN §7.5, §9.9, D-18, D-20): the trial's days left, the subscription's status
// in plain words, and the one action that fits it: Subscribe (also continues an open checkout),
// Update payment method (the stored Razorpay link, for a failed payment), Resume (paused) or Cancel
// (now while the trial runs, at the end of the period once paying). There is no return URL from
// Razorpay's page: while a checkout is open the page re-reads our database every few seconds. Owner
// only; no-store and noindex come from the proxy (D-49).

export const metadata: Metadata = {
  title: 'Billing',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function Action({ view }: { view: BillingPageView }) {
  switch (view.action) {
    case 'subscribe':
      return (
        <form action={startCheckoutAction} className="space-y-2">
          <SubmitButton pendingLabel={ACTION_TEXT.subscribe.pending}>{ACTION_TEXT.subscribe.label}</SubmitButton>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            {view.subscribeFirstPaymentOn === null ? ACTION_TEXT.subscribe.billsNow : ACTION_TEXT.subscribe.billsAtTrialEnd(view.subscribeFirstPaymentOn)}
          </p>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">{ACTION_TEXT.subscribe.note}</p>
        </form>
      );
    case 'update_payment':
      return view.updatePaymentLink === null ? null : (
        <div className="space-y-2">
          <LinkButton href={view.updatePaymentLink} plain>
            {ACTION_TEXT.updatePayment.label}
          </LinkButton>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">{ACTION_TEXT.updatePayment.note}</p>
        </div>
      );
    case 'resume':
      return (
        <form action={resumeSubscriptionAction}>
          <SubmitButton pendingLabel={ACTION_TEXT.resume.pending}>{ACTION_TEXT.resume.label}</SubmitButton>
        </form>
      );
    case 'cancel': {
      const subscription = view.subscription;
      const text =
        subscription?.status === 'authenticated' ? (subscription.firstPaymentAhead ? ACTION_TEXT.cancelTrial : ACTION_TEXT.cancelAfterPayment) : ACTION_TEXT.cancelActive;
      return (
        <form action={cancelSubscriptionAction} className="space-y-2">
          <SubmitButton variant="secondary" pendingLabel={text.pending}>
            {text.label}
          </SubmitButton>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">{text.note}</p>
        </form>
      );
    }
    case 'none':
      return view.subscription?.status === 'pending' || view.subscription?.status === 'halted' ? (
        <p className="text-neutral-700 dark:text-neutral-300">{ACTION_TEXT.noLink}</p>
      ) : null;
  }
}

export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, await headers());
  const view = await billingPageView(deps, scope);
  if (view === null) notFound();
  const result = ownValue(BILLING_RESULTS, single((await searchParams).result));
  const status = subscriptionCopy(view.subscription, view.supportEmail);
  const running = RUNNING_TEXT[view.processingState];

  return (
    <Page title="Billing" description={PRICE_LINE} width="wide">
      {result === undefined ? null : <Alert tone={result.tone}>{result.text}</Alert>}
      {running === null ? null : <Alert tone="warning">{running}</Alert>}
      <Card title="Free trial">
        <p className="text-neutral-700 dark:text-neutral-300" data-testid="trial-line">
          {trialLine(view.trial)}
        </p>
      </Card>
      <Card title="Subscription">
        <div className="space-y-2" data-testid="subscription-status" data-status={view.subscription?.status ?? 'none'} data-action={view.action}>
          <p className="text-xl font-semibold">{status.title}</p>
          {status.lines.map((line) => (
            <p key={line} className="text-neutral-700 dark:text-neutral-300">
              {line}
            </p>
          ))}
        </div>
        <Action view={view} />
      </Card>
      {view.checkoutOpen ? (
        <Card title={CHECKOUT_OPEN_TEXT.title}>
          <p className="text-neutral-700 dark:text-neutral-300">{CHECKOUT_OPEN_TEXT.line}</p>
          <LinkButton href={BILLING_PATH} variant="secondary" plain>
            {CHECKOUT_OPEN_TEXT.manual}
          </LinkButton>
          <AutoRefresh everySeconds={5} forMinutes={30} />
        </Card>
      ) : null}
    </Page>
  );
}
