import 'server-only';
import { EnvError, getEnv, type AppMode } from '@/server/env';
import { log } from '@/server/obs/log';

export type HealthMode = AppMode | 'unknown';

export interface HealthBody {
  ok: true;
  mode: HealthMode;
}

// Liveness only: the process answers. An invalid environment reports mode "unknown" in the body, and
// once per server instance the deployment's logs name the variables at fault (names only, never a
// value; EnvError's issues never hold one), so WIRE_UP 9.2 can be followed from a single curl.

let reported = false;

function reportInvalidEnvOnce(error: unknown): void {
  if (reported) return;
  reported = true;
  const names = error instanceof EnvError ? error.issues.map((issue) => issue.split(':')[0]?.trim() ?? '').filter((name) => name !== '') : [];
  log.error('health: invalid environment', { event: 'health.env_invalid', count: names.length, codes: names }, error);
}

function currentMode(): HealthMode {
  try {
    return getEnv().APP_MODE;
  } catch (error) {
    reportInvalidEnvOnce(error);
    return 'unknown';
  }
}

export function handleHealth(_req: Request): Response {
  const body: HealthBody = { ok: true, mode: currentMode() };
  return Response.json(body, { headers: { 'cache-control': 'no-store' } });
}
