import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getDevPanelContext } from '@/server/actions/dev';
import { buildDevOutboxMail } from '@/server/http/dev';

// One email from fake mode's outbox (fake mode only; PLAN §4 "view the outbox"). The HTML renders
// in a sandboxed iframe without `allow-scripts`, so nothing in it runs; links open in a new tab
// (outside the sandbox), so the action links can be tried.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Dev tools: outbox',
  robots: { index: false, follow: false },
};

type Params = Promise<{ id: string }>;

const MUTED = 'text-sm text-neutral-700 dark:text-neutral-300';

export default async function DevOutboxMailPage({ params }: { params: Params }) {
  const mail = await buildDevOutboxMail(await getDevPanelContext(), (await params).id);
  if (mail === null) notFound();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">Fake mode only · outbox</p>
        <h1 className="text-2xl font-semibold tracking-tight">{mail.subject}</h1>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="font-semibold">To</dt>
          <dd>{mail.to}</dd>
          {mail.replyTo === null ? null : (
            <>
              <dt className="font-semibold">Responses go to</dt>
              <dd>{mail.replyTo}</dd>
            </>
          )}
          <dt className="font-semibold">Kind</dt>
          <dd>
            <code>{mail.kind}</code>
          </dd>
          <dt className="font-semibold">Sent</dt>
          <dd>{mail.createdAt}</dd>
        </dl>
        <p className={MUTED}>
          <a href={mail.backPath} className="font-medium underline underline-offset-4">
            Back to the outbox
          </a>
        </p>
      </header>
      <iframe
        title="The email as HTML"
        srcDoc={mail.srcDoc}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="h-[70dvh] w-full rounded-lg border border-neutral-300 bg-white dark:border-neutral-700"
      />
      <details>
        <summary className="cursor-pointer text-sm font-semibold">Plain-text part</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border border-neutral-300 p-4 text-sm dark:border-neutral-700">{mail.text}</pre>
      </details>
    </main>
  );
}
