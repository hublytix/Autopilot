import 'server-only';
import type {
  EmailDirection,
  EmailMetadataProperty,
  HubSpotContactProperty,
} from '@/server/domain/types';

// HubSpot is read-only (law 2, D-03). The live client accepts only the request allow-list and throws
// ConfigError('hubspot_request_not_allowed') before any network call otherwise. Every call takes the
// access token explicitly: the token manager (lease, refresh, 401 rule) lives in services. HubSpot ids
// (portal, contact, form, email, app) are strings everywhere, whatever their wire type.
//
// Errors (from '@/server/domain/errors'), unless a method documents a null result instead:
// - TransientError: 423, 429, 477, 5xx, network errors and timeouts. `retryAfterMs` carries
//   Retry-After (HubSpot sends seconds; 477 can be up to 24 h). A daily-limit 429 has no delay: the
//   caller defers to the portal's next local midnight (D-11).
// - PermanentError: other 4xx and unparseable 2xx bodies.
// - ConfigError: OAuth client misconfiguration, and requests outside the allow-list.
// - RevokedError: only from `refresh` (D-11).
//
// Every network method takes an optional AbortSignal (HubSpotCallOptions), so callers bound each call
// by their remaining budget: the token manager's single refresh (8 s, PLAN §9.1 step 3), the poll
// cron's ~240 s (§7.3), job handlers' function budgets. An aborted call, or one the signal aborts
// while in flight, throws TransientError('hubspot_timeout') with no httpStatus.

/** Error codes the HubSpot client throws with. Services branch on the ones noted. */
export type HubSpotErrorCode =
  /** 401 on an API call: the caller refreshes once, then retries or treats it as transient (D-11). */
  | 'hubspot_unauthorized'
  /** 403 `MISSING_SCOPES`: the feature reports "Not enough data" (D-03 path b). */
  | 'hubspot_missing_scopes'
  | 'hubspot_forbidden'
  | 'hubspot_not_found'
  | 'hubspot_bad_request'
  /** Code exchange rejected (`BAD_AUTH_CODE`, reused or expired code). */
  | 'hubspot_bad_auth_code'
  | 'hubspot_rate_limited'
  /** Daily request limit: defer to the next local midnight. */
  | 'hubspot_daily_limit'
  | 'hubspot_locked'
  /** 477: the portal is moving data centres; reschedule by `retryAfterMs`. */
  | 'hubspot_migration_in_progress'
  | 'hubspot_server_error'
  | 'hubspot_network'
  | 'hubspot_timeout'
  | 'hubspot_invalid_response'
  | 'hubspot_request_not_allowed'
  /** `refresh`: classified `revoked` (RevokedError). */
  | 'hubspot_refresh_revoked'
  /** `refresh`/`exchangeCode`: classified `config` (ConfigError). */
  | 'hubspot_oauth_config';

export interface AuthorizeUrlInput {
  /** The HKDF-signed state value, echoed back to the callback. */
  state: string;
  redirectUri: string;
  /** Exactly `REQUIRED_SCOPES`. */
  scopes: readonly string[];
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime from the response (`expires_in`, 1800 today). */
  expiresInSeconds: number;
  /** `hub_id` (the portal id) when the token response includes it. */
  hubId?: string | undefined;
  /** Granted scopes when the token response includes them. */
  scopes?: string[] | undefined;
}

export type TokenTypeHint = 'access_token' | 'refresh_token';

export interface ActiveTokenInfo {
  active: true;
  hubId: string;
  /** The portal's own website domain (display only, D-12). */
  hubDomain: string | null;
  /** The installing user's email (`user`); the default owner email (D-35). */
  userEmail: string | null;
  scopes: string[];
  appId: string;
  /** HubSpot's `token_use`. */
  tokenType: TokenTypeHint;
}

/** `active:false` means revoked or uninstalled (D-10). */
export type TokenIntrospection = ActiveTokenInfo | { active: false };

