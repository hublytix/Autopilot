import { getFakeCheckoutContext, handleFakeCheckoutDecision, handleFakeCheckoutDecisionOtherMethod } from '@/server/http/dev/fake-checkout';

// The fake Razorpay checkout's form target (fake mode only; 404 otherwise; PLAN §7.6).
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export async function POST(req: Request, { params }: { params: Params }): Promise<Response> {
  return handleFakeCheckoutDecision(req, (await params).id, await getFakeCheckoutContext());
}

export async function GET(): Promise<Response> {
  return handleFakeCheckoutDecisionOtherMethod(await getFakeCheckoutContext());
}
