import { getDevPanelContext } from '@/server/actions/dev';
import { handleDevAction, handleDevActionOtherMethod } from '@/server/http/dev';

// The /dev panel's form target (fake mode only; 404 otherwise; same-origin; PLAN §4, §7.6).
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleDevAction(req, await getDevPanelContext());
}

export async function GET(): Promise<Response> {
  return handleDevActionOtherMethod(await getDevPanelContext());
}
