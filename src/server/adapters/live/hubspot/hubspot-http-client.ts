import 'server-only';
import type { z } from 'zod';
import { AppError, ConfigError, PermanentError, TransientError } from '@/server/domain/errors';
import {
  OFFERED_FORM_TYPES,
  isEmailDirection,
  isEmailMetadataProperty,
  isHubSpotContactProperty,
  isOfferedFormType,
  type EmailMetadataProperty,
  type HubSpotContactProperty,
} from '@/server/domain/types';
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
  HubSpotErrorCode,
  HubSpotForm,
  ListContactEmailIdsOptions,
  ListSubmissionsOptions,
  SubmissionPage,
  TokenIntrospection,
  TokenSet,
  TokenTypeHint,
} from '@/server/ports/hubspot';
import { DEFAULT_HUBSPOT_API_VERSION, HUBSPOT_API_ORIGIN, HUBSPOT_AUTHORIZE_URL, hubSpotPaths, type HubSpotPaths } from '@/server/hubspot/paths';
import { REQUIRED_SCOPES } from '@/server/hubspot/scopes';
import { assertHubSpotRequestAllowed } from '@/server/security/hubspot-allow-list';
import { apiError, exchangeError, refreshError, tokenMetadataError, type HubSpotResponse } from './errors';
import {
  accountDetailsSchema,
  associationsPageSchema,
  contactSchema,
  emailsBatchReadSchema,
  formsPageSchema,
  introspectionSchema,
  searchTotalSchema,
  submissionsPageSchema,
  tokenResponseSchema,
} from './schemas';

// The live HubSpotClient (D-40): plain fetch + Zod over the dated endpoints (D-04), no SDK
// (HS-SDK-CHOICE). Every request:
// 1. passes the read-only allow-list (D-03) before anything else, so a disallowed request never
//    reaches the network;
// 2. runs under the caller's AbortSignal and the client's own per-call timeout (either ends it with
//    TransientError('hubspot_timeout'));
// 3. is answered by a typed error (ports/hubspot.ts, D-11) or a Zod-validated body.
// Contact and email reads request only the allow-listed properties (law 4, D-03): the types forbid
// anything else, and a runtime check refuses it before the network for untyped callers.
// Nothing here logs. Tokens, the client secret, emails and bodies never leave this module except as
// the request itself; errors carry only a code, the HTTP status and a retry delay.
//
// Not here: the per-portal limiter (D-36) and refresh scheduling, which need the portal and the
// token row; services wrap this client per portal.

/** Object batch endpoints take at most 100 inputs (HS-EMAIL-BY-CONTACT). */
const EMAIL_BATCH_SIZE = 100;
const FORMS_PAGE_LIMIT = 100;
/** The submissions endpoint's maximum `limit` (HS-INTAKE-SUBMISSIONS-API). */
const MAX_SUBMISSIONS_LIMIT = 50;
/** A runaway cursor guard for the forms list (100 per page: 5 000 forms). */
const MAX_FORMS_PAGES = 50;
export const DEFAULT_HUBSPOT_TIMEOUT_MS = 10_000;

const INBOUND_DIRECTIONS = ['INCOMING_EMAIL', 'FORWARDED_EMAIL'] as const;

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export interface HubSpotHttpClientOptions {
  clientId: string;
  /** Sent only in form bodies of the token endpoints, never in a URL. */
  clientSecret: string;
  /** HUBSPOT_API_VERSION; default `2026-09`. */
  apiVersion?: string | undefined;
  /** Each call's own timeout, on top of the caller's signal. Default 10 s. */
  timeoutMs?: number | undefined;
  /** Injected in tests; default the global fetch. */
  fetch?: FetchLike | undefined;
}

type Method = 'GET' | 'POST' | 'DELETE';

interface RequestSpec {
  method: Method;
  /** Path plus, for GET only, a query string. */
  path: string;
  accessToken?: string | undefined;
  json?: unknown;
  form?: readonly (readonly [string, string])[] | undefined;
  signal?: AbortSignal | undefined;
}

