import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Checkbox, Field, Input, Select, Textarea } from '@/components/ui';
import { getDevPanelContext } from '@/server/actions/dev';
import { ADVANCE_UNITS, buildDevPanelView, type DevAction, type DevPanelView } from '@/server/http/dev';

// The /dev panel (fake mode only; 404 otherwise; PLAN §4, §7.6, D-29): plays HubSpot, the lead, the
// owner's mailbox, time, QStash, the crons and Razorpay for a fake-mode run, and shows the dev
// outbox. Every button is a plain same-origin form POST to /dev/actions (works without JavaScript),
// which answers 303 back here with a result. The logic is in src/server/http/dev.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Dev tools',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const LINK = 'font-medium underline underline-offset-4';
const MUTED = 'text-sm text-neutral-700 dark:text-neutral-300';

function ActionForm({ path, action, children, className }: { path: string; action: DevAction; children: ReactNode; className?: string }) {
  return (
    <form method="post" action={path} className={className ?? 'flex flex-col gap-3'}>
      <input type="hidden" name="action" value={action} />
      {children}
    </form>
  );
}

function Status({ view }: { view: DevPanelView }) {
  return (
    <Card title="Clock and jobs">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="font-semibold">Fake now</dt>
        <dd data-testid="dev-now">
          {view.now}
          {view.offset === null ? '' : ` (${view.offset})`}
        </dd>
        <dt className="font-semibold">Job ticker</dt>
        <dd>{view.tickerRunning ? 'Running: due jobs every 10 s, the poll every 5 fake minutes' : 'Not running in this process'}</dd>
        <dt className="font-semibold">Queued deliveries</dt>
        <dd>{view.queue.total}</dd>
        <dt className="font-semibold">Jobs</dt>
        <dd>{view.jobs.length === 0 ? 'none' : view.jobs.map((j) => `${j.status} ${j.count}`).join(' · ')}</dd>
      </dl>
      {view.queue.next.length === 0 ? null : (
        <ul className={MUTED}>
          {view.queue.next.map((m, index) => (
            <li key={index}>
              {m.runAt}: <code>{m.kind}</code>
            </li>
          ))}
        </ul>
      )}
      <ActionForm path={view.actionPath} action="advance" className="flex flex-wrap items-end gap-3">
        <Field id="dev-amount" label="Advance the clock by">
          <Input id="dev-amount" name="amount" type="number" min={1} max={999} defaultValue={1} required className="w-28" />
        </Field>
        <Field id="dev-unit" label="Unit">
          <Select id="dev-unit" name="unit" defaultValue="hours" className="w-36">
            {ADVANCE_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="secondary" fullWidth={false}>
          Advance
        </Button>
      </ActionForm>
      <div className="flex flex-wrap gap-3">
        <ActionForm path={view.actionPath} action="run_jobs">
          <Button type="submit">Run due jobs now</Button>
        </ActionForm>
        <ActionForm path={view.actionPath} action="run_daily">
          <Button type="submit" variant="secondary">
            Run the daily maintenance now
          </Button>
        </ActionForm>
      </div>
      <p className={MUTED}>
        Run due jobs: QStash&apos;s due deliveries, the 5-minute poll (states, polls, sweeper, retention) and the hourly
        weekly-report check, then whatever they queued.
      </p>
    </Card>
  );
}

function Accounts({ view }: { view: DevPanelView }) {
  return (
    <Card title="Accounts and billing">
      {view.accounts.length === 0 ? (
        <p className={MUTED}>
          No account yet.{' '}
          <a href="/api/hubspot/install" className={LINK}>
            Install
          </a>{' '}
          through the fake HubSpot consent page to create one.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {view.accounts.map((account) => (
            <li key={account.id} className="space-y-1 text-sm">
              <p>
                <code>{account.id}</code>
              </p>
              <p>
                {account.processingState}
                {account.paused ? ' (paused)' : ''} · connection {account.connection ?? 'none'} · {account.owned ? 'owner bound' : 'no owner yet'}
                {account.trialEndsAt === null ? '' : ` · trial ends ${account.trialEndsAt}`}
              </p>
              {account.subscriptions.length === 0 ? (
                <p className={MUTED}>No subscription. The owner subscribes on the billing page.</p>
              ) : (
                <ul className="list-disc pl-5">
                  {account.subscriptions.map((sub) => (
                    <li key={sub.id}>
                      <a href={sub.checkoutPath} className={LINK}>
                        {sub.open ? 'Open checkout' : 'Fake Razorpay page'}
                      </a>{' '}
                      <code>{sub.id}</code> ({sub.status})
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <ActionForm path={view.actionPath} action="deliver_razorpay">
        <Button type="submit" variant="secondary">
          Deliver Razorpay&apos;s queued events
        </Button>
      </ActionForm>
      <p className={MUTED}>
        Applies fake Razorpay&apos;s time-based changes (a trial ending, a renewal) and posts every queued event, signed, to the
        real webhook handler.
      </p>
    </Card>
  );
}

function SubmitLead({ view }: { view: DevPanelView }) {
  return (
    <Card title="Submit a lead" description="A form submission in the fake HubSpot portal, as a lead would make it.">
      <ActionForm path={view.actionPath} action="submit_lead">
        <Field id="dev-form" label="Form">
          <Select id="dev-form" name="form" required>
            {view.portal.forms.map((form) => (
              <option key={form.id} value={form.id}>
                {form.name} ({form.fields.join(', ')})
              </option>
            ))}
          </Select>
        </Field>
        <Field id="dev-contact" label="Contact">
          <Select id="dev-contact" name="contact" defaultValue="new">
            <option value="new">New contact (HubSpot sends a webhook)</option>
            <option value="existing">Existing contact (no webhook: the poll finds it)</option>
            <option value="any">Either</option>
          </Select>
        </Field>
        <Field id="dev-email" label="Email">
          <Input id="dev-email" name="email" type="email" list="dev-contact-emails" required maxLength={254} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="dev-first" label="First name" optional>
            <Input id="dev-first" name="firstName" maxLength={100} />
          </Field>
          <Field id="dev-last" label="Last name" optional>
            <Input id="dev-last" name="lastName" maxLength={100} />
          </Field>
        </div>
        <Field id="dev-company" label="Company" optional>
          <Input id="dev-company" name="company" maxLength={200} />
        </Field>
        <Field id="dev-message" label="Message" optional>
          <Textarea id="dev-message" name="message" maxLength={5000} rows={4} />
        </Field>
        <Button type="submit">Submit the form</Button>
      </ActionForm>
    </Card>
  );
}

function HubSpot({ view }: { view: DevPanelView }) {
  const { portal } = view;
  return (
    <Card
      title="Fake HubSpot"
      description="HubSpot's own data: it keeps contacts, submissions and logged emails whatever Autopilot deletes."
    >
      <p className="text-sm">
        Portal <code>{portal.portalId}</code>
        {portal.hubDomain === null ? '' : ` (${portal.hubDomain})`} · app {portal.installed ? 'installed' : 'not installed'}
        {portal.refreshRevoked ? ' · refresh tokens revoked' : ''} · owner mailbox <code>{portal.ownerMailbox}</code> logs:{' '}
        {portal.loggingMode}
      </p>
      <datalist id="dev-contact-emails">
        {portal.contacts.map((contact) => (
          <option key={contact.id} value={contact.email} />
        ))}
      </datalist>
      <ActionForm path={view.actionPath} action="log_send" className="flex flex-wrap items-end gap-3">
        <Field id="dev-send-to" label="Log the owner's send to">
          <Input id="dev-send-to" name="to" type="email" list="dev-contact-emails" required maxLength={254} />
        </Field>
        <Button type="submit" variant="secondary" fullWidth={false}>
          Log the send
        </Button>
      </ActionForm>
      <ActionForm path={view.actionPath} action="log_reply" className="flex flex-wrap items-end gap-3">
        <Field id="dev-inbound-from" label="Log the lead's reply from">
          <Input id="dev-inbound-from" name="from" type="email" list="dev-contact-emails" required maxLength={254} />
        </Field>
        <Button type="submit" variant="secondary" fullWidth={false}>
          Log the lead&apos;s reply
        </Button>
      </ActionForm>
      <ActionForm path={view.actionPath} action="opt_out" className="flex flex-wrap items-end gap-3">
        <Field id="dev-optout" label="Opt a contact out of email">
          <Input id="dev-optout" name="email" type="email" list="dev-contact-emails" required maxLength={254} />
        </Field>
        <Button type="submit" variant="secondary" fullWidth={false}>
          Opt out
        </Button>
      </ActionForm>
      <ActionForm path={view.actionPath} action="revoke_token">
        <Button type="submit" variant="danger">
          Revoke the HubSpot token
        </Button>
      </ActionForm>
      <details>
        <summary className="cursor-pointer text-sm font-semibold">
          Contacts ({portal.contactCount}
          {portal.contactCount > portal.contacts.length ? `, newest ${portal.contacts.length} shown` : ''})
        </summary>
        <ul className="mt-2 space-y-1 text-sm">
          {portal.contacts.map((contact) => (
            <li key={contact.id}>
              <code>{contact.id}</code> {contact.email}
              {contact.name === '' ? '' : ` · ${contact.name}`}
              {contact.company === '' ? '' : ` · ${contact.company}`} · {contact.createdAt}
              {contact.optedOut ? ' · opted out' : ''}
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

function Outbox({ view }: { view: DevPanelView }) {
  return (
    <div id="outbox">
      <Card title="Outbox" description="Every email fake mode sent, newest first (the latest 50).">
        {view.outbox.length === 0 ? (
          <p className={MUTED}>No email yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {view.outbox.map((mail) => (
              <li key={mail.id}>
                <a href={mail.path} className={LINK}>
                  {mail.subject}
                </a>{' '}
                <span className="text-neutral-700 dark:text-neutral-300">
                  · {mail.kind} · to {mail.to} · {mail.createdAt}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Reset({ view }: { view: DevPanelView }) {
  return (
    <Card title="Reset fake state" description="Empties the database and the outbox, puts the fake HubSpot portal and Razorpay back to their start, returns to real time and signs you out.">
      <ActionForm path={view.actionPath} action="reset">
        <Checkbox id="dev-reset-confirm" name="confirm" value="yes" required label="Yes, delete everything in this fake-mode database" />
        <Button type="submit" variant="danger">
          Reset fake state
        </Button>
      </ActionForm>
    </Card>
  );
}

export default async function DevPanelPage({ searchParams }: { searchParams: SearchParams }) {
  const view = await buildDevPanelView(await getDevPanelContext(), await searchParams);
  if (view === null) notFound();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">Fake mode only</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Dev tools</h1>
        <p className={MUTED}>
          <a href="/dashboard" className={LINK}>
            Dashboard
          </a>{' '}
          ·{' '}
          <a href="#outbox" className={LINK}>
            Outbox
          </a>
        </p>
      </header>
      <div id="result">{view.result === null ? null : <Alert tone={view.result.tone}>{view.result.text}</Alert>}</div>
      <Status view={view} />
      <SubmitLead view={view} />
      <HubSpot view={view} />
      <Accounts view={view} />
      <Outbox view={view} />
      <Reset view={view} />
    </main>
  );
}
