import 'server-only';
import type { MailClient } from '@/server/domain/types';
import type { ComposeClient } from './build';

// Which compose target a send-link click gets (D-13, CMP-GMAIL-MOBILE, CMP-OUTLOOK-MOBILE-SESSION,
// CMP-BUILDER-SPEC "target selection"):
// - a phone gets the `mailto:` interstitial: Gmail's and Outlook's web compose links open the inbox
//   in a phone browser, while `mailto:` opens the default mail app (which can be the Gmail or
//   Outlook app);
// - so do the "Other" mail client and the email's "Open in default mail app" link (`?via=mailto`);
// - a desktop with Gmail or Outlook gets that web compose URL.
//
// Phones: iPhone/iPod, Android with "Mobile" (Android tablets omit it), Windows Phone and the older
// mobile browsers, or Chromium's `Sec-CH-UA-Mobile: ?1` hint. iPads count as desktops: iPadOS sends a
// desktop Safari user agent, and an older one says "iPad", which is not a phone. In-app browsers
// (the Gmail and Outlook apps' link viewers) carry the platform's phone user agent.

const PHONE_USER_AGENT = /\b(?:iPhone|iPod)\b|\bAndroid\b.*\bMobile\b|\bWindows Phone\b|\bIEMobile\b|\bBlackBerry\b|\bBB10\b|\bOpera Mini\b/i;

export interface DeviceHints {
  /** The User-Agent request header. */
  readonly userAgent: string | null;
  /** The Sec-CH-UA-Mobile request header (`?1` on a Chromium phone). */
  readonly chUaMobile?: string | null | undefined;
}

/** True for a phone browser or a phone app's in-app browser. */
export function isPhone(hints: DeviceHints): boolean {
  if (hints.chUaMobile?.trim() === '?1') return true;
  return PHONE_USER_AGENT.test(hints.userAgent ?? '');
}

/** The compose target for a click: the owner's client on a desktop, else the device's mail app. */
export function chooseComposeClient(input: { mailClient: MailClient; phone: boolean; viaMailto: boolean }): ComposeClient {
  if (input.viaMailto || input.phone || input.mailClient === 'other') return 'mailto';
  return input.mailClient;
}
