import { getDeps } from '@/server/container';
import { handleSignOut } from '@/server/http/auth/signout';

// Sign out (PLAN §7.2): same-origin POST only.
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleSignOut(req, await getDeps());
}
