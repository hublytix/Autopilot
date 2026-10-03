import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, LegalSection, PRICE_LINE } from '@/components/marketing';

// /refunds (D-20: Razorpay needs a refund and cancellation policy page to accept USD): how
// cancelling works, exactly as the billing code does it (D-18, D-20): during the trial the cancel is
// immediate and nothing is charged, after a payment it takes effect at the end of the paid period.
// Paused, pending and halted subscriptions can't be cancelled through Razorpay's API (D-48), so the
// intro never says "at any time" (brief §4.6 narrowed, D-83). The refund policy itself is not decided
// yet, and the page says so (law 5).

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = { title: 'Refunds and cancellation' };

const LINK = 'font-medium underline underline-offset-4';

export default function RefundsPage() {
  return (
    <LegalPage
      title="Refunds and cancellation"
      productName={productName}
      intro={
        <p>
          {PRICE_LINE}, paid in US dollars through Razorpay. You can cancel on your billing page in {productName}, or when you
          disconnect HubSpot. The exception is while a payment has failed or your subscription is paused: see &ldquo;When
          cancelling isn&apos;t available&rdquo; below.
        </p>
      }
    >
      <LegalSection title="Cancelling during your free trial">
        <p>
          If you subscribe with more than a day of your trial left, your first payment is taken when the trial ends. Cancel
          before then and nothing is charged: the subscription ends at once, and {productName} keeps working until your trial
          ends. With a day or less left, the first payment is taken when you subscribe.
        </p>
        <p>When you set up your card, Razorpay may check it with a small charge that it refunds.</p>
      </LegalSection>

      <LegalSection title="Cancelling after a payment">
        <p>
          The subscription ends at the end of the month you have paid for, and nothing more is charged. {productName} keeps
          working until then.
        </p>
      </LegalSection>

      <LegalSection title="When cancelling isn't available">
        <p>
          If a payment has failed or your subscription is paused, it can&apos;t be cancelled from {productName}. Update your
          payment method or resume the subscription on your billing page first, or contact us (contact details will be added
          here before launch).
        </p>
      </LegalSection>

      <LegalSection title="Refunds">
        <p>Whether payments already made can be refunded, and how, is still to be decided (TODO: legal review).</p>
        <p>
          If Razorpay takes a payment after your account has been deleted, we cancel that subscription and refund the payment.
        </p>
      </LegalSection>

      <LegalSection title="More">
        <p>
          See also the{' '}
          <Link href="/terms" className={LINK}>
            terms
          </Link>{' '}
          and the{' '}
          <Link href="/privacy" className={LINK}>
            privacy
          </Link>{' '}
          page.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
