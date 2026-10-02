import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

// Owner action-link pages (PLAN §7.4, D-49): no sign-in (the token is the authorisation), never
// cached and never indexed (the proxy sends Cache-Control: private, no-store and X-Robots-Tag:
// noindex on /a/*; these pages also say noindex and a same-origin referrer policy themselves, D-62),
// and no browser Sentry (src/instrumentation-client.ts skips /a/*, whose URLs carry tokens and whose
// pages show lead content). Rendered per request, so Next puts the proxy's CSP nonce on its scripts.
// The /a/{token}/send and /beacon route handlers answer for themselves and do not use this layout.

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  referrer: 'same-origin',
};

export default async function ActionLinkLayout({ children }: { children: ReactNode }) {
  await connection();
  return children;
}
