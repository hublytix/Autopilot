import 'server-only';
import type { EmailDirection, RefreshFailureClass } from '@/server/domain/types';
import type { Clock } from '@/server/ports/clock';
import type { ApiFailureKind, RefreshModeState } from './state';

// Inputs of FakeHubSpot's constructor and of its test and dev helpers (not part of the port).

export type RefreshMode =
  | 'ok'
  | 'revoked'
  | 'config'
  | { kind: 'ok' }
  /** Every refresh fails as revoked (`BAD_REFRESH_TOKEN` by default, or `BAD_HUB`); introspection is unaffected. */
  | { kind: 'revoked'; variant?: 'bad_refresh_token' | 'bad_hub' | undefined }
  /** `invalid_client`: also fails code exchange, introspection and revocation. */
  | { kind: 'config' }
  /** The next `times` refreshes fail transiently (502 by default), then refreshes succeed again. */
  | { kind: 'transient'; times: number; failure?: 429 | 500 | 502 | 503 | 504 | 'timeout' | undefined }
  /** The next `times` (default 1) refreshes get 477 with `Retry-After` in seconds. */
  | { kind: 'migration'; retryAfterSeconds: number; times?: number | undefined };

export interface FakeHubSpotOptions {
  clock: Clock;
  /** A portal in the fixture format; defaults to test/fixtures/hubspot-portal.json. */
  portal?: unknown;
  /** Base URL of the app, for the fake consent page `/dev/fake-hubspot/authorize`. */
  appUrl?: string | undefined;
  clientId?: string | undefined;
  /** Signs webhooks unless a call passes its own. */
  clientSecret?: string | undefined;
  /**
   * Decides how a failed refresh is classified from the HubSpot-shaped response (M2's
   * `classifyRefreshFailure`). Without it, each refresh mode yields the class it simulates.
   */
  classifyRefreshFailure?: ((status: number, body: unknown) => RefreshFailureClass) | undefined;
}

export interface SubmitFormInput {
  formId: string;
  email: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  company?: string | undefined;
  message?: string | undefined;
  /** `submittedAt`; defaults to now. A future time stays invisible until the clock reaches it. */
  at?: Date | undefined;
  /** true: the email must not belong to a contact yet; false: it must; omitted: either. */
  newContact?: boolean | undefined;
  /** How long a newly created contact stays unreadable (404); defaults to the portal setting. */
  visibilityDelayMs?: number | undefined;
  /** false: HubSpot returns this submission without a `conversionId`. */
  withConversionId?: boolean | undefined;
  pageUrl?: string | undefined;
}

export interface SubmitFormResult {
  /** null when the form creates no contact for a new email (`createNewContactForNewEmail: false`). */
  contactId: string | null;
  conversionId: string | null;
  /** True when this submission created the contact (HubSpot then fires `object.creation`). */
  createdContact: boolean;
}

export interface CreateContactInput {
  email: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  company?: string | undefined;
  message?: string | undefined;
  /** Creation time; defaults to now. */
  at?: Date | undefined;
  visibilityDelayMs?: number | undefined;
  /** Any further contact properties, e.g. `hs_additional_emails`. */
  properties?: Record<string, string | null> | undefined;
}

export interface LogOwnerSendInput {
  /** The lead's address (`hs_email_to_email`). */
  to: string;
  /** Associated with the email but not in `hs_email_to_email`. */
  cc?: readonly string[] | undefined;
  /** `hs_timestamp`; defaults to now. */
  at?: Date | undefined;
  /** When the engagement becomes readable; defaults to `at`. */
  loggedAt?: Date | undefined;
  /** The sending mailbox; defaults to the installer's. */
  from?: string | undefined;
  /** `hs_email_status`; defaults to `SENT`; null for none. */
  status?: string | null | undefined;
  /** BCC logging creates a contact for an unknown recipient (HS-INBOX-LOGGING-CHECK-DESIGN); false to skip. */
  createContactIfMissing?: boolean | undefined;
}

export interface LogLeadReplyInput {
  /** The lead's address (`hs_email_from_email`); must belong to a contact ("known contacts" rule). */
  from: string;
  /** The owner mailbox that received it; defaults to the installer's. */
  to?: string | undefined;
  at?: Date | undefined;
  loggedAt?: Date | undefined;
  direction?: 'INCOMING_EMAIL' | 'FORWARDED_EMAIL' | undefined;
}

export interface LogEmailInput {
  direction: EmailDirection;
  from: string;
  to: readonly string[];
  contactIds: readonly string[];
  at?: Date | undefined;
  loggedAt?: Date | undefined;
  status?: string | null | undefined;
}

export interface InjectedFailure {
  kind: ApiFailureKind;
  /** How many calls fail; default 1. */
  times?: number | undefined;
  /** `Retry-After` in seconds, for `rate_limited` (optional) and `migration` (default 3600). */
  retryAfterSeconds?: number | undefined;
}

/** Validates a refresh mode and turns it into its stored form. */
export function toRefreshModeState(mode: RefreshMode): RefreshModeState {
  if (mode === 'ok' || mode === 'config') return { kind: mode };
  if (mode === 'revoked') return { kind: 'revoked', variant: 'bad_refresh_token' };
  switch (mode.kind) {
    case 'ok':
    case 'config':
      return { kind: mode.kind };
    case 'revoked':
      return { kind: 'revoked', variant: mode.variant ?? 'bad_refresh_token' };
    case 'transient':
      if (!Number.isInteger(mode.times) || mode.times < 1) throw new RangeError('fake_hubspot: times must be a positive integer');
      return { kind: 'transient', remaining: mode.times, failure: mode.failure ?? 502 };
    case 'migration': {
      const times = mode.times ?? 1;
      if (!Number.isInteger(times) || times < 1) throw new RangeError('fake_hubspot: times must be a positive integer');
      if (!Number.isInteger(mode.retryAfterSeconds) || mode.retryAfterSeconds < 0) {
        throw new RangeError('fake_hubspot: retryAfterSeconds must be a non-negative integer');
      }
      return { kind: 'migration', remaining: times, retryAfterSeconds: mode.retryAfterSeconds };
    }
  }
}
