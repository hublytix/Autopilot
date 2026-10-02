import { describe, expect, it } from 'vitest';
import { chooseComposeClient, isPhone } from '.';

// Representative user agents (CMP-GMAIL-MOBILE: phones get the mailto: interstitial; iPads count as
// desktops).
const UA = {
  iPhoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iPhoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
  iPod: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 15; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  // In-app browsers: the Gmail app (Chrome Custom Tabs on Android, a WebKit view on iOS) and the
  // Outlook app (an Android WebView, a WebKit view on iOS).
  gmailAppAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.157 Mobile Safari/537.36',
  gmailAppIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 GSA/379.0.785410560 Safari/604.1',
  outlookAppAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.157 Mobile Safari/537.36',
  outlookAppIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  windowsPhone:
    'Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Mobile Safari/537.36 Edge/15.15063',
  // Desktops and tablets.
  iPadOs:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  iPadLegacy:
    'Mozilla/5.0 (iPad; CPU OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
} as const;

describe('isPhone', () => {
  it.each([
    'iPhoneSafari',
    'iPhoneChrome',
    'iPod',
    'androidChrome',
    'androidFirefox',
    'androidSamsung',
    'gmailAppAndroid',
    'gmailAppIos',
    'outlookAppAndroid',
    'outlookAppIos',
    'windowsPhone',
  ] as const)('treats %s as a phone', (name) => {
    expect(isPhone({ userAgent: UA[name] })).toBe(true);
  });

  it.each(['iPadOs', 'iPadLegacy', 'androidTablet', 'macChrome', 'windowsEdge', 'linuxFirefox'] as const)(
    'treats %s as a desktop',
    (name) => {
      expect(isPhone({ userAgent: UA[name] })).toBe(false);
    },
  );

  it("believes Chromium's Sec-CH-UA-Mobile: ?1 hint", () => {
    expect(isPhone({ userAgent: UA.androidTablet, chUaMobile: '?1' })).toBe(true);
    expect(isPhone({ userAgent: UA.macChrome, chUaMobile: '?0' })).toBe(false);
  });

  it('treats a missing user agent as a desktop', () => {
    expect(isPhone({ userAgent: null })).toBe(false);
    expect(isPhone({ userAgent: '' })).toBe(false);
  });
});

describe('chooseComposeClient', () => {
  it("gives a desktop the owner's Gmail or Outlook web compose", () => {
    expect(chooseComposeClient({ mailClient: 'gmail', phone: false, viaMailto: false })).toBe('gmail');
    expect(chooseComposeClient({ mailClient: 'outlook_work', phone: false, viaMailto: false })).toBe('outlook_work');
    expect(chooseComposeClient({ mailClient: 'outlook_personal', phone: false, viaMailto: false })).toBe('outlook_personal');
  });

  it('gives a phone, the "Other" client and ?via=mailto the device mail app', () => {
    expect(chooseComposeClient({ mailClient: 'gmail', phone: true, viaMailto: false })).toBe('mailto');
    expect(chooseComposeClient({ mailClient: 'other', phone: false, viaMailto: false })).toBe('mailto');
    expect(chooseComposeClient({ mailClient: 'outlook_work', phone: false, viaMailto: true })).toBe('mailto');
  });
});
