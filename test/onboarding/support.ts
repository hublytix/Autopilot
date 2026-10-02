import type { FakeHubSpot } from '@/server/adapters/fake/hubspot';
import type { Db } from '@/server/db';
import { createJobRegistry, type JobRegistry } from '@/server/jobs';
import { createJobTestRig, seedAccount, type JobTestRig } from '@/server/jobs/testing';
import { seedInstalledConnection, seedOwner } from '@/server/services/accounts/testing';
import { createOwnerScopeForTest, type OwnerScope } from '@/server/services/auth';
import { baselineFailurePath, createBaselineHandler } from '@/server/services/baseline';
import { saveOwnerBrief } from '@/server/services/brief';
import type { Sleep } from '@/server/services/hubspot';
import { saveFormSelection, savePreferences, type PreferencesInput, type SavePreferencesResult } from '@/server/services/onboarding';

// Shared set-up for the onboarding tests: every fake around PGlite, the baseline job in a private
// registry, and an account in `onboarding` installed on the fixture portal with its owner bound
// (the state right after /auth/confirm), the settings row the install creates, and nothing else.

export const OWNER_EMAIL = 'owner@brightside-plumbing.example';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface OnboardingRig extends JobTestRig {
  hubspot: FakeHubSpot;
  registry: JobRegistry;
  /** Advances the FakeClock instead of waiting (portal limiter). */
  sleep: Sleep;
  accountId: string;
  userId: string;
  scope: OwnerScope;
  connectionId: string;
  contactUs: string;
  quote: string;
  newsletter: string;
}

export async function createOnboardingRig(db: Db): Promise<OnboardingRig> {
  const registry = createJobRegistry();
  const box: { rig?: JobTestRig } = {};
  const sleep: Sleep = async (ms) => {
    box.rig?.clock.advance(ms);
  };
  registry.register('baseline', createBaselineHandler({ sleep }));
  registry.registerFailurePath('baseline', baselineFailurePath);
  const rig = createJobTestRig(db, registry);
  box.rig = rig;
  const now = rig.clock.now();
  const accountId = await seedAccount(db, { now, processingState: 'onboarding' });
  await db.query(`update accounts set timezone_source = 'hubspot' where id = $1`, [accountId]);
  await db.query(`insert into settings (account_id) values ($1)`, [accountId]);
  const userId = await seedOwner(db, accountId, OWNER_EMAIL);
  const hubspot = rig.fakes.hubspot;
  const { connectionId } = await seedInstalledConnection(rig.deps, hubspot, { accountId, now });
  return {
    ...rig,
    hubspot,
    registry,
    sleep,
    accountId,
    userId,
    scope: createOwnerScopeForTest(accountId, userId),
    connectionId,
    contactUs: hubspot.formIdByName('Contact us'),
    quote: hubspot.formIdByName('Request a quote'),
    newsletter: hubspot.formIdByName('Newsletter signup'),
  };
}

/** The D-39 preferences: Gmail, the owner's own address, quiet 19–08, weekends allowed, follow-ups on. */
export function preferencesInput(overrides: Partial<PreferencesInput> = {}): PreferencesInput {
  return {
    mail_client: 'gmail',
    gmail_account_email: null,
    notify_emails: [OWNER_EMAIL],
    quiet_start_hour: 19,
    quiet_end_hour: 8,
    skip_weekends: false,
    followups_enabled: true,
    bcc_address: null,
    timezone: null,
    ...overrides,
  };
}

export async function savePrefs(rig: OnboardingRig, overrides: Partial<PreferencesInput> = {}): Promise<SavePreferencesResult> {
  return savePreferences(rig.scope, rig.deps, preferencesInput(overrides));
}

export async function selectForms(rig: OnboardingRig, formIds: readonly string[] = [rig.contactUs, rig.quote]): Promise<void> {
  const result = await saveFormSelection(rig.scope, rig.deps, { formIds }, { sleep: rig.sleep });
  if (!result.ok) throw new Error(`form selection refused: ${result.reason}`);
}

export async function saveBrief(rig: OnboardingRig): Promise<void> {
  const result = await saveOwnerBrief(rig.scope, rig.deps, {
    company_name: 'Brightside Plumbing',
    one_line: 'Family-run plumbers.',
    services: ['Emergency repairs'],
    who_we_serve: 'Homeowners',
    tone: { style: 'friendly', note: '' },
    sign_off_name: 'Dana Whitfield',
    allow_pricing: false,
    never_promise: [],
    faqs: [],
    booking_link_choice: 'none',
    booking_link: null,
    booking_link_confirmed: false,
  });
  if (!result.ok) throw new Error('brief save refused');
}

export async function settingsOf(db: Db, accountId: string): Promise<{
  notify_emails: string[];
  notify_emails_verified: string[];
  mail_client: string;
  quiet_start_hour: number;
  quiet_end_hour: number;
  skip_weekends: boolean;
  bcc_address: string | null;
  preferences_saved_at: Date | null;
}> {
  return db.one(
    `select notify_emails, notify_emails_verified, mail_client, quiet_start_hour, quiet_end_hour, skip_weekends, bcc_address, preferences_saved_at
       from settings where account_id = $1`,
    [accountId],
  );
}

/** The action-link token in a verify-notify email's text. */
export function verifyLinkToken(text: string): string {
  const match = /\/a\/(apt_[A-Za-z0-9_-]{43})\/verify-notify/.exec(text);
  if (match?.[1] === undefined) throw new Error('no verify-notify link in the email');
  return match[1];
}
