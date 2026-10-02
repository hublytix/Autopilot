import 'server-only';
import { ConfigError, PermanentError, RevokedError, TransientError, type AppError } from '@/server/domain/errors';
import type { HubSpotErrorCode } from '@/server/ports/hubspot';
import { classifyRefreshFailure } from '@/server/hubspot/refresh-classifier';
import { apiErrorBodySchema, oauthErrorBodySchema } from './schemas';

// Maps a HubSpot HTTP failure to the typed errors the port documents (ports/hubspot.ts). Errors carry
// only a code, the HTTP status and a retry delay: never the body, which can quote tokens or content.

/** A response that arrived: its status, headers and body (parsed JSON, raw text, or null when empty). */
export interface HubSpotResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

/** `Retry-After` in seconds (HubSpot's unit, HS-HTTP-ERROR-CODES) as milliseconds; dates and junk are ignored. */
export function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')?.trim();
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) * 1000 : undefined;
}

/** 423, 429, 477 and every 5xx are retryable whatever the body says (D-11). */
export function isTransientStatus(status: number): boolean {
  return status === 423 || status === 429 || status === 477 || status >= 500;
}

function apiErrorBody(body: unknown): { category?: string | undefined; policyName?: string | undefined; message?: string | undefined } {
  const parsed = apiErrorBodySchema.safeParse(body);
  return parsed.success ? parsed.data : {};
}

/** A daily-limit 429 (`policyName: DAILY`), as opposed to the ten-secondly or search-secondly ones (HS-429-SHAPE). */
function isDailyLimit(body: unknown): boolean {
  const { policyName, message } = apiErrorBody(body);
  return policyName === 'DAILY' || (policyName === undefined && message !== undefined && /daily limit/i.test(message));
}

/** The TransientError for a 423, 429, 477 or 5xx. A daily-limit 429 has no delay: the caller defers to local midnight (D-11). */
export function transientError(response: HubSpotResponse): TransientError {
  const httpStatus = response.status;
  const retry = retryAfterMs(response.headers);
  let code: HubSpotErrorCode;
  if (httpStatus === 429) {
    if (isDailyLimit(response.body)) return new TransientError<HubSpotErrorCode>('hubspot_daily_limit', { httpStatus });
    code = 'hubspot_rate_limited';
  } else if (httpStatus === 477) code = 'hubspot_migration_in_progress';
  else if (httpStatus === 423) code = 'hubspot_locked';
  else code = 'hubspot_server_error';
  return new TransientError<HubSpotErrorCode>(code, { httpStatus, retryAfterMs: retry });
}

function permanentCode(response: HubSpotResponse): HubSpotErrorCode {
  switch (response.status) {
    case 401:
      return 'hubspot_unauthorized';
    case 403:
      return apiErrorBody(response.body).category === 'MISSING_SCOPES' ? 'hubspot_missing_scopes' : 'hubspot_forbidden';
    case 404:
      return 'hubspot_not_found';
    default:
      // A redirect (never followed) or another status the API should not send.
      return response.status >= 400 ? 'hubspot_bad_request' : 'hubspot_invalid_response';
  }
}

/** The error for a failed API (non-OAuth) call. */
export function apiError(response: HubSpotResponse): AppError {
  if (isTransientStatus(response.status)) return transientError(response);
  return new PermanentError<HubSpotErrorCode>(permanentCode(response), { httpStatus: response.status });
}

/** The TransientError for a token-endpoint failure the classifier called transient. */
function oauthTransient(response: HubSpotResponse): TransientError {
  return isTransientStatus(response.status)
    ? transientError(response)
    : new TransientError<HubSpotErrorCode>('hubspot_invalid_response', { httpStatus: response.status });
}

/** `refresh`: RevokedError, ConfigError or TransientError, as `classifyRefreshFailure` decides (D-11). */
export function refreshError(response: HubSpotResponse): AppError {
  const httpStatus = response.status;
  switch (classifyRefreshFailure(httpStatus, response.body)) {
    case 'revoked':
      return new RevokedError<HubSpotErrorCode>('hubspot_refresh_revoked', { httpStatus });
    case 'config':
      return new ConfigError<HubSpotErrorCode>('hubspot_oauth_config', { httpStatus });
    case 'transient':
      return oauthTransient(response);
  }
}

/**
 * `exchangeCode`: an expired, reused or unknown code (`BAD_AUTH_CODE`, `invalid_grant`) ends that
 * install attempt (PermanentError); client or redirect misconfiguration is a ConfigError
 * (HS-V2-AUTH-CODE-ERRORS); 423/429/477/5xx are transient.
 */
export function exchangeError(response: HubSpotResponse): AppError {
  const httpStatus = response.status;
  const parsed = oauthErrorBodySchema.safeParse(response.body);
  if (!isTransientStatus(httpStatus) && parsed.success && parsed.data.status === 'BAD_AUTH_CODE') {
    return new PermanentError<HubSpotErrorCode>('hubspot_bad_auth_code', { httpStatus });
  }
  switch (classifyRefreshFailure(httpStatus, response.body)) {
    case 'revoked':
      return new PermanentError<HubSpotErrorCode>('hubspot_bad_auth_code', { httpStatus });
    case 'config':
      return new ConfigError<HubSpotErrorCode>('hubspot_oauth_config', { httpStatus });
    case 'transient':
      return oauthTransient(response);
  }
}

/**
 * `introspect` and `revoke`: a token HubSpot calls invalid (`invalid_grant`, `BAD_REFRESH_TOKEN`,
 * `BAD_HUB`) returns null, so the caller can treat it as inactive (introspect) or already revoked
 * (revoke); otherwise a ConfigError or TransientError.
 */
export function tokenMetadataError(response: HubSpotResponse): AppError | null {
  switch (classifyRefreshFailure(response.status, response.body)) {
    case 'revoked':
      return null;
    case 'config':
      return new ConfigError<HubSpotErrorCode>('hubspot_oauth_config', { httpStatus: response.status });
    case 'transient':
      return oauthTransient(response);
  }
}
