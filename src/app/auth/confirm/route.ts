import { getDeps } from '@/server/container';
import { handleConfirmGet, handleConfirmPost } from '@/server/http/auth/confirm';

// Magic-link confirmation (PLAN §7.2, D-22): GET shows the "Sign in" button (the token stays in the
// URL fragment); POST verifies it, binds an onboarding owner and starts the session.
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleConfirmGet(req, await getDeps());
}

export async function POST(req: Request): Promise<Response> {
  return handleConfirmPost(req, await getDeps());
}
