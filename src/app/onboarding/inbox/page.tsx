import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Alert, Card, Field, fieldDescription, Input, LinkButton, Page, SubmitButton } from '@/components/ui';
import { skipInboxCheckAction, startInboxCheckAction } from '@/server/actions/inbox/inbox-check';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { loadInboxCheckPage, type InboxCheckPageView, type InboxCheckView, type InboxLegView } from '@/server/views/inbox';
import { ownValue } from '@/shared/own-key';
import { AutoRefresh } from './AutoRefresh';

// /onboarding/inbox (PLAN §7.5, §9.7, D-14): why it matters in one sentence, the 30-day history
// counts, the two-leg live test (started here, run in the background by the inbox_check job), the
// result per leg with fix steps that tell "test contact missing" apart from "not logged", and
// "Continue — we'll keep checking" / "Skip for now". Owner only; the proxy sends this path with
// `Cache-Control: private, no-store` and `X-Robots-Tag: noindex` (D-49).

const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Hublytix Autopilot';

export const metadata: Metadata = {
  title: 'Inbox check',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const REFRESH_MS = 15_000;
const PREFERENCES_PATH = '/onboarding/preferences';
const INBOX_PATH = '/onboarding/inbox';

const HUBSPOT_CONNECT_INBOX = 'Settings → General → Email → Connect personal email';
const HUBSPOT_LOGGING_RULES = 'Settings → Objects → Activities → Email Log & Track';
const LOG_ALL = 'Log all emails to/from known contacts';

const RESULT_ALERTS: Readonly<Record<string, { tone: 'success' | 'warning' | 'error'; text: string }>> = {
  started: { tone: 'success', text: 'Test email sent to you. Open it and follow the steps: we check HubSpot every minute.' },
  invalid_address: { tone: 'error', text: 'Enter a valid email address, like name@example.com.' },
  same_as_owner: {
    tone: 'error',
    text: 'Use a different address from the one you sign in with: the test sends an email between two of your mailboxes.',
  },
  not_connected: { tone: 'error', text: "HubSpot isn't connected right now, so the test can't run." },
  rate_limited: { tone: 'error', text: "You've started the test 5 times in the last 24 hours. Try again later, or skip it for now." },
  hubspot_unavailable: { tone: 'error', text: "HubSpot didn't answer just now. Please try again in a minute." },
  send_failed: {
    tone: 'warning',
    text: "We couldn't send the test email just now. We'll keep trying for a few minutes; if it doesn't arrive, start the test again.",
  },
};

function ListSteps({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5">{children}</ul>;
}

function HistoryCard({ check }: { check: InboxCheckView | null }) {
  const history = check?.history;
  let body: ReactNode;
  if (history === undefined) {
    body = <p>We count these when you start the test.</p>;
  } else if (history.status === 'unavailable') {
    body = <p>HubSpot hasn&apos;t given {productName} access to email activity, so we can&apos;t count logged emails.</p>;
  } else if (history.status === 'unknown') {
    body = <p>We couldn&apos;t count your logged emails just now.</p>;
  } else {
    body = (
      <>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
          <dt>Outgoing emails logged</dt>
          <dd className="text-right font-semibold tabular-nums">{history.outbound}</dd>
          <dt>Incoming emails from contacts logged</dt>
          <dd className="text-right font-semibold tabular-nums">{history.inbound}</dd>
        </dl>
        {history.outbound === 0 && history.inbound === 0 ? <p>Not enough logged history: HubSpot logged no email in the last 30 days.</p> : null}
      </>
    );
  }
  return (
    <Card title="Logged in HubSpot, last 30 days" description="All one-to-one emails logged in your HubSpot account in the last 30 days, by anyone in it.">
      <div className="space-y-2 text-base">{body}</div>
    </Card>
  );
}

function legText(leg: InboxLegView): { mark: string; text: string } {
  switch (leg.status) {
    case 'passed':
      return { mark: '✓', text: 'Seen in HubSpot' };
    case 'failed':
      return { mark: '✗', text: 'Not seen in HubSpot' };
    case 'skipped':
      return { mark: '–', text: 'Not checked' };
    case 'pending':
      return { mark: '…', text: leg.until === null ? 'Waiting' : `Checking until ${leg.until}` };
  }
}

function Leg({ label, leg }: { label: string; leg: InboxLegView }) {
  const { mark, text } = legText(leg);
  return (
    <li className="flex min-h-11 items-center justify-between gap-4 border-b border-neutral-200 py-2 last:border-b-0 dark:border-neutral-800">
      <span>{label}</span>
      <span className="flex items-center gap-2 text-right font-medium">
        <span aria-hidden="true" className="text-lg">
          {mark}
        </span>
        <span>{text}</span>
      </span>
    </li>
  );
}

function Legs({ check }: { check: InboxCheckView }) {
  return (
    <ul aria-live="polite" aria-label="Test results" className="flex flex-col">
      <Leg label="Your send is logged" leg={check.send} />
      <Leg label="Replies from leads are logged" leg={check.reply} />
    </ul>
  );
}

function ContactMissingSteps({ address, certain }: { address: string | null; certain: boolean }) {
  const shown = address ?? 'your test address';
  return (
    <Alert tone="warning" title={certain ? 'HubSpot has no contact for this address yet' : 'Start the test again'}>
      <p>
        HubSpot only logs email with contacts it knows.{' '}
        {certain ? (
          <>
            There is no contact for <strong className="break-all">{shown}</strong> yet, and you haven&apos;t saved a BCC address.
          </>
        ) : (
          <>
            If HubSpot has no contact for <strong className="break-all">{shown}</strong> yet, the test can&apos;t start without a BCC address.
          </>
        )}{' '}
        Do one of these, then start the test again:
      </p>
      <ListSteps>
        <li>
          Add your HubSpot BCC address in <Link href={PREFERENCES_PATH} className="font-medium underline underline-offset-4">Preferences</Link>. HubSpot
          shows it under {HUBSPOT_LOGGING_RULES} (BCC address). When you send your test reply, HubSpot creates the contact.
        </li>
        <li>
          Or fill in one of your own website forms using <span className="break-all">{shown}</span>. That creates the contact. It won&apos;t
          count as a lead.
        </li>
      </ListSteps>
    </Alert>
  );
}

function NotLoggedSteps({ check }: { check: InboxCheckView }) {
  if (check.send.status === 'failed') {
    return (
      <Alert tone="warning" title="HubSpot didn't log the email you sent">
        <p>Do one of these, then run the test again:</p>
        <ListSteps>
          <li>
            Connect your inbox in HubSpot: {HUBSPOT_CONNECT_INBOX}. Then, under {HUBSPOT_LOGGING_RULES}, choose &quot;{LOG_ALL}&quot;. This logs your
            sends and replies from leads.
          </li>
          <li>
            Or add your HubSpot BCC address in <Link href={PREFERENCES_PATH} className="font-medium underline underline-offset-4">Preferences</Link>.
            It logs your sends only, not replies from leads.
          </li>
        </ListSteps>
        <p>Send from the email address you use in HubSpot. A personal test address outside your company domain works best.</p>
      </Alert>
    );
  }
  if (check.reply.status === 'failed') {
    return (
      <Alert tone="warning" title="Your sends are logged, but replies from leads aren't">
        <p>
          A BCC address logs only what you send. To log replies from leads, connect your inbox in HubSpot ({HUBSPOT_CONNECT_INBOX}) and choose
          &quot;{LOG_ALL}&quot; under {HUBSPOT_LOGGING_RULES}. Then run the test again.
        </p>
        <p>Until then, {productName} can confirm your sends but can&apos;t see when a lead replies.</p>
      </Alert>
    );
  }
  return null;
}

function ResultAlert({ check }: { check: InboxCheckView }) {
  switch (check.result) {
    case 'log_all':
      return (
        <Alert tone="success" title="Your email is logged">
          <p>HubSpot logged your send and the answer from your other address, so {productName} can confirm your sends and see when a lead replies.</p>
        </Alert>
      );
    case 'sends_only':
    case 'none':
      return <NotLoggedSteps check={check} />;
    default:
      return null;
  }
}

function StartForm({ view, label, defaultAddress }: { view: InboxCheckPageView; label: string; defaultAddress: string }) {
  if (!view.canStart) {
    return <Alert tone="error">HubSpot isn&apos;t connected right now, so the test can&apos;t run.</Alert>;
  }
  return (
    <form action={startInboxCheckAction} className="flex flex-col gap-4">
      <Field
        id="test_address"
        label="Your other email address"
        hint={`Not ${view.ownerEmail}. A personal address outside your company domain works best, like a Gmail address.`}
      >
        <Input
          id="test_address"
          name="test_address"
          type="email"
          autoComplete="off"
          inputMode="email"
          required
          maxLength={254}
          defaultValue={defaultAddress}
          describedBy={fieldDescription('test_address', { hint: true })}
        />
      </Field>
      <SubmitButton pendingLabel="Starting…">{label}</SubmitButton>
    </form>
  );
}

function HowItWorks() {
  return (
    <ol className="list-decimal space-y-2 pl-5">
      <li>Enter another email address of yours.</li>
      <li>We email you a test lead, just like a real one. Tap &quot;Send from my email&quot; and send your reply from your usual mailbox.</li>
      <li>Open your other address and answer that email.</li>
      <li>We check HubSpot every minute for about 10 minutes and show what it logged.</li>
    </ol>
  );
}

function LiveTestCard({ view, result }: { view: InboxCheckPageView; result: string | undefined }) {
  const check = view.check;
  const address = check?.testAddress ?? '';
  if (check === null || check.phase === 'closed_early') {
    return (
      <Card title="Live test" description="Two quick emails between your own mailboxes show whether HubSpot logs your sends and replies.">
        <HowItWorks />
        <StartForm view={view} label="Start the test" defaultAddress="" />
      </Card>
    );
  }
  if (check.phase === 'needs_contact') {
    return (
      <Card title="Live test">
        {result === 'test_contact_missing' || (result === undefined && !view.bccSaved) ? (
          <ContactMissingSteps address={check.testAddress} certain={result === 'test_contact_missing'} />
        ) : (
          <p>The test stopped before the test email. Start it again.</p>
        )}
        <StartForm view={view} label="Start the test again" defaultAddress={address} />
      </Card>
    );
  }
  if (check.phase === 'sending' || check.phase === 'running') {
    return (
      <Card title="Live test">
        <AutoRefresh intervalMs={REFRESH_MS} />
        <p>
          {check.phase === 'sending' ? "We're sending your test email. " : 'We emailed you a test lead. '}
          Tap &quot;Send from my email&quot; in it and send your reply, then answer it from{' '}
          <strong className="break-all">{check.testAddress ?? 'your other address'}</strong>.
        </p>
        <Legs check={check} />
        <NotLoggedSteps check={check} />
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          This page updates by itself.{' '}
          <a href={INBOX_PATH} className="font-medium underline underline-offset-4">
            Check now
          </a>
        </p>
        <details className="rounded-md border border-neutral-300 p-3 dark:border-neutral-700">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">Use a different address</summary>
          <div className="pt-3">
            <StartForm view={view} label="Start again with this address" defaultAddress="" />
          </div>
        </details>
      </Card>
    );
  }
  return (
    <Card title="Live test">
      <ResultAlert check={check} />
      <Legs check={check} />
      <details className="rounded-md border border-neutral-300 p-3 dark:border-neutral-700">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">Run the test again</summary>
        <div className="pt-3">
          <StartForm view={view} label="Run the test again" defaultAddress={address} />
        </div>
      </details>
    </Card>
  );
}

function NextSteps({ view }: { view: InboxCheckPageView }) {
  const next = view.onboardingComplete ? '/dashboard' : '/onboarding/baseline';
  const phase = view.check?.phase;
  const running = phase === 'sending' || phase === 'running';
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      {running ? <LinkButton href={next}>Continue — we&apos;ll keep checking</LinkButton> : null}
      {phase === 'finished' ? <LinkButton href={next}>Continue</LinkButton> : null}
      {phase === 'finished' ? null : (
        <form action={skipInboxCheckAction}>
          <SubmitButton variant="secondary" pendingLabel="Skipping…">
            Skip for now
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

export default async function OnboardingInboxPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, await headers());
  const view = await loadInboxCheckPage(scope, deps);
  const result = typeof params.result === 'string' ? params.result : undefined;
  const alert = ownValue(RESULT_ALERTS, result);

  return (
    <Page
      width="wide"
      title="Check your email logging"
      description={`${productName} can only see replies from leads that HubSpot logs, so let's check your email is logged.`}
    >
      {alert === undefined ? null : <Alert tone={alert.tone}>{alert.text}</Alert>}
      <HistoryCard check={view.check} />
      <LiveTestCard view={view} result={result} />
      <NextSteps view={view} />
      {view.check?.phase === 'finished' ? null : (
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          If you skip, {productName} still drafts your replies to new leads. Until the check passes, your reports say &quot;Not enough data&quot;
          where they depend on logged email. You can come back to this page and run it later.
        </p>
      )}
    </Page>
  );
}
