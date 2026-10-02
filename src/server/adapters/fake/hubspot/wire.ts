import 'server-only';
import { ConfigError, PermanentError, RevokedError, TransientError, type AppError } from '@/server/domain/errors';
import type { RefreshFailureClass } from '@/server/domain/types';
import type { HubSpotErrorCode } from '@/server/ports/hubspot';
import type { FaultState } from './state';

// What HubSpot would have put on the wire for each failure the fake simulates (bodies from
// docs/research/02 02.y, 03 and 05; texts marked "fake" are invented where HubSpot's are unknown).
// The fake throws the typed errors the port documents. Those errors carry only a code and status
// (law 4), so the HubSpot-shaped response travels beside the error: `wireResponseOf(error)` returns
// it, which lets M2's refresh classifier be tested against exactly what the fake simulated.

export interface FakeWireResponse {
  /** HTTP status; null when no response arrived (timeout, network error). */
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON body, a string for a non-JSON body, or null for none. */
  readonly body: unknown;
}

const CORRELATION_ID = '00000000-0000-4000-8000-00000000fa6e';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Shared and frozen: a test that inspects a response cannot change what later failures return. */
function wire(status: number | null, body: unknown, headers: Record<string, string> = {}): FakeWireResponse {
  return deepFreeze({ status, headers: { ...headers }, body });
}

/** HubSpot-shaped responses for the token endpoint, exported so classifier tests can use the same fixtures. */
export const REFRESH_WIRE = {
  /** HS-OAUTH-REFRESH-ERRORS `refresh_revoked`: revoked, uninstalled or unknown refresh token. */
  badRefreshToken: wire(400, {
    error: 'invalid_grant',
    error_description: 'refresh token is invalid, expired or revoked',
    status: 'BAD_REFRESH_TOKEN',
    message: 'refresh token is invalid, expired or revoked',
  }),
  /** `refresh_bad_hub` (verifier-corrected body): the portal was deleted. */
  badHub: wire(400, { status: 'BAD_HUB', message: 'missing or unknown hub id', error: 'access_denied' }),
  /** `refresh_bad_client` (message text is fake). */
  invalidClient: wire(400, { error: 'invalid_client', status: 'BAD_CLIENT_ID', message: 'missing or invalid client id' }),
  /** Authorization-code exchange with an expired, reused or unknown code (texts are fake). */
  badAuthCode: wire(400, {
    error: 'invalid_grant',
    error_description: 'missing or invalid auth code',
    status: 'BAD_AUTH_CODE',
    message: 'missing or invalid auth code',
  }),
  /** Exchange with a redirect URI that differs from the authorize request (texts are fake). */
  badRedirectUri: wire(400, {
    error: 'invalid_request',
    error_description: 'redirect_uri does not match',
    status: 'BAD_REDIRECT_URI',
    message: 'redirect_uri does not match',
  }),
} as const;

/** `rate_limited_ten_secondly` (02.y). */
const TEN_SECONDLY_BODY = {
  status: 'error',
  message: 'You have reached your ten_secondly_rolling limit.',
  errorType: 'RATE_LIMIT',
  correlationId: CORRELATION_ID,
  policyName: 'TEN_SECONDLY_ROLLING',
};

/** `rate_limited_daily` (02.y). */
const DAILY_BODY = {
  status: 'error',
  message: 'You have reached your daily limit.',
  errorType: 'RATE_LIMIT',
  correlationId: CORRELATION_ID,
  policyName: 'DAILY',
};

/** A gateway error page: a non-JSON body with a 5xx (HS-OAUTH-REFRESH-ERRORS transient case). */
function gatewayBody(status: number): string {
  return `<html><body><h1>${status}</h1>Service temporarily unavailable</body></html>`;
}

export const API_WIRE = {
  unauthorized: wire(401, {
    status: 'error',
    message: 'Authentication credentials not found.',
    correlationId: CORRELATION_ID,
    category: 'INVALID_AUTHENTICATION',
  }),
  /** The community-reported 403 for email reads without `sales-email-read` (HS-EMAIL-SCOPES). */
  missingScopes: wire(403, {
    status: 'error',
    message: "This app hasn't been granted all required scopes to make this call.",
    correlationId: CORRELATION_ID,
    errors: [
      {
        message: 'One or more of the following scopes are required.',
        context: { requiredGranularScopes: ['crm.objects.contacts.read', 'sales-email-read'] },
      },
    ],
    category: 'MISSING_SCOPES',
  }),
  /** HS-CONTACT-DELETED-MERGED: a deleted (archived) or unknown record. */
  notFound: wire(404, { status: 'error', message: 'resource not found', correlationId: CORRELATION_ID, category: 'OBJECT_NOT_FOUND' }),
  badRequest: wire(400, { status: 'error', message: 'Invalid input', correlationId: CORRELATION_ID, category: 'VALIDATION_ERROR' }),
  tenSecondly: wire(429, TEN_SECONDLY_BODY),
  daily: wire(429, DAILY_BODY),
  locked: wire(423, { status: 'error', message: 'Resource is locked', correlationId: CORRELATION_ID, category: 'LOCKED' }),
} as const;

