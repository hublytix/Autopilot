import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { BillingInactive, billingInactiveSubject } from '@/emails/BillingInactive';
import { OwnerAlert } from '@/emails/OwnerAlert';
import { ReconnectHubSpot, reconnectHubSpotSubject } from '@/emails/ReconnectHubSpot';
import { renderEmail } from '@/server/email/render';
import { createJobRegistry } from '@/server/jobs/registry';
import { runSweeper } from '@/server/jobs/sweeper';
import { createJobTestRig, seedActiveAccount, type JobTestRig } from '@/server/jobs/testing';
import { revokeConnectionInTx } from '@/server/services/hubspot/revoke';
import { NotificationKeys } from '@/server/services/notifications/predicates';
import { createNotificationRegistry, type NotificationRegistry, type NotificationResumer } from '@/server/services/notifications/renderers';
import { reserveInTx } from '@/server/services/notifications/reserve';
import { useTestDb as setUpTestDb } from '../../../../test/db/harness';
import { applyProcessingStateInTx } from './apply-processing-state';
import { accountLocalDate, formatAccountDate, parseReconnectKey, registerAccountNotifications } from './emails';
import { seedOwner } from './testing';

const getDb = setUpTestDb();

let rig: JobTestRig;
let registry: NotificationRegistry;

beforeEach(() => {
  rig = createJobTestRig(getDb(), createJobRegistry());
  registry = createNotificationRegistry();
  registerAccountNotifications({ notifications: registry });
});

async function ownedAccount(email = 'owner@example.com'): Promise<{ accountId: string; connectionId: string }> {
  const ids = await seedActiveAccount(getDb(), rig.clock.now());
  await seedOwner(getDb(), ids.accountId, email);
  return ids;
}

function sweep() {
  return runSweeper(rig.deps, { notificationRegistry: registry });
}

describe('templates', () => {
  it('ReconnectHubSpot: honest copy, the purge date, the reconnect button and the permission note', async () => {
    const { html, text } = await renderEmail(
      createElement(ReconnectHubSpot, { productName: 'Hublytix Autopilot', reconnectUrl: 'https://app.example/api/hubspot/install', purgeDate: 'November 5, 2026' }),
    );
    expect(reconnectHubSpotSubject('Hublytix Autopilot')).toBe('Reconnect HubSpot to keep Hublytix Autopilot running');
    expect(reconnectHubSpotSubject('Acme Replies')).toBe('Reconnect HubSpot to keep Acme Replies running');
    expect(text).toContain('has stopped checking for new leads and drafting your replies');
    expect(text).toContain('we delete your Hublytix Autopilot data for this HubSpot account on November 5, 2026');
    expect(text).toContain('Reconnect HubSpot https://app.example/api/hubspot/install');
    expect(text).toContain('Super Admin');
    expect(html).toContain('href="https://app.example/api/hubspot/install"');
  });

  it('ReconnectHubSpot says "in 30 days" when the purge date is unknown', async () => {
    const { text } = await renderEmail(createElement(ReconnectHubSpot, { productName: 'P', reconnectUrl: 'https://app.example/x', purgeDate: null }));
    expect(text).toContain('for this HubSpot account in 30 days');
  });

  it('BillingInactive and OwnerAlert render their copy and buttons', async () => {
    const billing = await renderEmail(createElement(BillingInactive, { productName: 'Hublytix Autopilot', billingUrl: 'https://app.example/dashboard/billing' }));
    expect(billingInactiveSubject('Hublytix Autopilot')).toBe("Your Hublytix Autopilot trial or subscription isn't active");
    expect(billing.text).toContain('stopped drafting your replies');
    expect(billing.text).toContain('Open billing https://app.example/dashboard/billing');
    const alert = await renderEmail(
      createElement(OwnerAlert, { productName: 'P', heading: 'Heads up', paragraphs: ['First.', 'Second.'], action: { label: 'Sign in', url: 'https://app.example/login' } }),
    );
    expect(alert.text.toLowerCase()).toContain('heads up');
    expect(alert.text).toContain('First.');
    expect(alert.text).toContain('Sign in https://app.example/login');
  });
});

describe('registerAccountNotifications', () => {
  it('registers reconnect, billing_inactive and owner_alert, and is safe to call twice', () => {
    expect(registry.resumer('reconnect')).toBeDefined();
    expect(registry.resumer('billing_inactive')).toBeDefined();
    expect(registry.resumer('owner_alert')).toBeDefined();
    expect(() => registerAccountNotifications({ notifications: registry })).not.toThrow();
  });

  it('leaves a kind someone else registered alone', () => {
    const other = createNotificationRegistry();
    const mine: NotificationResumer = async () => null;
    other.register('owner_alert', mine);
    registerAccountNotifications({ notifications: other });
    expect(other.resumer('owner_alert')).toBe(mine);
  });
});

