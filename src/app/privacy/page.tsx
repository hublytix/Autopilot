import type { Metadata } from 'next';
import Link from 'next/link';
import { BASELINE_HEADING, BASELINE_NOTE, DATA_SOURCE, EMAIL_METADATA_NOTE, HUBSPOT_DISCLOSURE, LegalPage, LegalSection, SUB_PROCESSORS, type SubProcessor } from '@/components/marketing';

// /privacy (PLAN §7.2, brief §5.13, D-03, D-31, D-49): what is stored and why, what never is, the
// HubSpot disclosure word for word, the setup baseline (D-38), every sub-processor with a link to its policy, the Vercel
// request-log note, disconnection and the purge. Day counts appear only for stores Autopilot
// controls; each provider's own retention is left to its linked policy (D-49, PLAN §16 R17).
// A placeholder until legal review (law 5).

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = { title: 'Privacy' };

const LINK = 'font-medium underline underline-offset-4';

function Processor({ processor }: { processor: SubProcessor }) {
  return (
    <li className="space-y-1">
      <p className="font-semibold">{processor.name}</p>
      <p>{processor.role}</p>
      <p className="text-neutral-700 dark:text-neutral-300">{processor.data}</p>
      <p>
        <a href={processor.policyUrl} className={LINK} rel="noopener noreferrer">
          {processor.name}&apos;s privacy policy
        </a>
      </p>
    </li>
  );
}

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      productName={productName}
      intro={
        <p>
          What {productName} stores, why, for how long, and who handles it for us. {productName} prepares drafts; it never sends
          email for you and never connects to your Gmail or Outlook account.
        </p>
      }
    >
      <LegalSection title="What we store and why">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Your HubSpot connection:</strong> the account (portal) id, its time zone and domains, the permissions granted,
            and the access tokens HubSpot issues, kept encrypted. We need them to read new form submissions.
          </li>
          <li>
            <strong>You:</strong> the email address you sign in with, the addresses you choose for notifications and for BCC, the
            Gmail account your drafts open in if you use Gmail, and your preferences (mail app, quiet hours, weekends, follow-ups
            on or off).
          </li>
          <li>
            <strong>Your business brief:</strong> a short description of your business, built from your website and edited by you,
            so the drafts describe your business correctly.
          </li>
          <li>
            <strong>Each lead, as records:</strong> HubSpot ids, timestamps and statuses, for example when the lead arrived, when
            you opened a send link, and whether HubSpot logged your send or the lead&apos;s reply.
          </li>
          <li>
            <strong>Each lead&apos;s content:</strong> the message from the form, the lead&apos;s first name, last name, company and
            email address, and the drafts we write. The name and address fill in the email your mail app opens. This content is
            deleted 30 days after the form was submitted.
          </li>
          <li>
            <strong>Setup test data:</strong> the test lead from the inbox check at setup and the test address you use for it are
            deleted after 24 hours. We keep only a one-way fingerprint of that address, so later test submissions from it are never
            treated as leads, until your account is deleted.
          </li>
          <li>
            <strong>{BASELINE_HEADING}:</strong> {BASELINE_NOTE}
          </li>
          <li>
            <strong>Billing:</strong> your Razorpay subscription&apos;s id, status and dates.
          </li>
          <li>
            <strong>Records without content:</strong> the counts in your Monday reports, records of the emails we sent you and of
            background jobs, records of webhooks received (kept 30 days), records of AI use (the model, its token counts and cost;
            kept up to 13 months), and an audit log of account changes.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="What we never store">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Email content from HubSpot.</strong> {EMAIL_METADATA_NOTE}
          </li>
          <li>
            <strong>Your mailbox.</strong> {productName} has no access to your Gmail or Outlook account.
          </li>
          <li>
            <strong>Card details.</strong> Payments go through Razorpay&apos;s own checkout; your card details never reach us.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Your HubSpot data">
        <p>{HUBSPOT_DISCLOSURE}</p>
      </LegalSection>

      <LegalSection title="Logs and error reports">
        <p>
          Our own logs and error reports leave out lead messages, drafts, email addresses and access tokens.
        </p>
        <p>
          Vercel, which hosts {productName}, keeps its own request logs, and they record the web address of each request. The
          buttons in our emails carry a private code in their web address, so those logs can contain it. We send these logs
          nowhere else and use the shortest log retention Vercel offers. The codes expire after 7 days and stop working when you
          disconnect.
        </p>
      </LegalSection>

      <LegalSection title="Who handles data for us">
        <p>
          These providers (sub-processors) handle data so {productName} can work. We give retention periods only for data we
          control; how long each provider keeps data is set by its own policy, linked below.
        </p>
        <ul className="space-y-5">
          {SUB_PROCESSORS.map((processor) => (
            <Processor key={processor.name} processor={processor} />
          ))}
        </ul>
        <h3 className="font-semibold">Your data source</h3>
        <ul>
          <Processor processor={DATA_SOURCE} />
        </ul>
      </LegalSection>

      <LegalSection title="Disconnecting and deletion">
        <p>
          You can disconnect HubSpot in your settings at any time. {productName} stops at once, asks HubSpot to uninstall the app
          and revoke its access, and the buttons in emails we already sent stop working. Everything we store about your account
          is deleted 30 days later, unless you reconnect before then.
        </p>
        <p>
          If nobody finishes setting up an install within 7 days, {productName} asks HubSpot to uninstall the app and deletes
          that install&apos;s data.
        </p>
        <p>
          After deletion we keep two records without names, addresses or messages: your HubSpot account id with the date your
          first free trial started, so a reinstall doesn&apos;t start a new trial; and the ids and last status of your Razorpay
          subscriptions, so nothing is charged after your account is gone.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Questions about your data: contact details will be added here before launch (TODO: legal review). See also the{' '}
          <Link href="/terms" className={LINK}>
            terms
          </Link>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
