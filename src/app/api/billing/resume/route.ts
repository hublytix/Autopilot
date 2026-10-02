import { getDeps } from '@/server/container';
import { handleBillingControl, handleBillingControlOtherMethod } from '@/server/http/billing';

// Resume a paused subscription (PLAN §7.3, D-18): owner + same-origin.
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleBillingControl(req, await getDeps(), 'resume');
}

export async function GET(): Promise<Response> {
  return handleBillingControlOtherMethod(await getDeps());
}