export interface AccountDetails {
  portalId: string;
  /** As HubSpot names it, e.g. `US/Eastern`; may not be IANA (D-12 falls back to the offset). */
  timeZone: string;
  utcOffsetMilliseconds: number;
  /** e.g. `app.hubspot.com`, `app-eu1.hubspot.com`; used for record links. */
  uiDomain: string;
  dataHostingLocation: string;
  /** `STANDARD`, `DEVELOPER_TEST`, `SANDBOX`, `APP_DEVELOPER`, or a newer value. */
  accountType: string;
}

export interface HubSpotFormField {
  name: string;
  /** HubSpot `fieldType`, e.g. `email`, `multi_line_text`. */
  fieldType: string;
  hidden: boolean;
  /** `0-1` for contact fields. */
  objectTypeId?: string | undefined;
}

/** A form definition, reduced to what form selection and newsletter detection need (HS-ONBOARD-NEWSLETTER-DETECT). */
export interface HubSpotForm {
  /** The form GUID. */
  id: string;
  name: string;
  /** `hubspot`, `flow`, `captured`, … (see HUBSPOT_FORM_TYPES); an open string on the wire. */
  formType: string;
  archived: boolean;
  /** Every field name across all field groups (= `fields.map(f => f.name)`). */
  fieldNames: string[];
  fields: HubSpotFormField[];
  /** `configuration.lifecycleStages[].value`, e.g. `subscriber`. */
  lifecycleStages: string[];
  /** Legal consent includes subscription opt-ins (`communicationsCheckboxes` / `subscriptionTypeIds`). */
  hasSubscriptionConsent: boolean;
  submitButtonText?: string | undefined;
}

export interface FormSubmissionValue {
  name: string;
  value: string;
  objectTypeId?: string | undefined;
}

export interface FormSubmission {
  /** Not always returned (HS-INTAKE-SUBMISSIONS-API). */
  conversionId?: string | undefined;
  submittedAt: Date;
  values: FormSubmissionValue[];
  pageUrl?: string | undefined;
}

/** Per-call options shared by every network method (see the header). */
export interface HubSpotCallOptions {
  /** Aborting it ends the call with TransientError('hubspot_timeout'). */
  signal?: AbortSignal | undefined;
}

export interface ListSubmissionsOptions extends HubSpotCallOptions {
  /** The cursor from the previous page's `nextAfter`. */
  after?: string | undefined;
  /** At most 50. */
  limit: number;
}

export interface SubmissionPage {
  /** Newest first, as HubSpot reports; callers must not depend on the order (they cap pages and dedupe). */
  results: FormSubmission[];
  /** Absent on the last page. */
  nextAfter?: string | undefined;
}

export interface GetContactOptions extends HubSpotCallOptions {
  /** `email` when `idOrEmail` is an address; omit for a record id. */
  idProperty?: 'email' | undefined;
  properties: readonly HubSpotContactProperty[];
  /** `emails` adds the first page of associated email ids. */
  associations?: readonly 'emails'[] | undefined;
}

export interface HubSpotContact {
  /** May differ from the requested id: the contact was merged, so re-map it (D-09). */
  id: string;
  /** Requested properties; HubSpot returns `null` for empty ones. */
  properties: Partial<Record<HubSpotContactProperty, string | null>>;
  /** First page of associated email ids, when `associations` asked for them. */
  associatedEmailIds?: string[] | undefined;
  /** Cursor for `listContactEmailIds` when there are more associated emails. */
  associationsNextAfter?: string | undefined;
}

export interface ListContactEmailIdsOptions extends HubSpotCallOptions {
  /** The cursor from `associationsNextAfter` or the previous page's `nextAfter`. */
  after?: string | undefined;
}

export interface EmailIdPage {
  ids: string[];
  nextAfter?: string | undefined;
}

