import { getDeps } from '@/server/container';
import { handleSendLink } from '@/server/http/action-links';

// "Send from my email" (PLAN §7.4, D-13, D-26): 302 to the owner's web compose window, or a page
// that opens their mail app, or the copy page. HEAD is answered the same way but never counts as a
// click.
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ token: string }> };

export async function GET(req: Request, { params }: Context): Promise<Response> {
  const { token } = await params;
  return handleSendLink(req, await getDeps(), token);
}

export async function HEAD(req: Request, { params }: Context): Promise<Response> {
  const { token } = await params;
  return handleSendLink(req, await getDeps(), token);
}
