import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fakeCheckoutView } from '@/server/http/dev/fake-checkout';

// Fake Razorpay's hosted checkout (fake mode only; PLAN §4, §7.6). Each button runs on FakeBilling
// and delivers the signed webhooks it queues to the real webhook handler. Like Razorpay's page, it
// doesn't send you back: the link below goes to the billing page.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Fake Razorpay: checkout',
  robots: { index: false, follow: false },
};

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const button =
  'inline-flex min-h-11 w-full items-center justify-center rounded-md px-5 py-3 text-base font-semibold sm:w-auto';

export default async function FakeCheckoutPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const view = await fakeCheckoutView((await params).id);
  if (view === null) notFound();
  const query = await searchParams;
  const done = single(query.done);
  const delivered = single(query.delivered);
  const failed = single(query.failed);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-12 sm:px-6">
      <p className="text-sm font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">Fake Razorpay (dev only)</p>
      <h1 className="text-2xl font-semibold tracking-tight">Subscription checkout</h1>
      {done === undefined ? null : (
        <p role="status" className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 text-blue-950 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-50">
          Done: <code>{done}</code>. Webhooks delivered: {/^\d{1,4}$/.test(delivered ?? '') ? delivered : '0'}
          {/^[1-9]\d{0,3}$/.test(failed ?? '') ? `, not accepted: ${failed ?? ''}` : ''}.
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="font-semibold">Subscription</dt>
        <dd>
          <code>{view.id}</code>
        </dd>
        <dt className="font-semibold">Status</dt>
        <dd>
          <code data-testid="fake-checkout-status">{view.status}</code>
        </dd>
        <dt className="font-semibold">Plan</dt>
        <dd>{view.price}</dd>
        {view.startAt === null ? null : (
          <>
            <dt className="font-semibold">Billing starts</dt>
            <dd>{view.startAt}</dd>
          </>
        )}
        {view.expireBy === null ? null : (
          <>
            <dt className="font-semibold">Link expires</dt>
            <dd>{view.expireBy}</dd>
          </>
        )}
      </dl>
      <form method="post" action={view.decisionPath} className="flex flex-col gap-3">
        {view.actions.map((item, index) => (
          <button
            key={item.action}
            type="submit"
            name="action"
            value={item.action}
            className={`${button} ${
              index === 0
                ? 'bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300'
                : 'border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900'
            }`}
          >
            {item.label}
          </button>
        ))}
      </form>
      <a href="/dashboard/billing" className="text-base font-medium underline underline-offset-4">
        Go to your billing page
      </a>
    </main>
  );
}
