import 'server-only';
import { IANAZone } from 'luxon';
import type { AppError } from '@/server/domain/errors';
import {
  isEmailMetadataProperty,
  isHubSpotContactProperty,
  type EmailDirection,
  type EmailMetadataProperty,
  type HubSpotContactProperty,
  type RefreshFailureClass,
} from '@/server/domain/types';
import type { Clock } from '@/server/ports/clock';
import type {
  AccountDetails,
  AuthorizeUrlInput,
  EmailCountQuery,
  EmailEngagement,
  EmailIdPage,
  FormSubmission,
  GetContactOptions,
  HubSpotCallOptions,
  HubSpotClient,
  HubSpotContact,
  HubSpotForm,
  ListContactEmailIdsOptions,
  ListSubmissionsOptions,
  SubmissionPage,
  TokenIntrospection,
  TokenSet,
  TokenTypeHint,
} from '@/server/ports/hubspot';
import { DEFAULT_PORTAL_FIXTURE } from './default-portal';
import {
  toRefreshModeState,
  type CreateContactInput,
  type FakeHubSpotOptions,
  type InjectedFailure,
  type LogEmailInput,
  type LogLeadReplyInput,
  type LogOwnerSendInput,
  type RefreshMode,
  type SubmitFormInput,
  type SubmitFormResult,
} from './inputs';
import {
  parseState,
  stateFromFixture,
  type ContactState,
  type EmailState,
  type FakeHubSpotApiOperation,
  type FakeHubSpotState,
  type MailboxLoggingMode,
  type PortalInfo,
  type RefreshModeState,
  type SubmissionState,
} from './state';
import { buildSignedWebhook, type FakeWebhookEvent, type SignedWebhook, type SignedWebhookOptions } from './webhook';
import {
  API_WIRE,
  NO_RESPONSE,
  REFRESH_WIRE,
  config,
  gatewayWire,
  injectedFailureError,
  migrationWire,
  notAllowed,
  permanent,
  refreshError,
  transient,
  type FakeWireResponse,
} from './wire';

/** Documented fake OAuth client values (fake mode only; live mode must reject them). */
export const FAKE_HUBSPOT_CLIENT_ID = 'fake-hubspot-client-id';
export const FAKE_HUBSPOT_CLIENT_SECRET = 'fake-hubspot-client-secret';

/** HubSpot's access-token lifetime (`expires_in`, HS-OAUTH-TOKEN-RESPONSE). */
export const ACCESS_TOKEN_TTL_SECONDS = 1800;
/** Authorization codes are single-use with a short exchange window; the length here is the fake's choice. */
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
/** The submissions endpoint's maximum `limit` (HS-INTAKE-SUBMISSIONS-API). */
export const MAX_SUBMISSIONS_PAGE = 50;
/** Associated email ids per page, on the contact GET and on the associations endpoint. */
export const ASSOCIATIONS_PAGE_SIZE = 100;
const EMAIL_READ_SCOPE = 'sales-email-read';
const OFFERED_FORM_TYPES: ReadonlySet<string> = new Set(['hubspot', 'flow']);
const INBOUND_DIRECTIONS: ReadonlySet<EmailDirection> = new Set(['INCOMING_EMAIL', 'FORWARDED_EMAIL']);

function lower(email: string): string {
  return email.trim().toLowerCase();
}

function splitEmails(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(';')
    .map(lower)
    .filter((s) => s.length > 0);
}

function encodeCursor(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, pattern: RegExp): RegExpExecArray | null {
  return pattern.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
}

function pad(n: number): string {
  return String(n).padStart(6, '0');
}

/**
 * An already-aborted signal ends the call as the live client's timeout would (TransientError
 * 'hubspot_timeout', no response), before any state changes. The fake answers synchronously, so a
 * signal cannot abort mid-call.
 */
function assertNotAborted(options: HubSpotCallOptions | undefined): void {
  if (options?.signal?.aborted === true) throw transient(NO_RESPONSE);
}

function assertMs(ms: number): number {
  if (!Number.isFinite(ms)) throw new RangeError('fake_hubspot_invalid_date');
  return ms;
}

/**
 * An in-memory HubSpot portal implementing `HubSpotClient` (PLAN §4), plus test and dev helpers
 * that are not part of the port. Time comes only from the injected Clock. State is plain JSON:
 * `snapshot()` / `restore()` persist it (fake mode keeps it in PGlite).
 *
 * Fidelity notes (choices where HubSpot is undocumented are marked in the research):
 * - Access tokens expire after 1800 s of fake time; uninstall invalidates them, a refresh-token
 *   revocation does not (HS-V1-REVOKE-RESPONSE).
 * - `getContact` by email matches the primary email only; by id it follows merges.
 * - Email reads need `sales-email-read` (403 `MISSING_SCOPES` otherwise); association reads do not.
 * - Contact and email property names outside Autopilot's allow-lists throw ConfigError
 *   `hubspot_request_not_allowed`, as the live client does before any network call (D-03).
 */
