import { getDeps } from '@/server/container';
import { handleBillingControl, handleBillingControlOtherMethod } from '@/server/http/billing';

// Start (or continue) a checkout (PLAN §7.3, §9.9): owner + same-origin; lands on /dashboard/billing/checkout.
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleBillingControl(req, await getDeps(), 'checkout');
}

export async function GET(): Promise<Response> {
  return handleBillingControlOtherMethod(await getDeps());
}
