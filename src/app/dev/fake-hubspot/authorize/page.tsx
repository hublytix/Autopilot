import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fakeHubSpotConsentView, type AuthorizeRejection } from '@/server/http/dev';

// Fake HubSpot's consent screen (fake mode only; PLAN §4, §7.6). Approve posts to the decision route,
// which redirects to the OAuth callback with a fresh code and the same `state`.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Fake HubSpot: connect app',
  robots: { index: false, follow: false },
};

const REJECTIONS: Readonly<Record<AuthorizeRejection, string>> = {
  client_id: 'The client id is not the configured fake HubSpot app.',
  redirect_uri: 'The redirect URI is not the one registered for the fake HubSpot app (HUBSPOT_REDIRECT_URI).',
  state: 'The request has no valid state.',
  scope: 'The request has no valid scope list.',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const button =
  'inline-flex min-h-11 w-full items-center justify-center rounded-md px-5 py-3 text-base font-semibold sm:w-auto';

export default async function FakeHubSpotAuthorizePage({ searchParams }: { searchParams: SearchParams }) {
  const view = await fakeHubSpotConsentView(await searchParams);
  if (view.kind === 'not_found') notFound();

  if (view.kind === 'invalid') {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-12 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Authorization error</h1>
        <p className="text-base text-neutral-700 dark:text-neutral-300">{REJECTIONS[view.reason]}</p>
      </main>
    );
  }

  const { request, portal } = view;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-12 sm:px-6">
      <p className="text-sm font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">Fake HubSpot (dev only)</p>
      <h1 className="text-2xl font-semibold tracking-tight">Connect the app to your HubSpot account</h1>
      <p className="text-base text-neutral-700 dark:text-neutral-300">
        Account {portal.portalId}
        {portal.hubDomain === null ? '' : ` (${portal.hubDomain})`}, {portal.accountType}.
      </p>
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">The app is asking for</h2>
        <ul className="list-disc pl-5 text-sm text-neutral-700 dark:text-neutral-300">
          {request.scopes.map((scope) => (
            <li key={scope}>
              <code>{scope}</code>
            </li>
          ))}
          {request.optionalScopes.map((scope) => (
            <li key={`optional:${scope}`}>
              <code>{scope}</code> (optional)
            </li>
          ))}
        </ul>
      </section>
      <form method="post" action={view.decisionPath} className="flex flex-col gap-3 sm:flex-row">
        <input type="hidden" name="client_id" value={request.clientId} />
        <input type="hidden" name="redirect_uri" value={request.redirectUri} />
        <input type="hidden" name="state" value={request.state} />
        <input type="hidden" name="scope" value={request.scopes.join(' ')} />
        <button
          type="submit"
          name="decision"
          value="approve"
          className={`${button} bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300`}
        >
          Approve
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          className={`${button} border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900`}
        >
          Cancel
        </button>
      </form>
    </main>
  );
}