/** A ten-secondly 429, optionally with `Retry-After` (undocumented for 429, honoured if present: HS-429-SHAPE). */
export function rateLimitedWire(retryAfterSeconds?: number): FakeWireResponse {
  return retryAfterSeconds === undefined ? API_WIRE.tenSecondly : wire(429, TEN_SECONDLY_BODY, { 'Retry-After': String(retryAfterSeconds) });
}

export function gatewayWire(status: number): FakeWireResponse {
  return wire(status, gatewayBody(status));
}

/** 477 Migration in Progress with `Retry-After` in seconds (HS-HTTP-ERROR-CODES); the body is unknown. */
export function migrationWire(retryAfterSeconds: number): FakeWireResponse {
  return wire(477, null, { 'Retry-After': String(retryAfterSeconds) });
}

export const NO_RESPONSE = wire(null, null);

const wireByError = new WeakMap<object, FakeWireResponse>();

/** The HubSpot-shaped response behind an error the fake threw; undefined for any other value. */
export function wireResponseOf(error: unknown): FakeWireResponse | undefined {
  return typeof error === 'object' && error !== null ? wireByError.get(error) : undefined;
}

function attach<E extends AppError>(error: E, response: FakeWireResponse): E {
  wireByError.set(error, response);
  return error;
}

function httpStatus(response: FakeWireResponse): { httpStatus?: number } {
  return response.status === null ? {} : { httpStatus: response.status };
}

function retryAfterMs(response: FakeWireResponse): number | undefined {
  const raw = response.headers['Retry-After'];
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) * 1000 : undefined;
}

/** The live client refuses a request outside the allow-list before any network call, so there is no response. */
export function notAllowed(): ConfigError {
  return new ConfigError<HubSpotErrorCode>('hubspot_request_not_allowed');
}

export function permanent(code: HubSpotErrorCode, response: FakeWireResponse): PermanentError {
  return attach(new PermanentError<HubSpotErrorCode>(code, httpStatus(response)), response);
}

export function config(code: HubSpotErrorCode, response: FakeWireResponse): ConfigError {
  return attach(new ConfigError<HubSpotErrorCode>(code, httpStatus(response)), response);
}

function isDailyLimit(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'policyName' in body && body.policyName === 'DAILY';
}

/** A transient error coded from the response, as the port lists: 423, 429 (daily or not), 477, 5xx. */
export function transient(response: FakeWireResponse, noResponseCode: HubSpotErrorCode = 'hubspot_timeout'): TransientError {
  const details = { ...httpStatus(response), retryAfterMs: retryAfterMs(response) };
  let code: HubSpotErrorCode;
  if (response.status === null) code = noResponseCode;
  else if (response.status === 477) code = 'hubspot_migration_in_progress';
  else if (response.status === 423) code = 'hubspot_locked';
  else if (response.status === 429) code = isDailyLimit(response.body) ? 'hubspot_daily_limit' : 'hubspot_rate_limited';
  else code = 'hubspot_server_error';
  return attach(new TransientError<HubSpotErrorCode>(code, details), response);
}

/** The typed error `refresh` throws for a failure of the given class (D-11). */
export function refreshError(cls: RefreshFailureClass, response: FakeWireResponse): AppError {
  switch (cls) {
    case 'revoked':
      return attach(new RevokedError<HubSpotErrorCode>('hubspot_refresh_revoked', httpStatus(response)), response);
    case 'config':
      return config('hubspot_oauth_config', response);
    case 'transient':
      return transient(response);
  }
}

/** The error an injected API failure produces, with its HubSpot-shaped response. */
export function injectedFailureError(fault: FaultState): AppError {
  switch (fault.kind) {
    case 'rate_limited':
      return transient(rateLimitedWire(fault.retryAfterSeconds ?? undefined));
    case 'daily_limit':
      return transient(API_WIRE.daily);
    case 'locked':
      return transient(API_WIRE.locked);
    case 'migration':
      return transient(migrationWire(fault.retryAfterSeconds ?? 3600));
    case 'server_error':
      return transient(gatewayWire(502));
    case 'timeout':
      return transient(NO_RESPONSE, 'hubspot_timeout');
    case 'network':
      return transient(NO_RESPONSE, 'hubspot_network');
    case 'unauthorized':
      return permanent('hubspot_unauthorized', API_WIRE.unauthorized);
    case 'missing_scopes':
      return permanent('hubspot_missing_scopes', API_WIRE.missingScopes);
  }
}
