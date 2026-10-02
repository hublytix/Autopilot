import 'server-only';
import * as SentryModule from '@sentry/nextjs';
import type { LiteralCode } from '@/server/domain/errors';
import { log, type LogFields } from '@/server/obs/log';

// Admin alerts (PLAN §8.3 step 6, §8.4 step 4, §11): one error log line plus one Sentry message per
// call. The Sentry message is the alert code itself (a snake_case literal the scrubber keeps); ids
// and codes go to the log line only. Never content, addresses or tokens (law 4).

export interface RaisedAlert {
  readonly code: string;
  readonly fields: LogFields;
}

export type AlertListener = (alert: RaisedAlert) => void;

const listeners = new Set<AlertListener>();

type CaptureMessage = typeof SentryModule.captureMessage;

// Under Next the namespace has captureMessage; under tsx/Node the CJS build exposes it on `default`.
function captureMessage(): CaptureMessage | undefined {
  const ns = SentryModule as unknown as { captureMessage?: CaptureMessage; default?: { captureMessage?: CaptureMessage } };
  return ns.captureMessage ?? ns.default?.captureMessage;
}

/**
 * Raises one alert. Never throws. `code` on the log line is always the alert code; an underlying
 * error code goes in `errorCode` (a caller's own `code` field is kept there rather than lost).
 */
export function raiseAlert<C extends string>(code: LiteralCode<C>, fields: LogFields = {}): void {
  const { code: callerCode, ...rest } = fields;
  const errorCode = rest.errorCode ?? (typeof callerCode === 'string' ? callerCode : undefined);
  log.error('alert raised', { ...rest, errorCode, event: 'alert', code });
  try {
    captureMessage()?.(code, { level: 'error', fingerprint: ['alert', code], tags: { alert: code } });
  } catch {
    // Monitoring must never break the caller.
  }
  for (const listener of [...listeners]) {
    try {
      listener({ code, fields });
    } catch {
      // A listener is an observer only.
    }
  }
}

/** Observes alerts (tests, and later the admin error counts). Returns the unsubscribe. */
export function onAlert(listener: AlertListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
