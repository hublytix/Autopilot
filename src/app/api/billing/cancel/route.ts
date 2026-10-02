import { getDeps } from '@/server/container';
import { handleBillingControl, handleBillingControlOtherMethod } from '@/server/http/billing';

// Cancel the subscription (PLAN §7.3, D-20): owner + same-origin; authenticated now, active at cycle end.
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleBillingControl(req, await getDeps(), 'cancel');
}

export async function GET(): Promise<Response> {
  return handleBillingControlOtherMethod(await getDeps());
}
