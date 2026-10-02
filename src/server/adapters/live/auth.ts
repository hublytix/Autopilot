import 'server-only';
import { getEnv } from '@/server/env';
import type { RefreshedSession } from '@/server/ports/auth';
import { createSupabaseAuthProvider, type SupabaseAuthProvider } from './supabase-auth';
import { SystemClock } from './system-clock';

// The live session refresh for src/proxy.ts (PLAN §7.7): the @supabase/ssr refresh-and-getClaims
// pattern on the request's cookies, with refreshed cookies set on the given response. The proxy
// may import only this and the CSP builder, and never touches the database. The provider is built
// once per proxy instance from the environment (it holds no per-request state).

let provider: SupabaseAuthProvider | undefined;

function liveProvider(): SupabaseAuthProvider {
  if (provider === undefined) {
    const env = getEnv();
    provider = createSupabaseAuthProvider({
      supabaseUrl: env.SUPABASE_URL,
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
      secretKey: env.SUPABASE_SECRET_KEY,
      appUrl: env.APP_URL,
      clock: new SystemClock(),
    });
  }
  return provider;
}

export async function refreshLiveProxySession(request: Request, response: Response): Promise<RefreshedSession> {
  return liveProvider().refreshSession(request, response);
}