function encodeQuery(params: readonly (readonly [string, string])[]): string {
  return params.length === 0 ? '' : `?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
}

function encodeForm(fields: readonly (readonly [string, string])[]): string {
  // application/x-www-form-urlencoded; %20 for spaces is valid there too.
  return encodeQuery(fields).slice(1);
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function invalidResponse(httpStatus: number): PermanentError {
  return new PermanentError<HubSpotErrorCode>('hubspot_invalid_response', { httpStatus });
}

function notAllowed(): ConfigError {
  return new ConfigError<HubSpotErrorCode>('hubspot_request_not_allowed');
}

function timeout(): TransientError {
  return new TransientError<HubSpotErrorCode>('hubspot_timeout');
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** `hs_timestamp`: an ISO-8601 string or an epoch-ms digit string. */
function parseInstant(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const trimmed = value.trim();
  const ms = /^\d{1,15}$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function lowerEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** `hs_email_to_email` lists several recipients separated by `;` (`,` accepted too). */
function splitEmails(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/[;,]/)
    .map(lowerEmail)
    .filter((s) => s.length > 0);
}

function nextAfter(paging: { next?: { after: string } | undefined } | null | undefined): string | undefined {
  return paging?.next?.after;
}

export class HubSpotHttpClient implements HubSpotClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #paths: HubSpotPaths;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: HubSpotHttpClientOptions) {
    if (options.clientId.length === 0 || options.clientSecret.length === 0) throw new ConfigError('hubspot_client_not_configured');
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#paths = hubSpotPaths(options.apiVersion ?? DEFAULT_HUBSPOT_API_VERSION);
    const timeoutMs = options.timeoutMs ?? DEFAULT_HUBSPOT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new ConfigError('hubspot_timeout_invalid');
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  // -------------------------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------------------------

  authorizeUrl(input: AuthorizeUrlInput): string {
    // Law 2: the consent screen may ask for exactly the app's read-only scopes, nothing else.
    const required: ReadonlySet<string> = new Set(REQUIRED_SCOPES);
    const asked = new Set(input.scopes);
    if (asked.size !== required.size || ![...asked].every((scope) => required.has(scope))) throw notAllowed();
    // encodeURIComponent, as HubSpot's SDK and CLI do: spaces become %20, not + (HS-OAUTH-AUTHORIZE-URL).
    return `${HUBSPOT_AUTHORIZE_URL}${encodeQuery([
      ['client_id', this.#clientId],
      ['redirect_uri', input.redirectUri],
      ['scope', input.scopes.join(' ')],
      ['state', input.state],
    ])}`;
  }

  async exchangeCode(code: string, redirectUri: string, options?: HubSpotCallOptions): Promise<TokenSet> {
    const response = await this.#send({
      method: 'POST',
      path: this.#paths.oauthToken,
      form: [
        ['grant_type', 'authorization_code'],
        ['client_id', this.#clientId],
        ['client_secret', this.#clientSecret],
        ['redirect_uri', redirectUri],
        ['code', code],
      ],
      signal: options?.signal,
    });
    if (!isSuccess(response.status)) throw exchangeError(response);
    const parsed = tokenResponseSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.refresh_token === undefined) throw invalidResponse(response.status);
    return this.#tokenSet(parsed.data, parsed.data.refresh_token);
  }

  async refresh(refreshToken: string, options?: HubSpotCallOptions): Promise<TokenSet> {
    const response = await this.#send({
      method: 'POST',
      path: this.#paths.oauthToken,
      form: [
        ['grant_type', 'refresh_token'],
        ['client_id', this.#clientId],
        ['client_secret', this.#clientSecret],
        ['refresh_token', refreshToken],
      ],
      signal: options?.signal,
    });
    if (!isSuccess(response.status)) throw refreshError(response);
    const parsed = tokenResponseSchema.safeParse(response.body);
    // An unreadable 2xx proves neither a revocation nor a config error: retry later (D-11).
    if (!parsed.success) throw new TransientError<HubSpotErrorCode>('hubspot_invalid_response', { httpStatus: response.status });
    // HubSpot may or may not rotate the refresh token: keep the newest one (HS-OAUTH-TOKEN-RESPONSE).
    return this.#tokenSet(parsed.data, parsed.data.refresh_token ?? refreshToken);
  }

  async introspect(token: string, hint: TokenTypeHint, options?: HubSpotCallOptions): Promise<TokenIntrospection> {
    const response = await this.#send({
      method: 'POST',
      path: this.#paths.oauthIntrospect,
      form: [
        ['client_id', this.#clientId],
        ['client_secret', this.#clientSecret],
        ['token', token],
        ['token_type_hint', hint],
      ],
      signal: options?.signal,
    });
    if (!isSuccess(response.status)) {
      const error = tokenMetadataError(response);
      if (error === null) return { active: false };
      throw error;
    }
    const parsed = introspectionSchema.safeParse(response.body);
    if (!parsed.success) throw invalidResponse(response.status);
    const info = parsed.data;
    if (!info.active) return { active: false };
    if (info.hub_id === undefined || info.app_id === undefined) throw invalidResponse(response.status);
    const user = info.user?.trim() ?? '';
    const domain = info.hub_domain?.trim() ?? '';
    return {
      active: true,
      hubId: info.hub_id,
      hubDomain: domain.length > 0 ? domain : null,
      userEmail: user.includes('@') ? lowerEmail(user) : null,
      scopes: info.scopes ?? [],
      appId: info.app_id,
      tokenType: info.token_use === 'access_token' || info.token_use === 'refresh_token' ? info.token_use : hint,
    };
  }

  async revoke(refreshToken: string, options?: HubSpotCallOptions): Promise<void> {
    const response = await this.#send({
      method: 'POST',
      path: this.#paths.oauthRevoke,
      form: [
        ['client_id', this.#clientId],
        ['client_secret', this.#clientSecret],
        ['token', refreshToken],
        ['token_type_hint', 'refresh_token'],
      ],
      signal: options?.signal,
    });
    if (isSuccess(response.status)) return;
    // A token HubSpot already calls invalid needs no revoking.
    const error = tokenMetadataError(response);
    if (error !== null) throw error;
  }

  // -------------------------------------------------------------------------------------------
  // API calls
  // -------------------------------------------------------------------------------------------

  async accountDetails(accessToken: string, options?: HubSpotCallOptions): Promise<AccountDetails> {
    const details = await this.#json(
      { method: 'GET', path: this.#paths.accountDetails, accessToken, signal: options?.signal },
      accountDetailsSchema,
    );
    return {
      portalId: details.portalId,
      timeZone: details.timeZone,
      utcOffsetMilliseconds: details.utcOffsetMilliseconds,
      uiDomain: details.uiDomain,
      dataHostingLocation: details.dataHostingLocation,
      accountType: details.accountType,
    };
  }

  async listForms(accessToken: string, options?: HubSpotCallOptions): Promise<HubSpotForm[]> {
    const forms: HubSpotForm[] = [];
    const seenCursors = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < MAX_FORMS_PAGES; page++) {
      // Repeated formTypes keys; `captured` stays out in v1 (D-07). Defaults are never relied on.
      const params: (readonly [string, string])[] = [
        ...OFFERED_FORM_TYPES.map((type) => ['formTypes', type] as const),
        ['archived', 'false'],
        ['limit', String(FORMS_PAGE_LIMIT)],
      ];
      if (after !== undefined) params.push(['after', after]);
      const body = await this.#json(
        { method: 'GET', path: `${this.#paths.formsList}${encodeQuery(params)}`, accessToken, signal: options?.signal },
        formsPageSchema,
      );
      for (const form of body.results) {
        if (form.archived === true || !isOfferedFormType(form.formType)) continue;
        const fields = (form.fieldGroups ?? []).flatMap((group) => group.fields ?? []);
        const consent = form.legalConsentOptions;
        forms.push({
          id: form.id,
          name: form.name,
          formType: form.formType,
          archived: false,
          fieldNames: fields.map((field) => field.name),
          fields: fields.map((field) => ({
            name: field.name,
            fieldType: field.fieldType,
            hidden: field.hidden ?? false,
            objectTypeId: field.objectTypeId,
          })),
          lifecycleStages: (form.configuration?.lifecycleStages ?? []).map((stage) => stage.value),
          hasSubscriptionConsent:
            (consent?.communicationsCheckboxes?.length ?? 0) > 0 || (consent?.subscriptionTypeIds?.length ?? 0) > 0,
          submitButtonText: form.displayOptions?.submitButtonText,
        });
      }
      after = nextAfter(body.paging);
      if (after === undefined) return forms;
      if (seenCursors.has(after)) throw invalidResponse(200);
      seenCursors.add(after);
    }
    throw invalidResponse(200);
  }

  async listSubmissions(accessToken: string, formId: string, options: ListSubmissionsOptions): Promise<SubmissionPage> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_SUBMISSIONS_LIMIT) {
      throw new PermanentError<HubSpotErrorCode>('hubspot_bad_request');
    }
    const params: (readonly [string, string])[] = [['limit', String(options.limit)]];
    if (options.after !== undefined) params.push(['after', options.after]);
    const body = await this.#json(
      { method: 'GET', path: `${this.#paths.formSubmissions(formId)}${encodeQuery(params)}`, accessToken, signal: options.signal },
      submissionsPageSchema,
    );
    const results: FormSubmission[] = body.results.map((s) => ({
      conversionId: s.conversionId ?? undefined,
      submittedAt: new Date(s.submittedAt),
      values: (s.values ?? []).map((v) => ({ name: v.name, value: v.value, objectTypeId: v.objectTypeId ?? undefined })),
      pageUrl: s.pageUrl ?? undefined,
    }));
    const cursor = nextAfter(body.paging);
    return cursor === undefined ? { results } : { results, nextAfter: cursor };
  }

  async getContact(accessToken: string, idOrEmail: string, options: GetContactOptions): Promise<HubSpotContact | null> {
    // Law 4 / D-03 at runtime too: only allow-listed contact properties, only email associations.
    const properties: readonly string[] = options.properties;
    if (!properties.every((p) => isHubSpotContactProperty(p))) throw notAllowed();
    const associations: readonly string[] = options.associations ?? [];
    if (!associations.every((a) => a === 'emails')) throw notAllowed();

    const params: (readonly [string, string])[] = properties.length > 0 ? [['properties', properties.join(',')]] : [];
    if (options.idProperty === 'email') params.push(['idProperty', 'email']);
    if (associations.length > 0) params.push(['associations', 'emails']);
    const response = await this.#send({
      method: 'GET',
      path: `${this.#paths.contact(idOrEmail)}${encodeQuery(params)}`,
      accessToken,
      signal: options.signal,
    });
    if (response.status === 404) return null;
    const contact = this.#parse(response, contactSchema);

    const values: Partial<Record<HubSpotContactProperty, string | null>> = {};
    for (const name of options.properties) values[name] = contact.properties?.[name] ?? null;
    const result: HubSpotContact = { id: contact.id, properties: values };
    if (associations.length > 0) {
      const emails = contact.associations?.emails;
      result.associatedEmailIds = [...new Set((emails?.results ?? []).map((r) => r.id))];
      const cursor = nextAfter(emails?.paging);
      if (cursor !== undefined) result.associationsNextAfter = cursor;
    }
    return result;
  }

  async listContactEmailIds(accessToken: string, contactId: string, options: ListContactEmailIdsOptions): Promise<EmailIdPage> {
    const params: (readonly [string, string])[] = options.after === undefined ? [] : [['after', options.after]];
    const body = await this.#json(
      {
        method: 'GET',
        path: `${this.#paths.contactEmailAssociations(contactId)}${encodeQuery(params)}`,
        accessToken,
        signal: options.signal,
      },
      associationsPageSchema,
    );
    const ids = [...new Set(body.results)];
    const cursor = nextAfter(body.paging);
    return cursor === undefined ? { ids } : { ids, nextAfter: cursor };
  }

  async batchReadEmails(
    accessToken: string,
    ids: readonly string[],
    properties: readonly EmailMetadataProperty[],
    options?: HubSpotCallOptions,
  ): Promise<EmailEngagement[]> {
    // Law 4 / D-03: metadata only, whatever an untyped caller passes.
    const requested: readonly string[] = properties;
    if (!requested.every((p) => isEmailMetadataProperty(p))) throw notAllowed();
    const want = new Set<string>(requested);
    // Engagements without `hs_timestamp` are dropped, so none could survive without it.
    if (!want.has('hs_timestamp') || ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const engagements: EmailEngagement[] = [];
    for (let start = 0; start < unique.length; start += EMAIL_BATCH_SIZE) {
      const chunk = unique.slice(start, start + EMAIL_BATCH_SIZE);
      const body = await this.#json(
        {
          method: 'POST',
          path: this.#paths.emailsBatchRead,
          accessToken,
          json: { inputs: chunk.map((id) => ({ id })), properties: [...requested], propertiesWithHistory: [] },
          signal: options?.signal,
        },
        emailsBatchReadSchema,
      );
      for (const email of body.results) {
        const props = email.properties ?? {};
        const timestamp = parseInstant(props.hs_timestamp);
        if (timestamp === null) continue;
        const direction = props.hs_email_direction;
        const engagement: EmailEngagement = {
          id: email.id,
          timestamp,
          direction: want.has('hs_email_direction') && isEmailDirection(direction) ? direction : null,
          toEmails: want.has('hs_email_to_email') ? splitEmails(props.hs_email_to_email) : [],
        };
        const status = props.hs_email_status?.trim();
        if (want.has('hs_email_status') && status !== undefined && status.length > 0) engagement.status = status;
        const from = props.hs_email_from_email;
        if (want.has('hs_email_from_email') && from !== null && from !== undefined && from.trim().length > 0) {
          engagement.fromEmail = lowerEmail(from);
        }
        engagements.push(engagement);
      }
    }
    return engagements;
  }

  async searchEmailsCount(accessToken: string, query: EmailCountQuery, options?: HubSpotCallOptions): Promise<number> {
    const sinceMs = query.since.getTime();
    if (!Number.isFinite(sinceMs)) throw new PermanentError<HubSpotErrorCode>('hubspot_bad_request');
    const directionFilter =
      query.direction === 'outbound'
        ? { propertyName: 'hs_email_direction', operator: 'EQ', value: 'EMAIL' }
        : { propertyName: 'hs_email_direction', operator: 'IN', values: [...INBOUND_DIRECTIONS] };
    // No free-text `query` (it searches subjects) and metadata properties only (D-03, HS-EMAIL-DATA-MINIMISATION).
    const body = await this.#json(
      {
        method: 'POST',
        path: this.#paths.emailsSearch,
        accessToken,
        json: {
          filterGroups: [{ filters: [{ propertyName: 'hs_timestamp', operator: 'GTE', value: String(sinceMs) }, directionFilter] }],
          properties: ['hs_timestamp', 'hs_email_direction'] satisfies EmailMetadataProperty[],
          sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
          limit: 1,
          after: '0',
        },
        signal: options?.signal,
      },
      searchTotalSchema,
    );
    return body.total;
  }

  async uninstallApp(accessToken: string, options?: HubSpotCallOptions): Promise<void> {
    const response = await this.#send({ method: 'DELETE', path: this.#paths.uninstall, accessToken, signal: options?.signal });
    if (!isSuccess(response.status)) throw apiError(response);
  }

  // -------------------------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------------------------

  #tokenSet(data: z.infer<typeof tokenResponseSchema>, refreshToken: string): TokenSet {
    return {
      accessToken: data.access_token,
      refreshToken,
      expiresInSeconds: data.expires_in,
      hubId: data.hub_id,
      scopes: data.scopes,
    };
  }

  /** Sends an API call and returns its validated 2xx body; any other status becomes the port's typed error. */
  async #json<S extends z.ZodType>(spec: RequestSpec, schema: S): Promise<z.infer<S>> {
    return this.#parse(await this.#send(spec), schema);
  }

  #parse<S extends z.ZodType>(response: HubSpotResponse, schema: S): z.infer<S> {
    if (!isSuccess(response.status)) throw apiError(response);
    const parsed = schema.safeParse(response.body);
    if (!parsed.success) throw invalidResponse(response.status);
    return parsed.data;
  }

  /** One HTTP exchange. Allow-list first; then the network, bounded by the caller's signal and the timeout. */
  async #send(spec: RequestSpec): Promise<HubSpotResponse> {
    assertHubSpotRequestAllowed(spec.method, spec.path);
    const url = new URL(spec.path, HUBSPOT_API_ORIGIN);
    if (url.origin !== HUBSPOT_API_ORIGIN) throw notAllowed();
    if (spec.signal?.aborted === true) throw timeout();

    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;
    if (spec.accessToken !== undefined) headers.Authorization = `Bearer ${spec.accessToken}`;
    if (spec.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(spec.form);
    } else if (spec.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.json);
    }

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    const signal = spec.signal === undefined ? deadline.signal : AbortSignal.any([spec.signal, deadline.signal]);
    try {
      const response = await this.#fetch(url, {
        method: spec.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal,
        // A redirect is answered as an error, never followed with the bearer token.
        redirect: 'manual',
        cache: 'no-store',
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: parseBody(text) };
    } catch (error) {
      if (error instanceof AppError) throw error;
      // The underlying error can quote the URL or body: only a code leaves this module.
      throw signal.aborted ? timeout() : new TransientError<HubSpotErrorCode>('hubspot_network');
    } finally {
      clearTimeout(timer);
    }
  }
}
