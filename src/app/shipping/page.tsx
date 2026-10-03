import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, LegalSection, PRICE_LINE } from '@/components/marketing';

// /shipping (D-20: Razorpay needs a shipping and delivery policy page to accept USD): Autopilot is
// a digital service and nothing is shipped. A placeholder until legal review (law 5).

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = { title: 'Shipping and delivery' };

const LINK = 'font-medium underline underline-offset-4';

export default function ShippingPage() {
  return (
    <LegalPage
      title="Shipping and delivery"
      productName={productName}
      intro={<p>{productName} is an online service. Nothing is shipped: there are no physical goods.</p>}
    >
      <LegalSection title="How you get the service">
        <p>
          You install the app from HubSpot and finish the short setup in your browser. {productName} starts reading new form
          submissions once setup is complete, and its emails arrive in your inbox.
        </p>
      </LegalSection>

      <LegalSection title="Trial and subscription">
        <p>
          {PRICE_LINE}. The trial starts when you install. When you subscribe, the service carries on for the same account; there
          is nothing to deliver or collect.
        </p>
        <p>
          Cancelling is explained on the{' '}
          <Link href="/refunds" className={LINK}>
            refunds and cancellation
          </Link>{' '}
          page.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
