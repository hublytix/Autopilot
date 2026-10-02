import 'server-only';
import { getEnv, type AppMode } from '@/server/env';

export type HealthMode = AppMode | 'unknown';

export interface HealthBody {
  ok: true;
  mode: HealthMode;
}

// Liveness only: the process answers. An invalid environment reports mode "unknown" here (the
// problems themselves are named by the EnvError wherever the app reads its env, never here).
function currentMode(): HealthMode {
  try {
    return getEnv().APP_MODE;
  } catch {
    return 'unknown';
  }
}

export function handleHealth(_req: Request): Response {
  const body: HealthBody = { ok: true, mode: currentMode() };
  return Response.json(body, { headers: { 'cache-control': 'no-store' } });
}
