## 06. Compose links: Gmail, Outlook, mailto

Of the three compose-link targets in brief §5.5, only `mailto:` has an official specification: RFC 6068 defines it, and Apple's and Android's official docs confirm that a `mailto:` link opens the device's default mail composer. Google and Microsoft document no web compose URL, so the Gmail and Outlook formats below rest on long-stable de-facto usage, browser source code (Chromium, Firefox), an unofficial 2021 mirror of the Outlook on the web (OWA) client code, community live tests and local experiments. Every vendor-specific behaviour must therefore be tested by hand on real accounts before launch. Official sources do settle the encoding rules (WHATWG URL and HTML, RFC 6068, Chromium's escape table), the Microsoft 365 host names (Microsoft's endpoint lists), browser URL-length ceilings and the Next.js 14 redirect default. The sandbox blocked support.google.com, developers.google.com, learn.microsoft.com, rfc-editor.org, stackoverflow.com and live probing of mail.google.com and the Outlook hosts, so Microsoft pages were read from their MicrosoftDocs GitHub sources, RFCs from byte-identical GitHub mirrors, and Microsoft Q&A threads only through search summaries.

**The sources correct the brief in five places:**
1. **Outlook parameters.** The brief's `…/mail/deeplink/compose?to=&cc=&bcc=&subject=&body=` is not reliable. Plain `cc=` and `bcc=` are reported dropped, though the evidence conflicts, and `%2B` in a plain `to=` has been reported to turn into a space, which breaks plus-addressed leads. The default should be `{base}?mailtouri={encodeURIComponent(mailto URI)}`. That is the exact URL a browser builds when Outlook on the web is the registered `mailto:` handler. Plain parameters stay available as a config fallback (CMP-OUTLOOK-PARAMS-BCC).
2. **Outlook work host.** Use `https://outlook.cloud.microsoft/mail/deeplink/compose`, not `outlook.office.com`. For personal accounts use `https://outlook.live.com/mail/deeplink/compose` (CMP-OUTLOOK-HOSTS).
3. **Phones.** The brief assumes one redirect target per owner. On phones, Gmail and Outlook web compose links usually land in the inbox instead of a composer, so phone User-Agents get the `mailto:` target (CMP-GMAIL-MOBILE, CMP-OUTLOOK-MOBILE-SESSION).
4. **Redirect status.** Next.js 14's `NextResponse.redirect` defaults to 307, so 302 must be passed explicitly (CMP-REDIRECT-IMPLEMENTATION).
5. **The `mailto:` path.** A bare 302 to `mailto:` is replaced by a small 200 interstitial page that links to the `mailto:` URI (CMP-REDIRECT-IMPLEMENTATION).

**The sources extend the brief with:**
- **The Gmail format.** It is `https://mail.google.com/mail/?view=cm&fs=1&to=&cc=&bcc=&su=&body=`, and the subject parameter is `su`. Gmail rewrites this URL to `/mail/u/0/?…&tf=cm`. Neither form is documented (CMP-GMAIL-WEB-URL).
- **Gmail account selection** through `/mail/u/{email}/`, set by a new optional onboarding field (CMP-GMAIL-MULTIACCOUNT).
- **One encoder for every client.** Use `encodeURIComponent`, also escape `!'()*`, and call `toWellFormed()` first. Never use `URLSearchParams`. Body line breaks are CRLF inside `mailto:` and LF for Gmail (CMP-ENCODING-PLUS-SPACE).
- **The ~1,800-character threshold holds.** It sits below every documented ceiling. Apply it per client to the final URL. The Outlook `mailtouri` URL is about 30% longer, so it reaches the limit at about 154 English words, and non-Latin text reaches it much sooner (CMP-URL-LENGTH-LIMITS).
- **BCC is guaranteed nowhere.**
  - On `mailto:`, RFC 6068 only guarantees `subject` and `body`.
  - On Outlook, `bcc` is unverified in both URL forms.
  - On Gmail, `bcc` is verified first-hand by the community only.
  - Show the BCC logging address on the interstitial and copy-reply pages as a manual fallback.
- **Lead input validation.** Validate the lead's address as one bare addr-spec, and never log compose URLs (CMP-RECIPIENT-SAFETY).
- **Sovereign-cloud owners** (GCC High, 21Vianet) are sent to `mailto:` (CMP-OUTLOOK-HOSTS).
- **A reference builder with golden vectors** (CMP-BUILDER-SPEC, 06.2).

### CMP-GMAIL-WEB-URL — Gmail web compose URL: `view=cm&fs=1` with `to`, `cc`, `bcc`, `su`, `body` (undocumented)
- **Brief:** §5.5 says [Send from my email] redirects to a Gmail web compose URL, "[VERIFY current URL formats]". The research prompt proposed `https://mail.google.com/mail/?view=cm&fs=1&to=&cc=&bcc=&su=&body=`.
- **Resolves:** [VERIFY] §5.5 current URL formats (Gmail web).
- **Verdict:** Not officially documented — medium confidence.
  - Google publishes no Help or Developers page for composing Gmail by URL. support.google.com and developers.google.com were unreachable, and searches surfaced only community pages.
  - The format rests on a 2024 first-hand community test, Chromium and Firefox source, and community projects.
  - The verifier upheld this.
- **Finding:**
  - **De-facto format** (still working per a 2024 first-hand test): `https://mail.google.com/mail/?view=cm&fs=1&to={to}&cc={cc}&bcc={bcc}&su={subject}&body={body}`.
  - **Parameter names:**
    - `to`, `cc` and `bcc`, each a comma-separated address list;
    - `su` for the subject (NOT `subject`);
    - `body` for the plain-text body.
  - **Canonical form.** Gmail normalises the URL by redirecting to `https://mail.google.com/mail/u/0/?to=…&cc=…&bcc=…&su=…&body=…&tf=cm`.
    - `tf=cm` opens the compose window.
    - `fs=0/1` now does nothing.
    - Either form works, and both are undocumented. Emit the `view=cm` form (the most widely deployed, and Gmail rewrites it) or the `tf=cm` form.
  - **Encoding.** Gmail decodes the query as `application/x-www-form-urlencoded`, so a raw `+` becomes a space.
    - Encode spaces as `%20` (or `+`).
    - A literal plus MUST be `%2B`.
    - Encode line breaks in `body` as `%0A`.
  - **`bcc` is honoured.** A first-hand screenshot shows "The To, CC, BCC, Subject and Body are filled out as requested in the URL". The verifier notes that this first-hand check was on the `/mail/u/0/?…&tf=cm` form; in the same test, the `view=cm&fs=1` link "redirected to almost the example I provided above".
  - **The `extsrc=mailto` template.** The only Google-authored artefact that names a Gmail compose entry point is Chromium's built-in ChromeOS default mailto handler template, `https://mail.google.com/mail/?extsrc=mailto&url=%s`. Firefox ships the same template as its built-in Gmail handler. It takes a whole RFC 6068 `mailto:` URI, percent-encoded, in `url=`.
    - Keep it as a fallback (it is documented in browser source).
    - Use the direct-parameter form as the primary, because `bcc` support is verified first-hand there.
- **Design consequence:**
  - **Gmail builder:** `'https://mail.google.com/mail/'` [+ `'u/{account}/'` per CMP-GMAIL-MULTIACCOUNT] + `'?view=cm&fs=1&to=' + addrList(to)` [+ `'&cc=…'`] [+ `'&bcc=' + addrList(bcc)`] + `'&su=' + pct(subject)` + `'&body=' + pct(LF-normalised body)`.
  - Use `su`, not `subject`. Never use `URLSearchParams`.
  - Make the Gmail form configurable (`GMAIL_FORM`), defaulting to `view=cm&fs=1` as in the golden vectors, with `tf=cm` as the alternative. The verifier asked for this because `bcc` was verified first-hand only on the `tf=cm` form (CMP-BUILDER-SPEC).
  - Because the format is undocumented:
    - keep the copy-reply fallback and the secondary `mailto:` link always visible;
    - add a manual pre-release smoke test, signed in and signed out, to the runbook.
- **Open risk:**
  - The format is undocumented, and Google has already changed the canonical form once (`view=cm` → `tf=cm`).
  - Gmail publishes no URL length limit.
  - Signed-out behaviour is not verified: do the parameters survive the accounts.google.com sign-in round-trip?
  - **WIRE_UP:** re-check live that both `view=cm&fs=1` and `tf=cm` URLs open a pre-filled compose window, with `to`, `cc`, `bcc`, `su` and `body` all filled, both signed in and signed out.
- **Sources:**
  - https://github.com/chromium/chromium/blob/main/chrome/common/url_constants.h — official SDK source (Chromium browser source) — "// Chrome OS default pre-defined custom handlers / inline constexpr char kChromeOSDefaultMailtoHandler[] = \"https://mail.google.com/mail/?extsrc=mailto&amp;url=%s\";" (the literal really contains "&amp;")
  - https://github.com/mozilla-firefox/firefox/blob/main/uriloader/exthandler/HandlerList.sys.mjs — official SDK source (Firefox browser source) — "name: "Gmail", uriTemplate: "https://mail.google.com/mail/?extsrc=mailto&url=%s","
  - https://til.simonwillison.net/google/gmail-compose-url — community, non-authoritative (committed 2024-03-12; read from the GitHub source because the site was blocked) — "`https://mail.google.com/mail/u/0/?to=recipient@example.com&cc=one@example.com,two@example.com&bcc=bcc@example.com&su=Email+Subject&body=Hello+There&tf=cm`" … "`su` - the email subject" … "the `fs=0/1` option no longer does anything, and I found that `view=cm` should be replaced by `tf=cm`." … "The To, CC, BCC, Subject and Body are filled out as requested in the URL."
  - https://github.com/simonw/til/blob/main/google/gmail-compose-url.md — community, non-authoritative — "git log: 9625e6e 2024-03-12 20:41:14 -0700 'Generating URLs to a Gmail compose window'; bc074c7 2024-03-13 12:57:38 -0700 'Tip about /u/0/ bit'. Text: 'Following that link redirected to almost the example I provided above.'"
  - https://github.com/db0x/voltage/blob/HEAD/webapps/build.google-mail.json — community, non-authoritative — "\"mailtoTemplate\": \"https://mail.google.com/mail/?view=cm&fs=1\", \"mailtoParamMap\": { \"subject\": \"su\" }"
  - https://github.com/Mira-Studios/mira/blob/HEAD/apps/mobile/src/internal/MailtoPage.tsx — community, non-authoritative — "`https://mail.google.com/mail/?extsrc=mailto&url=${encodeURIComponent(mailtoUrl)}`"

### CMP-GMAIL-MULTIACCOUNT — Choose the Gmail account with `/mail/u/{email}/`
- **Brief:** Not addressed (§5.5 Gmail compose URL; §4, onboarding step 2.4 "Choose mail client").
- **Verdict:** Extended — low confidence.
  - Not officially documented: Google publishes nothing on account selection for Gmail URLs.
  - Google's official samples show only the index form `/mail/u/0/`, and only for inbox links.
  - The email-in-path form is community-reported only.
  - The verifier upheld this.
- **Finding:**
  - **The problem.** Without a selector, the link opens in the browser's default Google session (`/mail/u/0/`). An owner signed into both a personal and a Workspace account can get the draft in the wrong mailbox. The email is then sent from the wrong address, and BCC logging is attributed wrongly.
  - **The index form.** Google's own official samples use the account-index path `https://mail.google.com/mail/u/0/…`.
  - **The email form.** A first-hand report says `/mail/u/{email}/` (an email address instead of an index) redirects to the matching signed-in account.
  - **`authuser=`.** The `authuser=` query parameter is used across Google web apps but is not documented for Gmail compose. Prefer the path form.
  - **Builder rule.**
    - The owner may give a "Gmail address I send from". It defaults to their login email when that is gmail.com, googlemail.com or a Google Workspace domain.
    - If they gave one, the base is `'https://mail.google.com/mail/u/' + pctAddr(email) + '/'`, which keeps `@` literal.
    - Otherwise the base is `'https://mail.google.com/mail/'`.
- **Design consequence:**
  - Add an optional onboarding field, `gmail_account_email`, and build `/mail/u/{email}/` from it.
  - If the owner is not signed in to that account, Google shows sign-in or the account chooser. That is acceptable.
- **Open risk:**
  - It is unverified whether the compose parameters survive when the named account is not signed in.
  - The email-in-path form is community-reported only.
  - **WIRE_UP:** test `/mail/u/{email}/` live with two signed-in accounts and with the named account signed out.
- **Sources:**
  - https://github.com/googleworkspace/apps-script-samples/blob/main/ai/email-classifier/Sheet.gs — official SDK source (Google Workspace official samples) — "line 51: const link = `https://mail.google.com/mail/u/0/#inbox/${thread.getId()}`;"
  - https://til.simonwillison.net/google/gmail-compose-url — community, non-authoritative — Tip from Corentin Smith: "You can replace the `/u/0/` with `/u/youremail@gmail.com/`, it will redirect you to the correct account"
  - https://github.com/matthiasmiller/chrome-mailto-anywhere/commit/3fb1f941b92c8ac40d16c842d8bcaf1b3acbdd6f — community, non-authoritative — "core.js presets: 'Google (Account #1)': 'https://mail.google.com/mail/u/0/?extsrc=mailto&url={URL}' ... 'Google (Account #5)': 'https://mail.google.com/mail/u/4/?extsrc=mailto&url={URL}'"

### CMP-GMAIL-MOBILE — Gmail web compose links do not open a composer on phones; use `mailto:` there
- **Brief:** Not addressed. The brief assumes one redirect target per owner client (§5.5 [Send from my email]; §5.5 "[Edit first] → a mobile page").
- **Verdict:** Extended — medium confidence.
  - The Gmail mobile-web behaviour is not officially documented; it comes from first-hand community reports only.
  - The `mailto:` behaviour on iOS and Android comes from Apple's and Android's official docs.
  - The verifier upheld this.
- **Finding:**
  - **No Google documentation.** Google documents nothing on this.
  - **Phones open the inbox, not a composer.** A first-hand report says that on iPhone, "attempting to click one of these links in Mobile Safari takes you to the Gmail inbox but does not open a compose window". Gmail's mobile web UI ignores `view=cm` and `tf=cm`.
  - **In-app browsers.** A tap inside the Gmail or Outlook app usually opens an in-app browser, not the Gmail app's composer.
  - **Custom schemes.** Gmail app schemes such as `googlegmail://co?…` are not documented by Google.
  - **Official platform docs say `mailto:` opens the device composer:**
    - Apple: "The mailto scheme is used to launch the Mail app and open the email compose sheet". It supports To, Cc, Bcc, subject and body.
    - Android: email apps register `ACTION_SENDTO` with the data scheme `mailto`, so only email apps handle it.
  - **The owner's real app.** iOS 14+ and Android let the user choose Gmail or Outlook as the default mail app, so a `mailto:` link lands in the owner's real app. Apple: "The system launches the default mail client in iOS whenever a user opens a `mailto:` link."
  - **Recommendation.** In `/a/{token}/send`, when the User-Agent is a phone, use the `mailto:` target instead of Gmail or Outlook web.
    - Phone patterns: `iPhone|iPod|Android…Mobile|Windows Phone`.
    - iPadOS reports a desktop UA; treat it as desktop.
- **Design consequence:**
  - Select the target per request: a phone UA gets the `mailto:` page; a desktop gets the client-specific web compose URL.
  - For click analytics, log which target was used, with no content.
- **Open risk:**
  - UA sniffing is a heuristic.
  - It is not verified whether mail.google.com links on Android open the Gmail app through App Links.
  - **WIRE_UP:** test on a real iPhone and a real Android phone with Gmail and Outlook each set as the default mail app.
- **Sources:**
  - https://til.simonwillison.net/google/gmail-compose-url — community, non-authoritative — "It doesn't work on Mobile Web" — "Frustratingly, attempting to click one of these links in Mobile Safari takes you to the Gmail inbox but does not open a compose window. I don't know if there's a workaround for that."
  - https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/MailLinks/MailLinks.html — official docs — "The mailto scheme is used to launch the Mail app and open the email compose sheet." ... "You can also include a subject field, a message, and multiple recipients in the To, Cc, and Bcc fields. (In iOS, the from attribute is ignored.)"
  - https://developer.android.com/guide/components/intents-common#Email — official docs — "If you want to make sure that your intent is handled only by an email app, and not a text messaging or social app, then use the ACTION_SENDTO action and include the \"mailto:\" data scheme" ... `<action android:name="android.intent.action.SENDTO" /> <data android:scheme="mailto" />`
  - https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.mail-client — official docs (fetched as the page's JSON data) — abstract "A Boolean that indicates whether the app can act as a user's default email client."; body "The system launches the default mail client in iOS whenever a user opens a `mailto:` link."; platforms iOS introducedAt 14.0, iPadOS 14.0.
  - https://gist.github.com/miwebguy/2e805e343e0d434f06f2194b92b925d8 — community, non-authoritative — Terry-Hagan-BA, Oct 4, 2021: "doesn't seem to work on mobile, opens up the browser but just goes to the Inbox."

### CMP-OUTLOOK-PARAMS-BCC — Outlook on the web: carry the message in `mailtouri=`, not in plain `cc=`/`bcc=`
- **Brief:** §5.5 composes in Outlook web via `https://outlook.office.com/mail/deeplink/compose?to=&cc=&bcc=&subject=&body=` and adds the HubSpot BCC logging address as `bcc` on every compose link.
- **Resolves:** [VERIFY] §5.5 current URL formats (Outlook web: parameters). It also covers the compose-link half of §5.5 BCC logging. Tier availability ("[VERIFY BCC logging availability on Free and Starter]") is resolved in section 05 (HubSpot email signals), not here.
- **Verdict:** Corrected — low confidence.
  - Not officially documented. Microsoft has no documentation for the mail compose deeplink; a GitHub code search for "deeplink/compose" in MicrosoftDocs and OfficeDev returned 0 hits.
  - The recommended form rests on:
    - official Chromium source and the WHATWG spec, for how browsers build the handler URL;
    - an unofficial 2021 mirror of OWA client code;
    - community tests.
  - The verifier corrected the original finding. It lowered confidence from medium to low, removed an overreach about where OWA parses `mailtouri`, and added contrary community evidence.
- **Finding:**
  - **Two de-facto forms exist.**
  - **Form A: plain parameters.** `{base}/mail/deeplink/compose?to=&subject=&body=`, optionally with `cc=` and `bcc=`.
    - `to`, `subject` and `body` are widely reported to work.
    - Reports on `cc` and `bcc` CONFLICT. The gist author (2024-02-15) and a 2026-08-01 Microsoft 365 tenant test say a plain `cc` is dropped. A Chrome extension switched TO plain `to`/`cc`/`bcc` parameters on 2026-07-03, without stating why; the preset it removed had a trailing slash, `compose/?mailtouri=`.
    - `%2B` in a plain `to=` has been reported (office-js #4127, 2024) to become a space. That breaks plus-addressed leads such as `jane+x@acme.com`.
    - The issue's labels are "Area: Outlook | Needs: author feedback | Resolution: external | Status: no recent activity", and it is closed. That records closure after a request for author feedback with no further activity, not a Microsoft ruling.
  - **Form B: `mailtouri`.** `{base}/mail/deeplink/compose?mailtouri={encodeURIComponent(RFC 6068 mailto URI)}`.
    - This is exactly the URL a browser produces when Outlook on the web is the registered `mailto:` handler. OWA registers `deeplink/compose?mailtouri=%s`, and Chromium substitutes `%s` using `EscapeQueryParamValue`, whose unescaped set (alphanumerics and `!'()*-._~`) equals `encodeURIComponent`'s.
    - The WHATWG spec likewise percent-encodes with the component percent-encode set.
    - Locally, the builder's TV1 and TV2 Outlook URLs are byte-identical to what Chromium navigates to.
    - Community reports from 2026 say this form honours `cc`.
  - **`bcc` is unverified in both forms.**
  - **What the unofficial 2021 OWA client mirror shows.** This is a model of OWA, not proof of how current OWA parses the deeplink.
    - OWA's own popout code writes `newSearch.mailtouri = serializeMailTo(mailTo)`.
    - Its mailto parser `processMailToLink`:
      - maps `to`, `cc`, `bcc`, `subject` and `body`;
      - decodes the address path with `decodeURIComponent`;
      - parses the query with a querystring parser that first rewrites `+` to `%20`;
      - keeps only the first `subject` and `body`;
      - treats a mailto that contains more than one `?` as invalid.
    - Its content converter turns `\n` or `\r\n` into `<BR>`.
    - However, the mirror's only importer of `processMailToLink` is the click handler for `mailto:` anchors inside message bodies, and no code in the mirror reads `mailtouri` on the deeplink route.
    - A 2026-08-19 community test of the calendar deeplink says "the mapping happens on the server". Current parsing may therefore differ.
  - **Recommendation:**
    - Default to form B. It is the browser contract, and it carries `cc`, `bcc` and plus-addresses through standard mailto parsing.
    - Keep form A as a config-switchable fallback.
    - Make a live `bcc` test on a Microsoft 365 tenant and on an Outlook.com account a launch blocker.
    - BCC logging could fail silently, so show the BCC logging address on the interstitial and copy-reply pages as a manual fallback.
- **Design consequence:**
  - **Outlook builder:** `OUTLOOK_BASE[kind] + '?mailtouri=' + pct(buildMailto(msg))`. The HubSpot BCC logging address goes in the inner mailto `bcc` hfield.
  - In the default mode, never emit plain `cc=` or `bcc=` parameters for Outlook, and never use a plain `to=` for plus-addressed leads.
  - The inner escapes are double-encoded: a space becomes `%2520` and CRLF becomes `%250D%250A`. Outlook URLs are therefore about 30% longer than the Gmail or `mailto:` URL for the same draft, so apply the length threshold per client (CMP-URL-LENGTH-LIMITS).
- **Open risk:**
  - The deeplink is undocumented and owned by Microsoft.
  - `bcc` via `mailtouri` is evidenced only by unofficial 2021 OWA client code and by the browser-handler contract. The 2026 live-tenant test covered `cc`, not `bcc`.
  - If `bcc` is dropped, BCC logging fails silently for Outlook owners.
  - **WIRE_UP (launch blocker):** on a live Microsoft 365 tenant (`outlook.cloud.microsoft`) and an Outlook.com account (`outlook.live.com`), verify that a `mailtouri` link pre-fills `to` (including a plus-address), `cc`, `bcc`, `subject` and a multi-line `body`. Also check the plain-parameter fallback for `cc`, `bcc` and `%2B`.
- **Sources:**
  - https://gist.github.com/miwebguy/2e805e343e0d434f06f2194b92b925d8 — community, non-authoritative — Main text: "Compose Mail Parameters - subject - body - to". Comment by miwebguy (Feb 15, 2024): "the standard cc= and bcc= that gmail uses don't work, so I'm not sure if they're implemented."
  - https://github.com/Branden574/StockPilot/blob/HEAD/docs/integrations/zendesk-dc4-intake.md — community, non-authoritative — "A plain `cc=` parameter on the compose deep link is **silently dropped** by OWA (owner test against the live L4L Microsoft 365 tenant, 2026-08-01). The whole message therefore rides inside a single `mailtouri=` parameter, whose mailto parser honors `cc` per RFC 6068"
  - https://github.com/OfficeDev/office-js/issues/4127 — community, non-authoritative — Title "[Outlook Deeplink] Breaks email subaddressing by handling \"%2B\" as space", opened 2024-02-13, repro `https://outlook.office.com/mail/deeplink/compose?to=support%2Bproduct-request%40example.com&subject=Test&body=testing` — "Subaddressing symbol from URI `%2B` gets replace with space symbol, which makes target address (TO) invalid." WebFetch 2026-10-01: "Labels: Area: Outlook | Needs: author feedback | Resolution: external | Status: no recent activity; State: Closed; no Microsoft staff comment visible."
  - https://github.com/ladifire-opensource/outlook.live.com_modules/blob/master/outlook_modules/owa-mailto-protocol-handler/src/utils/handleAndLogOperation.ts — community, non-authoritative (unofficial 2021 mirror of Microsoft's shipped OWA client source, commit fef05749) — "window.navigator.registerProtocolHandler( 'mailto', `${getOrigin()}${getMailPath()}deeplink/compose?mailtouri=%s`, loc(mailtoProtocolHandlerTitle) );"
  - https://github.com/ladifire-opensource/outlook.live.com_modules/blob/master/outlook_modules/owa-popout/src/utils/getMailComposeDeeplink.ts — community, non-authoritative (unofficial 2021 OWA mirror) — "const newSearch = getQueryStringParameters(); newSearch.mailtouri = serializeMailTo(mailTo); return formatUrl(MAIL_DEEPLINK_URL_BASE, COMPOSE_ROUTE, '?' + querystring.stringify(newSearch));"
  - https://github.com/ladifire-opensource/outlook.live.com_modules/blob/master/outlook_modules/owa-content-handler/src/utils/processMailToLink.ts — community, non-authoritative (unofficial 2021 OWA mirror) — "const TO_PARAM_NAME = 'to'; const CC_PARAM_NAME = 'cc'; const BCC_PARAM_NAME = 'bcc'; const SUBJECT_PARAM_NAME = 'subject'; const BODY_PARAM_NAME = 'body'; ... // If the link contains more than one '?', it is invalid. ... processRecipientsFromUrlParameter(decodeURIComponent(parts[0]), toRecipients); ... const parsedMailTo = parse(parts[1]); ... case BCC_PARAM_NAME: processRecipientsFromUrlParameter(paramValue, bccRecipients);"
  - https://github.com/ladifire-opensource/outlook.live.com_modules/blob/master/outlook_modules/owa-querystring/src/index.ts — community, non-authoritative (unofficial 2021 OWA mirror) — "const regexp = /\+/g; ... const qsPartSplit = qsParts[i].replace(regexp, '%20').split('='); result[decodeURIComponent(qsPartSplit[0])] = decodeURIComponent(qsPartSplit.slice(1).join('='));"
  - https://github.com/ladifire-opensource/outlook.live.com_modules/blob/master/outlook_modules/owa-content-handler/src/utils/contentConversion.ts — community, non-authoritative (unofficial 2021 OWA mirror) — "const NEW_LINE_REGEX = new RegExp('\\n|\\r\\n', 'g'); export function replaceLineBreaksWithBrTags(string) { return string.replace(NEW_LINE_REGEX, BR_TAG_NAME); }"
  - https://github.com/ladifire-opensource/outlook.live.com_modules/blob/master/outlook_modules/owa-content-handler/src/handlers/mailToHandler.ts — community, non-authoritative (unofficial 2021 OWA mirror; the caveat source) — "Only importer of processMailToLink in the 8,040-file mirror (commit fef05749, 2021-08-15): const MAIL_TO_HANDLER_SELECTOR = \"a[href^='mailto:'],a[href^='MAILTO:']\"; ... grep for 'mailtouri' finds only handleAndLogOperation.ts (registerProtocolHandler) and getMailComposeDeeplink.ts (writer) - no reader of the parameter."
  - https://html.spec.whatwg.org/multipage/system-state.html#custom-handlers — RFC/standard (WHATWG HTML) — "Let encodedURL be the result of running UTF-8 percent-encode on inputURLString using the component percent-encode set." ... "Replace the first instance of \"%s\" in handlerURLString with encodedURL."
  - https://github.com/chromium/chromium/blob/main/components/custom_handlers/protocol_handler.cc — official SDK source (Chromium browser source) — "GURL ProtocolHandler::TranslateUrl(const GURL& url) const { ... base::ReplaceFirstSubstringAfterOffset(&translatedUrlSpec, 0, \"%s\", base::EscapeQueryParamValue(url_spec, false)); return GURL(translatedUrlSpec); }"
  - https://github.com/chromium/chromium/blob/main/base/strings/escape.cc — official SDK source (Chromium browser source) — "// Everything except alphanumerics and !'()*-._~ ... static const Charmap kQueryCharmap = ... std::string EscapeQueryParamValue(std::string_view text, bool use_plus) { return Escape(text, kQueryCharmap, use_plus); }"
  - https://github.com/matthiasmiller/chrome-mailto-anywhere/commit/3fb1f941b92c8ac40d16c842d8bcaf1b3acbdd6f — community, non-authoritative (contrary evidence) — "Commit 3fb1f94, 2026-07-03, \"Fix Outlook presets.\": -'Outlook': 'https://outlook.office.com/mail/deeplink/compose/?mailtouri={URL}' +'Outlook (Office)': 'https://outlook.office.com/mail/deeplink/compose?to={To}&cc={Cc}&bcc={Bcc}&subject={Subject}&body={Body}', +'Outlook (Cloud)': 'https://outlook.cloud.microsoft/mail/deeplink/compose?to={To}&cc={Cc}&bcc={Bcc}&subject={Subject}&body={Body}'"
  - https://github.com/InteractionDesignFoundation/add-event-to-calendar-docs/blob/main/services/outlook-web.md — community, non-authoritative — "Commits 7e66d71/d6f8556 2026-08-19: \"Unlike Google Calendar, the Outlook web app does not parse the deep link in the browser. ... so the mapping happens on the server.\""
  - https://github.com/Mira-Studios/mira/blob/HEAD/apps/mobile/src/internal/MailtoPage.tsx — community, non-authoritative — "`https://outlook.office.com/mail/deeplink/compose?mailtouri=${encodeURIComponent(mailtoUrl)}`"
  - local://scratchpad/compose/exp/run.mjs — local experiment (Node 22) — "buildOutlookMailtouri(T2) where T2.to=[\"jane+leads@example.com\"], bcc=[\"log-1234@bcc.example.net\"], subject=\"Q&A: 50% off? #1 = best + more\" → outer owaNodeParseQueryString().mailtouri === buildMailto(T2) (true); owaProcessMailTo(inner) → to \"jane+leads@example.com\", bcc \"log-1234@bcc.example.net\", subject and body identical (check_outlook_mailtouri_owa=true)." Verifier re-run (Node v22.22.0): "output out.verify.json JSON-identical to original out.json; check_outlook_mailtouri_owa true for T1-T3." The run.mjs record also says the plain-param `to` became "jane leads@example.com" after a second form decode, but the verifier classed that as a simulation, not a reproduction of OWA behaviour.
  - local://scratchpad/verify_compose/chromium_translate.mjs — local experiment (Node v22.22.0) — "Decoded Chromium kQueryCharmap bitmap: unescaped ASCII = \"!'()*-.0-9A-Z_a-z~\"; escapeQueryParamValue(ch)===encodeURIComponent(ch) for all 128 ASCII chars (true). For T1 and T2: new URL(mailto).href===mailto (true) and 'https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=%s'.replace('%s', escapeQueryParamValue(mailto)) === buildOutlookMailtouri(msg,'work') (true for both)."

### CMP-OUTLOOK-HOSTS — Outlook hosts: `outlook.cloud.microsoft` for work or school, `outlook.live.com` for personal accounts
- **Brief:** Work/school: `https://outlook.office.com/mail/deeplink/compose…`; personal: `outlook.live.com/…`.
- **Resolves:** [VERIFY] §5.5 current URL formats (Outlook web: hosts).
- **Verdict:** Corrected — medium confidence.
  - The host names are official, from Microsoft's docs and endpoint lists read through their MicrosoftDocs GitHub sources.
  - Three points are community-reported only:
    - the deeplink path on each host;
    - the redirect behaviour of `outlook.office.com`;
    - the `/0/` index form.
  - The verifier corrected the original finding:
    - the personal base drops `/0/` by default;
    - the `outlook.office.com` redirect claim rests on one community repo;
    - the "New Outlook for Windows" statements were removed as unsourced;
    - the sovereign-cloud hosts were verified.
- **Finding:**
  - **Work or school (Microsoft 365 worldwide):** `https://outlook.cloud.microsoft/mail/deeplink/compose`.
    - Microsoft's official docs (ms.date 04/09/2025) list Outlook among the products already served from the `cloud.microsoft` domain.
    - Endpoint ID 1 is `outlook.cloud.microsoft, outlook.office.com, outlook.office365.com`.
    - One community tenant report (2026-08-02) says the `outlook.office.com` domain-migration redirect drops the compose path and lands the user on the bare inbox.
    - Another community project still shipped an `outlook.office.com` preset beside `outlook.cloud.microsoft` on 2026-07-03.
    - On the official evidence, `outlook.cloud.microsoft` is still the right choice for work accounts.
  - **Personal (Outlook.com, Hotmail, Live, MSN):** `https://outlook.live.com/mail/deeplink/compose`.
    - The `/0/` account-index form, `https://outlook.live.com/mail/0/deeplink/compose`, is reported equivalent: a 2026-08-19 live test of the calendar deeplink found "Both forms behave identically".
    - A 2023 comment says the `calendar/0/deeplink/compose` form "doesn't work anymore".
    - Keep `/0/` only as a config alternative.
  - **Never put a mailbox address in the path.** OWA treats `/mail/{address}/` as explicit logon to that (shared or delegated) mailbox, not as account selection.
  - **Sovereign clouds use other hosts:** GCC High uses `outlook.office365.us` and 21Vianet uses `partner.outlook.cn`. Send those owners to `mailto:`.
  - **Keep the hosts in config.**
  - **New Outlook for Windows.** Its behaviour with https deeplinks is unverified; no source covers it.
- **Design consequence:**
  - Store a `mail_client` enum: `gmail | outlook_work | outlook_personal | other`.
  - In onboarding, when the owner chooses "Outlook", ask "Work or school (Microsoft 365)" or "Personal (Outlook.com/Hotmail)". Default to personal for owner domains outlook.com, hotmail.*, live.* and msn.com.
  - Set `OUTLOOK_BASE = { outlook_work: 'https://outlook.cloud.microsoft/mail/deeplink/compose', outlook_personal: 'https://outlook.live.com/mail/deeplink/compose' }`, held in env config so a host can change without a deploy.
  - The original design note used `https://outlook.live.com/mail/0/deeplink/compose` for personal accounts; the verifier changed the default to the no-index form.
- **Open risk:**
  - Host behaviour is undocumented and has changed during the `cloud.microsoft` migration.
  - It was not verified whether `outlook.cloud.microsoft` serves consumer (MSA) accounts, so keep `outlook.live.com` for personal accounts.
  - **WIRE_UP:** before launch, re-test both hosts signed in and signed out. Test `outlook.live.com` with and without `/0/`, and confirm that `outlook.office.com` really drops the compose path.
- **Sources:**
  - https://learn.microsoft.com/en-us/microsoft-365/enterprise/cloud-microsoft-domain — official docs source repo (renders to the public docs URL; read from MicrosoftDocs/microsoft-365-docs `microsoft-365/enterprise/cloud-microsoft-domain.md`) — "ms.date: 04/09/2025" … "Some Microsoft 365 products that are already using the `cloud.microsoft` domain include Microsoft 365 Copilot Chat, Word, Excel, PowerPoint, Outlook, OneNote, Planner, ..."
  - https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges — official docs source repo (renders to the public docs URL; `microsoft-365/includes/office-365-worldwide-endpoints.md`) — "1 | Optimize<BR>Required | Yes | `outlook.cloud.microsoft, outlook.office.com, outlook.office365.com`"
  - https://learn.microsoft.com/en-us/microsoft-365/enterprise/microsoft-365-u-s-government-gcc-high-endpoints — official docs source repo (renders to the public docs URL; `microsoft-365/includes/office-365-u.s.-government-gcc-high-endpoints.md`) — "1 | Optimize<BR>Required | Yes | `outlook.office365.us`"
  - https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges-21vianet — official docs source repo (renders to the public docs URL; `microsoft-365/includes/office-365-operated-by-21vianet-endpoints.md`) — "1 | Optimize<BR>Required | No | `partner.outlook.cn`"
  - https://github.com/Branden574/StockPilot/blob/HEAD/docs/integrations/zendesk-dc4-intake.md — community, non-authoritative — "The host must be `outlook.cloud.microsoft`, never `outlook.office.com` — the office.com domain-migration redirect drops the compose path and lands the user on their bare inbox (owner hit this live, 2026-08-02"
  - https://github.com/julian-alarcon/prospect-mail/blob/HEAD/src/settings.js — community, non-authoritative — "// outlook.cloud.microsoft is Microsoft's unified-domain Outlook host and is now the principal URL. The legacy office.com / office365.com / live.com hosts remain valid endpoints and are kept for compatibility." urlsInternal includes "outlook.cloud.microsoft/mail/deeplink", "outlook.live.com/mail/deeplink"
  - https://github.com/ladifire-opensource/outlook.live.com_modules/blob/master/outlook_modules/owa-url/src/internalGetScopedPath.ts — community, non-authoritative (unofficial 2021 OWA mirror) — "In the case of an indexed path (e.g. /mail/0/) for multiple account scenarios (Outlook/Gmail) it will include the index." / "In the case of a target mailbox path (e.g. /mail/me@contoso.com/) for explicit logon scenarios it will include the target mailbox."
  - https://github.com/InteractionDesignFoundation/add-event-to-calendar-docs/blob/main/services/outlook-web.md — community, non-authoritative — "An account index may be inserted before `deeplink`, for example `https://outlook.live.com/calendar/0/deeplink/compose`. Both forms behave identically." (live check on outlook.live.com 2026-08-19)
  - https://gist.github.com/miwebguy/2e805e343e0d434f06f2194b92b925d8 — community, non-authoritative — kadosknight, May 30, 2023: "Many sources use 'calendar/0/deeplink/compose' but that doesn't work anymore, use 'calendar/deeplink/compose' instead"
  - https://github.com/matthiasmiller/chrome-mailto-anywhere/commit/3fb1f941b92c8ac40d16c842d8bcaf1b3acbdd6f — community, non-authoritative — "2026-07-03 presets include both 'Outlook (Office)': 'https://outlook.office.com/mail/deeplink/compose?...' and 'Outlook (Cloud)': 'https://outlook.cloud.microsoft/mail/deeplink/compose?...'"

### CMP-OUTLOOK-MOBILE-SESSION — Outlook deeplinks on phones and after the session expires
- **Brief:** Not addressed (§5.5 [Send from my email] redirect).
- **Verdict:** Not officially documented — low confidence.
  - The finding rests on community reports, including Microsoft Q&A community answers that could only be read through search summaries (learn.microsoft.com was blocked).
  - The verifier upheld this.
- **Finding:**
  - **No Microsoft documentation** covers this.
  - **Phones.** Community reports say that on phones an https Outlook deeplink opens Outlook on the web in a browser or in-app browser, not the installed Outlook app.
  - **Custom scheme.** Microsoft does not document an Outlook app compose scheme (`ms-outlook://compose?…`). Microsoft docs mention only `ms-outlook://people/<account>` contact fields.
  - **Known failure modes** (Microsoft Q&A community answers, read through search summaries):
    - When the OWA session has expired, the sign-in redirect can drop `cc`, `subject` and `body` on the first open.
    - On the first open through sign-in, `%20`-encoded spaces were shown as `+` ("on first click there is a Microsoft redirect to the login page and in this redirect the space characters are replaced with plus signs"). Later opens were fine.
  - **Recommendation:**
    - A phone UA gets `mailto:`, since Outlook mobile can be the default mail app.
    - A desktop gets the `mailtouri` deeplink, plus a visible "Copy reply instead" link on the interstitial.
- **Design consequence:**
  - The QA checklist must include a signed-out desktop browser, an expired session and a phone.
  - Never rely on `ms-outlook://` or `googlegmail://` in v1.
- **Open risk:**
  - The signed-out and first-open mangling may also affect the `mailtouri` form. This could not be tested from the sandbox.
  - **WIRE_UP:** open a `mailtouri` link with a signed-out and an expired session on both Outlook hosts, and check that `cc`, `bcc`, `subject` and `body` arrive with spaces intact.
- **Sources:**
  - https://learn.microsoft.com/en-us/answers/questions/4670577/space-character-in-outlook-deeplink — community, non-authoritative (Microsoft Q&A community answer; official page via search summary — direct fetch blocked in sandbox) — spaces encoded as %20 "get replaced with a + sign the first time the link is used, but the second time and onwards the space characters are kept as intended" because "on first click there is a Microsoft redirect to the login page"
  - https://learn.microsoft.com/en-us/answers/questions/4619953/want-to-pre-populate-to-cc-subject-body-by-passing — community, non-authoritative (Microsoft Q&A community answer; official page via search summary — direct fetch blocked in sandbox) — "after a session expires, if an email is generated, the cc, subject, and body fields do not pre-populate"
  - https://github.com/Branden574/StockPilot/blob/HEAD/packages/core/src/email/outlook-compose.ts — community, non-authoritative — "Microsoft's NATIVE Outlook app URL scheme (iOS + Android), used by mobile clients where handing an https URL to the OS opens a BROWSER on Outlook Web instead of the installed app."
  - https://learn.microsoft.com/en-us/troubleshoot/exchange/mobile-devices/duplicate-contacts-in-ios-contacts-app — official docs source repo (renders to the public docs URL; MicrosoftDocs/SupportArticles-docs `Exchange/ExchangeOnline/mobile-devices/duplicate-contacts-in-ios-contacts-app.md`) — "you see the \"Outlook ms-outlook://people/\\<account>\" field" (the only `ms-outlook://` mention found in MicrosoftDocs)
  - https://github.com/MicrosoftDocs/SupportArticles-docs/blob/main/Exchange/ExchangeOnline/mobile-devices/duplicate-contacts-in-ios-contacts-app.md — official docs source repo (renders to the public docs URL) — "GitHub code search '\"ms-outlook://\" org:MicrosoftDocs' total_count 1: 'you see the \"Outlook ms-outlook://people/\\<account>\" field'"
  - https://gist.github.com/miwebguy/2e805e343e0d434f06f2194b92b925d8 — community, non-authoritative — Terry-Hagan-BA, Oct 4, 2021: "Hi, doesn't seem to work on mobile, opens up the browser but just goes to the Inbox."

### CMP-MAILTO-RFC6068 — `mailto:` syntax per RFC 6068
- **Brief:** §5.5 always offers a `mailto:` link as a secondary option ("Open in default mail app"); the format was to be verified.
- **Resolves:** [VERIFY] §5.5 current URL formats (`mailto:`).
- **Verdict:** Confirmed — high confidence. RFC 6068 (October 2010, obsoletes RFC 2368) was read from three byte-identical GitHub mirrors because rfc-editor.org was blocked. The verifier upheld this.
- **Finding:**
  - **ABNF:**
    ```text
    mailtoURI  = "mailto:" [ to ] [ hfields ]
    to         = addr-spec *("," addr-spec )
    hfields    = "?" hfield *( "&" hfield )
    hfield     = hfname "=" hfvalue
    hfname     = *qchar
    hfvalue    = *qchar
    qchar      = unreserved / pct-encoded / some-delims
    some-delims = "!" / "$" / "'" / "(" / ")" / "*" / "+" / "," / ";" / ":" / "@"
    ```
  - **Header names.** hfnames are case-insensitive. Use lower-case `to`, `cc`, `bcc`, `subject` and `body`. `body` is the first `text/plain` part.
  - **Escaping rules:**
    - `?`, `=` and `&` MUST be `%3F`, `%3D` and `%26` when they are not delimiters.
    - `#` MUST be `%23`.
    - `%` becomes `%25`.
    - In addresses, `/`, `?`, `#`, `[`, `]`, `&`, `;` and `=` are also percent-encoded, while `@` stays literal.
  - **Spaces and plus signs.** "All spaces SHOULD be encoded as %20, and '+' characters MAY be encoded as %2B." A `+` is a literal plus, which is common in subaddresses.
  - **Line breaks.** "Line breaks in the body of a message MUST be encoded with "%0D%0A"". Line breaks in other hfields SHOULD NOT be used.
  - **Non-ASCII text** is converted to UTF-8 bytes, and each byte is percent-encoded.
  - **Domain names.** "URI producers SHOULD provide these domain names in the IDNA encoding, rather than percent-encoded" (§2 item 4).
  - **Multiple recipients** are comma-separated addr-specs, in the path or in `cc`/`bcc` values.
  - **Put the To address in the path.** `mailto:a@x?to=b@y` is NOT RECOMMENDED ("some existing clients ignore "to" hfvalues"). Never repeat an hfname.
  - **In HTML,** the `href` must write `&` as `&amp;`.
  - **Client support** is guaranteed only for `subject` and `body` ("The creator of a 'mailto' URI cannot expect the resolver of a URI to understand more than the "subject" header field and "body""). `bcc` on `mailto:` is therefore best-effort.
  - **Ignored fields.** Clients MUST ignore From, Date and MIME fields.
  - **Length.** RFC 6068 defines no length limit.
- **Design consequence:**
  - **mailto builder:** `'mailto:' + addrList(to) + '?' + ['cc=…', 'bcc=…', 'subject=' + pct(oneLine(subject)), 'body=' + pct(CRLF body)].join('&')`.
  - React Email escapes `&` in `href` automatically. Assert `&amp;` in the rendered HTML in a test.
- **Open risk:**
  - `bcc` on `mailto:` depends on the owner's mail app; the RFC guarantees only `subject` and `body`.
  - **WIRE_UP:** test `bcc` from a `mailto:` link in the owner-facing apps you support (for example Apple Mail, the Gmail app and the Outlook app).
- **Sources:**
  - https://www.rfc-editor.org/rfc/rfc6068 — RFC/standard (read from byte-identical GitHub mirrors mnot/rfc-refs, kesara/watcher, norwd/archive) — "Within 'mailto' URIs, the characters \"?\", \"=\", and \"&\" are reserved, serving as delimiters. They have to be escaped (as \"%3F\", \"%3D\", and \"%26\", respectively) when not serving as delimiters." ; "The character \"#\" in <hfvalue>s MUST be escaped as %23." ; §5 "Also note that line breaks in the body of a message MUST be encoded with \"%0D%0A\"." ; "When producing 'mailto' URIs, all spaces SHOULD be encoded as %20, and '+' characters MAY be encoded as %2B." ; §2 "However, the latter form is NOT RECOMMENDED because different user agents handle this case differently. In particular, some existing clients ignore \"to\" <hfvalue>s." ; §4 "The creator of a 'mailto' URI cannot expect the resolver of a URI to understand more than the \"subject\" header field and \"body\"." ; §2 item 4 "URI producers SHOULD provide these domain names in the IDNA encoding, rather than percent-encoded, if they wish to maximize interoperability with legacy 'mailto' URI interpreters." ; §2 item 1 "all the characters in gen-delims except \"@\" and \":\" (i.e., \"/\", \"?\", \"#\", \"[\", and \"]\")" ; §6.1 example <mailto:infobot@example.com?body=send%20current-issue%0D%0Asend%20index>
  - https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/MailLinks/MailLinks.html — official docs — "You can also include a subject field, a message, and multiple recipients in the To, Cc, and Bcc fields." Example: mailto:foo@example.com?cc=bar@example.com&subject=Greetings%20from%20Cupertino!&body=Wish%20you%20were%20here!

### CMP-ENCODING-PLUS-SPACE — One encoder for every client: `encodeURIComponent`, never `URLSearchParams`
- **Brief:** Not addressed (§5.5 compose links, all clients).
- **Verdict:** Extended — high confidence. The rules come from the WHATWG URL and HTML standards and Chromium source; the OWA behaviour comes from the unofficial 2021 mirror; all were checked by local experiment. The verifier upheld this.
- **Finding:** The `+` sign is the main trap.
  - **(a) Form serialisation turns spaces into `+`.** `URLSearchParams` and form serialisation encode a space as `+`. WHATWG URL: "URLSearchParams objects will percent-encode anything in the application/x-www-form-urlencoded percent-encode set, and will encode U+0020 SPACE as U+002B (+)".
  - **(b) RFC 6068 treats `+` as a literal plus.** Browsers' own mailto form submission therefore rewrites `+` to `%20`. WHATWG HTML, "Mail with headers": "Replace occurrences of U+002B PLUS SIGN characters (+) in headers with the string "%20"".
  - **(c) HTTPS consumers decode `+` as a space.** Gmail does, and OWA's parser replaces `/\+/g` with `%20` before `decodeURIComponent`.
  - **Hence one encoder for all clients:** `pct(s) = encodeURIComponent(s)`.
    - It turns spaces into `%20` and `+` into `%2B`, and escapes `& = ? # % / : ; , @`.
    - Optionally also escape `!'()*` for strict RFC 3986, because `encodeURIComponent` leaves them bare.
    - Never use `URLSearchParams`, and never insert a `+` by hand.
  - **Line breaks.** Normalise `\r\n|\r|\n`:
    - to CRLF (`%0D%0A`) inside `mailto:` URIs, including the inner mailto for Outlook;
    - to LF (`%0A`) for Gmail https parameters.
  - **Lone surrogates.** Run `s.toWellFormed()` first. `encodeURIComponent` throws `URIError` "URI malformed" on a lone surrogate (verified on Node 22).
- **Design consequence:**
  - Ship the `pct()`, `pctAddr()` and `eol()` helpers in one module with unit tests.
  - Lint-ban `URLSearchParams` in that module.
- **Open risk:** The research record lists no open risk. One addition, not from the research record: the experiments ran on Node 22. Confirm that the deployed runtime provides `String.prototype.toWellFormed` (an ES2024 method), or polyfill it.
- **Sources:**
  - https://url.spec.whatwg.org/#component-percent-encode-set — RFC/standard (WHATWG URL) — "URLSearchParams objects will percent-encode anything in the application/x-www-form-urlencoded percent-encode set, and will encode U+0020 SPACE as U+002B (+)." ; urlencoded parser: "Replace any 0x2B (+) in name and value with 0x20 (SP)." ; "The component percent-encode set is a percent-encode set consisting of the userinfo percent-encode set and U+0024 ($) to U+0026 (&), inclusive, U+002B (+), and U+002C (,)."
  - https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#submit-mailto-headers — RFC/standard (WHATWG HTML) — "Mail with headers": "Let headers be the result of running the application/x-www-form-urlencoded serializer with pairs and encoding." "Replace occurrences of U+002B PLUS SIGN characters (+) in headers with the string \"%20\"."
  - https://github.com/ladifire-opensource/outlook.live.com_modules/blob/master/outlook_modules/owa-querystring/src/index.ts — community, non-authoritative (unofficial 2021 OWA mirror) — "qsParts[i].replace(regexp, '%20') where const regexp = /\+/g"
  - https://github.com/chromium/chromium/blob/main/base/strings/escape.cc — official SDK source (Chromium browser source) — "// Everything except alphanumerics and !'()*-._~ ... static const Charmap kQueryCharmap"
  - local://scratchpad/compose/exp/run.mjs — local experiment — "new URLSearchParams({body:\"a b+c\"}).toString() → \"body=a+b%2Bc\"; \"body=\"+encodeURIComponent(\"a b+c\") → \"body=a%20b%2Bc\"; encodeURIComponent(\"!'()*\") → \"!'()*\"; pct(\"!'()*\") → \"%21%27%28%29%2A\"; querystring.parse(\"body=a+b%2Bc\") → {body:\"a b+c\"}; new URL(\"https://x.test/?body=a+b%2Bc\").searchParams.get(\"body\") → \"a b+c\"; encodeURIComponent(\"a\\uD800b\") → URIError \"URI malformed\"; encodeURIComponent(\"a\\uD800b\".toWellFormed()) → \"a%EF%BF%BDb\""
  - local://scratchpad/verify_compose/chromium_translate.mjs — local experiment — "pct('a\\uD800b') (compose.mjs) throws URIError 'URI malformed'; encodeURIComponent('a\\uD800b'.toWellFormed()) = 'a%EF%BF%BDb'; kQueryCharmap escape set == encodeURIComponent for all 128 ASCII chars."

### CMP-URL-LENGTH-LIMITS — The ~1,800-character threshold is sound; apply it per client to the final URL
- **Brief:** §5.5: "If the encoded URL exceeds about 1,800 characters, fall back to a 'copy reply' page."
- **Verdict:** Extended — medium confidence.
  - The browser, HTTP and IIS numbers are official.
  - Gmail and Outlook on the web publish no limit. The 1,800 threshold is therefore a conservative engineering choice, not a vendor-documented number.
  - The verifier upheld this.
- **Finding:**
  - **Official numbers:**
    - **Chrome:** URLs are capped at 2 MB (`url::kMaxURLChars = 2*1024*1024`; "Chrome limits URLs to a maximum length of 2MB"). The omnibox displays up to 32 kB.
    - **Firefox:** `network.standard-url.max-length = 1048576` ("The maximum allowed length for a URL - 1MB default").
    - **Internet Explorer (retired):** 2,083 characters.
    - **Microsoft Azure DevOps docs (legacy guidance):** "Most browsers enforce a limit of between 2,000 and 2,083 characters for a URL string".
    - **HTTP:** RFC 9110 §4.1 recommends supporting "at a minimum, URIs with lengths of 8000 octets". Servers may return 414 URI Too Long.
    - **IIS request-filtering defaults:** `maxQueryString` 2048 bytes and `maxUrl` 4096 bytes. This is a Microsoft-stack reference; Outlook's front-door limits are not published.
  - **The historical `mailto:` hand-off limit on Windows.** Chromium and Mozilla used to refuse external-protocol URLs longer than 2048 characters ("IE 5 and 6 support URLS of 2083 chars in length, 2K is safe" … `kMaxUrlLength = 2048`). Current Chromium and Firefox sources (fetched 2026-10-01) no longer contain that cap.
  - **No vendor limit.** Gmail and Outlook on the web publish no limit (unverifiable), and RFC 6068 sets none.
  - **Community data points:**
    - A 2026-08-19 test against `outlook.live.com` found that an 8000-character `body` arrives intact, and that IIS returned a plain `Bad Request` page only beyond about 31,145 characters.
    - Another project states that "both transports truncate SILENTLY past ~2,000 chars" and uses 1,800 as its own limit.
  - **Assessment:**
    - About 1,800 sits below every documented ceiling, including the strictest legacy ones (2,048 and 2,083) and IIS's default 2,048-byte query string.
    - It also leaves headroom for sign-in redirect wrappers.
    - Keep it as `COMPOSE_URL_LIMIT = 1800`, and apply it per client to the final encoded string that is actually redirected to.
  - **Measured with the reference builder (local experiment):**
    - A 124-word English draft plus a `bcc` gives `mailto:` 1,193, Gmail 1,206 and Outlook `mailtouri` 1,569 characters.
    - The longest English draft under 1,800 is about 207 words for `mailto:`, about 205 for Gmail and about 154 for Outlook `mailtouri`.
    - Non-Latin scripts blow up, because each UTF-8 byte costs 3 characters, or 5 when double-encoded. A 30-word Hindi body gives `mailto:` 1,427 and Outlook `mailtouri` 2,381.
- **Design consequence:**
  - Compute each client's URL. If `url.length > 1800`, that button routes to the copy-reply page, which shows the subject, body, recipient and BCC address, each with a copy button.
  - The Outlook URL is the longest, so an Outlook owner hits the fallback first, at about 150+ English words.
  - Do not use word count as a proxy, because non-Latin drafts can exceed the limit at about 30 words.
  - Keep the threshold in config.
  - Derived from the measurements above: with the §5.4 cap of 120 words, English drafts fit every client (TV3: 124 words gives at most 1,569 characters). Non-Latin drafts can still exceed the limit.
- **Open risk:**
  - Gmail and Outlook server-side limits, and any silent truncation, are unpublished. The figure of 1,800 is a conservative engineering choice.
  - **WIRE_UP:** send one draft just under 1,800 characters through each client and check that it arrives complete.
- **Sources:**
  - https://chromium.googlesource.com/chromium/src/+/main/docs/security/url_display_guidelines/url_display_guidelines.md — official docs source repo (Chromium docs) — "In general, the *web platform* does not have limits on the length of URLs (although 2^31 is a common limit). *Chrome* limits URLs to a maximum length of **2MB** for practical reasons and to avoid causing denial-of-service problems in inter-process communication." "On most platforms, Chrome’s omnibox limits URL display to **32kB**"
  - https://github.com/chromium/chromium/blob/main/url/url_constants.h — official SDK source (Chromium browser source) — "lines 69-71: '// Max GURL length passed between processes. ...' 'inline constexpr size_t kMaxURLChars = 2 * 1024 * 1024;'"
  - https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/StaticPrefList.yaml — official SDK source (Firefox browser source) — "# The maximum allowed length for a URL - 1MB default. - name: network.standard-url.max-length type: RelaxedAtomicUint32 value: 1048576"
  - https://learn.microsoft.com/en-us/sql/reporting-services/application-integration/integrating-reporting-services-using-url-access-web-application — official docs source repo (renders to the public docs URL; MicrosoftDocs/sql-docs) — "Internet Explorer has a maximum URL length of 2,083 characters."
  - https://learn.microsoft.com/en-us/azure/devops/boards/queries/using-queries — official docs source repo (renders to the public docs URL; MicrosoftDocs/azure-devops-docs) — "Most browsers enforce a limit of between 2,000 and 2,083 characters for a URL string."
  - https://www.rfc-editor.org/rfc/rfc9110#section-4.1 — RFC/standard (read from a GitHub mirror) — §4.1: "It is RECOMMENDED that all senders and recipients support, at a minimum, URIs with lengths of 8000 octets in protocol elements." §15.5.15 "414 URI Too Long"
  - https://learn.microsoft.com/en-us/iis/configuration/system.webserver/security/requestfiltering/requestlimits/ — official docs source repo (renders to the public docs URL) — "| `maxQueryString` | ... Specifies the maximum length of the query string, in bytes. ... The default value is `2048`. |" "| `maxUrl` | ... Specifies maximum length of the URL, in bytes. ... The default value is `4096`. |"
  - https://github.com/chromium/chromium/blob/main/chrome/browser/platform_util_win.cc — official SDK source (Chromium browser source) — "Historical copies (e.g. endlessm/chromium-browser, kiwibrowser/src.next) of this file contained: \"// According to Mozilla in uriloader/exthandler/win/nsOSHelperAppService.cpp: \\\"Some versions of windows (Win2k before SP3, Win XP before SP1) crash in ShellExecute on long URLs ... IE 5 and 6 support URLS of 2083 chars in length, 2K is safe.\\\" ... const size_t kMaxUrlLength = 2048;\" — the current main OpenExternalOnWorkerThread has no length check (fetched 2026-10-01)."
  - https://github.com/InteractionDesignFoundation/add-event-to-calendar-docs/blob/main/services/outlook-web.md — community, non-authoritative — "Measured against `outlook.live.com` on 2026-08-19, an 8000 character `body` arrives in the compose form intact" ; table: 30 975 -> 200, 31 145 -> 200, 31 161 -> 400; "Past that the host answers with a plain `Bad Request` page from IIS"
  - https://github.com/Branden574/StockPilot/blob/HEAD/packages/core/src/email/outlook-compose.ts — community, non-authoritative — "/** Conservative compose-link ceiling; both transports truncate SILENTLY past ~2,000 chars. 1,800 leaves headroom for tenant redirect wrappers. */ export const DRAFT_URL_LIMIT = 1800;"
  - local://scratchpad/compose/exp/run.mjs — local experiment — "run.mjs T3 (124 words incl. booking link) → mailto 1193, gmail 1206, outlook mailtouri work 1569, personal 1564."
  - local://scratchpad/compose/exp/curve.mjs — local experiment (re-run by the verifier) — "120w 1113/1132/1467, 160w 1423/1442/1857, 200w 1739/1758/2253, Hindi 30w 1427/1446/2381; max English words under 1800: mailto 207, gmail 205, outlook_mailtouri 154."

### CMP-REDIRECT-IMPLEMENTATION — Pass 302 explicitly, and use an interstitial page for `mailto:`
- **Brief:** §5.5: "/a/{token}/send … records the click … redirects (302) to a compose URL".
- **Verdict:** Extended — medium confidence. The Next.js and Chromium behaviour comes from their official source; the "blank tab" behaviour and Safari/iOS handling are not source-verified. The verifier upheld this.
- **Finding:**
  - **Next.js redirect default.** In Next.js 14.2.35, `NextResponse.redirect(url, init)` defaults to 307 (`init.status ?? 307`). Pass 302 explicitly: `NextResponse.redirect(url, 302)`.
  - **The Location header.** It is set to `validateURL(url)`, which is `String(new URL(String(url)))`.
    - Our pct-encoded Gmail, Outlook and `mailto:` strings are unchanged by that WHATWG normalisation and by `Response.redirect` (local experiment).
    - A raw `'` in an https query, by contrast, would be rewritten to `%27`. That is another reason to pre-escape.
  - **Chromium and `mailto:`.**
    - Chromium launches `mailto:` without a confirmation prompt: "The mailto scheme is allowed explicitly because of its ubiquity on the web and because every platform provides a default handler for it".
    - Its anti-flood guard blocks repeated external-protocol launches ("Not allowed to launch … because a user gesture is required.").
  - **Use an interstitial for `mailto:`.**
    - A bare 302 to `mailto:` leaves the user on a blank tab.
    - For the `mailto:` and mobile path, prefer a tiny 200 interstitial page with an `<a href="mailto:…">` "Open mail app" button, plus auto-navigation and a "Copy reply" link.
    - Use a plain 302 for Gmail and Outlook web.
- **Design consequence:**
  - **Route handler:**
    1. Record the click.
    2. Choose the target from the client setting and the UA.
    3. If the URL length is OK: Gmail and Outlook use `NextResponse.redirect(url, 302)`, and `mailto:` gets a 200 HTML interstitial.
    4. Otherwise, show the copy-reply page.
  - Unit-test the status code and the Location string byte for byte.
- **Open risk:**
  - Safari/iOS handling of a 302 to `mailto:` was not verified here; the interstitial avoids depending on it.
  - The "blank tab" behaviour is stated in the research answer without a quoted source.
  - **WIRE_UP:** if a Next.js 14.x version other than 14.2.35 is pinned, re-check the redirect default. Click through the interstitial on iOS Safari and Android Chrome.
- **Sources:**
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/server/web/spec-extension/response.ts — official SDK source (Next.js framework source) — "dist/server/web/spec-extension/response.js: \"static redirect(url, init) { const status = typeof init === \\\"number\\\" ? init : (init == null ? void 0 : init.status) ?? 307; ... headers.set(\\\"Location\\\", (0, _utils.validateURL)(url));\" ; dist/server/web/utils.js: \"function validateURL(url) { try { return String(new URL(String(url)));\"" (line 95 of response.js holds the `?? 307` default)
  - https://github.com/chromium/chromium/blob/main/chrome/browser/external_protocol/external_protocol_handler.cc — official SDK source (Chromium browser source) — "// The mailto scheme is allowed explicitly because of its ubiquity on the web // and because every platform provides a default handler for it. if (scheme == \"mailto\") { ... return DONT_BLOCK; }" ; "\"Not allowed to launch '\" + url.possibly_invalid_spec() + \"'\" + (g_accept_requests ? \".\" : \" because a user gesture is required.\")"
  - local://scratchpad/compose/exp/run.mjs — local experiment — "For T1–T3: new URL(x).href === x for mailto, Gmail and Outlook URLs (whatwg_href_unchanged all true); Response.redirect(olWork,302).headers.get(\"location\") === olWork and same for mailto (true); new URL(\"https://x.test/?a=it's\").href → \"https://x.test/?a=it%27s\""

### CMP-RECIPIENT-SAFETY — Validate lead addresses before building any compose link
- **Brief:** Not addressed (§5.5 compose links built from lead form data; §5.4 drafts).
- **Verdict:** Extended — high confidence.
  - The RFC rules are official.
  - OWA's recipient splitting comes from the unofficial 2021 OWA mirror and was confirmed by a local experiment.
  - The verifier upheld this.
- **Finding:**
  - **The lead's email is untrusted,** because it comes from a public form.
  - **Recipient splitting.** OWA splits recipient strings on `/[,;]/` after decoding, and Gmail and RFC 6068 split on `,`. A value such as `a@x.com;evil@y.com` therefore becomes two recipients, even when the `;` is percent-encoded. Verified: `decodeURIComponent('a%40x.com%3Bb%40y.com').split(/[,;]/)` → `['a@x.com','b@y.com']`.
  - **Validate `to` and `bcc`** as one bare addr-spec before building:
    - no display name;
    - reject whitespace and `, ; < > " ( ) [ ] \ ? & = # %`, plus control characters;
    - 254 characters or fewer.
  - **Encode** everything except `@`.
  - **Subject line breaks.** Collapse CR and LF in the subject to spaces ("Line breaks in other <hfield>s SHOULD NOT be used").
  - **Never emit** `from`, `date` or `content-*` hfields.
  - **`bcc` visibility.** RFC 6068 §7: `bcc` values are visible to anyone who sees the URI. That is acceptable here, because the URI opens in the owner's own browser, but do not log full URLs.
- **Design consequence:**
  - **Zod schema for compose input:**
    - `to` is a single email (strict regex, and none of `[,;\s<>"]`);
    - `bcc` is optional, with the same rule;
    - `subject` is a single line of 255 characters or fewer;
    - `body` is plain text.
  - Never log compose URLs, because they contain lead PII and draft content.
- **Open risk:** None recorded.
- **Sources:**
  - https://github.com/ladifire-opensource/outlook.live.com_modules/blob/master/outlook_modules/owa-recipient-email-address/src/utils/processRecipientsFromUrlParameter.ts — community, non-authoritative (unofficial 2021 OWA mirror) — "const RECIPIENT_SPLIT_REGEX = /[,;]/; ... const splitRecipients = rawRecipients.split(RECIPIENT_SPLIT_REGEX);" ; "if (isValidSmtpAddress(recipient)) {...} else { // Check if the recipient text includes a display name along with the SMTP address ... const addressAndName = getDisplayNameAndAddressFromRecipientString(recipient);"
  - https://www.rfc-editor.org/rfc/rfc6068 — RFC/standard — §5 "Line breaks in other <hfield>s SHOULD NOT be used." ; §7 "This applies to all mail addresses that are part of the 'mailto' URI, including the addresses in a \"bcc\" <hfvalue>." ; §3 "Originator fields like From and Date, ... and MIME header fields (MIME-Version, Content-*), when present in the URI, MUST be ignored."
  - local://scratchpad/compose/exp/run.mjs — local experiment — "node -e: decodeURIComponent('a%40x.com%3Bb%40y.com').split(/[,;]/) → [ 'a@x.com', 'b@y.com' ]"

### CMP-BUILDER-SPEC — Reference builder rules and golden tests
- **Brief:** Not addressed (§5.5 compose links: implementation rules and tests).
- **Verdict:** Extended — medium confidence. The verifier corrected the original finding:
  1. The spec text says `pct` uses `s.toWellFormed()`, but the experiment's `compose.mjs` does not; production must.
  2. The `outlook_personal` base drops `/0/` by default.
  3. The Outlook mode must be configurable, with `mailtouri` as the default and plain parameters as the fallback.
  4. Gmail `bcc` was verified first-hand only on the `/mail/u/0/?…&tf=cm` form, so the Gmail form must be configurable.
  5. Add IDN-to-punycode conversion for address domains.
  6. The "second form decode" showing `jane leads@example.com` is a simulation, not a reproduction of OWA behaviour.
- **Finding:** The builder rules (final):
  ```text
  pct(s)       = encodeURIComponent(s.toWellFormed()).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  pctAddr(a)   = pct(local-part) + '@' + domainToASCII(domain)          // '@' stays literal; IDN domain -> punycode
  addrList(xs) = xs.map(pctAddr).join(',')
  eol(s, x)    = s.replace(/\r\n|\r|\n/g, x)
  oneLine(s)   = s.replace(/\r\n|\r|\n/g, ' ')

  mailto(m) = 'mailto:' + addrList(m.to) + '?' +
              [cc && 'cc=' + addrList(cc), bcc && 'bcc=' + addrList(bcc),
               'subject=' + pct(oneLine(subject)), 'body=' + pct(eol(body, '\r\n'))].filter(Boolean).join('&')

  gmail(m)  = GMAIL_FORM === 'tf'
    ? 'https://mail.google.com/mail/' + (confirmedAccount ? 'u/' + pctAddr(acct) + '/' : 'u/0/') + '?to=...&cc=...&bcc=...&su=...&body=...&tf=cm'
    : 'https://mail.google.com/mail/' + (confirmedAccount ? 'u/' + pctAddr(acct) + '/' : '')   + '?view=cm&fs=1&to=...&cc=...&bcc=...&su=...&body=...'
    // su = pct(oneLine(subject)); body = pct(eol(body, '\n'))  (body LF)

  outlook(m, kind) = OUTLOOK_MODE === 'mailtouri'
    ? OUTLOOK_BASE[kind] + '?mailtouri=' + pct(mailto(m))
    : OUTLOOK_BASE[kind] + '?to=...&cc=...&bcc=...&subject=...&body=...'
  OUTLOOK_BASE = { outlook_work:     'https://outlook.cloud.microsoft/mail/deeplink/compose',
                   outlook_personal: 'https://outlook.live.com/mail/deeplink/compose' }   // all in env config
  ```
  - **Parameter names per client:**
    - **Gmail:** `to`, `cc`, `bcc`, `su` and `body`, plus `view=cm&fs=1` or `tf=cm`.
    - **Outlook:** `mailtouri`; the inner mailto puts `to` in the path and uses `cc`, `bcc`, `subject` and `body`.
    - **`mailto:`:** `to` in the path, then `cc`, `bcc`, `subject` and `body`.
  - **Target selection in `/a/{token}/send`:**
    - a phone UA or mail client `other` gets the `mailto:` interstitial;
    - `gmail` gets `gmail()`;
    - `outlook_*` gets `outlook()`;
    - sovereign-cloud Outlook owners get `mailto:` (CMP-OUTLOOK-HOSTS);
    - if the chosen URL is longer than 1,800 characters, the copy-reply page is shown instead.
  - **The secondary link.** "Open in default mail app" should also go through `/a/{token}/send?via=mailto`. That records the click and keeps long hrefs out of the notification email.
  - **Golden tests:**
    - the TV1–TV3 vectors in 06.2, with `outlook_personal` adjusted for the base change;
    - a lone-surrogate input;
    - an IDN-domain input.
  - **Two details from the experiment's builder (`compose.mjs`):**
    - It emits `subject=` and `body=` only when they are non-empty.
    - Its `pctAddr` was `pct(a.trim()).replace(/%40/g, '@')`, which matches the final rule for ASCII domains.
- **Design consequence:**
  - Port `compose.mjs` to TypeScript (`lib/compose-links.ts`), with the vectors below as golden Vitest cases.
  - Add a property test: random Unicode strings, including `+ & ? # % =` and CR/LF, must round-trip through `rfc6068Decode`, `URLSearchParams` and the OWA-parser copies.
- **Open risk:**
  - Vendor-side behaviour (Gmail, OWA) can only be confirmed by manual testing on real accounts.
  - The OWA round-trip check uses 2021 client-code copies whose use on the deeplink route is unproven.
- **Sources:**
  - local://scratchpad/compose/exp/run.mjs — local experiment — "run.mjs checks for T1, T2, T3 all true: check_mailto_rfc6068 (RFC-style decode returns original to/bcc/subject/body), check_gmail_form (URLSearchParams decode returns originals, body LF-normalised), check_outlook_mailtouri_owa (OWA outer+inner parser copies return originals)." Verifier re-run (Node v22.22.0): "out.verify.json JSON-identical to original out.json; every quoted vector string matched byte-for-byte."
  - local://scratchpad/verify_compose/chromium_translate.mjs — local experiment — "T1/T2 Outlook mailtouri vectors equal Chromium's registerProtocolHandler substitution (EscapeQueryParamValue) for OWA's template; compose.mjs pct() throws URIError on lone surrogate."

### 06.1 Verifier-added items

#### CMP-OUTLOOK-LEGACY-OWA — Legacy OWA compose URLs (`/owa/?path=/mail/action/compose`, `/owa/?rru=compose`): do not use
- **Brief:** Not addressed. This is an implicit alternative to the §5.5 Outlook compose URL.
- **Resolves:** [VERIFY] §5.5 current URL formats (Outlook web). It rejects an alternative form.
- **Verdict:** Not officially documented — low confidence. The verifier gave no confidence grade; this rests only on community reports.
- **Finding:**
  - **Not recommended.** The legacy forms are `https://outlook.office.com/owa/?path=/mail/action/compose&to=...` and `/owa/?rru=compose&to=...`.
  - **No official documentation.** The Microsoft blog the gist originally cited (blogs.msdn.microsoft.com/carloshm/2016/01/16/...) has been deleted ("MS deleted the blog entry").
  - **Reported broken.** Community reports say the `owa/?path=/calendar/action/compose` variant stopped working in 2021.
  - **Current integrations have moved.** The gist author (2021) and the cal-invite changelog both moved to `/mail|calendar/deeplink/compose`.
  - Use only the `deeplink/compose` forms in CMP-OUTLOOK-PARAMS-BCC and CMP-OUTLOOK-HOSTS.
- **Design consequence:** Do not implement or configure the `/owa/` forms. The Outlook builder emits only `…/mail/deeplink/compose`.
- **Open risk:** None beyond those of the `deeplink/compose` forms.
- **Sources:**
  - https://gist.github.com/miwebguy/2e805e343e0d434f06f2194b92b925d8 — community, non-authoritative — PPetky, Jun 5, 2021: "MS deleted the blog entry"; PPetky, Sep 13, 2021: "looks like https://outlook.office.com/owa/?path=/calendar/action/compose not working anymore"; miwebguy, Sep 16, 2021: "New Mail Link https://outlook.office.com/mail/deeplink/compose" ... "(Still not finding official documentation)"
  - https://github.com/DashAPI-ai/cal-invite/blob/HEAD/CHANGELOG.md — community, non-authoritative — "fix stale deep-link URLs. Switched from the legacy `outlook.live.com/calendar/0/action/compose` and `outlook.office.com/owa/` hosts to the currently documented `outlook.live.com/calendar/deeplink/compose` and `outlook.office.com/calendar/deeplink/compose`"
  - https://github.com/mems/calepin/blob/HEAD/Web/Websites.md — community, non-authoritative — "lines 2846-2858: navigator.registerProtocolHandler(\"mailto\", \"https://outlook.office.com/mail/deeplink/compose?mailtouri=%s\", \"Outlook\"); ... `https://outlook.office.com/owa/?rru=compose&to={to}&subject={subject}&body={body}&cc={cc}`"

#### CMP-MAILTO-APP-LENGTH — Length limits for `mailto:` in mail apps: none published
- **Brief:** §5.5: "If the encoded URL exceeds about 1,800 characters, fall back to a 'copy reply' page." This item covers the `mailto:` hand-off to mail apps.
- **Verdict:** Not officially documented — low confidence. The verifier gave no confidence grade; there are no official numbers.
- **Finding:**
  - **No official numbers** were found for any mail app (Outlook desktop, Apple Mail, Gmail or Outlook mobile), and RFC 6068 defines none.
  - **The old browser limit is gone.** Chromium and Mozilla used to refuse external-protocol URLs longer than 2048 characters on Windows, citing IE's 2,083. Current Chromium and Firefox no longer have that limit.
  - **Unsupported community figure.** Community planning docs repeat "~2,000 chars on some systems" without evidence.
  - **Conclusion.** This is unverifiable officially. Apply the same 1,800 threshold to the `mailto:` URL and route longer drafts to copy-reply.
- **Design consequence:** The per-client 1,800 check in CMP-URL-LENGTH-LIMITS also covers the `mailto:` URL, including the secondary "Open in default mail app" link.
- **Open risk:** Mail-app limits are unknown. **WIRE_UP:** open a `mailto:` link just under 1,800 characters in each supported mail app and confirm that the body arrives complete.
- **Sources:**
  - https://github.com/endlessm/chromium-browser/blob/master/chrome/browser/platform_util_win.cc — community, non-authoritative (historical Chromium copy, mirror) — "line 98 '// support URLS of 2083 chars in length, 2K is safe.\"' line 101 'const size_t kMaxUrlLength = 2048;' line 102 'if (escaped_url.length() > kMaxUrlLength)'"
  - https://github.com/chromium/chromium/blob/main/chrome/browser/platform_util_win.cc — official SDK source (Chromium browser source) — "Current OpenExternalOnWorkerThread: 'std::string escaped_url = url.spec(); escaped_url.insert(0, \"\\\"\"); ... ShellExecuteA(NULL, \"open\", escaped_url.c_str(), ...)' - no length check"
  - https://github.com/CobyGayer/Q5-Recruit-AI/blob/HEAD/docs/email-integration-research.md — community, non-authoritative — "'Mailto has ~2,000 char limit on some systems.' (no evidence given)"

### 06.2 Test vectors

**Provenance:**
- **No vendor vectors.** Google, Microsoft and the IETF publish no compose-link test vectors.
- **How the vectors below were made.** They were generated locally by the research reference builder (`scratchpad/compose/exp/compose.mjs`, Node 22), which is not an official SDK.
- **Verifier recheck.** The verifier re-ran the builder and reproduced every string byte for byte.
- **Chromium cross-check.** The TV1 and TV2 Outlook `mailtouri` vectors are also byte-identical to a local re-implementation of Chromium's `EscapeQueryParamValue` substitution, the browser's own mailto-handler contract, built from official Chromium source.
- **Known gaps:**
  - The `outlook_personal` vectors below use the old `/0/` base. The derived vectors further down use the new default base.
  - `compose.mjs` does not call `toWellFormed()`, so a lone-surrogate golden case must be added. The expected output is in "Encoding contrasts".
  - The "second form decode" result (`jane leads@example.com`) is a simulation of the office-js #4127 failure, not a reproduction of OWA behaviour.

**Research vectors (verbatim):**

```text
Builder = scratchpad/compose/exp/compose.mjs (Node 22). All outputs below are exact.

TV1 input: to=["jane@example.com"], subject="Re: Your enquiry", body="Hi Jane,\n\nThanks for reaching out.\n\nBest,\nSam"
 mailto (142): mailto:jane@example.com?subject=Re%3A%20Your%20enquiry&body=Hi%20Jane%2C%0D%0A%0D%0AThanks%20for%20reaching%20out.%0D%0A%0D%0ABest%2C%0D%0ASam
 gmail (161): https://mail.google.com/mail/?view=cm&fs=1&to=jane@example.com&su=Re%3A%20Your%20enquiry&body=Hi%20Jane%2C%0A%0AThanks%20for%20reaching%20out.%0A%0ABest%2C%0ASam
 gmail account=sam@acme.com: https://mail.google.com/mail/u/sam@acme.com/?view=cm&fs=1&to=jane@example.com&su=Re%3A%20Your%20enquiry&body=Hi%20Jane%2C%0A%0AThanks%20for%20reaching%20out.%0A%0ABest%2C%0ASam
 outlook_work (256): https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=mailto%3Ajane%40example.com%3Fsubject%3DRe%253A%2520Your%2520enquiry%26body%3DHi%2520Jane%252C%250D%250A%250D%250AThanks%2520for%2520reaching%2520out.%250D%250A%250D%250ABest%252C%250D%250ASam
 outlook_personal (251): https://outlook.live.com/mail/0/deeplink/compose?mailtouri=mailto%3Ajane%40example.com%3Fsubject%3DRe%253A%2520Your%2520enquiry%26body%3DHi%2520Jane%252C%250D%250A%250D%250AThanks%2520for%2520reaching%2520out.%250D%250A%250D%250ABest%252C%250D%250ASam
 (NOT recommended) outlook plain params: https://outlook.cloud.microsoft/mail/deeplink/compose?to=jane@example.com&subject=Re%3A%20Your%20enquiry&body=Hi%20Jane%2C%0A%0AThanks%20for%20reaching%20out.%0A%0ABest%2C%0ASam

TV2 input: to=["jane+leads@example.com"], bcc=["log-1234@bcc.example.net"], subject="Q&A: 50% off? #1 = best + more", body="C++ & C#; 1+1=2 ?x=y#frag %20 literal 'q' \"dq\" (p) *s* !b café — naïve 😀\r\nline2\rline3"
 mailto (326): mailto:jane%2Bleads@example.com?bcc=log-1234@bcc.example.net&subject=Q%26A%3A%2050%25%20off%3F%20%231%20%3D%20best%20%2B%20more&body=C%2B%2B%20%26%20C%23%3B%201%2B1%3D2%20%3Fx%3Dy%23frag%20%2520%20literal%20%27q%27%20%22dq%22%20%28p%29%20%2As%2A%20%21b%20caf%C3%A9%20%E2%80%94%20na%C3%AFve%20%F0%9F%98%80%0D%0Aline2%0D%0Aline3
 gmail (354): https://mail.google.com/mail/?view=cm&fs=1&to=jane%2Bleads@example.com&bcc=log-1234@bcc.example.net&su=Q%26A%3A%2050%25%20off%3F%20%231%20%3D%20best%20%2B%20more&body=C%2B%2B%20%26%20C%23%3B%201%2B1%3D2%20%3Fx%3Dy%23frag%20%2520%20literal%20%27q%27%20%22dq%22%20%28p%29%20%2As%2A%20%21b%20caf%C3%A9%20%E2%80%94%20na%C3%AFve%20%F0%9F%98%80%0Aline2%0Aline3
 outlook_work (538): https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=mailto%3Ajane%252Bleads%40example.com%3Fbcc%3Dlog-1234%40bcc.example.net%26subject%3DQ%2526A%253A%252050%2525%2520off%253F%2520%25231%2520%253D%2520best%2520%252B%2520more%26body%3DC%252B%252B%2520%2526%2520C%2523%253B%25201%252B1%253D2%2520%253Fx%253Dy%2523frag%2520%252520%2520literal%2520%2527q%2527%2520%2522dq%2522%2520%2528p%2529%2520%252As%252A%2520%2521b%2520caf%25C3%25A9%2520%25E2%2580%2594%2520na%25C3%25AFve%2520%25F0%259F%2598%2580%250D%250Aline2%250D%250Aline3
 outlook_personal (533): same as outlook_work with base https://outlook.live.com/mail/0/deeplink/compose
 Round-trip: RFC-6068 decode of mailto, URLSearchParams decode of gmail, and OWA outer+inner parser copies of outlook all return the original to/bcc/subject/body (line breaks normalised). Plain-param Outlook to= after OWA decode = "jane+leads@example.com"; after a second form decode = "jane leads@example.com" (the #4127 failure).

TV3 (length): to=jane.doe@acme-industries.com, bcc=12345678@bcc.example-crm.com, subject="Re: Kitchen remodel enquiry", 124-word / 782-char English body incl. https://meetings.hubspot.com/sam-smith/intro?utm_source=autopilot → mailto 1193, gmail 1206, outlook_work 1569, outlook_personal 1564 chars (all < 1800).
Length curve (same headers, body 'Hi Jane,\n\n' + N words + '\n\nBest,\nSam'): N=120 → 1113/1132/1467 (mailto/gmail/outlook); N=160 → 1423/1442/1857; N=200 → 1739/1758/2253; Hindi N=30 → 1427/1446/2381; max English N under 1800: 207/205/154.

Encoding contrasts: new URLSearchParams({body:'a b+c'}).toString() = "body=a+b%2Bc" (WRONG for mailto); 'body='+encodeURIComponent('a b+c') = "body=a%20b%2Bc" (RIGHT); pct("!'()*") = "%21%27%28%29%2A"; querystring.parse('body=a+b%2Bc') = {body:'a b+c'}; encodeURIComponent('a\uD800b') throws URIError 'URI malformed'; after toWellFormed() = "a%EF%BF%BDb".
```

**Verifier recheck (verbatim; only the closing sentence that gives a local scratch path to the review JSON is omitted):**

```text
Re-executed scratchpad/compose/exp/run.mjs and curve.mjs with Node v22.22.0: run.mjs output (saved as compose/exp/out.verify.json) is JSON-identical to the original out.json. Every quoted vector string in test_vectors matched byte-for-byte (TV1 mailto/gmail/gmail-account/outlook_work/outlook_personal/plain; TV2 mailto/gmail/outlook_work; outlook_personal = outlook_work with the live.com/0 base, 533 chars). Lengths reproduce: TV1 142/161/176/256/251/177, TV2 326/354/538/533/341, TV3 1193/1206/1569/1564/1189; curve 120w 1113/1132/1467, 160w 1423/1442/1857, 200w 1739/1758/2253, Hindi 30w 1427/1446/2381, max English words under 1800 = 207/205/154; all round-trip checks true; encoding contrasts identical. New experiment verify_compose/chromium_translate.mjs: Chromium kQueryCharmap == encodeURIComponent for all ASCII; the Outlook mailtouri vectors for T1/T2 equal Chromium's registerProtocolHandler substitution for OWA's template exactly; pct() in compose.mjs throws URIError on a lone surrogate (spec text promises toWellFormed()). Caveats: the OWA round-trip check uses 2021 client-code copies whose use on the deeplink route is unproven, and the '#4127 second decode' result is a simulation. If the personal Outlook base drops '/0/', outlook_personal vectors become 249 (TV1), 531 (TV2) and 1562 (TV3) chars (computed).
```

**Derived vectors for the new default personal Outlook base** (`https://outlook.live.com/mail/deeplink/compose`, no `/0/`). These were generated locally in this write-up by swapping the base in the verified `out.json` strings; the rest of each string is identical to `outlook_work` after the base. The lengths match the verifier's computed 249, 531 and 1562 characters.

```text
TV1 outlook_personal, no index (249): https://outlook.live.com/mail/deeplink/compose?mailtouri=mailto%3Ajane%40example.com%3Fsubject%3DRe%253A%2520Your%2520enquiry%26body%3DHi%2520Jane%252C%250D%250A%250D%250AThanks%2520for%2520reaching%2520out.%250D%250A%250D%250ABest%252C%250D%250ASam
TV2 outlook_personal, no index (531): https://outlook.live.com/mail/deeplink/compose?mailtouri=mailto%3Ajane%252Bleads%40example.com%3Fbcc%3Dlog-1234%40bcc.example.net%26subject%3DQ%2526A%253A%252050%2525%2520off%253F%2520%25231%2520%253D%2520best%2520%252B%2520more%26body%3DC%252B%252B%2520%2526%2520C%2523%253B%25201%252B1%253D2%2520%253Fx%253Dy%2523frag%2520%252520%2520literal%2520%2527q%2527%2520%2522dq%2522%2520%2528p%2529%2520%252As%252A%2520%2521b%2520caf%25C3%25A9%2520%25E2%2580%2594%2520na%25C3%25AFve%2520%25F0%259F%2598%2580%250D%250Aline2%250D%250Aline3
TV3 outlook_personal, no index: 1562 chars
```

**Decode-side vectors from published examples.** These are published by a standard body or a vendor and were checked locally against `compose.mjs` on Node v22.22.0 in this write-up.
- **RFC 6068 §6.1 example** (published by the standard). `compose.mjs` produces it exactly from `to=["infobot@example.com"], body="send current-issue\r\nsend index"`:
  ```text
  mailto:infobot@example.com?body=send%20current-issue%0D%0Asend%20index
  ```
- **Apple Mail Links example** (published by the vendor). It leaves `!` bare, which RFC 6068 `some-delims` allows. Our `pct` escapes `!` as `%21`, so the builder output differs by byte but decodes to the same `cc`, `subject` and `body`. Use the Apple string as a parser or decoder test, not as a builder golden.
  ```text
  published: mailto:foo@example.com?cc=bar@example.com&subject=Greetings%20from%20Cupertino!&body=Wish%20you%20were%20here!
  builder:   mailto:foo@example.com?cc=bar@example.com&subject=Greetings%20from%20Cupertino%21&body=Wish%20you%20were%20here%21
  decoded (both): {"cc":"bar@example.com","subject":"Greetings from Cupertino!","body":"Wish you were here!"}
  ```