export class FakeHubSpot implements HubSpotClient {
  readonly #clock: Clock;
  readonly #appUrl: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #classify: ((status: number, body: unknown) => RefreshFailureClass) | undefined;
  #state: FakeHubSpotState;

  constructor(options: FakeHubSpotOptions) {
    this.#clock = options.clock;
    this.#appUrl = (options.appUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
    this.#clientId = options.clientId ?? FAKE_HUBSPOT_CLIENT_ID;
    this.#clientSecret = options.clientSecret ?? FAKE_HUBSPOT_CLIENT_SECRET;
    this.#classify = options.classifyRefreshFailure;
    this.#state = stateFromFixture(options.portal ?? DEFAULT_PORTAL_FIXTURE);
  }

  // -------------------------------------------------------------------------------------------
  // HubSpotClient: OAuth
  // -------------------------------------------------------------------------------------------

  authorizeUrl(input: AuthorizeUrlInput): string {
    const query = [
      ['client_id', this.#clientId],
      ['redirect_uri', input.redirectUri],
      ['scope', input.scopes.join(' ')],
      ['state', input.state],
    ]
      .map(([key, value]) => `${key}=${encodeURIComponent(value ?? '')}`)
      .join('&');
    return `${this.#appUrl}/dev/fake-hubspot/authorize?${query}`;
  }

  async exchangeCode(code: string, redirectUri: string, options?: HubSpotCallOptions): Promise<TokenSet> {
    assertNotAborted(options);
    const oauth = this.#state.oauth;
    if (oauth.refreshMode.kind === 'config') throw config('hubspot_oauth_config', REFRESH_WIRE.invalidClient);
    const now = this.#now();
    const entry = oauth.authCodes.find((c) => c.code === code);
    if (entry === undefined || entry.used || now >= entry.expiresAtMs) {
      throw permanent('hubspot_bad_auth_code', REFRESH_WIRE.badAuthCode);
    }
    if (entry.redirectUri !== redirectUri) throw config('hubspot_oauth_config', REFRESH_WIRE.badRedirectUri);
    entry.used = true;
    oauth.installed = true;
    return this.#issueTokenSet(this.#newRefreshToken());
  }

  async refresh(refreshToken: string, options?: HubSpotCallOptions): Promise<TokenSet> {
    assertNotAborted(options);
    const failure = this.#refreshFailure(refreshToken);
    if (failure !== undefined) throw failure;
    return this.#issueTokenSet(refreshToken);
  }

  async introspect(token: string, _hint: TokenTypeHint, options?: HubSpotCallOptions): Promise<TokenIntrospection> {
    assertNotAborted(options);
    // HubSpot treats `token_type_hint` as a hint: the token is found whatever its kind.
    const oauth = this.#state.oauth;
    if (oauth.refreshMode.kind === 'config') throw config('hubspot_oauth_config', REFRESH_WIRE.invalidClient);
    if (!oauth.installed) return { active: false };
    let tokenType: TokenTypeHint;
    if (oauth.refreshTokens.some((t) => t.token === token && !t.revoked)) tokenType = 'refresh_token';
    else if (this.#liveAccessToken(token)) tokenType = 'access_token';
    else return { active: false };
    const portal = this.#state.portal;
    return {
      active: true,
      hubId: portal.portalId,
      hubDomain: portal.hubDomain,
      userEmail: portal.installerEmail,
      scopes: [...portal.grantedScopes],
      appId: portal.appId,
      tokenType,
    };
  }

  async revoke(refreshToken: string, options?: HubSpotCallOptions): Promise<void> {
    assertNotAborted(options);
    const oauth = this.#state.oauth;
    if (oauth.refreshMode.kind === 'config') throw config('hubspot_oauth_config', REFRESH_WIRE.invalidClient);
    for (const t of oauth.refreshTokens) if (t.token === refreshToken) t.revoked = true;
  }

  // -------------------------------------------------------------------------------------------
  // HubSpotClient: API calls (each takes an access token)
  // -------------------------------------------------------------------------------------------

  async accountDetails(accessToken: string, options?: HubSpotCallOptions): Promise<AccountDetails> {
    assertNotAborted(options);
    this.#authorize(accessToken, 'accountDetails');
    const portal = this.#state.portal;
    const offsetMs = IANAZone.isValidZone(portal.timeZone)
      ? IANAZone.create(portal.timeZone).offset(this.#now()) * 60_000
      : (portal.utcOffsetMilliseconds ?? 0);
    return {
      portalId: portal.portalId,
      timeZone: portal.timeZone,
      utcOffsetMilliseconds: offsetMs,
      uiDomain: portal.uiDomain,
      dataHostingLocation: portal.dataHostingLocation,
      accountType: portal.accountType,
    };
  }

  async listForms(accessToken: string, options?: HubSpotCallOptions): Promise<HubSpotForm[]> {
    assertNotAborted(options);
    this.#authorize(accessToken, 'listForms');
    return this.#state.forms
      .filter((f) => !f.archived && OFFERED_FORM_TYPES.has(f.formType))
      .map((f) => ({
        id: f.id,
        name: f.name,
        formType: f.formType,
        archived: f.archived,
        fieldNames: f.fields.map((field) => field.name),
        fields: f.fields.map((field) => ({
          name: field.name,
          fieldType: field.fieldType,
          hidden: field.hidden,
          objectTypeId: field.objectTypeId,
        })),
        lifecycleStages: [...f.lifecycleStages],
        hasSubscriptionConsent: f.hasSubscriptionConsent,
        submitButtonText: f.submitButtonText,
      }));
  }

  async listSubmissions(accessToken: string, formId: string, options: ListSubmissionsOptions): Promise<SubmissionPage> {
    assertNotAborted(options);
    this.#authorize(accessToken, 'listSubmissions');
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_SUBMISSIONS_PAGE) {
      throw permanent('hubspot_bad_request', API_WIRE.badRequest);
    }
    if (!this.#state.forms.some((f) => f.id === formId)) throw permanent('hubspot_not_found', API_WIRE.notFound);

    let older = (_s: SubmissionState): boolean => true;
    if (options.after !== undefined) {
      const match = decodeCursor(options.after, /^s:(-?\d+):(\d+)$/);
      if (match === null) throw permanent('hubspot_bad_request', API_WIRE.badRequest);
      const [atMs, seq] = [Number(match[1]), Number(match[2])];
      older = (s) => s.submittedAtMs < atMs || (s.submittedAtMs === atMs && s.seq < seq);
    }
    const now = this.#now();
    const remaining = this.#state.submissions
      .filter((s) => s.formId === formId && s.submittedAtMs <= now && older(s))
      .sort((a, b) => b.submittedAtMs - a.submittedAtMs || b.seq - a.seq);
    const page = remaining.slice(0, options.limit);
    const last = page.at(-1);
    const results: FormSubmission[] = page.map((s) => ({
      conversionId: s.conversionId ?? undefined,
      submittedAt: new Date(s.submittedAtMs),
      values: s.values.map((v) => ({ name: v.name, value: v.value, objectTypeId: v.objectTypeId })),
      pageUrl: s.pageUrl ?? undefined,
    }));
    return remaining.length > page.length && last !== undefined
      ? { results, nextAfter: encodeCursor(`s:${last.submittedAtMs}:${last.seq}`) }
      : { results };
  }

  async getContact(accessToken: string, idOrEmail: string, options: GetContactOptions): Promise<HubSpotContact | null> {
    assertNotAborted(options);
    this.#authorize(accessToken, 'getContact');
    if (!options.properties.every((p) => isHubSpotContactProperty(p))) throw notAllowed();
    if (!(options.associations ?? []).every((a) => a === 'emails')) throw notAllowed();

    const contact =
      options.idProperty === 'email' ? this.#liveContactByEmail(idOrEmail, false) : this.#resolveContact(idOrEmail);
    if (contact === undefined || !this.#readable(contact)) return null;

    const properties: Partial<Record<HubSpotContactProperty, string | null>> = {};
    for (const name of options.properties) properties[name] = contact.properties[name] ?? null;
    const result: HubSpotContact = { id: contact.id, properties };
    if (options.associations?.includes('emails') === true) {
      const page = this.#emailIdPage(contact.id, 0);
      result.associatedEmailIds = page.ids;
      if (page.nextAfter !== undefined) result.associationsNextAfter = page.nextAfter;
    }
    return result;
  }

  async listContactEmailIds(accessToken: string, contactId: string, options: ListContactEmailIdsOptions): Promise<EmailIdPage> {
    assertNotAborted(options);
    this.#authorize(accessToken, 'listContactEmailIds');
    const contact = this.#resolveContact(contactId);
    if (contact === undefined || !this.#readable(contact)) throw permanent('hubspot_not_found', API_WIRE.notFound);
    let offset = 0;
    if (options.after !== undefined) {
      const match = decodeCursor(options.after, /^o:(\d+)$/);
      if (match === null) throw permanent('hubspot_bad_request', API_WIRE.badRequest);
      offset = Number(match[1]);
    }
    return this.#emailIdPage(contact.id, offset);
  }

  async batchReadEmails(
    accessToken: string,
    ids: readonly string[],
    properties: readonly EmailMetadataProperty[],
    options?: HubSpotCallOptions,
  ): Promise<EmailEngagement[]> {
    assertNotAborted(options);
    this.#authorize(accessToken, 'batchReadEmails');
    this.#requireEmailScope();
    if (!properties.every((p) => isEmailMetadataProperty(p))) throw notAllowed();
    const want = new Set<EmailMetadataProperty>(properties);
    // The live client drops engagements without `hs_timestamp`, so none survive if it was not requested.
    if (!want.has('hs_timestamp')) return [];
    const result: EmailEngagement[] = [];
    for (const id of new Set(ids)) {
      const email = this.#visibleEmail(id);
      if (email === undefined) continue;
      const engagement: EmailEngagement = {
        id: email.id,
        timestamp: new Date(email.timestampMs),
        direction: want.has('hs_email_direction') ? email.direction : null,
        toEmails: want.has('hs_email_to_email') ? [...email.toEmails] : [],
      };
      if (want.has('hs_email_status') && email.status !== null) engagement.status = email.status;
      if (want.has('hs_email_from_email') && email.fromEmail !== null) engagement.fromEmail = email.fromEmail;
      result.push(engagement);
    }
    return result;
  }

  async searchEmailsCount(accessToken: string, query: EmailCountQuery, options?: HubSpotCallOptions): Promise<number> {
    assertNotAborted(options);
    this.#authorize(accessToken, 'searchEmailsCount');
    this.#requireEmailScope();
    const sinceMs = assertMs(query.since.getTime());
    const now = this.#now();
    return this.#state.emails.filter(
      (e) =>
        e.visibleAtMs <= now &&
        e.timestampMs >= sinceMs &&
        (query.direction === 'outbound' ? e.direction === 'EMAIL' : INBOUND_DIRECTIONS.has(e.direction)),
    ).length;
  }

  async uninstallApp(accessToken: string, options?: HubSpotCallOptions): Promise<void> {
    assertNotAborted(options);
    this.#authorize(accessToken, 'uninstallApp');
    const oauth = this.#state.oauth;
    oauth.installed = false;
    for (const t of oauth.refreshTokens) t.revoked = true;
    for (const t of oauth.accessTokens) t.revoked = true;
  }

  // -------------------------------------------------------------------------------------------
  // Test and dev helpers: portal facts
  // -------------------------------------------------------------------------------------------

  get portal(): PortalInfo {
    return structuredClone(this.#state.portal);
  }

  get ownerEmail(): string {
    return this.#state.portal.installerEmail;
  }

  /** The owner's other address for the inbox check, when the portal defines one. */
  get testAddress(): string | undefined {
    return this.#state.portal.ownerTestAddress;
  }

  /** True between a code exchange (or `installTokens`) and an uninstall. */
  isInstalled(): boolean {
    return this.#state.oauth.installed;
  }

  formIdByName(name: string): string {
    const form = this.#state.forms.find((f) => f.name === name);
    if (form === undefined) throw new Error('fake_hubspot: unknown form name');
    return form.id;
  }

  /** The live contact that owns this primary or additional email, readable yet or not. */
  contactIdByEmail(email: string): string | null {
    return this.#liveContactByEmail(email, true)?.id ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // Test and dev helpers: OAuth
  // -------------------------------------------------------------------------------------------

  /** What the fake consent page does on "Approve": a single-use code for `exchangeCode`. */
  createAuthCode(input: { redirectUri: string }): string {
    const oauth = this.#state.oauth;
    const now = this.#now();
    oauth.authCodes = oauth.authCodes.filter((c) => !c.used && c.expiresAtMs > now);
    const code = `fake-hs-code-${pad(this.#state.counters.token++)}`;
    oauth.authCodes.push({ code, redirectUri: input.redirectUri, expiresAtMs: now + AUTH_CODE_TTL_MS, used: false });
    return code;
  }

  /** Installs the app and returns tokens without the consent round trip. */
  installTokens(): TokenSet {
    this.#state.oauth.installed = true;
    return this.#issueTokenSet(this.#newRefreshToken());
  }

  /** Revokes every refresh token (as an uninstall from HubSpot's side would); issued access tokens live on. */
  revokeToken(): void {
    for (const t of this.#state.oauth.refreshTokens) t.revoked = true;
  }

  setRefreshMode(mode: RefreshMode): void {
    this.#state.oauth.refreshMode = toRefreshModeState(mode);
  }

  /** e.g. `setGrantedScopes([...scopes without 'sales-email-read'])` for the D-03 path (b) variant. */
  setGrantedScopes(scopes: readonly string[]): void {
    this.#state.portal.grantedScopes = [...scopes];
  }

  /** Makes the next `times` calls of an operation (or of any, with `'*'`) fail. */
  injectFailure(operation: FakeHubSpotApiOperation | '*', failure: InjectedFailure): void {
    const times = failure.times ?? 1;
    if (!Number.isInteger(times) || times < 1) throw new RangeError('fake_hubspot: times must be a positive integer');
    this.#state.faults.push({
      operation,
      kind: failure.kind,
      remaining: times,
      retryAfterSeconds: failure.retryAfterSeconds ?? null,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Test and dev helpers: contacts and submissions
  // -------------------------------------------------------------------------------------------

  /** Delay before a contact created by a submission becomes readable (default 0). */
  setContactVisibilityDelay(ms: number): void {
    if (!Number.isInteger(ms) || ms < 0) throw new RangeError('fake_hubspot: delay must be a non-negative integer');
    this.#state.settings.contactVisibilityDelayMs = ms;
  }

  submitForm(input: SubmitFormInput): SubmitFormResult {
    const form = this.#state.forms.find((f) => f.id === input.formId);
    if (form === undefined) throw new Error('fake_hubspot: unknown form');
    const atMs = this.#ms(input.at);
    const email = lower(input.email);
    if (!email.includes('@')) throw new Error('fake_hubspot: submission needs an email');

    const provided = new Map<string, string | undefined>([
      ['firstname', input.firstName],
      ['lastname', input.lastName],
      ['email', email],
      ['company', input.company],
      ['message', input.message],
    ]);
    const fieldNames = new Set(form.fields.map((f) => f.name));
    for (const [name, value] of provided) {
      if (value !== undefined && !fieldNames.has(name)) throw new Error(`fake_hubspot: form has no ${name} field`);
    }
    const values = form.fields.flatMap((field) => {
      const value = provided.get(field.name);
      return value === undefined || value === '' ? [] : [{ name: field.name, value, objectTypeId: field.objectTypeId }];
    });
    const submitted = Object.fromEntries(values.filter((v) => v.name !== 'email').map((v) => [v.name, v.value]));

    const existing = this.#liveContactByEmail(email, true);
    if (input.newContact === true && existing !== undefined) throw new Error('fake_hubspot: contact already exists');
    if (input.newContact === false && existing === undefined) throw new Error('fake_hubspot: no such contact');

    let contact = existing;
    let createdContact = false;
    if (contact !== undefined) {
      Object.assign(contact.properties, submitted);
    } else if (form.createNewContactForNewEmail) {
      const delay = input.visibilityDelayMs ?? this.#state.settings.contactVisibilityDelayMs;
      contact = this.#newContact({ email, ...submitted }, atMs, atMs + delay);
      createdContact = true;
    }

    const conversionId = input.withConversionId === false ? null : this.#newConversionId();
    this.#state.submissions.push({
      seq: this.#state.counters.submission++,
      formId: form.id,
      conversionId,
      submittedAtMs: atMs,
      values,
      pageUrl: input.pageUrl ?? form.pageUrl ?? null,
    });
    return { contactId: contact?.id ?? null, conversionId, createdContact };
  }

  createContact(input: CreateContactInput): string {
    const email = lower(input.email);
    if (this.#liveContactByEmail(email, true) !== undefined) throw new Error('fake_hubspot: contact already exists');
    const atMs = this.#ms(input.at);
    const named: Record<string, string> = {};
    for (const [name, value] of [
      ['firstname', input.firstName],
      ['lastname', input.lastName],
      ['company', input.company],
      ['message', input.message],
    ] as const) {
      if (value !== undefined) named[name] = value;
    }
    const delay = input.visibilityDelayMs ?? 0;
    return this.#newContact({ ...input.properties, ...named, email }, atMs, atMs + delay).id;
  }

  updateContact(contactId: string, properties: Record<string, string | null>): void {
    Object.assign(this.#liveContact(contactId).properties, properties);
  }

  optOut(contactId: string): void {
    this.updateContact(contactId, { hs_email_optout: 'true' });
  }

  /** Any non-empty reason is a stop (HS-BOUNCE-BADADDRESS: the enum values are not documented). */
  hardBounce(contactId: string, reason = 'UNKNOWN_USER'): void {
    this.updateContact(contactId, { hs_email_hard_bounce_reason_enum: reason });
  }

  /** Archives the contact: reads by id or email then return 404. */
  deleteContact(contactId: string): void {
    this.#liveContact(contactId).deletedAtMs = this.#now();
  }

  /**
   * Merges as HubSpot has since 2025-01-14: a new record with a new id, which both old ids resolve
   * to; the primary's values win, the secondary's email becomes an additional email, and the email
   * associations move to the new record. Without a secondary, models a merge with an untracked record.
   */
  mergeContact(primaryId: string, secondaryId?: string): string {
    const primary = this.#liveContact(primaryId);
    const secondary = secondaryId === undefined ? undefined : this.#liveContact(secondaryId);
    if (secondary === primary) throw new Error('fake_hubspot: cannot merge a contact with itself');
    const primaryEmail = primary.properties.email ?? null;
    const additional = new Set([
      ...splitEmails(primary.properties.hs_additional_emails),
      ...(secondary === undefined
        ? []
        : [...splitEmails(secondary.properties.email), ...splitEmails(secondary.properties.hs_additional_emails)]),
    ]);
    if (primaryEmail !== null) additional.delete(primaryEmail);

    const properties: Record<string, string | null> = { ...secondary?.properties };
    for (const [name, value] of Object.entries(primary.properties)) if (value !== null) properties[name] = value;
    properties.email = primaryEmail;
    properties.hs_additional_emails = additional.size > 0 ? [...additional].join(';') : null;

    const createdAtMs = Math.min(primary.createdAtMs, secondary?.createdAtMs ?? primary.createdAtMs);
    const merged = this.#newContact(properties, createdAtMs, this.#now());
    const replaced = new Set([primary.id, ...(secondary === undefined ? [] : [secondary.id])]);
    primary.mergedIntoId = merged.id;
    if (secondary !== undefined) secondary.mergedIntoId = merged.id;
    for (const email of this.#state.emails) {
      if (email.contactIds.some((id) => replaced.has(id))) {
        email.contactIds = [...new Set(email.contactIds.map((id) => (replaced.has(id) ? merged.id : id)))];
      }
    }
    return merged.id;
  }

  // -------------------------------------------------------------------------------------------
  // Test and dev helpers: logged emails
  // -------------------------------------------------------------------------------------------

  setLoggingMode(mode: MailboxLoggingMode, mailbox?: string): void {
    this.#state.mailboxes[lower(mailbox ?? this.#state.portal.installerEmail)] = mode;
  }

  loggingMode(mailbox?: string): MailboxLoggingMode {
    return this.#state.mailboxes[lower(mailbox ?? this.#state.portal.installerEmail)] ?? 'none';
  }

  /** The owner sends from their mailbox: an `EMAIL` engagement, if that mailbox logs sends. Returns its id or null. */
  logOwnerSend(input: LogOwnerSendInput): string | null {
    const from = lower(input.from ?? this.#state.portal.installerEmail);
    if (this.loggingMode(from) === 'none') return null;
    const atMs = this.#ms(input.at);
    const to = lower(input.to);
    const contactIds = new Set<string>();
    for (const recipient of new Set([to, ...(input.cc ?? []).map(lower)])) {
      let contact = this.#liveContactByEmail(recipient, true);
      if (contact === undefined && (input.createContactIfMissing ?? true)) contact = this.#newContact({ email: recipient }, atMs, atMs);
      if (contact !== undefined) contactIds.add(contact.id);
    }
    return this.#addEmail({
      direction: 'EMAIL',
      timestampMs: atMs,
      status: input.status === undefined ? 'SENT' : input.status,
      fromEmail: from,
      toEmails: [to],
      contactIds: [...contactIds],
      visibleAtMs: input.loggedAt === undefined ? atMs : this.#ms(input.loggedAt),
    });
  }

  /**
   * The lead replies to the owner: an `INCOMING_EMAIL` engagement, logged only when the receiving
   * mailbox logs everything and the sender is a known contact. Returns its id or null.
   */
  logLeadReply(input: LogLeadReplyInput): string | null {
    const mailbox = lower(input.to ?? this.#state.portal.installerEmail);
    if (this.loggingMode(mailbox) !== 'log_all') return null;
    const from = lower(input.from);
    const contact = this.#liveContactByEmail(from, true);
    if (contact === undefined) return null;
    const atMs = this.#ms(input.at);
    const id = this.#addEmail({
      direction: input.direction ?? 'INCOMING_EMAIL',
      timestampMs: atMs,
      status: null,
      fromEmail: from,
      toEmails: [mailbox],
      contactIds: [contact.id],
      visibleAtMs: input.loggedAt === undefined ? atMs : this.#ms(input.loggedAt),
    });
    contact.properties.hs_sales_email_last_replied = new Date(atMs).toISOString();
    return id;
  }

  /** Any engagement, ignoring logging modes (third-party senders, bounces, CC-only and similar cases). */
  logEmail(input: LogEmailInput): string {
    for (const id of input.contactIds) this.#liveContact(id);
    const atMs = this.#ms(input.at);
    return this.#addEmail({
      direction: input.direction,
      timestampMs: atMs,
      status: input.status ?? null,
      fromEmail: lower(input.from),
      toEmails: input.to.map(lower),
      contactIds: [...new Set(input.contactIds)],
      visibleAtMs: input.loggedAt === undefined ? atMs : this.#ms(input.loggedAt),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Test and dev helpers: webhooks and persistence
  // -------------------------------------------------------------------------------------------

  /** A webhook delivery as HubSpot sends it: the raw JSON body and v3-signed headers. */
  signedWebhook(events: readonly FakeWebhookEvent[], options: SignedWebhookOptions): SignedWebhook {
    const portal = this.#state.portal;
    const resolved = events.map((event) => ({
      ...event,
      occurredAt: event.occurredAt ?? this.#clock.now(),
      eventId: event.eventId ?? this.#state.counters.event++,
      portalId: event.portalId ?? portal.portalId,
      appId: event.appId ?? portal.appId,
    }));
    return buildSignedWebhook(resolved, {
      clientSecret: options.clientSecret ?? this.#clientSecret,
      method: options.method ?? 'POST',
      uri: options.uri,
      timestampMs: options.timestampMs ?? this.#now(),
    });
  }

  /** A deep copy of the whole portal state, JSON-serialisable. */
  snapshot(): FakeHubSpotState {
    return structuredClone(this.#state);
  }

  /** Replaces the state with a snapshot (validated: it may come back from storage). Parsing copies it. */
  restore(state: unknown): void {
    this.#state = parseState(state);
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  #now(): number {
    return assertMs(this.#clock.now().getTime());
  }

  #ms(date: Date | undefined): number {
    return date === undefined ? this.#now() : assertMs(date.getTime());
  }

  #authorize(accessToken: string, operation: FakeHubSpotApiOperation): void {
    const fault = this.#takeFault(operation);
    if (fault !== undefined) throw fault;
    if (!this.#liveAccessToken(accessToken)) throw permanent('hubspot_unauthorized', API_WIRE.unauthorized);
  }

  #liveAccessToken(token: string): boolean {
    const now = this.#now();
    return this.#state.oauth.accessTokens.some((t) => t.token === token && !t.revoked && now < t.expiresAtMs);
  }

  #requireEmailScope(): void {
    if (!this.#state.portal.grantedScopes.includes(EMAIL_READ_SCOPE)) {
      throw permanent('hubspot_missing_scopes', API_WIRE.missingScopes);
    }
  }

  #takeFault(operation: FakeHubSpotApiOperation): AppError | undefined {
    const faults = this.#state.faults;
    const index = faults.findIndex((f) => f.operation === operation || f.operation === '*');
    const fault = faults[index];
    if (fault === undefined) return undefined;
    fault.remaining -= 1;
    if (fault.remaining <= 0) faults.splice(index, 1);
    return injectedFailureError(fault);
  }

  #refreshFailure(refreshToken: string): AppError | undefined {
    const oauth = this.#state.oauth;
    const mode = oauth.refreshMode;
    switch (mode.kind) {
      case 'config':
        return this.#refreshError('config', REFRESH_WIRE.invalidClient);
      case 'revoked':
        return this.#refreshError('revoked', mode.variant === 'bad_hub' ? REFRESH_WIRE.badHub : REFRESH_WIRE.badRefreshToken);
      case 'transient': {
        this.#consumeRefreshMode(mode);
        const response =
          mode.failure === 'timeout' ? NO_RESPONSE : mode.failure === 429 ? API_WIRE.tenSecondly : gatewayWire(mode.failure);
        return this.#refreshError('transient', response);
      }
      case 'migration':
        this.#consumeRefreshMode(mode);
        return this.#refreshError('transient', migrationWire(mode.retryAfterSeconds));
      case 'ok':
        break;
    }
    const known = oauth.refreshTokens.find((t) => t.token === refreshToken);
    if (!oauth.installed || known === undefined || known.revoked) {
      return this.#refreshError('revoked', REFRESH_WIRE.badRefreshToken);
    }
    return undefined;
  }

  #refreshError(simulated: RefreshFailureClass, response: FakeWireResponse): AppError {
    const cls = response.status !== null && this.#classify !== undefined ? this.#classify(response.status, response.body) : simulated;
    return refreshError(cls, response);
  }

  #consumeRefreshMode(mode: Extract<RefreshModeState, { remaining: number }>): void {
    mode.remaining -= 1;
    if (mode.remaining <= 0) this.#state.oauth.refreshMode = { kind: 'ok' };
  }

  #newRefreshToken(): string {
    const token = `na1-fake-refresh-${pad(this.#state.counters.token++)}`;
    this.#state.oauth.refreshTokens.push({ token, revoked: false });
    return token;
  }

  #issueTokenSet(refreshToken: string): TokenSet {
    const oauth = this.#state.oauth;
    const now = this.#now();
    oauth.accessTokens = oauth.accessTokens.filter((t) => !t.revoked && t.expiresAtMs > now);
    const accessToken = `fake-hs-access-${pad(this.#state.counters.token++)}`;
    oauth.accessTokens.push({ token: accessToken, expiresAtMs: now + ACCESS_TOKEN_TTL_SECONDS * 1000, revoked: false });
    return {
      accessToken,
      refreshToken,
      expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
      hubId: this.#state.portal.portalId,
      scopes: [...this.#state.portal.grantedScopes],
    };
  }

  #newConversionId(): string {
    const n = this.#state.counters.conversion++;
    return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  }

