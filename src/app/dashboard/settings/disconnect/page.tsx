import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Alert, Card, Checkbox, LinkButton, Page, SubmitButton } from '@/components/ui';
import { disconnectHubSpotAction } from '@/server/actions/settings/settings';
import { getDeps } from '@/server/container';
import { requireOwnerPage } from '@/server/http/auth/guards';
import { disconnectPageView } from '@/server/views/settings';
import { billingChoice, BILLING_PATH, disconnectConsequences, INSTALL_PATH } from '../copy';

// The Disconnect HubSpot dialog (PLAN §7.5, §9.1 step 5, D-10, D-48), as its own confirmation page so
// it works without JavaScript: what happens (processing stops now, the uninstall and the token revoke
// are attempted, action links stop working, the data is deleted in 30 days unless the owner
// reconnects), and the billing choice: "also cancel my subscription" only from authenticated/active;
// paused/pending/halted are explained instead. Owner only; no-store and noindex from the proxy.

export const metadata: Metadata = {
  title: 'Disconnect HubSpot',
  robots: { index: false, follow: false },
};

export default async function DisconnectPage() {
  const deps = await getDeps();
  const scope = await requireOwnerPage(deps, await headers());
  const view = await disconnectPageView(scope, deps);

  if (view.connectionStatus !== 'active') {
    return (
      <Page title="HubSpot is disconnected">
        <Card>
          <p className="text-neutral-700 dark:text-neutral-300">There&apos;s nothing to disconnect: Autopilot can&apos;t read your HubSpot account.</p>
          {view.purgeOn === null ? null : (
            <p className="text-neutral-700 dark:text-neutral-300">We delete your account&apos;s data on {view.purgeOn} unless you reconnect before then.</p>
          )}
          <LinkButton href={INSTALL_PATH} plain>
            Reconnect HubSpot
          </LinkButton>
          <LinkButton href="/dashboard/settings" variant="secondary">
            Back to settings
          </LinkButton>
        </Card>
      </Page>
    );
  }

  const choice = billingChoice(view.billing, view.supportEmail);
  return (
    <Page title="Disconnect HubSpot?" description="Read what happens before you decide.">
      <Card title="What happens">
        <ul className="list-disc space-y-2 pl-5 text-neutral-700 dark:text-neutral-300" data-testid="disconnect-consequences">
          {disconnectConsequences(view.purgeOnIfNow).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Card>
      <form action={disconnectHubSpotAction} className="flex flex-col gap-6">
        <Card title="Your subscription">
          <div className="space-y-2" data-testid="disconnect-billing" data-option={view.billing.type}>
            {choice.checkbox === null ? null : <Checkbox id="cancel_billing" name="cancel_billing" label={choice.checkbox.label} hint={choice.checkbox.hint} />}
            {choice.lines.map((line) => (
              <p key={line} className="text-sm text-neutral-700 dark:text-neutral-300">
                {line}
              </p>
            ))}
            {view.billing.type === 'not_cancellable' ? (
              <LinkButton href={BILLING_PATH} variant="secondary">
                Open billing
              </LinkButton>
            ) : null}
          </div>
        </Card>
        <Alert tone="warning">You stay signed in, and you can reconnect from your dashboard within 30 days.</Alert>
        <div className="flex flex-col gap-3 sm:flex-row">
          <SubmitButton variant="danger" pendingLabel="Disconnecting…">
            Disconnect HubSpot
          </SubmitButton>
          <LinkButton href="/dashboard/settings" variant="secondary">
            Keep HubSpot connected
          </LinkButton>
        </div>
      </form>
    </Page>
  );
}
