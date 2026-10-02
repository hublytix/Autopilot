import 'server-only';
import { timingSafeEqualString } from './keys';
import { verifyQstashRequest } from './qstash';

// Periodic routes (`/api/cron/*`, PLAN §7.3, §8.1, D-16) accept either trigger:
// - Vercel Cron: GET with `Authorization: Bearer ${CRON_SECRET}`, compared in constant time
//   (VC-CRON-SECRET-UA); the `vercel-cron/1.0` user agent is never trusted;
// - a QStash schedule: POST with a valid QStash signature for the route's own URL.
// Anything else is refused (401). An unset or empty secret refuses every GET.

export interface CronAuthConfig {
  cronSecret: string;
  currentSigningKey: string;
  nextSigningKey: string;
  /** The route's own configured URL, e.g. `${APP_URL}/api/cron/poll` (the QStash `sub`). */
  url: string;
}

const BEARER = /^Bearer (.+)$/;

/** True when the request is a genuine cron trigger. Reads (a clone of) the body for POST only. */
export async function isAuthorizedCronRequest(req: Request, config: CronAuthConfig): Promise<boolean> {
  if (req.method === 'GET') {
    if (config.cronSecret.length === 0) return false;
    const match = BEARER.exec(req.headers.get('authorization') ?? '');
    const presented = match?.[1];
    if (presented === undefined) return false;
    return timingSafeEqualString(presented, config.cronSecret);
  }
  if (req.method === 'POST') {
    const rawBody = await req.clone().text();
    const verified = await verifyQstashRequest(req, rawBody, {
      currentSigningKey: config.currentSigningKey,
      nextSigningKey: config.nextSigningKey,
      url: config.url,
    });
    return verified.ok;
  }
  return false;
}
