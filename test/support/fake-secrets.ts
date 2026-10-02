// Fake, secret-shaped test values. They are assembled at runtime so the
// source never contains a literal that secret scanners treat as a leaked
// credential. None of them is, or ever was, a real secret.
const join = (...parts: string[]): string => parts.join('');

export const FAKE_HUBSPOT_REFRESH_TOKEN = join('na1', '-6f18f21e', '-a743-4509-b7fd-1a5e632fffa1');
export const FAKE_HUBSPOT_PRIVATE_APP_TOKEN = join('pat', '-na1', '-0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0');
export const FAKE_SUPABASE_SECRET = join('sb_', 'secret_', 'Fx7Kq2Lm9Np4Rs8Tv');
export const FAKE_ANTHROPIC_KEY = join('sk-', 'ant-', 'api03-', 'Fx7Kq2Lm9Np4Rs8TvWx1');
export const FAKE_RAZORPAY_KEY = join('rzp_', 'live_', 'Fx7Kq2Lm9Np4Rs');
export const FAKE_JWT = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: 'fixture-7f3a' })).toString('base64url'),
  Buffer.from('signature-fixture').toString('base64url'),
].join('.');
/** QStash's public local-development token (documented, not a secret). */
export const QSTASH_PUBLIC_DEV_TOKEN = Buffer.from(JSON.stringify({ UserID: 'defaultUser', Password: 'defaultPassword' })).toString('base64');