  #newContact(properties: Record<string, string | null>, createdAtMs: number, visibleAtMs: number): ContactState {
    const contact: ContactState = {
      id: String(this.#state.counters.contact++),
      properties: { ...properties },
      createdAtMs,
      visibleAtMs,
      deletedAtMs: null,
      mergedIntoId: null,
    };
    this.#state.contacts.push(contact);
    return contact;
  }

  #addEmail(email: Omit<EmailState, 'id'>): string {
    const id = String(this.#state.counters.email++);
    this.#state.emails.push({ id, ...email });
    return id;
  }

  /** Follows merges from any id that ever existed; undefined for an unknown id. */
  #resolveContact(id: string): ContactState | undefined {
    let contact = this.#state.contacts.find((c) => c.id === id);
    for (let hops = 0; contact !== undefined && contact.mergedIntoId !== null && hops < 100; hops++) {
      const next = contact.mergedIntoId;
      contact = this.#state.contacts.find((c) => c.id === next);
    }
    return contact;
  }

  /** A contact that has not been deleted or merged away, for helpers; throws for anything else. */
  #liveContact(id: string): ContactState {
    const contact = this.#resolveContact(id);
    if (contact === undefined || contact.deletedAtMs !== null) throw new Error('fake_hubspot: no such live contact');
    return contact;
  }

  #liveContactByEmail(email: string, includeAdditional: boolean): ContactState | undefined {
    const wanted = lower(email);
    const live = this.#state.contacts.filter((c) => c.deletedAtMs === null && c.mergedIntoId === null);
    return (
      live.find((c) => c.properties.email?.toLowerCase() === wanted) ??
      (includeAdditional ? live.find((c) => splitEmails(c.properties.hs_additional_emails).includes(wanted)) : undefined)
    );
  }

  #readable(contact: ContactState): boolean {
    return contact.deletedAtMs === null && contact.visibleAtMs <= this.#now();
  }

  #visibleEmail(id: string): EmailState | undefined {
    const now = this.#now();
    return this.#state.emails.find((e) => e.id === id && e.visibleAtMs <= now);
  }

  #emailIdPage(contactId: string, offset: number): EmailIdPage {
    const now = this.#now();
    const ids = this.#state.emails
      .filter((e) => e.visibleAtMs <= now && e.contactIds.includes(contactId))
      .map((e) => e.id)
      .sort((a, b) => Number(a) - Number(b));
    const page = ids.slice(offset, offset + ASSOCIATIONS_PAGE_SIZE);
    const next = offset + ASSOCIATIONS_PAGE_SIZE;
    return next < ids.length ? { ids: page, nextAfter: encodeCursor(`o:${next}`) } : { ids: page };
  }
}
