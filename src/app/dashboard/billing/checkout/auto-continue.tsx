'use client';

import { useEffect } from 'react';

// Sends the browser on to Razorpay's hosted checkout once this page has loaded: a script navigation,
// not the redirect of a form POST, so CSP form-action 'self' does not apply (D-56). `replace` keeps
// this hop out of the history: Back from Razorpay's page returns to the billing page. The page's own
// link does the same without JavaScript.

export function AutoContinue({ href }: { href: string }) {
  useEffect(() => {
    window.location.replace(href);
  }, [href]);
  return null;
}
