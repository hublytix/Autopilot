import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Alert, Card, LinkButton, Page } from '@/components/ui';
import { getDeps } from '@/server/container';
import { copyPageState } from '@/server/http/action-links';
import { CopyButton } from './CopyButton';
import { PageBeacon } from './PageBeacon';

// /a/[token]/copy (PLAN §7.4, D-13, D-46): the reply in parts, each with a copy button, for any mail
// app. Shows the recipient, subject, message and BCC logging address only; no sign-in (the send
// token is the authorisation). Opening it records nothing by itself; the page's beacon does, on the
// first gesture of a person on the page (D-26).

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Copy your reply',
  robots: { index: false, follow: false },
  referrer: 'same-origin',
};

type Params = Promise<{ token: string }>;

interface PartProps {
  id: string;
  title: string;
  /** Lower case, for "Copy {label}". */
  label: string;
  value: string;
  hint?: string;
  multiline?: boolean;
}

function Part({ id, title, label, value, hint, multiline = false }: PartProps) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h2 id={`${id}-title`} className="text-base font-semibold">
        {title}
      </h2>
      {hint === undefined ? null : <p className="text-sm text-neutral-700 dark:text-neutral-300">{hint}</p>}
      <div
        className={
          'rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-base break-words dark:border-neutral-700 dark:bg-neutral-950' +
          (multiline ? ' whitespace-pre-wrap' : '')
        }
      >
        {value}
      </div>
      <CopyButton text={value} label={label} />
    </section>
  );
}

export default async function CopyReplyPage({ params }: { params: Params }) {
  const { token } = await params;
  const state = await copyPageState(await getDeps(), token, await headers());

  if (state.type === 'message') {
    return (
      <Page centered eyebrow={productName} title={state.message.title}>
        {state.message.paragraphs.map((text) => (
          <p key={text} className="text-base text-neutral-700 dark:text-neutral-300">
            {text}
          </p>
        ))}
      </Page>
    );
  }

  const { view } = state;
  return (
    <Page eyebrow={productName} title="Copy your reply" description="Copy each part into a new email in your mail app, then send it from there.">
      <PageBeacon url={state.beaconPath} nonce={view.beaconNonce} />
      {view.recipientValid ? null : (
        <Alert tone="warning" title="Check the address">
          <p>
            {view.recipient === null
              ? 'This lead has no email address on file, so there is no recipient to copy.'
              : 'This address looks unusual, so it was not put into a compose link. Check it before you send.'}
          </p>
        </Alert>
      )}
      <Card>
        {view.recipient === null ? null : <Part id="to" title="To" label="recipient" value={view.recipient} />}
        <Part id="subject" title="Subject" label="subject" value={view.subject} />
        <Part id="message" title="Message" label="message" value={view.body} multiline />
        {view.bcc === null ? null : (
          <Part id="bcc" title="BCC" label="BCC address" value={view.bcc} hint="Add this address as BCC so HubSpot logs your email." />
        )}
      </Card>
      {state.mailtoPath === null ? null : (
        <LinkButton plain variant="secondary" href={state.mailtoPath}>
          Open in my mail app instead
        </LinkButton>
      )}
      <p className="text-sm text-neutral-700 dark:text-neutral-300">{state.neverSends}</p>
    </Page>
  );
}
