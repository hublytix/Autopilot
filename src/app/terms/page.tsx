import type { Metadata } from 'next';
import Link from 'next/link';
import { HUBSPOT_DISCLOSURE, LegalPage, LegalSection, PRICE_LINE } from '@/components/marketing';

// /terms (PLAN §7.2, brief §5.13): a placeholder until legal review (law 5). It states only what the
// product does and how billing works; nothing here is a promise the product does not keep.

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = { title: 'Terms' };

const LINK = 'font-medium underline underline-offset-4';

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms"
      productName={productName}
      intro={<p>The terms for using {productName}. The final wording will replace this placeholder after legal review.</p>}
    >
      <LegalSection title="The service">
        <p>
          {productName} reads new submissions of the HubSpot forms you choose, drafts your replies and follow-ups with AI, and
          emails them to you. You decide whether to send each draft, and you send it from your own mail app. {productName} never
          sends email for you.
        </p>
        <p>{HUBSPOT_DISCLOSURE}</p>
      </LegalSection>

      <LegalSection title="Your part">
        <ul className="list-disc space-y-2 pl-5">
          <li>Read each draft before you send it. Drafts are written by AI and can be wrong.</li>
          <li>You are responsible for the emails you send.</li>
          <li>Keep your HubSpot account, your sign-in email and your settings up to date.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Price and free trial">
        <p>
          {PRICE_LINE}. The trial starts when you install the app and needs no card. When it ends, {productName} stops checking
          HubSpot and drafting until you subscribe. Payments are handled by Razorpay.
        </p>
        <p>
          How cancelling works is on the{' '}
          <Link href="/refunds" className={LINK}>
            refunds and cancellation
          </Link>{' '}
          page.
        </p>
      </LegalSection>

      <LegalSection title="When things go wrong">
        <p>
          {productName} depends on HubSpot, on the providers listed on the{' '}
          <Link href="/privacy" className={LINK}>
            privacy
          </Link>{' '}
          page, and on how your email is logged in HubSpot. A draft can arrive late, or not at all, and a send or a lead&apos;s
          reply that HubSpot doesn&apos;t show can&apos;t be counted.
        </p>
      </LegalSection>

      <LegalSection title="Ending the service">
        <p>
          You can disconnect HubSpot in your settings at any time. What happens to your data then is on the privacy page.
        </p>
      </LegalSection>

      <LegalSection title="Changes and contact">
        <p>Changes to these terms, the governing law and contact details will be added after legal review (TODO: legal review).</p>
      </LegalSection>
    </LegalPage>
  );
}