/** An email engagement's metadata only: never subject, body or headers (D-03). */
export interface EmailEngagement {
  id: string;
  /** `hs_timestamp`, HubSpot's event time. Engagements without one are dropped by the client. */
  timestamp: Date;
  /** `null` when absent or a value outside EMAIL_DIRECTIONS. */
  direction: EmailDirection | null;
  /** `hs_email_status` as sent (`SENT`, `BOUNCED`, …); absent when HubSpot has none. */
  status?: string | undefined;
  /** Lower-cased sender address, when `hs_email_from_email` was requested and set. */
  fromEmail?: string | undefined;
  /** Lower-cased recipient addresses (`hs_email_to_email`, split); empty when not requested. */
  toEmails: string[];
}

export interface EmailCountQuery {
  /** `outbound` counts `EMAIL`; `inbound` counts `INCOMING_EMAIL` and `FORWARDED_EMAIL` (D-14). */
  direction: 'outbound' | 'inbound';
  /** Counts emails with `hs_timestamp >= since`. */
  since: Date;
}

export interface HubSpotClient {
  /** Builds the consent URL with exactly the given scopes (fake: `/dev/fake-hubspot/authorize`). No network. */
  authorizeUrl(input: AuthorizeUrlInput): string;

  /** Exchanges an authorization code for tokens, using the same redirect URI as the authorize URL. */
  exchangeCode(code: string, redirectUri: string, options?: HubSpotCallOptions): Promise<TokenSet>;

  /**
   * One refresh call (no retries). Throws RevokedError, ConfigError or TransientError as
   * `classifyRefreshFailure` decides (D-11). The token manager passes an 8 s signal (PLAN §9.1 step 3).
   */
  refresh(refreshToken: string, options?: HubSpotCallOptions): Promise<TokenSet>;

  /** Token metadata (installer email, hub id, scopes); `{active:false}` for a revoked or uninstalled token. */
  introspect(token: string, hint: TokenTypeHint, options?: HubSpotCallOptions): Promise<TokenIntrospection>;

  /** Revokes a refresh token (best effort on disconnect; does not uninstall or kill issued access tokens). */
  revoke(refreshToken: string, options?: HubSpotCallOptions): Promise<void>;

  /** `GET /account-info/{v}/details`: timezone, UI domain, hosting location (D-12). */
  accountDetails(accessToken: string, options?: HubSpotCallOptions): Promise<AccountDetails>;

  /** All live (`archived=false`) `hubspot` and `flow` forms, following every page (D-07). */
  listForms(accessToken: string, options?: HubSpotCallOptions): Promise<HubSpotForm[]>;

  /** One page of a form's submissions from the legacy submissions endpoint (D-07). */
  listSubmissions(accessToken: string, formId: string, options: ListSubmissionsOptions): Promise<SubmissionPage>;

  /** One contact by id or email with only the listed properties; `null` on 404 (deleted, or not visible yet). */
  getContact(accessToken: string, idOrEmail: string, options: GetContactOptions): Promise<HubSpotContact | null>;

  /** One further page of a contact's associated email ids (the dated associations endpoint). */
  listContactEmailIds(accessToken: string, contactId: string, options: ListContactEmailIdsOptions): Promise<EmailIdPage>;

  /** Reads email metadata for any number of ids (chunked into batch reads of 100); missing ids are omitted. */
  batchReadEmails(
    accessToken: string,
    ids: readonly string[],
    properties: readonly EmailMetadataProperty[],
    options?: HubSpotCallOptions,
  ): Promise<EmailEngagement[]>;

  /** Number of logged emails in one direction since a time, via `emails/search` with `limit=1` (D-14 history). */
  searchEmailsCount(accessToken: string, query: EmailCountQuery, options?: HubSpotCallOptions): Promise<number>;

  /** Uninstalls the app from the portal (`DELETE /appinstalls/{v}/external-install`); HubSpot emails its admins. */
  uninstallApp(accessToken: string, options?: HubSpotCallOptions): Promise<void>;
}