describe('resuming reserved account emails (sweeper)', () => {
  it('a crash after a revoke commits still delivers the reconnect email, exactly once', async () => {
    const { accountId, connectionId } = await ownedAccount();
    const now = rig.clock.now();
    const { outcome } = await getDb().tx((tx) => revokeConnectionInTx(tx, now, { accountId, connectionId, tokenVersion: 0, reason: 'refresh_revoked' }));
    expect(outcome).toBe('revoked');
    // The process died before the post-commit send.
    expect(rig.fakes.mailer.sent).toHaveLength(0);

    rig.clock.advance({ minutes: 11 });
    await sweep();
    const reconnect = rig.fakes.mailer.sent.filter((mail) => mail.kind === 'reconnect');
    expect(reconnect).toHaveLength(1);
    expect(reconnect[0]).toMatchObject({ to: ['owner@example.com'], subject: reconnectHubSpotSubject(rig.deps.env.PRODUCT_NAME) });

    rig.clock.advance({ hours: 3 });
    await sweep();
    expect(rig.fakes.mailer.sent.filter((mail) => mail.kind === 'reconnect')).toHaveLength(1);
  });

  it('the owner reconnects before the sweeper runs: no reconnect email', async () => {
    const { accountId, connectionId } = await ownedAccount();
    const now = rig.clock.now();
    await getDb().tx((tx) => revokeConnectionInTx(tx, now, { accountId, connectionId, tokenVersion: 0, reason: 'refresh_revoked' }));
    rig.clock.advance({ minutes: 5 });
    await getDb().query(`update hubspot_connections set status = 'active', status_changed_at = $2, access_token_enc = $3, refresh_token_enc = $3 where id = $1`, [
      connectionId,
      rig.clock.now(),
      'v1.0123abcd.aaaa.bbbb.cccc',
    ]);
    rig.clock.advance({ minutes: 6 });
    await sweep();
    expect(rig.fakes.mailer.sent).toHaveLength(0);
    const row = await getDb().one<{ status: string }>(`select status from notifications_sent where kind = 'reconnect'`);
    expect(row.status).toBe('failed');
  });

  it('a lost billing-inactive send is resumed while the account is still inactive, and dropped once it is not', async () => {
    const first = await ownedAccount();
    const second = await ownedAccount('second.owner@example.com');
    rig.clock.advance({ days: 15 });
    const now = rig.clock.now();
    for (const { accountId } of [first, second]) {
      const applied = await getDb().tx((tx) => applyProcessingStateInTx(tx, now, accountId));
      expect(applied?.work.sends).toEqual([NotificationKeys.billingInactive(accountId, now)]);
    }
    // The second account subscribes before the sweeper runs.
    await getDb().query(`update accounts set processing_state = 'active' where id = $1`, [second.accountId]);

    rig.clock.advance({ minutes: 11 });
    await sweep();
    const billing = rig.fakes.mailer.sent.filter((mail) => mail.kind === 'billing_inactive');
    expect(billing).toHaveLength(1);
    expect(billing[0]?.idempotencyKey).toContain(first.accountId);
  });

  it('an owner alert of an unknown kind cannot be resumed and is marked failed', async () => {
    const { accountId } = await ownedAccount();
    await reserveInTx(getDb(), { kind: 'owner_alert', dedupeKey: `alert:${accountId}:mystery:1`, accountId, now: rig.clock.now() });
    rig.clock.advance({ minutes: 11 });
    await sweep();
    expect(rig.fakes.mailer.sent).toHaveLength(0);
    expect((await getDb().one<{ status: string }>(`select status from notifications_sent`)).status).toBe('failed');
  });
});

describe('helpers', () => {
  it('parseReconnectKey reads back the key NotificationKeys builds', () => {
    const at = new Date('2026-10-06T14:26:00.123Z');
    const connectionId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(parseReconnectKey(NotificationKeys.reconnect(connectionId, at))).toEqual({ connectionId, statusChangedAt: at });
    expect(parseReconnectKey(`reconnect:${connectionId}:not-a-date`)).toBeNull();
    expect(parseReconnectKey('billing-inactive:x:y')).toBeNull();
  });

  it('formats dates in the account timezone, falling back to UTC', () => {
    const at = new Date('2026-11-06T02:00:00.000Z');
    expect(formatAccountDate(at, 'America/New_York')).toBe('November 5, 2026');
    expect(formatAccountDate(at, null)).toBe('November 6, 2026');
    expect(formatAccountDate(at, 'Not/AZone')).toBe('November 6, 2026');
    expect(accountLocalDate(at, 'America/New_York')).toBe('2026-11-05');
    expect(accountLocalDate(at, 'UTC-5')).toBe('2026-11-05');
  });
});
