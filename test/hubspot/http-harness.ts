import type { FetchLike } from '@/server/adapters/live/hubspot';

// A recording fetch for HubSpotHttpClient tests: no network, every request kept for assertions.

export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly redirect: RequestRedirect | undefined;
}

export type Responder = (request: RecordedRequest) => Response | Promise<Response>;

export interface RecordingFetch {
  readonly fetch: FetchLike;
  readonly requests: RecordedRequest[];
}

export function recordingFetch(responder: Responder): RecordingFetch {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request: RecordedRequest = {
      method: init.method ?? 'GET',
      url: new URL(input),
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
      signal: init.signal ?? undefined,
      redirect: init.redirect,
    };
    requests.push(request);
    return responder(request);
  };
  return { fetch, requests };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function textResponse(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/html', ...headers } });
}

export function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/** The fields of an `application/x-www-form-urlencoded` body. */
export function formFields(request: RecordedRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(request.body ?? ''));
}

export function jsonBody(request: RecordedRequest): unknown {
  return JSON.parse(request.body ?? 'null');
}

/** A fetch that never answers: it rejects only when its signal aborts, as fetch does. */
export function hangingResponder(): Responder {
  return (request) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = request.signal;
      if (signal === undefined) return;
      const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
}

/** Email properties that carry content and must never be requested (D-03, HS-EMAIL-DATA-MINIMISATION). */
export const CONTENT_EMAIL_PROPERTIES = [
  'hs_email_subject',
  'hs_email_text',
  'hs_email_html',
  'hs_email_headers',
  'hs_attachment_ids',
  'hs_body_preview',
  'hs_body_preview_html',
  'hs_body_preview_is_truncated',
] as const;
