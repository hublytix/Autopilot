import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Page } from '@/components/ui';
import { submitEditAction } from '@/server/actions/action-links/edit';
import { getDeps } from '@/server/container';
import { editPageState } from '@/server/http/action-links/edit';
import { PageBeacon } from '../copy/PageBeacon';
import { EditReply } from './EditReply';

// /a/[token]/edit (PLAN §7.4, D-13, D-26, D-47): "Edit first". The draft's subject and reply in
// editable fields, the lead's message (unverified, links defanged) and the BCC logging address. No
// sign-in (the edit token is the authorisation); never cached or indexed (the proxy and the /a
// layout); no browser Sentry and no third-party requests. Opening it records nothing by itself: the
// page's beacon does, on a person's first click or copy (D-26, D-62), and so does "Done editing".

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Edit your reply',
  robots: { index: false, follow: false },
  referrer: 'same-origin',
};

type Params = Promise<{ token: string }>;

function LeadMessage({ text }: { text: string | null }) {
  return (
    <section aria-labelledby="lead-message-title" className="flex flex-col gap-2">
      <h2 id="lead-message-title" className="text-base font-semibold">
        Message from the lead (unverified)
      </h2>
      {text === null ? (
        <p className="text-base text-neutral-700 dark:text-neutral-300">The lead didn&apos;t write a message.</p>
      ) : (
        <blockquote className="border-l-4 border-neutral-300 py-1 pl-4 text-base whitespace-pre-wrap text-neutral-800 [overflow-wrap:anywhere] dark:border-neutral-600 dark:text-neutral-200">
          {text}
        </blockquote>
      )}
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        Anyone can type anything into a form. Web and email addresses in it are shown broken up (like example[.]com) so they can&apos;t be
        opened by mistake.
      </p>
    </section>
  );
}

export default async function EditReplyPage({ params }: { params: Params }) {
  const { token } = await params;
  const requestHeaders = await headers();
  const state = await editPageState(await getDeps(), token, requestHeaders);

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
    <Page
      width="wide"
      eyebrow={productName}
      title="Edit your reply"
      description="Change anything you like, then open your reply in your own mail app and send it from there. Your changes aren't saved."
    >
      <PageBeacon url={state.beaconPath} nonce={view.beaconNonce} />
      <LeadMessage text={view.leadMessage} />
      <EditReply
        action={submitEditAction}
        token={token}
        draft={{ subject: view.subject, body: view.body }}
        recipient={view.recipient}
        recipientValid={view.recipientValid}
        bcc={view.bcc}
        limits={state.limits}
      />
      <p className="text-sm text-neutral-700 dark:text-neutral-300">{state.neverSends}</p>
    </Page>
  );
}
