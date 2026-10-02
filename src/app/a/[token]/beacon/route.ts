import { getDeps } from '@/server/container';
import { handleBeacon } from '@/server/http/action-links';

// The page beacon (D-26): the interstitial's, copy page's and edit page's script posts its nonce
// here, which counts as the owner opening the link. Same-origin POST only.
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  return handleBeacon(req, await getDeps(), token);
}
