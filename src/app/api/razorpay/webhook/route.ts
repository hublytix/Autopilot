import { getDeps } from '@/server/container';
import { handleRazorpayWebhook } from '@/server/http/razorpay-webhook';

// Razorpay webhook deliveries (PLAN §7.3, D-19): the signature on the raw body, the created_at
// window, dedupe, then the subscription is read from Razorpay and applied. Route handlers run on the
// Node runtime by default (node:crypto).
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleRazorpayWebhook(req, await getDeps());
}
