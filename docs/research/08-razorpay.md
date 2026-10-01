## 08. Razorpay Subscriptions and webhooks

Razorpay signs every webhook with `X-Razorpay-Signature`, a lowercase-hex HMAC-SHA256 of the raw request body keyed with the per-webhook secret (not the API key secret). That confirms the §5.10 [VERIFY], and four signature test vectors, one of them published by Razorpay, reproduce with the official `razorpay@2.9.8` helper, `node:crypto` and `openssl`. razorpay.com was blocked in the sandbox (curl CONNECT 403, WebFetch EGRESS_BLOCKED), so every docs page was read from Razorpay's official docs export `github.com/razorpay/markdown-docs` (commit `ab3bda5f11c308034b2089df532df1064db1df7c`, auto-synced 2026-04-09), which renders to the `razorpay.com/docs/...` URLs cited below; no web-search snippets were used. Subscriptions have nine documented statuses and ten `subscription.*` webhook events. Delivery is at-least-once and unordered, and some transitions (`created` → `expired`, a failed authentication payment) fire no webhook at all, so status must also be reconciled with `GET /v1/subscriptions/{id}`. The §3 "hosted checkout" is the Subscription Link (`short_url`) returned by `POST /v1/subscriptions`, the 14-day no-card trial maps onto a future `start_at`, and charging USD $49 needs International Cards activation, which in turn needs more website policy pages than the brief plans.

**The sources correct the brief in four places:**
1. **§7 "timestamps checked" (for Razorpay):** Razorpay sends no signed timestamp header. The only time is the body field `created_at`, retries arrive for up to 24 hours after event creation, and Razorpay-initiated replays cover events up to 15 days old, so a 5-minute freshness window would reject legitimate deliveries. Replay protection comes from event-id and body-hash dedupe, monotonic per-subscription application and a `created_at` sanity window (RZP-WH-REPLAY-TIMESTAMP).
2. **§5.10 checkout guard:** "never block on `created`" is right, but blocking only on `active` and `halted` is incomplete. `authenticated`, `pending` and `paused` are live subscriptions too, and a second checkout would create a second mandate. For `created`, reuse the stored `short_url` (RZP-SUB-DECLINED-CREATED-GUARD).
3. **§10 WIRE_UP step 7 "fails silently":** the same-generation requirement for key ID and key secret is right, but Razorpay's docs do not support "silently". With server-side Subscription Links a mismatched pair fails loudly at create time ("The api key provided is invalid"). The genuinely quiet failures are elsewhere (RZP-API-KEYS).
4. **§5.13 legal pages (a gap rather than a contradiction):** activating International Cards, which USD pricing needs, requires Terms and Conditions, Privacy, Refund and Cancellation, and Shipping policy pages. The brief plans only `/privacy` and `/terms`, and Razorpay may reject "TODO: legal review" placeholders (RZP-USD-INTERNATIONAL).

**The sources extend the brief with:**
- **Webhook delivery:** return 2XX within 5 seconds; failures are retried with exponential backoff for 24 hours, after which the webhook is disabled. Dedupe on the unsigned `x-razorpay-event-id` header plus a UNIQUE `sha256(rawBody)`, because the documented body has no event id (RZP-WH-IDEMPOTENCY-EVENT-ID, RZP-WH-RETRY-TIMEOUT).
- **Our own verifier:** the SDK helper uses a plain `===` comparison and accepts a forgery when the secret is empty (RZP-WH-SIGNATURE).
- **Statuses and events:** nine statuses, including `paused`, which the entity enum and the SDK type omit; a possible undocumented `resumed`. Ten event names, empty `notes` serialised as `[]`, an unreliable `contains` array and `short_url: null` in webhooks (RZP-SUB-STATUSES, RZP-SUB-WEBHOOK-EVENTS-PAYLOAD).
- **Reconciliation:** transitions with no webhook mean a reconcile job must call `GET /v1/subscriptions/{id}` (08.1 V1).
- **The 3-day grace:** Razorpay's own `pending` state covers retries on T+1, T+2 and T+3, then `halted`, so the grace period should follow status, not a timer (RZP-SUB-PENDING-HALTED-RETRY, RZP-STATUS-MAPPING).
- **Checkout and plan:** the Subscription Link flow (no documented return URL); Flash Checkout and Subscriptions must be enabled; the create-subscription and create-plan fields (USD `4900` cents, `monthly`, `interval` 1; plans are immutable and mode-scoped) (RZP-CHECKOUT-HOSTED, RZP-SUB-CREATE-FIELDS, RZP-PLAN-CREATE).
- **Trial:** subscribe mid-trial with `start_at = trial_end` and treat `authenticated` as entitled (RZP-TRIAL-START-AT).
- **Cancel, pause, resume, fetch:** the endpoints, the SDK `cancel()` boolean gotcha, and cardholders who can pause, resume or cancel from their bank's portal (RZP-SUB-CANCEL-PAUSE-RESUME-FETCH).
- **SDK caveats:** no request timeout, network errors surface as a `TypeError`, and the type definitions are wrong in places (RZP-SDK-PACKAGE).
- **WIRE_UP step 7:** run once per mode (Test, then Live), make the webhook secret mandatory, add the Subscriptions → Settings → Card toggle, and use the documented test cards (RZP-WIRE-UP-WEBHOOK).

### RZP-WH-SIGNATURE — Webhook signature: header, algorithm, key and SDK helper
- **Brief:** §5.10 "`POST /api/razorpay/webhook` verifies the signature **[VERIFY]**"; §7 "Webhook signatures verified (HubSpot, QStash, Razorpay)".
- **Resolves:** [VERIFY] §5.10 Razorpay webhook signature
- **Verdict:** Confirmed — high confidence
- **Finding:**
  - **Header:** `X-Razorpay-Signature`. Read it case-insensitively; in Next.js, `req.headers.get("x-razorpay-signature")`.
  - **Value:** lowercase hex HMAC-SHA256.
    - **Key:** the WEBHOOK secret, an arbitrary string you type when creating the webhook in the Dashboard. The docs say "The webhook secret does not need to be the Razorpay API key secret".
    - **Message:** the RAW request body bytes. The docs say "Do not parse or cast the webhook request body". JSON re-serialisation changes the signature; vector B proves it (pretty-printed body → false).
  - **The secret is optional on Razorpay's side:** "Entering the secret is optional but recommended", and Razorpay signs only "When your webhook `secret` is set". A webhook saved without a secret therefore arrives unsigned.
  - **Secret rotation:** Razorpay retries older events signed with the OLD secret: "If you have changed your webhook secret, remember to use the old secret for webhook signature validation while retrying older requests".
  - **Official helper** (`razorpay@2.9.8`, latest on npm): `validateWebhookSignature(body: string, signature: string, secret: string): boolean`. It is exposed two ways:
    - (a) `import Razorpay from "razorpay"; Razorpay.validateWebhookSignature(rawBody, sig, secret)`. This is the static method; the package is CJS `export = Razorpay` and needs `esModuleInterop`, which Next.js enables.
    - (b) `const { validateWebhookSignature } = require("razorpay/dist/utils/razorpay-utils")`. The package has no `"exports"` map, so in plain Node ESM the deep import must include `.js`; without it Node throws `ERR_MODULE_NOT_FOUND`.
  - **Helper implementation:** `crypto.createHmac("sha256", secret).update(body.toString()).digest("hex") === signature`. This is a plain `===`, not a constant-time comparison; the official PHP SDK, by contrast, uses `hash_equals` "to mitigate timing attacks". Uppercase hex is rejected.
  - **Helper edge cases:**
    - it throws its own `Error("Invalid Parameters: ...")` only when an argument is `undefined`;
    - a `null` signature returns false;
    - a `null` secret throws a Node `TypeError` from `crypto.createHmac`;
    - a `null` body throws a `TypeError` on `.toString()`.
  - **Security gap (proven locally):** with an EMPTY secret, the helper accepts a forged HMAC keyed with `""` (accepted = true).
- **Design consequence:** In the route handler, call `const raw = await req.text()` BEFORE any `JSON.parse`; verify, then `JSON.parse(raw)` and Zod. Write our own verifier, which keeps the SDK out of the edge path and fixes its weaknesses:
  - refuse to start (or return 500) if `RAZORPAY_WEBHOOK_SECRET` is empty;
  - check the header matches `/^[0-9a-f]{64}$/`;
  - compute the hex HMAC and compare with `crypto.timingSafeEqual(Buffer.from(expected,"hex"), Buffer.from(sig,"hex"))`;
  - support an optional `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` (try both) for rotation.

  Use the SDK helper only as the oracle in unit tests (vectors in 08.2), and run the route on the Node.js runtime (`node:crypto`).
- **Open risk:** None material. The docs pages were read from the official razorpay/markdown-docs export because razorpay.com is blocked here; the export was last synced 2026-04-09. During WIRE_UP, re-read the live validate-test page and confirm that a real Test-mode delivery, signed with the configured secret, passes our verifier.
- **Sources:**
  - https://razorpay.com/docs/webhooks/validate-test/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/validate-test.md` @ab3bda5) — L80: "This hash signature is passed with each request under the `X-Razorpay-Signature` header that you need to validate at your end." L85: "The hash signature is calculated using HMAC with SHA256 algorithm; with your webhook secret set as the key and the webhook request body as the message." L107: "ensure that the webhook body passed as an argument is the **raw webhook request body**. **Do not parse or cast the webhook request body**." L82: "use the old secret for webhook signature validation while retrying older requests."
  - https://razorpay.com/docs/webhooks/validate-test/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/validate-test.md` @ab3bda5, byte-identical to raw.githubusercontent.com master on 2026-10-01) — L80: "When your webhook `secret` is set, Razorpay uses it to create a hash signature with each payload."
  - https://razorpay.com/docs/webhooks/setup-edit-payments/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/setup-edit-payments.md` @ab3bda5) — L44-45: "Entering the secret is optional but recommended." / "The webhook secret does not need to be the Razorpay API key secret."
  - https://github.com/razorpay/razorpay-node/blob/master/lib/utils/razorpay-utils.js — official SDK source — "function validateWebhookSignature (body, signature, secret) { ... body = body.toString(); var expectedSignature = crypto.createHmac('sha256', secret).update(body).digest('hex'); return expectedSignature === signature; }"
  - https://github.com/razorpay/razorpay-node/blob/master/lib/razorpay.js — official SDK source — "static validateWebhookSignature (...args) { return validateWebhookSignature(...args); }"
  - https://github.com/razorpay/razorpay-node/blob/master/lib/utils/razorpay-utils.d.ts — official SDK source — "export function validateWebhookSignature(body: string, signature: string, secret: string): boolean"
  - https://github.com/razorpay/razorpay-php/blob/master/src/Utility.php — official SDK source — "verifySignature: $expectedSignature = hash_hmac(self::SHA256, $payload, $secret); // Use lang's built-in hash_equals if exists to mitigate timing attacks ... $verified = hash_equals($expectedSignature, $actualSignature);"
  - https://www.npmjs.com/package/razorpay/v/2.9.8 — local experiment — "Ran razorpay@2.9.8 on node v22.22.0: Razorpay.validateWebhookSignature and deep import both true for valid sig; validateWebhookSignature('{"event":"subscription.activated"}', '8d5d9f09e43d30e59e4bb9610080ca577b42035adb6784d6dbeee5ff186489a2', '') === true (empty-secret forgery accepted); null signature -> false; ESM import without .js -> ERR_MODULE_NOT_FOUND"
  - https://www.npmjs.com/package/razorpay/v/2.9.8 — local experiment — "Re-ran with SDK utils loaded from the npm-packed tarball (npm/razorpay-2.9.8/package/dist/utils/razorpay-utils.js), node v22.22.0: null_sig -> false; undefined sig -> throws 'Invalid Parameters: Please give request body,signature sent in X-Razorpay-Signature header and webhook secret from dashboard as parameters'; null secret -> throws TypeError 'The "key" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey. Received null'; empty-secret forgery 8d5d9f09...89a2 -> true. ESM: import Razorpay from 'razorpay' static -> true; 'razorpay/dist/utils/razorpay-utils.js' -> true; without .js -> ERR_MODULE_NOT_FOUND."

### RZP-WH-TEST-VECTORS — Known-good webhook and checkout signature vectors
- **Brief:** Not addressed. Relates to §8 "signature verification with known vectors" and the §5.10 webhook.
- **Verdict:** Extended — high confidence
- **Finding:** Four positive vectors and one forgery vector, listed in full in 08.2:
  - **Vector A** (Razorpay's own documented example, reproduced):
    - secret `"123456"`;
    - body = `JSON.stringify(<payment.captured sample in razorpay-node documents/paymentVerfication.md>)`, 983 bytes, sha256 `986651c07d2a3e46d95cff0f9947a12f5c77b00d47c83c30be9f5c0283463b1b`;
    - → `55d3c166391ec51285b388f1bb9f0ba9b13dde1bece4484aaac6edd34a01459a` (SDK: true).
  - **Vector B** (`subscription.activated`, exact raw body in `vectors/razorpay/B.body`, 781 bytes):
    - secret `"autopilot_webhook_secret_test"`;
    - → `295edb02518396f42f7568c942c21def25aa3a7bb2a92cff001c25d6344d7bbc` (SDK utils true, static true, Buffer body true);
    - negatives, all false: pretty-printed re-serialisation, wrong secret, UPPERCASE hex, trailing `"\n"`.
  - **Vector C** (UTF-8 body containing `"Café Zürich ₹"`, 178 bytes, in `C.body`):
    - secret `"s3cr3t-ütf8"`;
    - → `4542d47ca6c160fb1323f7650cc30a070241d9d3afe9b2ea1601568bf3b25ac3`.
  - **Vector D** (Standard Checkout subscription payment signature, keyed with the KEY SECRET):
    - message `"pay_TESTPAY000001|sub_TESTSUB000001"`, key_secret `"testkeysecret0000000000"`;
    - → `e877a2b95c3e1d1d5b9001ba8af2be9dd2129026e99137d5626667610a96d353` (SDK `validatePaymentVerification` true).
  - **Empty-secret forgery:** body `'{"event":"subscription.activated"}'`, secret `""` → `8d5d9f09e43d30e59e4bb9610080ca577b42035adb6784d6dbeee5ff186489a2`. The SDK accepts it; our verifier must reject it.
  - **Cross-checks:** B, C and D were cross-checked with `openssl dgst -sha256 -hmac`, and the verifier reproduced all of them independently.
- **Design consequence:** Copy `B.body` and `C.body` byte for byte into test fixtures. Do not reformat them; vector B is a single-line JSON string with no trailing newline. Store B's body sha256 (`b17497e95dc61a3a75cddd63778f4cf2dd248f4a109d0b3349f11e9193defc56`) in the fixture so a reformatted fixture is caught. Include the negative cases as tests:
  - re-serialised body;
  - key_secret used instead of the webhook secret;
  - uppercase hex;
  - trailing newline;
  - empty secret, which OUR verifier must reject even though the SDK accepts it.
- **Open risk:** Vectors B–D and the empty-secret vector were generated locally with the official helper (the algorithm is deterministic); only vector A is a Razorpay-published value.
- **Sources:**
  - https://github.com/razorpay/razorpay-node/blob/master/documents/paymentVerfication.md — official SDK source — "var xRazorpaySignature = "55d3c166391ec51285b388f1bb9f0ba9b13dde1bece4484aaac6edd34a01459a" var webhookSecret = "123456"; validateWebhookSignature(JSON.stringify(payload), xRazorpaySignature, webhookSecret)"
  - https://www.npmjs.com/package/razorpay/v/2.9.8 — local experiment — "Generated by razorpay-vectors.js with require("razorpay") and require("razorpay/dist/utils/razorpay-utils") from razorpay@2.9.8; outputs listed in answer; openssl cross-check printed identical digests 295edb02..., 4542d47c..., e877a2b9..."
  - https://www.npmjs.com/package/razorpay/v/2.9.8 — local experiment — "vecA.js eval()s the `var payload = {...}` block from documents/paymentVerfication.md -> {"len":983,"sha256":"986651c07d2a3e46d95cff0f9947a12f5c77b00d47c83c30be9f5c0283463b1b","hmac":"55d3c166391ec51285b388f1bb9f0ba9b13dde1bece4484aaac6edd34a01459a"}; recheck.js: B_len 781, B_sha256 b17497e95dc61a3a75cddd63778f4cf2dd248f4a109d0b3349f11e9193defc56, B_hmac 295edb02..., C_hmac 4542d47c..., D e877a2b9..., all SDK checks true, negatives false; `openssl dgst -sha256 -hmac autopilot_webhook_secret_test < B.body` -> 295edb02518396f42f7568c942c21def25aa3a7bb2a92cff001c25d6344d7bbc"

### RZP-WH-IDEMPOTENCY-EVENT-ID — Dedupe on `x-razorpay-event-id` (an unsigned header)
- **Brief:** §6 "`webhook_events` (`eventId` unique)".
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Delivery:** Razorpay delivers at-least-once, and duplicates are "expected behaviour".
  - **Dedupe key:** the request header `x-razorpay-event-id`; "The value for this header is unique per event" and "can help you determine the duplicity of a webhook event".
  - **No body id:** the documented event body has NO id field. The envelope is `entity`, `account_id`, `event`, `contains`, `payload`, `created_at`. The event id therefore exists only in an UNSIGNED header; the signature covers the body only.
  - **Format:** the event id format is undocumented, so store it as text with no length or format assumption.
  - **Ordering:** event order is not guaranteed ("you may not always receive the webhooks in the order").
- **Design consequence:**
  - `webhook_events.event_id` = header `x-razorpay-event-id` (UNIQUE, `text`).
  - Because the header is not covered by the HMAC, also store `sha256(rawBody)` with a UNIQUE index, so a replayed signed body with a fresh header id is still caught. If the header is missing, fall back to the body hash.
  - Make state application idempotent and monotonic: per subscription, keep `last_event_created_at` and ignore events older than the last applied one. The simplest order-proof alternative is to treat the webhook as a trigger and set status from `GET /v1/subscriptions/{id}`.
  - Respond 200 for duplicates.
- **Open risk:** The docs do not state the exact format of the event id, nor say explicitly that retries reuse it (implied by "unique per event ... determine the duplicity"). During WIRE_UP, check on a real retried Test-mode delivery that the header value repeats.
- **Sources:**
  - https://razorpay.com/docs/webhooks/validate-test/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/validate-test.md` @ab3bda5) — L112-115: "There could be scenarios where your endpoint might receive the same webhook event multiple times. This is an expected behaviour ... You can identify the duplicate webhooks using the `x-razorpay-event-id` header. The value for this header is unique per event." Order section: "you may not always receive the webhooks in the order."
  - https://razorpay.com/docs/webhooks/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/faqs.md` @ab3bda5) — L109: "Check the value of `x-razorpay-event-id` in the webhook request header. The value for this header is unique per event and can help you determine the duplicity of a webhook event."
  - https://razorpay.com/docs/webhooks/best-practices/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/best-practices.md` @ab3bda5) — L48: "Razorpay follows at-least-once delivery semantics. ... if we do not receive a successful response from your server, we resend the webhook."
  - https://razorpay.com/docs/webhooks/subscriptions/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/subscriptions.md` @ab3bda5) — "Every sample envelope: {"entity": "event", "account_id": ..., "event": ..., "contains": [...], "payload": {...}, "created_at": ...} - no event id in body"

### RZP-WH-RETRY-TIMEOUT — 5-second response, 24-hour retries, auto-disable, replay and URL rules
- **Brief:** Not addressed. Relates to the §5.10 webhook and §5.12 admin ("last webhook received").
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Response deadline:** the handler must return 2XX within 5 seconds; any non-2xx or a timeout counts as a failure.
  - **Retries and disabling:** failed deliveries are retried with exponential backoff for 24 hours after event creation. If failures continue for 24 hours, the webhook is DISABLED and an email goes to the Alert Email (or, if none was set, to the account email). You must re-enable the webhook in the Dashboard.
  - **Manual replay:** you can ask Razorpay to replay events up to 15 days old, and only if the webhook was enabled when the event occurred. There is no bulk replay.
  - **Limits and URL rules:**
    - up to 30 webhook URLs per account (Payments);
    - the URL must be public, on ports 80/443 only, with TLS 1.2+ (production rejects TLS 1.0 and 1.1);
    - the URL cannot contain "razorpay" as a domain;
    - tunnel and inspection hosts are blacklisted, including `ngrok.io`, `loca.lt`, `webhook.site` and `requestbin.com`; for localhost the docs suggest `zrok`.
  - **IP allowlisting:** the docs also say "Ensure Razorpay webhook IPs are whitelisted on your server". Vercel has no inbound firewall, so this needs no action. Do NOT add an IP allowlist in middleware unless we also maintain Razorpay's published IP list (`security/whitelists.md#webhook-ips`).
  - **Modes:** Test-mode and Live-mode webhooks are configured separately. The default OTP in Test mode is `754081`.
- **Design consequence:** Keep the handler fast: verify → insert the `webhook_events` row → apply status (single DB transaction) → 200. Never call Resend or Anthropic inline.
  - Return 200 for unknown or ignored event types and for duplicates.
  - Return 401 for a bad signature. Razorpay will retry for 24 h, then disable the webhook and email you, which serves as the misconfiguration alarm.
  - Admin page: show the last webhook received per mode, and alert if no webhook has arrived for N days while subscriptions are active.
  - WIRE_UP: configure the webhook separately in Test and Live mode.
- **Open risk:** The exact backoff intervals are not published. During WIRE_UP, confirm the Dashboard's webhook form still enforces these URL rules.
- **Sources:**
  - https://razorpay.com/docs/webhooks/setup-edit-payments/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/setup-edit-payments.md` @ab3bda5) — L95: "All webhook responses must return a status code in the range `2XX` within a window of 5 seconds." Next para: "re-tried at progressive intervals of time, defined in the exponential back-off policy, for 24 hours. If the failures continue for 24 hours, the webhook is disabled."
  - https://razorpay.com/docs/webhooks/best-practices/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/best-practices.md` @ab3bda5) — L13: "we retry the delivery in exponential backoff policy for 24 hours after event creation timestamp." L48: "fails to respond in 5 seconds. In such cases, the session is marked timeout."
  - https://razorpay.com/docs/webhooks/best-practices/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/best-practices.md` @ab3bda5) — L27: "In case you have not provided an **Alert Email Address** during webhook set up, we send a mail to the email address configured under **Account & Settings** on the Dashboard."
  - https://razorpay.com/docs/webhooks/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/faqs.md` @ab3bda5) — Q5: "The webhook event should not be older than 15 days." / "Currently, bulk replaying of webhook events is not possible." Q1: "For Payments, you can create up to 30 different webhook URLs."
  - https://razorpay.com/docs/webhooks/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/faqs.md` @ab3bda5) — Q5: "The webhook should be enabled on the dashboard during the occurrence of this event." / "The webhook event should not be older than 15 days." Q8: "Razorpay Production environment does not support the older versions of TLS 1.0 and 1.1"
  - https://razorpay.com/docs/webhooks/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks.md` @ab3bda5) — L55: "Webhook URLs must use ports **80** or **443** only."
  - https://razorpay.com/docs/webhooks/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks.md` @ab3bda5) — L56: "Ensure Razorpay webhook IPs are whitelisted on your server."
  - https://razorpay.com/docs/webhooks/validate-test/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/validate-test.md` @ab3bda5) — "Blacklisted Domains list includes `ngrok.io`, `loca.lt`, `webhook.site`, `requestbin.com`; "Enter the default OTP `754081` when prompted ... in test mode.""

### RZP-WH-REPLAY-TIMESTAMP — No signed timestamp; what "timestamps checked" means for Razorpay
- **Brief:** §7 "Webhook signatures verified (HubSpot, QStash, Razorpay) and timestamps checked."
- **Verdict:** Corrected — high confidence
- **Finding:**
  - **No timestamp header:** none is documented for Razorpay webhooks. The docs name only `X-Razorpay-Signature` and `x-razorpay-event-id`. Across all the official Razorpay repos in the corpus, the only other `X-Razorpay-*` headers are the request-side `X-Razorpay-Account` and `X-Razorpay-Device-Mode`; no timestamp header appears.
  - **The only time field:** the body field `created_at` (Unix seconds, event creation), which IS inside the signed body.
  - **Why a short window fails:** a tight HubSpot-style 5-minute freshness window would reject legitimate deliveries. Retries arrive for up to 24 hours after event creation, and Razorpay-initiated replays cover events up to 15 days old.
- **Design consequence:** For Razorpay, the "timestamp check" runs after signature verification and rejects the event if `body.created_at > now + 300s` (clock skew) or if it is older than 16 days. The 16-day bound is our design choice, not a Razorpay rule. Replay protection comes from:
  1. UNIQUE `x-razorpay-event-id`;
  2. UNIQUE `sha256(raw body)`;
  3. monotonic per-subscription application (ignore an event whose `created_at` is older than the last applied one), or re-fetching the subscription from the API.

  Document this deviation from §7 in DECISIONS.md.
- **Open risk:** The header list is inferred from the docs. Razorpay may send other undocumented headers, but none of them are signed. During WIRE_UP, log the header names (never the values) of one real Test-mode delivery to confirm.
- **Sources:**
  - https://razorpay.com/docs/webhooks/validate-test/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/validate-test.md` @ab3bda5) — "Validate Webhooks section names only `X-Razorpay-Signature`; Idempotency section names only `x-razorpay-event-id`."
  - https://razorpay.com/docs/webhooks/best-practices/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/best-practices.md` @ab3bda5) — "we retry the delivery in exponential backoff policy for 24 hours after event creation timestamp."
  - https://razorpay.com/docs/webhooks/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/faqs.md` @ab3bda5) — "The webhook event should not be older than 15 days." (replay criteria)
  - https://razorpay.com/docs/webhooks/subscriptions/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/subscriptions.md` @ab3bda5) — "Envelope sample ends with `"created_at": 1592811255` at top level (event creation time)."
  - https://github.com/razorpay/markdown-docs — local experiment — "grep -rhoi 'x-razorpay-[a-z-]*|HTTP_X_RAZORPAY_[A-Z_]*' over corpus-extra/razorpay_* (markdown-docs, razorpay-php, razorpay-python, woocommerce, woocommerce-subscriptions, cli, mcp-server) -> X-Razorpay-Account (16), HTTP_X_RAZORPAY_SIGNATURE (15), X-Razorpay-Signature (14), x-razorpay-event-id (6), X-Razorpay-Device-Mode (2); no timestamp header."

### RZP-SUB-STATUSES — The nine subscription statuses and their transitions
- **Brief:** §5.10 "maps subscription statuses". The brief mentions `active`, `halted` and `created`, plus the internal `trialing`.
- **Verdict:** Extended — high confidence
- **Finding:** Nine statuses are documented in `states.md`:
  - **`created`:** set on creation. An immediate-start subscription stays here until the first charge succeeds, then goes straight to `active`. A trial or future-start subscription with an add-on stays `created` until the add-on is processed.
  - **`authenticated`:** the customer completed the authentication transaction for a future `start_at` (i.e. a trial without an add-on). It moves to `active` when the billing cycle starts.
  - **`active`:** the billing cycle is running. It is entered from:
    - `created` (immediate start);
    - `authenticated` (`start_at` reached);
    - `pending` or `halted` (a successful retry, a card change or a manual charge of an older invoice);
    - `paused` (resume).
  - **`pending`:** an auto-charge failed. Razorpay retries, and the customer may change card.
  - **`halted`:** retries are exhausted. Invoices are still generated but not auto-charged. It returns to `active` only after a card change or a successful manual charge, and earlier missed charges are not re-attempted.
  - **`paused`:** reachable only from `active`; pausing an `authenticated` subscription CANCELS it. Who can pause (see `pause_initiated_by`):
    - the business, via API or Dashboard;
    - UPI customers, via their UPI app;
    - cardholders, from their bank's portal, per Cards FAQ Q10, which also lets them resume or cancel.
  - **`cancelled`:** terminal, cannot be restarted. It can be set by API or Dashboard, by UPI customers, or by cardholders through the bank portal (see `cancel_initiated_by`).
  - **`completed`:** terminal; all billing cycles are done.
  - **`expired`:** terminal; `start_at` was set and authentication was not done by `start_at`.

  **Documentation inconsistencies:**
  - The entity reference enum and the SDK type list only 8 values (no `paused`).
  - The webhook table says `subscription.resumed` moves the subscription "to the `resumed` state", but the sample payload shows `"status": "active"` and `states.md` has no `resumed` state.

  Parse status as an open string. Map an unexpected `resumed` to active, and any other unknown value to inactive plus an admin alert.
- **Design consequence:** The Zod schema must include all nine values plus a catch-all (`z.string()`) for forward compatibility; do not rely on the SDK type. Mapping:
  - `created` / `expired` → not subscribed;
  - `authenticated` / `active` → entitled;
  - `pending` → entitled (grace);
  - `halted` / `paused` / `cancelled` / `completed` → inactive.
- **Open risk:** The docs inconsistently omit `paused` from enums. Treat unknown statuses as inactive and alert the admin. During WIRE_UP, confirm in Test mode that `GET /v1/subscriptions/{id}` returns `"paused"` for a paused subscription, and that a resumed one returns `"active"`, not `"resumed"`.
- **Sources:**
  - https://razorpay.com/docs/payments/subscriptions/states/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/states.md` @ab3bda5) — L27: "The Subscription with an immediate start date remains in the `created` state till the first charge is made and moves to the `active` state after the first charge." L119: "If you pause a Subscription in the `authenticated` state, the Subscription goes to the `cancelled` state." Expired: "If the `start_at` time for the Subscription has been set and the authentication transaction has not been done by the `start_at` time, the Subscription moves to the `expired` state and cannot be used again." Cancelled: "Once cancelled, a Subscription cannot be restarted." Halted: "Once the Subscription moves to the `active` state from the `halted` state, the previous charges are not re-attempted."
  - https://razorpay.com/docs/api/payments/subscriptions/entity/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/entity.md` @ab3bda5) — "`status` Possible values: `created` `authenticated` `active` `pending` `halted` `cancelled` `completed` `expired` (no paused)"
  - https://razorpay.com/docs/webhooks/subscriptions/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/subscriptions.md` @ab3bda5) — "subscription.paused sample: "status": "paused", "pause_initiated_by": "self"; subscription.resumed sample: "status": "active""
  - https://razorpay.com/docs/webhooks/subscriptions/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/subscriptions.md` @ab3bda5) — Event table: "`subscription.resumed`| Sent when a subscription is resumed and moved to the `resumed` state." vs sample L629: "status": "active"
  - https://razorpay.com/docs/payments/subscriptions/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/faqs.md` @ab3bda5) — Cards Q10: "Yes, cardholders can pause, resume and cancel active Subscriptions from the portal provided by the bank to manage them. You will get notifications through multiple webhooks when a cardholder initiates any such changes to the Subscriptions."
  - https://github.com/razorpay/razorpay-node/blob/master/lib/types/subscriptions.d.ts — official SDK source — "status: | 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'cancelled' | 'completed' | 'expired';"
  - https://github.com/razorpay/razorpay-node/blob/master/documents/subscription.md — official SDK source — "Pause response: "status": "paused", "paused_at": 1590280581, "pause_initiated_by": "self""

### RZP-SUB-DECLINED-CREATED-GUARD — What a declined card does, and the corrected checkout guard
- **Brief:** §5.10 "Checkout guard: block a new checkout only when the status is `active` or `halted`. Never block on `created`; that permanently locks out users whose card was declined."
- **Verdict:** Corrected — medium confidence
- **Finding:**
  - **A declined or failed authentication payment does not change the subscription's status:**
    - an immediate-start subscription stays `created` until the first charge succeeds (`states.md`);
    - a future-start subscription stays `created`, and becomes `expired` if authentication is not completed by `start_at`.
  - **No webhook (inferred):** the documented webhook list has no event for a failed authentication, so only payment-level events would fire. This is inferred by omission.
  - **Retry on the same link (inferred):** the customer can retry on the same `short_url` while `expire_by` has not passed. This follows from the `expire_by` definition, "till when the customer can make the authorisation payment" (default 30 years).
  - **Unusable IDs:** the integration guide treats only cancelled or expired `subscription_id`s as unusable at checkout.
  - **eMandate FAQ sentence:** "If the payment still fails, the Subscription remains in the `created` state" belongs to Emandate FAQ Q6 and concerns eMandate registration, where registration and the first debit cannot happen on the same day. It is not evidence about declined cards.
  - **Verdict on the brief:** "never block on `created`" is correct, but the guard is incomplete. `authenticated` (mandate given, future start), `pending` (Razorpay still retrying), `halted` (dues outstanding) and `paused` (resumable) are all live subscriptions, and a second checkout would create a second mandate.
  - **Cancel API:** it documents only `active` and `authenticated` as cancellable ("Ensure that the Subscription is in the active or authenticated state to cancel"; expired → "Subscription is not cancellable in expired status."). Whether a `created` subscription can be cancelled is undocumented.
  - **Corrected guard:**
    - BLOCK on {`authenticated`, `active`, `pending`, `halted`, `paused`};
    - ALLOW on no subscription, or on {`created`, `expired`, `cancelled`, `completed`};
    - on `created`, REUSE the stored `short_url` while `expire_by` is still in the future.
- **Design consequence:**
  - BLOCK a new checkout when the latest subscription status is in {authenticated, active, pending, halted, paused}. For `pending` and `halted`, show "Update payment method" instead of a new checkout. That button uses the existing subscription's stored `short_url`, which Razorpay's hosted page uses to retry or change the card.
  - ALLOW when there is no subscription, or the status is in {created, expired, cancelled, completed}.
  - On `created`: reuse the newest `created` subscription (same plan, `expire_by` in the future) and redirect to its stored `short_url` instead of minting a new one. Pass `expire_by` (e.g. now + 7 days) so abandoned subscriptions expire.
  - Safety net: if `subscription.activated` or `subscription.charged` arrives for a second live subscription on the same account, cancel the newer one immediately (`cancel_at_cycle_end=false`) and alert the admin.
  - Store `short_url` at creation time, because webhook payloads often have `"short_url": null`.
  - Record the guard change in DECISIONS.md.
- **Open risk:**
  - Whether a `created` subscription can be cancelled via the API is undocumented.
  - The minimum allowed `expire_by` is undocumented.
  - Recovering a `halted` subscription through the original `short_url` is documented for the Dashboard flow only.
  - During WIRE_UP, verify in Test mode: a declined card leaves the subscription `created` and the same `short_url` can be retried; a `created` subscription can or cannot be cancelled; the `halted` → card change → `active` path works through the stored link.
- **Sources:**
  - https://razorpay.com/docs/payments/subscriptions/states/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/states.md` @ab3bda5) — L27: "remains in the `created` state till the first charge is made"
  - https://razorpay.com/docs/payments/subscriptions/states/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/states.md` @ab3bda5) — Expired: "If the `start_at` time for the Subscription has been set and the authentication transaction has not been done by the `start_at` time, the Subscription moves to the `expired` state and cannot be used again."
  - https://razorpay.com/docs/api/payments/subscriptions/create-subscription/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/create-subscription.md` @ab3bda5) — `expire_by` _optional_: "Unix timestamp that indicates till when the customer can make the authorisation payment ... The default value is 30 years."
  - https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/cancel-subscription.md` @ab3bda5) — Errors: "Subscription is not cancellable in expired status." solution: "Ensure that the Subscription is in the active or authenticated state to cancel."
  - https://razorpay.com/docs/payments/subscriptions/payment-retries/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/payment-retries.md` @ab3bda5) — "Use the Dashboard status filter to search for `halted` and `pending` Subscriptions. You can send the Subscription link to the respective customers to clear dues and make those Subscriptions active."
  - https://razorpay.com/docs/payments/subscriptions/integration-guide/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/integration-guide.md` @ab3bda5) — L157: "This error also occurs if the `subscription_id` is in the cancelled/expired state."
  - https://razorpay.com/docs/payments/subscriptions/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/faqs.md` @ab3bda5) — L1112 '## Emandate' ... L1181: "### 6. The Subscription state is still `created` and not `active`, even after paying the registration payment. Why?" L1183: "This is a bank constraint as the payment and registration cannot happen on the same day." (eMandate context: not evidence about declined cards)

### RZP-SUB-PENDING-HALTED-RETRY — When `pending` and `halted` occur, and the retry schedule
- **Brief:** §5.10 "while the subscription is `active` (plus a 3-day grace period on payment failure)"; "When inactive: pause processing, show a banner and send one email."
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Cards and UPI:** the charge runs on day T. On failure the subscription moves to `pending` and a `subscription.pending` webhook fires; the webhook repeats on each failed retry. Razorpay retries on T+1, T+2 and T+3. If the charge still fails, the subscription moves to `halted` and `subscription.halted` fires.
    - The docs export strips tab labels, so mapping the three retry blocks to Emandate, UPI and Cards is inferred from the order in "Following is the retry model for Emandate, UPI and Cards". The UPI and Cards blocks are identical (T+1..T+3), so the card schedule is right either way.
  - **Emandate:** Razorpay retries only after the bank confirms or rejects, which can take more than 24 h; bank-holiday rules are T-1/T-3.
  - **Test mode:** "If you fail a charge 4 times in a row ... marked as `halted`", and each failure moves the next charge by one day.
  - **Recovery:** while `pending`, a successful retry or a card change fires `subscription.charged` and then `subscription.activated` (back to `active`).
    - "Manual charging of a domestic card is not supported", so for Indian cards, recovering from `halted` needs a card or payment-method change through the hosted update page or link, not a merchant-side manual charge.
  - **Customer emails:** with `customer_notify=true`, Razorpay emails the customer on failure with a link to update the payment method. The hosted page supports card, UPI and emandate changes ("retry the payment on the same card or update the card details or change the payment method to UPI or Emandate").
  - **Pre-debit:** for domestic cards (under ₹15,000, RBI rules), Razorpay initiates the debit about 36 h before the debit date, with a pre-debit notification.
- **Design consequence:** Implement the brief's grace period as: keep processing while status is `pending` (Razorpay's own ~3-day retry window); stop on `halted`.
  - Optionally also cap it with `grace_until` = first pending event's `created_at` + 3 days.
  - Send the single "billing inactive" email on the transition to `halted` / `cancelled` / `paused` / `completed`, not on each pending event.
  - Dedupe repeated `subscription.pending` events.
- **Open risk:** The retry cadence could change; mapping status rather than running a timer keeps us aligned. During WIRE_UP, drive pending → halted in Test mode with "Charge this now" and failing charges, and confirm the events and their order.
- **Sources:**
  - https://razorpay.com/docs/payments/subscriptions/payment-retries/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/payment-retries.md` @ab3bda5) — L73-75: "If the charge fails, the Subscription moves to the `pending` state, and we automatically reattempt the charge on T+1 day." / "two more times on T+2 and T+3 days, respectively." / "If the charge still fails, the Subscription moves to the `halted` state."
  - https://razorpay.com/docs/payments/subscriptions/payment-retries/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/payment-retries.md` @ab3bda5) — "Manual Charge on Same Card ... **Watch Out!** Manual charging of a domestic card is not supported."; Hosted page: "Customers can either retry the payment on the same card or update the card details or change the payment method to UPI or Emandate (bank accounts) using the link."
  - https://razorpay.com/docs/payments/subscriptions/test/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/test.md` @ab3bda5) — L332: "If you fail a charge 4 times in a row, all the available retries get exhausted. This results in a Subscription being marked as `halted` and the `subscription.halted` webhook event is triggered."
  - https://razorpay.com/docs/webhooks/subscriptions/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/subscriptions.md` @ab3bda5) — `subscription.pending`: "We try to charge the card on a periodic basis while it is in the `pending` state. If the payment fails again, the Webhook is triggered again."
  - https://razorpay.com/docs/payments/subscriptions/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/faqs.md` @ab3bda5) — Cards Q8: "Razorpay will initiate the debit 36 hours before the actual debit date."

### RZP-SUB-WEBHOOK-EVENTS-PAYLOAD — Event names and payload shape
- **Brief:** Not addressed. Relates to §5.10 "maps subscription statuses".
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Events (exact names):** `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.completed`, `subscription.updated`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.paused`, `subscription.resumed`.
  - **Envelope:**
    ```json
    {"entity":"event","account_id":"acc_...","event":"subscription.charged","contains":["subscription","payment"],"payload":{"subscription":{"entity":{...}},"payment":{"entity":{...}}},"created_at":<unix s>}
    ```
  - **Payment entity:** `payment` is present only if a payment attempt preceded the event (charged, completed, activated-with-charge).
    - The `contains` array is unreliable: the "Immediate start date/Upfront amount/Both" `subscription.activated` sample has `"contains": ["subscription"]`, but its payload DOES carry `payment.entity`. Key off the presence of `payload.payment`, not `contains`.
  - **Subscription entity fields seen:** `id` (`"sub_..."`), `entity` (`"subscription"`), `plan_id`, `customer_id`, `status`, `type` (int 1/2/3, undocumented, not in the entity reference), `current_start`, `current_end`, `ended_at`, `quantity`, `notes`, `charge_at`, `start_at`, `end_at`, `auth_attempts`, `total_count`, `paid_count`, `customer_notify`, `created_at`, `expire_by`, `short_url`, `has_scheduled_changes`, `change_scheduled_at`, `source`, `offer_id`, `remaining_count`, `payment_method` (`"card"`), `pause_initiated_by`, `cancel_initiated_by`.
  - **Nullable in the samples:**
    - `current_start` / `current_end` (null before activation);
    - `ended_at`;
    - `charge_at` (null when paused, cancelled or completed);
    - `expire_by`;
    - `short_url` (null in every webhook sample);
    - `change_scheduled_at`.
  - **GOTCHA:** empty notes are serialised as an empty ARRAY, `"notes": []`; non-empty notes as an object.
  - **Sequencing:** an immediate-start authentication fires `subscription.activated`, then `subscription.charged` (test guide). The webhook reference says `subscription.authenticated` is "Sent when the first payment is made", but the test guide says a future-start authentication triggers "no webhook events". Handle both.
  - **Unprompted events:** cardholders can pause, resume or cancel card subscriptions from their bank portal (Cards FAQ Q10), so `subscription.paused`, `.resumed` and `.cancelled` can arrive unprompted. Check `pause_initiated_by` and `cancel_initiated_by`, but do not depend on them.
- **Design consequence:** The Zod schema (pseudo-code, as given in the research record):
  ```ts
  envelope = {
    event: z.string(),
    created_at: z.number().int(),
    payload: { subscription: { entity: {
      id: z.string().startsWith("sub_"),
      status: z.string(),
      plan_id: z.string(),
      notes: z.union([z.record(z.union([z.string(), z.number()])), z.array(z.unknown()).length(0)]),
      current_end: z.number().nullable().optional(),
      charge_at: z.number().nullable().optional(),
      customer_id: z.string().nullable().optional(),
    }.passthrough() } },
  }.passthrough()
  ```
  - Ignore non-subscription events with 200.
  - Put our internal account UUID in the subscription `notes` at creation (e.g. `{"autopilot_account_id": "<uuid>"}`). Map webhook → account via our stored `razorpay_subscription_id` first and `notes` second.
  - Subscribe to all ten events in the Dashboard.
- **Open risk:** Field presence varies across the sample payloads in the docs, so keep the schema permissive. During WIRE_UP, capture one real Test-mode payload per event type (header names and body shape only, no values in logs) and replay it through the schema.
- **Sources:**
  - https://razorpay.com/docs/webhooks/subscriptions/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/subscriptions.md` @ab3bda5) — "Event table lists the ten events; L41: "The payload for all these events contain the subscription entity. They also contain a payment entity if a payment attempt was made before the event was triggered." subscription.authenticated sample: "notes": [], "short_url": null; subscription.charged sample: "contains": ["subscription","payment"], "type": 2"
  - https://razorpay.com/docs/webhooks/subscriptions/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/subscriptions.md` @ab3bda5) — "L139-L226 sample 'Immediate start date/Upfront amount/Both': "event": "subscription.activated", "contains": ["subscription"] while payload includes a payment entity with "status": "captured" (L187)"
  - https://razorpay.com/docs/payments/subscriptions/subscribe-to-webhooks/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/subscribe-to-webhooks.md` @ab3bda5) — "Same ten events; "Navigate to **Accounts & Settings** → **Webhooks**""
  - https://razorpay.com/docs/payments/subscriptions/test/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/test.md` @ab3bda5) — L280: "no webhook events are triggered by performing an authentication payment for **Subscription B**." Subscription A: "First, you receive the `subscription.activated` webhook ... Next, you receive the `subscription.charged` webhook"
  - https://github.com/razorpay/razorpay-woocommerce/blob/master/includes/razorpay-webhook.php — official SDK source — "const SUBSCRIPTION_CANCELLED = 'subscription.cancelled'; const SUBSCRIPTION_PAUSED = 'subscription.paused'; const SUBSCRIPTION_RESUMED = 'subscription.resumed'; const SUBSCRIPTION_CHARGED = 'subscription.charged'; ... $this->api->utility->verifyWebhookSignature($post, $_SERVER['HTTP_X_RAZORPAY_SIGNATURE'], $razorpayWebhookSecret);"

### RZP-CHECKOUT-HOSTED — "Hosted checkout" = Subscription Link (`short_url`) vs Standard Checkout
- **Brief:** §3 "Billing: Razorpay Subscriptions (hosted checkout)"; §5.10 "Checkout: Razorpay hosted checkout for `RAZORPAY_PLAN_ID`."
- **Verdict:** Extended — medium confidence
- **Finding:**
  - **Hosted = Subscription Link:** `POST /v1/subscriptions` returns `short_url` (e.g. `"https://rzp.io/rzp/Dqdqx3h"`). "Customers click the link and are taken to a checkout page hosted by Razorpay where they make the authentication payment".
    - It is server-only: no key in the browser, no checkout.js and no client-signature step. We learn about activation through webhooks or a fetch.
    - No redirect or callback parameter is documented on the create-subscription API, so the customer is not automatically returned to our site.
    - With pure Subscription Links, card and method changes go through Razorpay's failure email, its hosted "Update Payment Method" page, or a re-sent Subscription link from the Dashboard.
  - **Standard Checkout (embedded modal):**
    - Load `https://checkout.razorpay.com/v1/checkout.js` and call `new Razorpay({ key: <key_id>, subscription_id: "sub_...", name, description, callback_url | handler, prefill })`.
    - Only Standard Checkout documents `callback_url` and `handler`, plus a `subscription_card_change: true` option that lets our own page offer a card change for `pending` or `halted` subscriptions.
    - On success it returns `razorpay_payment_id`, `razorpay_subscription_id` and `razorpay_signature`. Verifying them is "a mandatory step": `generated_signature = hmac_sha256(razorpay_payment_id + "|" + subscription_id, key_secret)`, where `subscription_id` comes from OUR server ("Do not use the razorpay_subscription_id returned by Checkout").
    - SDK: `validatePaymentVerification({subscription_id, payment_id}, signature, key_secret)` (payload order `payment_id|subscription_id`).
  - **Prerequisite for BOTH flows:** Flash Checkout must be enabled (Account & Settings → Checkout Features). If it is not, checkout shows "Oops! Something went wrong. Please contact the merchant for further assistance." The same error appears when the subscription is cancelled or expired. The Subscriptions feature must also be enabled in both Test and Live mode.
  - **`notify_info`:** per `create-subscription-link.md`, `notify_info` data "will not be prefilled in the checkout as per the government guidelines".
- **Design consequence:** Recommend the Subscription Link flow: `POST /api/billing/checkout` (server) → guard → create (or reuse) the subscription → 303 redirect to `short_url`.
  - A return page, `/settings/billing?pending=1`, polls our DB (falling back to `GET /v1/subscriptions/{id}`) until a webhook flips the status.
  - This flow needs no CSP changes, no `NEXT_PUBLIC` key and no client-signature route.
  - If Standard Checkout is chosen instead:
    - add `script-src https://checkout.razorpay.com` and frame/connect rules to the CSP;
    - expose the key id as `NEXT_PUBLIC_RAZORPAY_KEY_ID`;
    - add a server route that verifies `razorpay_signature` with the KEY SECRET (not the webhook secret);
    - still treat webhooks as the source of truth.
  - WIRE_UP: enable Subscriptions and Flash Checkout in both modes.
- **Open risk:** The absence of a return or callback URL for Subscription Links is inferred from the parameter list, not stated explicitly. The exact CSP hosts for the checkout.js iframe are not verified. During WIRE_UP, open a Test-mode `short_url`, complete the payment and record where the hosted page leaves the customer.
- **Sources:**
  - https://razorpay.com/docs/payments/subscriptions/workflow/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/workflow.md` @ab3bda5) — L82: "Customers click the link and are taken to a checkout page hosted by Razorpay where they make the authentication payment via Razorpay's checkout page. There is no need to host the link on your website or application."
  - https://razorpay.com/docs/api/payments/subscriptions/create-subscription/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/create-subscription.md` @ab3bda5) — Response: "short_url": "https://rzp.io/rzp/Dqdqx3h"; `short_url`: "URL that can be used to make the authorisation payment."
  - https://razorpay.com/docs/payments/subscriptions/integration-guide/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/integration-guide.md` @ab3bda5) — L189: generated_signature = hmac_sha256(razorpay_payment_id + "|" + subscription_id, secret); "`subscription_id` | Retrieve the subscription_id from your server. Do not use the razorpay_subscription_id returned by Checkout." L156: "Oops! Something went wrong. Please contact the merchant for further assistance. | - This error occurs when Flash Checkout is not enabled on the Dashboard. - This error also occurs if the `subscription_id` is in the cancelled/expired state."
  - https://razorpay.com/docs/payments/subscriptions/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions.md` @ab3bda5) — L81: "Navigate to **Account & Settings → Checkout Features** and enable **Flash checkout**."
  - https://razorpay.com/docs/payments/subscriptions/payment-retries/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/payment-retries.md` @ab3bda5) — "Use the `subscription_card_change` parameter to control this feature"; options {"key": "key_id", "subscription_id": "sub_00000000000001", "subscription_card_change": true, "callback_url": ...}
  - https://razorpay.com/docs/api/payments/subscriptions/create-subscription-link/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/create-subscription-link.md` @ab3bda5) — `notify_info`: "Use this array only if you have set the `customer_notify` parameter to `true`. ... The same will not be prefilled in the checkout as per the government guidelines."
  - https://github.com/razorpay/razorpay-node/blob/master/lib/utils/razorpay-utils.js — official SDK source — "}else if(isDefined(params.subscription_id)===true){ var subscriptionId = params.subscription_id; var payload = paymentId + '|' + subscriptionId;"
  - https://github.com/razorpay/razorpay-woocommerce/blob/master/woo-razorpay.php — official SDK source — "L851: https://checkout.razorpay.com/v1/checkout.js"

### RZP-SUB-CREATE-FIELDS — Create-subscription endpoint and fields
- **Brief:** Not addressed. The brief says only "plan from `RAZORPAY_PLAN_ID`" (§3, §5.10 Checkout).
- **Verdict:** Extended — high confidence
- **Finding:** `POST https://api.razorpay.com/v1/subscriptions`, with Basic auth `key_id:key_secret` and a JSON body.
  - **Mandatory fields:**
    - `plan_id` (string);
    - `total_count` (integer, the number of billing cycles).
  - **Optional fields:**
    - `quantity` (int, default 1);
    - `start_at` (Unix s). If omitted, the subscription starts immediately after the authorisation payment, i.e. the plan amount is charged at authentication;
    - `expire_by` (Unix s; the deadline for the authorisation payment; default 30 years). A past value fails with "Link expire by cannot be lesser than the current time.";
    - `customer_notify` (boolean, default `true` = Razorpay handles customer communication);
    - `addons` `[{item:{name, amount, currency=plan currency}}]`;
    - `offer_id`;
    - `notes` (object, max 15 key-value pairs);
    - `notify_info` `{notify_phone, notify_email}` (link variant, same endpoint; only with `customer_notify` true).
  - **Response:** status `"created"`, with `short_url`.
  - **Duration limits are inconsistent in the docs:**
    - the FAQ says the maximum duration is 100 years;
    - the Dashboard link guide says 30 years;
    - the integration guide's error row says `end_time` must be between `946684800` and `4765046400` (2000-01-01 to 2120-12-31 UTC, consistent with 100 years) and also "Currently, you can only charge a Subscription for up to 10 years".
  - **Errors:**
    - Subscriptions not enabled → 400 "The requested URL was not found on the server.";
    - wrong-mode or unknown plan → 400 "The id provided does not exist" ("The plan should be active and created using the same API key and Secret.").
- **Design consequence:** Body:
  ```json
  {"plan_id": RAZORPAY_PLAN_ID, "total_count": 120, "quantity": 1, "customer_notify": true, "expire_by": now+7d, "notes": {"autopilot_account_id": "<uuid>"}}
  ```
  - Add `"start_at": trial_end_unix` when subscribing mid-trial (see RZP-TRIAL-START-AT).
  - `total_count` 120 (10 years monthly) stays inside every documented limit for an immediate start. But if the 10-year note IS enforced from creation time, 120 cycles plus a future `start_at` (up to 14 days ahead) ends just past 10 years. The lowest-risk choice is `total_count` 119 when `start_at` is set, or a flat 100 cycles.
  - Keep `customer_notify` true, so Razorpay sends charge receipts and failed-payment/update-card emails; our own "inactive" email still goes out once.
  - Do not send `notify_info`: we redirect, and omitting it stops Razorpay emailing or SMSing the link.
- **Open risk:** Which duration limit is actually enforced is unclear. During WIRE_UP, create a Test-mode subscription with the chosen `total_count` and a `start_at` 14 days out, and confirm it is accepted.
- **Sources:**
  - https://razorpay.com/docs/api/payments/subscriptions/create-subscription/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/create-subscription.md` @ab3bda5) — `plan_id` _mandatory_ ... `total_count` _mandatory_ ... `expire_by` _optional_ ... "The default value is 30 years." ... `customer_notify` _optional_ `true` (default) ... `notes` ... "maximum of 15 key-value pairs" ... L372: "This error occurs when the Subscriptions feature is not enabled." L378: "The plan should be active and created using the same API key and Secret."
  - https://razorpay.com/docs/payments/subscriptions/integration-guide/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/integration-guide.md` @ab3bda5) — L154: "`end_time` must be between `946684800` and `4765046400`. | ... | Currently, you can only charge a Subscription for up to 10 years."
  - https://razorpay.com/docs/payments/subscriptions/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/faqs.md` @ab3bda5) — L40: "We support Subscriptions for a maximum duration of 100 years."
  - https://razorpay.com/docs/api/payments/subscriptions/create-subscription-link/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/create-subscription-link.md` @ab3bda5) — Failure sample: "description": "Link expire by cannot be lesser than the current time."
  - https://github.com/razorpay/razorpay-node/blob/master/lib/types/subscriptions.d.ts — official SDK source — "plan_id: string; total_count: number; customer_notify?: boolean | 0 | 1; quantity?: number; offer_id?: string; start_at?: number; expire_by?: number; addons?: ...; notes?: IMap<string | number>;"
  - https://www.npmjs.com/package/razorpay/v/2.9.8 — local experiment — "rzp.subscriptions.create({plan_id:"plan_X", total_count:120, quantity:1, customer_notify:true, notes:{account_id:"uuid"}}) -> POST https://api.razorpay.com/v1/subscriptions with that exact JSON body and axios basic auth {username:key_id, password:key_secret}"
  - https://www.npmjs.com/package/razorpay/v/2.9.8 — local experiment — "date -u -d @4765046400 -> Tue Dec 31 00:00:00 UTC 2120; date -u -d @946684800 -> Sat Jan 1 00:00:00 UTC 2000. Axios-adapter capture (capture2.js): subscriptions.create({...}) -> POST https://api.razorpay.com/v1/subscriptions data '{"plan_id":"plan_X","total_count":120,"quantity":1,"customer_notify":true,"notes":{"autopilot_account_id":"uuid"}}' auth {username:key_id,password:key_secret}"

### RZP-PLAN-CREATE — Creating the $49/month plan
- **Brief:** §10 WIRE_UP step 7 "Create the Razorpay plan"; §3 "Plan ID from env `RAZORPAY_PLAN_ID`".
- **Verdict:** Confirmed — high confidence
- **Finding:** Create the plan with `POST https://api.razorpay.com/v1/plans` or in the Dashboard (Subscriptions → Plans). Body:
  ```json
  {"period":"monthly","interval":1,"item":{"name":"Hublytix Autopilot","amount":4900,"currency":"USD","description":"$49/month"},"notes":{...}}
  ```
  - **`period`:** one of `daily` | `weekly` | `monthly` | `quarterly` | `yearly`. The SDK type omits `quarterly`.
  - **`interval`:** an integer; daily plans need `interval` >= 7.
  - **`item.amount`:** in currency subunits (USD cents; USD exponent 2), and at least 100 subunits.
  - **Response:** id `"plan_..."`.
  - **Immutable:** plans cannot be updated or deleted; create a new one (or duplicate).
  - **Mode-scoped:** a plan must be created with the same API keys (Test or Live) that create the subscriptions. This is inferred from the create-subscription error solution, "created using the same API key and Secret".
- **Design consequence:** WIRE_UP creates the plan TWICE (Test mode with test keys, Live mode with live keys) and sets `RAZORPAY_PLAN_ID` per Vercel environment. A smoke check (`GET /v1/plans/{RAZORPAY_PLAN_ID}`) asserts `item.amount=4900`, `currency=USD`, `period=monthly`, `interval=1`; it also catches a key/plan mode mismatch. A price change means a new plan id.
- **Open risk:** Creating a USD plan requires international payments to be enabled (see RZP-USD-INTERNATIONAL); this is not testable here. Whether Test mode accepts a USD plan before International Cards is activated is unverified, so check it during WIRE_UP.
- **Sources:**
  - https://razorpay.com/docs/api/payments/subscriptions/create-plan/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/create-plan.md` @ab3bda5) — `period` _mandatory_ Possible values: `daily` `weekly` `monthly` `quarterly` `yearly`; L221: "For daily plans, the minimum value should be `7`."; `amount` _mandatory_; `currency` _mandatory_ "You can accept payment in any of the supported currencies"; L298: "Currency subunits, such as paise (in the case of INR), should always be greater than 100."
  - https://razorpay.com/docs/payments/subscriptions/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/faqs.md` @ab3bda5) — L76: "No. You cannot update or delete a Plan. You should create a new Plan."
  - https://razorpay.com/docs/payments/international-payments/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/international-payments.md` @ab3bda5) — L407: "United States dollar | USD | 2"; "you must pass `USD` in the `currency` parameter and `2000` in the `amount` parameter (since the amount should be in cents)."
  - https://github.com/razorpay/razorpay-node/blob/master/lib/types/plans.d.ts — official SDK source — "period: "daily" | "weekly" | "monthly" | "yearly"; interval: number;"
  - https://www.npmjs.com/package/razorpay/v/2.9.8 — local experiment — "rzp.plans.create(...) -> POST https://api.razorpay.com/v1/plans {"period":"monthly","interval":1,"item":{"name":"Hublytix Autopilot","amount":4900,"currency":"USD","description":"$49/month"}}"

### RZP-USD-INTERNATIONAL — Charging USD $49/month: International Cards and policy pages
- **Brief:** §1 and §5.13 "$49/month after a 14-day free trial" (USD implied); §5.13 legal pages: only `/privacy` and `/terms`.
- **Verdict:** Extended — medium confidence
- **Finding:** Yes, Razorpay Subscriptions can charge USD, with conditions.
  - **Currency support:** Subscriptions is listed as supporting international payments, and USD is a supported currency. But ONLY card payments support international currencies for Subscriptions; UPI and eMandate are INR-only.
  - **Dashboard toggles:** a per-method toggle at Dashboard → Subscriptions → Settings → "Card" enables "recurring payments via cards for your subscriptions in any of our supported international currencies".
  - **Account feature:** the international payments feature must be enabled ("You must get the international payments feature enabled on your Razorpay account to accept payments in currencies other than INR"), at Dashboard → Account & Settings → International payments → Activate International Cards.
  - **Eligibility:**
    - an active, KYC-verified account;
    - a website with Terms and Conditions, Privacy policy, Refund and Cancellation policy, and Shipping policy pages ("International payments cannot be enabled for your account without these sections/pages").
  - **Settlement:** always in INR, at the rate at payment creation. The default international settlement cycle is T+7 working days.
  - **Card networks and rules:**
    - card SI for Subscriptions supports Visa, Mastercard and RuPay;
    - international cards (issued by overseas banks: Visa, Mastercard, Amex; Diners and Discover on request) are outside RBI e-mandate rules ("RBI guidelines apply only to domestic cards and not international cards", Cards FAQ Q9);
    - domestic card mandates above ₹15,000 need AFA per debit (not relevant at $49).
  - **Indian-issued cards:** debit-card subscriptions are limited to Mastercard/Visa/RuPay cards from specific banks (ICICI, Kotak, Citibank, Canara). Credit cards (Amex, Mastercard, Visa, RuPay) need 2FA/3DS on the first transaction. Many Indian debit cards therefore cannot subscribe at all.
  - **Live keys:** Live API keys also require a verified website.
- **Design consequence:** This fills a brief gap: §5.13 lists only `/privacy` and `/terms`.
  - Add `/refunds` (Refund and Cancellation policy) and `/shipping` (Shipping/Delivery policy, e.g. "digital service, no physical shipping"), linked in the footer.
  - WIRE_UP must include "Activate International Cards" and the Subscriptions → Settings → Card toggle before creating the USD plan.
  - Show prices in USD; never show INR conversions. Expect card to be the only payment method on the hosted page.
  - Record the extra pages in DECISIONS.md.
- **Open risk:**
  - Whether Indian-issued domestic cards can authorise a USD-denominated recurring mandate is not documented.
  - Razorpay may reject placeholder ("TODO: legal review") policy pages during website review; real policy text may be needed before activation.
  - Neither can be tested here. During WIRE_UP, confirm International Cards activation succeeds and that a Test-mode international card can authorise the USD plan.
- **Sources:**
  - https://razorpay.com/docs/payments/subscriptions/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/faqs.md` @ab3bda5) — L1295: "You can accept Subscription payments in any of the supported currencies." L1303: "Only card payments support international currencies. UPI payments do not support international currencies." L1311: "Settlements are always made in `INR`."
  - https://razorpay.com/docs/payments/subscriptions/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/faqs.md` @ab3bda5) — Payment Methods Q2: "Navigate to **Subscriptions** → **Settings**." "- **Card**: Enable this to accept recurring payments via cards for your subscriptions in any of our supported international currencies." Cards Q13: "Subscriptions are allowed on Mastercard, Visa and RuPay network cards issued by the following banks ... - Citibank - Canara Bank - ICICI Bank - Kotak Mahindra Bank"; Q12 credit cards: "American Express - MasterCard - Visa - RuPay"
  - https://razorpay.com/docs/payments/international-payments/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/international-payments/faqs.md` @ab3bda5) — L28: "You must get the international payments feature enabled on your Razorpay account to accept payments in currencies other than INR."
  - https://razorpay.com/docs/payments/international-payments/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/international-payments/faqs.md` @ab3bda5) — Q5: "we only support international payments made using cards issued by overseas banks for all the major networks, following are the supported card networks: - Visa - Mastercard - Amex - Diners - Discover" / "To enable Diners and Discover cards, ."
  - https://razorpay.com/docs/payments/international-payments/international-debit-credit-cards/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/international-payments/international-debit-credit-cards.md` @ab3bda5) — Eligibility: "Terms and Conditions", "Privacy policy", "Refund and Cancellation policy", "Shipping policy"; L40: "International payments cannot be enabled for your account without these sections/pages on your website."
  - https://razorpay.com/docs/payments/international-payments/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/international-payments.md` @ab3bda5) — Supported Products: "Subscriptions | Yes"; "United States dollar | USD | 2"
  - https://razorpay.com/docs/payments/subscriptions/supported-payment-methods/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/supported-payment-methods.md` @ab3bda5) — "Cards | Visa, Mastercard and RuPay"

### RZP-TRIAL-START-AT — The 14-day no-card trial and `start_at`
- **Brief:** §5.10 "Trial: 14 days from install, no card"; §4 "Day 15: trial ends → checkout → $49/month."
- **Verdict:** Extended — medium confidence
- **Finding:**
  - **Trial model:** Razorpay models a trial as a future `start_at`: "provide a future start date when creating the Subscription. The actual billing cycle automatically starts at the specified date".
  - **Future start, no add-on:** the authentication charge is a token amount that is auto-refunded. The subscription goes to `authenticated` and moves to `active` (`subscription.activated` + `subscription.charged`) at `start_at`.
    - The webhook reference's `subscription.authenticated` sample (`start_at` 1593109800, later than `created_at` 1592811228) shows that event firing for a future-start authentication, while the test guide says "no webhook events". Handle both.
  - **No `start_at`:** the plan amount is charged immediately at authentication.
  - **Expiry:** if `start_at` is set and authentication is not done by then, the subscription becomes `expired`.
  - **Pause:** pausing an `authenticated` subscription cancels it.
- **Design consequence:** Decision for DECISIONS.md:
  - if the user subscribes while trialing and `trial_end > now + 1 day`, pass `start_at = trial_end`, so the free days are honoured (status `authenticated` = entitled);
  - otherwise omit `start_at` (immediate $49 charge).

  Treat `authenticated` as entitled. Ensure `expire_by <= start_at` when `start_at` is used; an unauthenticated future-start subscription expires at `start_at` anyway.
- **Open risk:** The token amount for USD future-start authorisations is not stated in the docs export (the amount symbol is stripped). During WIRE_UP, verify the token amount and the auto-refund in Test mode.
- **Sources:**
  - https://razorpay.com/docs/payments/subscriptions/create/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/create.md` @ab3bda5) — L38: "To create a trial period for your customers, provide a future start date when creating the Subscription. The actual billing cycle automatically starts at the specified date, creating a free trial period."
  - https://razorpay.com/docs/payments/subscriptions/workflow/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/workflow.md` @ab3bda5) — Authentication Amount table: "Immediate | x | Plan Amount" / "Future | x |  (auto refunded)"
  - https://razorpay.com/docs/payments/subscriptions/test/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/test.md` @ab3bda5) — "Performing the same payment request on **Subscription B** results in being marked as `authenticated`. It is not charged, as it is not due to start for a few months."
  - https://razorpay.com/docs/webhooks/subscriptions/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/subscriptions.md` @ab3bda5) — subscription.authenticated sample: "status": "authenticated", "current_start": null, "charge_at": 1593109800, "start_at": 1593109800, "created_at": 1592811228

### RZP-API-KEYS — Key pairs, Test vs Live, regeneration, and the "fails silently" claim
- **Brief:** §10 WIRE_UP step 7 "The key ID and key secret must come from the same key generation, or checkout fails silently."
- **Verdict:** Corrected — medium confidence
- **Finding:**
  - **Key pair:** an API key is a `key_id` + `key_secret` pair, used as HTTP Basic auth (`Authorization: Basic base64(KEY_ID:KEY_SECRET)`).
  - **Modes:** Test and Live keys are separate, with `key_id` prefixes `rzp_test_` and `rzp_live_`. There is one key per mode per MID ("You can use only one set of API keys").
  - **Secret visibility:** the secret is shown only at generation, so download it. Only the Owner and Admin roles can see keys.
  - **Regeneration:** "Generate new key" issues a new key and lets you deactivate the old key immediately or within 24 hours. The id and secret must therefore come from the same generation, and during the overlap the old pair still works until it is deactivated.
  - **Live keys:** these require a verified website (up to 3 working days).
  - **Webhook secret:** a separate, user-chosen string set per webhook.
  - **"Fails silently" is NOT supported by Razorpay's docs:** "silent" appears nowhere in the docs export. With server-side calls (Subscription Links), a mismatched pair fails loudly: "The api key provided is invalid" / "The API key/secret provided is invalid.". The genuinely quiet failures are:
    - (a) Standard Checkout with a browser `key_id` from one generation and a server secret from another: the payment succeeds, but our `razorpay_signature` check fails;
    - (b) Flash Checkout disabled, which shows the generic "Oops! Something went wrong";
    - (c) `RAZORPAY_PLAN_ID` from the other mode, giving "The id provided does not exist".
  - **Smoke test:** `GET /v1/plans/{RAZORPAY_PLAN_ID}` with the configured pair.
- **Design consequence:** Env vars: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_ID` (all per mode).
  - The Zod env check requires the key id to match `/^rzp_(test|live)_/`, and to be `rzp_live_` in production.
  - In the smoke test, a 401 means a mismatched id/secret, and a 400 "does not exist" means a plan from the other mode.
  - WIRE_UP: copy the id and secret from the same download. After any regeneration, update both env vars together and redeploy BEFORE deactivating the old key. A half-updated deploy keeps working during the overlap and breaks only when the old key is deactivated.
  - Record the "fails silently" correction in DECISIONS.md.
- **Open risk:** The exact HTTP status and description for an id/secret mismatch are not uniformly documented for each endpoint. During WIRE_UP, run the smoke test with a deliberately wrong secret once and record the actual response.
- **Sources:**
  - https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/dashboard/account-settings/api-keys.md` @ab3bda5) — "An API key is a combination of the `key_id` and `key_secret`"; L57: "You can use only one set of API keys."; "only the **Key Id** is visible on the Dashboard, **not the Key secret**"; L84: "This allows you to deactivate the old key immediately or within 24 hours."; "Only users with the **Owner** or **Admin** role have access to the API keys."
  - https://razorpay.com/docs/api/authentication/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/authentication.md` @ab3bda5) — "Basic auth expects an `Authorization` header for each request in the `Basic base64token` format. Here, `base64token` is a base64 encoded string of `YOUR_KEY_ID:YOUR_KEY_SECRET`."
  - https://razorpay.com/docs/api/payments/subscriptions/pause-subscription/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/pause-subscription.md` @ab3bda5) — Failure sample: "description": "The api key provided is invalid"; Errors: "The API key/secret provided is invalid. ... This error occurs due to a mismatch between the API credentials passed in the API call and those generated on the Dashboard."
  - https://github.com/razorpay/razorpay-cli/blob/master/README.md — official SDK source — L46: "Generate keys from the [Razorpay Dashboard](https://dashboard.razorpay.com/app/website-app-settings/api-keys) — `rzp_test_` for development, `rzp_live_` for production."
  - https://github.com/razorpay/razorpay-woocommerce/blob/master/includes/razorpay-route.php — official SDK source — "L1026: $modeCode = (strpos($keyId, 'rzp_test_') === 0) ? 2 : 1;"
  - https://github.com/razorpay/markdown-docs — local experiment — "grep -rn -i 'silent' --include=*.md over the razorpay/markdown-docs checkout (webhooks, payments/subscriptions, api/payments/subscriptions, api/authentication, dashboard api-keys) -> no matches"

### RZP-SUB-CANCEL-PAUSE-RESUME-FETCH — Cancel, pause, resume and fetch, and the SDK `cancel()` gotcha
- **Brief:** Not addressed. Relates to §5.11 settings "billing" and the §4 "cancel" action.
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Cancel:** `POST https://api.razorpay.com/v1/subscriptions/{id}/cancel` with body `{"cancel_at_cycle_end": false|true}`.
    - `false` (the default) cancels immediately.
    - `true` keeps the status `active` until the end of the current billing cycle, then sets `cancelled`.
    - A cancelled subscription cannot be renewed or reactivated.
    - An expired one cannot be cancelled ("Subscription is not cancellable in expired status."); the docs say to cancel from `active` or `authenticated`.
  - **Pause:** `POST /v1/subscriptions/{id}/pause` with `{"pause_at":"now"}`. Only `active` can be paused; pausing `authenticated` CANCELS it.
  - **Resume:** `POST /v1/subscriptions/{id}/resume` with `{"resume_at":"now"}`. The sample shows the status back to `active`.
  - **Who else can act:**
    - UPI customers can pause or cancel from their UPI app.
    - Per Subscriptions Cards FAQ Q10, cardholders can also pause, resume and cancel from their bank's portal, and webhooks fire.
    - This contradicts the FAQ's pause/resume table, which marks cards as business-only. Expect customer-initiated `subscription.paused`, `.resumed` and `.cancelled` events for any payment method (`pause_initiated_by` / `cancel_initiated_by`).
  - **Fetch one:** `GET /v1/subscriptions/{id}`.
  - **List:** `GET /v1/subscriptions?plan_id=&from=&to=&count=&skip=`, where `count` defaults to 10 (max 100).
  - **SDK gotcha (`razorpay@2.9.8`):** `subscriptions.cancel(id, cancelAtCycleEnd?: boolean|number)` sends `{cancel_at_cycle_end: 1}` for ANY truthy second argument.
    - An options object, including `{cancel_at_cycle_end:false}` written in the shape of the official API reference's Node example (`instance.subscriptions.cancel(subscriptionId, {cancel_at_cycle_end: true})`), therefore cancels at cycle END.
    - Call `cancel(id, true)` or `cancel(id)`, or use fetch directly.
    - Observed request bodies: `cancel(id)` and `cancel(id, false)` → no body; `cancel(id, true)` → `{"cancel_at_cycle_end":1}`; `cancel(id, {cancel_at_cycle_end:false})` → `{"cancel_at_cycle_end":1}`.
  - **SDK errors:** rejections are plain objects `{statusCode, error:{code, description,...}}`, e.g. `{statusCode:400, error:{code:'BAD_REQUEST_ERROR', description:'The id provided does not exist'}}`, not `Error` instances.
- **Design consequence:** The billing settings "Cancel" button calls `cancel_at_cycle_end=true`. The user keeps access until `current_end`, and the status stays `active` until the cancelled webhook arrives.
  - Call the SDK as `cancel(id, true)`, or use plain fetch.
  - Reconciliation: on dashboard load (if the subscription row is non-terminal and the last sync is older than 1 h), and in a daily cron for all non-terminal rows, `GET /v1/subscriptions/{id}` and apply the status. This fixes missed and out-of-order webhooks.
  - Do not expose pause in v1. The brief's "pause all" pauses processing; it is NOT a Razorpay pause.
- **Open risk:** razorpay-cli accepts `pause_at` `"cycle_end"`, but the API reference documents only `"now"` (we do not use pause). During WIRE_UP, cancel a Test-mode subscription with `cancel_at_cycle_end=true` and confirm it stays `active` until `current_end`.
- **Sources:**
  - https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/cancel-subscription.md` @ab3bda5) — "If you choose to cancel a Subscription at the end of a billing cycle, its status changes to `cancelled` only at the end of the current billing cycle." `cancel_at_cycle_end` "`false` (default): Cancel the subscription immediately." curl: -X POST https://api.razorpay.com/v1/subscriptions/sub_00000000000001/cancel -d '{"cancel_at_cycle_end": false}'
  - https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/cancel-subscription.md` @ab3bda5) — Node.js example: "instance.subscriptions.cancel(subscriptionId, {\n  cancel_at_cycle_end: true,\n});"
  - https://razorpay.com/docs/api/payments/subscriptions/pause-subscription/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/pause-subscription.md` @ab3bda5) — "You can only pause a Subscriptions in the `active` state." "If you pause a Subscription in the `authenticated` state, it goes to the `cancelled` state." `pause_at` "The value should be `now`"
  - https://razorpay.com/docs/api/payments/subscriptions/resume-subscription/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/resume-subscription.md` @ab3bda5) — "-X POST https://api.razorpay.com/v1/subscriptions/sub_00000000000001/resume; `resume_at` "The value should be `now`""
  - https://razorpay.com/docs/api/payments/subscriptions/fetch-subscriptions/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/fetch-subscriptions.md` @ab3bda5) — `count` "Default value is `10`. Maximum value is 100."
  - https://razorpay.com/docs/payments/subscriptions/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/faqs.md` @ab3bda5) — Cards Q10: "Yes, cardholders can pause, resume and cancel active Subscriptions from the portal provided by the bank to manage them. You will get notifications through multiple webhooks when a cardholder initiates any such changes to the Subscriptions." vs Pause table: "Debit Cards | ✓ | x" / "Credit Cards | ✓ | x"
  - https://razorpay.com/docs/payments/subscriptions/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/faqs.md` @ab3bda5) — Pause FAQ: "Debit Cards | ✓ | x" / "Credit Cards | ✓ | x" / "UPI | ✓ | ✓" (Business | Customer)
  - https://github.com/razorpay/razorpay-node/blob/master/lib/resources/subscriptions.js — official SDK source — "cancel (subscriptionId, cancelAtCycleEnd=false, callback) { ... return api.post({ url, ...(cancelAtCycleEnd && {data: {cancel_at_cycle_end: 1}}) }, callback); }"
  - https://www.npmjs.com/package/razorpay/v/2.9.8 — local experiment — "rzp.subscriptions.cancel("sub_X", { cancel_at_cycle_end: false }) -> POST https://api.razorpay.com/v1/subscriptions/sub_X/cancel data {"cancel_at_cycle_end":1}; cancel("sub_X") -> no body; cancel("sub_X", true) -> {"cancel_at_cycle_end":1}"
  - https://www.npmjs.com/package/razorpay/v/2.9.8 — local experiment — "capture2.js sets rzp.api.rq.defaults.adapter to record axios configs: cancel('sub_X') -> POST .../sub_X/cancel (no data); cancel('sub_X', false) -> no data; cancel('sub_X', true) -> data '{"cancel_at_cycle_end":1}'; cancel('sub_X', {cancel_at_cycle_end:false}) -> data '{"cancel_at_cycle_end":1}'; pause -> '{"pause_at":"now"}'; resume -> '{"resume_at":"now"}'; error adapter -> rejection_is_Error false, {statusCode:400, error:{code:'BAD_REQUEST_ERROR', description:'The id provided does not exist'}}"

### RZP-STATUS-MAPPING — Mapping Razorpay status onto Autopilot entitlement
- **Brief:** §5.10 "When processing runs: while `trialing`, or while the subscription is `active` (plus a 3-day grace period on payment failure)"; "block a new checkout only when the status is `active` or `halted`"; §5.11 "Status".
- **Verdict:** Extended — medium confidence. This is a product decision grounded in the documented lifecycle.
- **Finding:** The proposed mapping:
  - **Entitled:** `trialing` (internal), OR a Razorpay status in {`authenticated`, `active`, `pending`}.
  - **Inactive:** {`halted`, `paused`, `cancelled`, `completed`, `expired`}, or no subscription AND the trial is over.
    - `paused` can be customer-initiated for cards and UPI, so treat it as inactive and send the "inactive" email.
  - **Checkout in progress:** `created`; entitlement follows the trial.
  - **Resume:** map `subscription.resumed`, or an unexpected `resumed` status value, to `active`.
  - **Cancel at cycle end:** `cancel_at_cycle_end` keeps the status `active` until the cycle ends, so access naturally lasts to `current_end`.
  - **Expiry:** no webhook fires for `created` → `expired`, so the entitlement function must not wait for one.
  - **Checkout allowed** only when no live subscription exists (none / `created` / `expired` / `cancelled` / `completed`).
- **Design consequence:** Encode the mapping as a pure function `entitlement(status, trialEndsAt, now)` with table-driven Vitest tests covering all nine statuses (plus `resumed` and an unknown value). The single "billing inactive" email fires only on entitled → inactive transitions.
- **Open risk:** This is a product decision; confirm it in PLAN review.
- **Sources:**
  - https://razorpay.com/docs/payments/subscriptions/states/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/states.md` @ab3bda5) — Pending: "We continue to retry the payment while it is in this state." Halted: "Invoices are generated for all billing cycles, but no auto-charge is attempted."
  - https://razorpay.com/docs/webhooks/subscriptions/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/subscriptions.md` @ab3bda5) — `subscription.activated`: "Sent when the subscription moves to the `active` state either from the `authenticated`, `pending` or `halted` state."

### RZP-WIRE-UP-WEBHOOK — Dashboard steps for WIRE_UP step 7
- **Brief:** §10 WIRE_UP step 7 "Create the Razorpay plan and webhook. The key ID and key secret must come from the same key generation".
- **Verdict:** Extended — high confidence
- **Finding:** Per mode (Test, then Live):
  1. Account & Settings → Checkout Features → enable **Flash checkout**; make sure Subscriptions is enabled.
  2. Dashboard → Subscriptions → Settings → enable **Card**, the toggle that allows recurring card payments in international currencies.
  3. Account & Settings → International payments → **Activate International Cards** (Live; needs the policy pages).
  4. Create the plan (Subscriptions → Plans, or `POST /v1/plans`) and copy `plan_...` to `RAZORPAY_PLAN_ID`.
  5. Account & Settings → **Webhooks** (under Website and app settings) → **+ Add New Webhook**:
     - URL `https://<prod-domain>/api/razorpay/webhook`;
     - Secret = a random string of 32+ characters, stored as `RAZORPAY_WEBHOOK_SECRET` (not the key secret). Razorpay treats the Secret as optional and signs only "when your webhook secret is set", so our checklist makes it MANDATORY;
     - Alert Email = an ops address;
     - Active Events = the ten `subscription.*` events;
     - then **Create Webhook** (Test-mode OTP `754081`).
  6. Account & Settings → **API Keys** → Generate Key; download it, and set `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` from the same download.
  7. Test with test cards `4718 6091 0820 4366` (domestic Visa) and `5104 0155 5555 5558` (international Mastercard), and use the Dashboard's "Charge this now" (Test mode) to drive charged, pending and halted.
- **Design consequence:** Put these steps verbatim into `docs/WIRE_UP.md` step 7. Add to the screenshot checklist: the webhook list showing 10 events, and the plan detail showing USD 49.00 monthly.
- **Open risk:**
  - Dashboard labels drift; the docs use both "Account & Settings" and "Developers → Webhooks".
  - Whether Test mode accepts a USD plan before International Cards is activated is unverified.
  - Re-check every label and the test card numbers live during WIRE_UP.
- **Sources:**
  - https://razorpay.com/docs/webhooks/setup-edit-payments/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/setup-edit-payments.md` @ab3bda5) — "Log in to the Dashboard and navigate to **Accounts & Settings**. Click **Webhooks** under **Website and app settings**. Click the **+ Add New Webhook** button." ... "In the **Alert Email** field..." "Select the required events from the list of **Active Events**."
  - https://razorpay.com/docs/payments/subscriptions/test/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/test.md` @ab3bda5) — Test cards: "Domestic | Visa | Credit Card | 4718 6091 0820 4366", "International | Mastercard | Credit Card | 5104 0155 5555 5558"; L291: "In test mode, you can simulate these charges from the Dashboard using the Charge this now button."
  - https://razorpay.com/docs/payments/dashboard/account-settings/checkout-features/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/dashboard/account-settings/checkout-features.md` @ab3bda5) — "Navigate to **Accounts & Settings** → **Checkout Features** in the **Checkout settings** section." "Toggle on the **Flash checkout** field."
  - https://razorpay.com/docs/payments/subscriptions/faqs/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/faqs.md` @ab3bda5) — "Navigate to **Subscriptions** → **Settings**. 3. Configure the payment methods: - **Card**: Enable this to accept recurring payments via cards for your subscriptions in any of our supported international currencies."

### RZP-SDK-PACKAGE — The `razorpay` npm package: version, shape and caveats
- **Brief:** Not addressed. Relates to §3 "Billing: Razorpay Subscriptions" and the §8 `Billing` fake.
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Package:** npm `razorpay` latest = `2.9.8` (`dist-tags.latest` 2.9.8, modified 2026-07-21).
    - It is CJS with the TypeScript declaration `export = Razorpay` and has no `"exports"` field.
    - Its single dependency is `axios ^1.18.1`.
    - The base URL is `https://api.razorpay.com/v1`, with auth via axios basic auth.
  - **Type caveats:**
    - the Subscriptions `status` union omits `"paused"`;
    - `remaining_count` is typed `string`, but the API returns an integer;
    - the Plans `period` type omits `"quarterly"`;
    - the `validatePaymentVerification` d.ts comment wrongly says "webhook secret" (the docs table says "your api secret as secret").
  - **Errors:** rejections are plain objects `{statusCode, error}`.
  - **Serverless hazards:**
    - (1) The SDK creates its axios instance with NO timeout (`rq.defaults.timeout === 0`), so a hung Razorpay call can consume the whole function duration.
    - (2) `normalizeError` dereferences `err.response.status` unconditionally. A network or timeout error (no response) therefore rejects with `TypeError: Cannot read properties of undefined (reading 'status')`, and the original cause is lost.
- **Design consequence:** Wrap Razorpay behind a `BillingProvider` interface, with a fake for tests. Then choose one of:
  - use the SDK only for create/fetch/cancel, with our own Zod-validated response types, setting `rzp.api.rq.defaults.timeout`;
  - or call the REST API with fetch (5 endpoints) and `AbortSignal.timeout`, which also keeps axios out of the bundle.

  Normalise SDK rejections (both the `{statusCode, error}` shape and the `TypeError`) into `Error` subclasses before they reach Sentry.
- **Open risk:** None. Before installing, re-check the npm version at wire-up.
- **Sources:**
  - https://github.com/razorpay/razorpay-node/blob/master/package.json — official SDK source — ""name": "razorpay", "version": "2.9.8", "main": "dist/razorpay", "typings": "dist/razorpay""
  - https://github.com/razorpay/razorpay-node/blob/master/lib/api.js — official SDK source — "function normalizeError(err) { throw { statusCode: err.response.status, error: err.response.data.error } } ... config.auth = { username: options.key_id, password: options.key_secret }"
  - https://github.com/razorpay/razorpay-node/blob/master/lib/api.js — official SDK source — "function normalizeError(err) { throw { statusCode: err.response.status, error: err.response.data.error } } ... const config = { baseURL: options.hostUrl, headers: ... } (no timeout key)"
  - https://github.com/razorpay/razorpay-node/blob/master/lib/types/subscriptions.d.ts — official SDK source — "remaining_count: string; status: ... (8 values, no paused)"
  - https://www.npmjs.com/package/razorpay/v/2.9.8 — local experiment — "npm view razorpay version dist-tags time.modified --json -> {"version":"2.9.8","dist-tags":{"latest":"2.9.8"},"time.modified":"2026-07-21T16:58:20.666Z"}; npm pack razorpay@2.9.8 -> dist/razorpay.d.ts last line `export = Razorpay`; package.json "dependencies": {"axios": "^1.18.1"} and no "exports" field"
  - https://www.npmjs.com/package/razorpay/v/2.9.8 — local experiment — "neterr.js: new Razorpay({key_id:'rzp_test_X',key_secret:'s'}).api.rq.defaults.timeout -> 0; adapter throwing Error('connect ETIMEDOUT') -> subscriptions.fetch rejects with TypeError: Cannot read properties of undefined (reading 'status')"

### 08.1 Verifier-added items

#### V1 — Transitions that fire no webhook, so status must be fetched
- **Brief:** Not addressed. §5.10 assumes the webhook alone "maps subscription statuses".
- **Verdict:** Extended — medium confidence. The ten-event list and the `expired` rule are documented; the absence of an expiry or failed-authentication event is inferred by omission.
- **Finding:**
  - **Documented events:** the ten events cover authenticated, activated, charged, completed, updated, pending, halted, cancelled, paused and resumed.
  - **Missing events:** there is NO `subscription.expired` event, and no event for a failed authentication payment.
    - A `created` subscription that passes `start_at` without authentication becomes `expired` silently.
    - Failed authentication attempts leave it `created`, with no `subscription.*` event.
  - **`subscription.authenticated` is optional:** the test guide says a future-start authentication fires "no webhook events", while the webhook reference's `subscription.authenticated` sample is a future-start case. Treat the event as optional.
- **Design consequence:**
  - Store `short_url`, `expire_by` and `start_at` at creation.
  - A reconcile job calls `GET /v1/subscriptions/{id}` for every non-terminal row (`created` / `authenticated` / `pending` / `halted` / `paused` / `active`) that has not synced in N hours, and also on billing-page load.
  - Locally, treat a `created` row past `expire_by` (or past `start_at`, when set) as expired even before the fetch confirms it.
- **Open risk:** During WIRE_UP, let a Test-mode `created` subscription with a near `start_at` lapse, and confirm that no webhook arrives and that `GET` returns `expired`.
- **Sources:**
  - https://razorpay.com/docs/webhooks/subscriptions/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `webhooks/subscriptions.md` @ab3bda5) — "Event table lists exactly: subscription.authenticated, .activated, .charged, .completed, .updated, .pending, .halted, .cancelled, .paused, .resumed (no expired)"
  - https://razorpay.com/docs/payments/subscriptions/states/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/states.md` @ab3bda5) — "If the `start_at` time for the Subscription has been set and the authentication transaction has not been done by the `start_at` time, the Subscription moves to the `expired` state and cannot be used again."
  - https://razorpay.com/docs/payments/subscriptions/test/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `payments/subscriptions/test.md` @ab3bda5) — L280: "no webhook events are triggered by performing an authentication payment for **Subscription B**."
  - https://razorpay.com/docs/api/payments/subscriptions/fetch-subscription-id/ — official docs source repo (renders to the public docs URL; razorpay/markdown-docs `api/payments/subscriptions/fetch-subscription-id.md` @ab3bda5) — "curl -u [YOUR_KEY_ID]:[YOUR_KEY_SECRET] -X GET https://api.razorpay.com/v1/subscriptions/sub_00000000000001"

### 08.2 Test vectors

Every webhook vector is lowercase-hex `HMAC-SHA256(key = webhook secret, message = raw body bytes)`. Vector D is the Standard Checkout payment signature, keyed with the API **key secret** over `razorpay_payment_id + "|" + subscription_id`.

Where they come from:
- **Published by the vendor:** **A** only. It is the example in the official razorpay-node `documents/paymentVerfication.md`: `var xRazorpaySignature = "55d3c166391ec51285b388f1bb9f0ba9b13dde1bece4484aaac6edd34a01459a"`, `var webhookSecret = "123456"`.
- **Generated locally with the official SDK (`razorpay@2.9.8` on node v22.22.0):** **B**, **C**, **D** and the **empty-secret forgery**. Each was cross-checked with `node:crypto` and `openssl dgst -sha256 -hmac`, and the verifier reproduced every one independently from the npm-packed tarball (shasum `8e021dae4103617a43a370dffd3cffdcbe6205a5` = registry `dist.shasum`).

The two blocks below are copied verbatim from the research record and the verifier's recheck. They are followed by the exact fixture bodies.

**Research vectors (verbatim):**

```text
HMAC-SHA256 lowercase hex, key=webhook secret, msg=raw body bytes (files under /tmp/claude-0/-home-user-Autopilot/93edeaab-e8bf-5524-b325-7fb2eb252823/scratchpad/vectors/razorpay/). A (Razorpay-published, razorpay-node documents/paymentVerfication.md): secret "123456", body=JSON.stringify(sample payment.captured event) [983 bytes, sha256 986651c07d2a3e46d95cff0f9947a12f5c77b00d47c83c30be9f5c0283463b1b] -> 55d3c166391ec51285b388f1bb9f0ba9b13dde1bece4484aaac6edd34a01459a. B: secret "autopilot_webhook_secret_test", body=B.body (781 bytes, single-line subscription.activated JSON starting {"entity":"event","account_id":"acc_TESTACCOUNT01","event":"subscription.activated",...,"created_at":1790812805}) -> 295edb02518396f42f7568c942c21def25aa3a7bb2a92cff001c25d6344d7bbc; negatives (pretty re-serialised body, wrong secret, uppercase hex, body+"\n") -> false. C: secret "s3cr3t-ütf8", body=C.body (178 bytes UTF-8, contains "Café Zürich ₹") -> 4542d47ca6c160fb1323f7650cc30a070241d9d3afe9b2ea1601568bf3b25ac3. D (checkout payment signature, key=KEY SECRET): msg "pay_TESTPAY000001|sub_TESTSUB000001", key "testkeysecret0000000000" -> e877a2b95c3e1d1d5b9001ba8af2be9dd2129026e99137d5626667610a96d353. Empty-secret forgery (SDK accepts; our verifier must reject): body '{"event":"subscription.activated"}', secret "" -> 8d5d9f09e43d30e59e4bb9610080ca577b42035adb6784d6dbeee5ff186489a2.
```

**Verifier recheck (verbatim):**

```text
ALL REPRODUCED (node v22.22.0; SDK utils loaded from the npm-packed razorpay@2.9.8 tarball, shasum 8e021dae4103617a43a370dffd3cffdcbe6205a5 = registry dist.shasum; cross-checked with node:crypto on file bytes and openssl dgst -sha256 -hmac). A: payload parsed directly from razorpay-node documents/paymentVerfication.md -> JSON.stringify 983 bytes, sha256 986651c07d2a3e46d95cff0f9947a12f5c77b00d47c83c30be9f5c0283463b1b, HMAC key '123456' -> 55d3c166391ec51285b388f1bb9f0ba9b13dde1bece4484aaac6edd34a01459a (= documented). B: B.body 781 bytes (no trailing newline), sha256 b17497e95dc61a3a75cddd63778f4cf2dd248f4a109d0b3349f11e9193defc56, key 'autopilot_webhook_secret_test' -> 295edb02518396f42f7568c942c21def25aa3a7bb2a92cff001c25d6344d7bbc; negatives (pretty JSON, wrong secret, UPPERCASE sig, body+'\n') all false. C: C.body 178 bytes, key 's3cr3t-ütf8' (UTF-8) -> 4542d47ca6c160fb1323f7650cc30a070241d9d3afe9b2ea1601568bf3b25ac3. D: 'pay_TESTPAY000001|sub_TESTSUB000001', key 'testkeysecret0000000000' -> e877a2b95c3e1d1d5b9001ba8af2be9dd2129026e99137d5626667610a96d353 (validatePaymentVerification true). Empty secret: body '{"event":"subscription.activated"}', key '' -> 8d5d9f09e43d30e59e4bb9610080ca577b42035adb6784d6dbeee5ff186489a2 (SDK accepts). SDK edge cases: null signature -> false; undefined signature -> SDK Error 'Invalid Parameters: ...'; null secret -> Node TypeError from createHmac. Scripts: scratchpad/verify-rzp/recheck.js, vecA.js, capture2.js, neterr.js. Review saved to /tmp/claude-0/-home-user-Autopilot/93edeaab-e8bf-5524-b325-7fb2eb252823/scratchpad/research/razorpay.verify.json
```

**Fixture bodies (exact bytes).** Each body is ONE line, with no trailing newline in the actual fixture; the line break that closes each code block below is not part of the body. Write these to `test/fixtures/razorpay/*.body` byte for byte. Do not pretty-print them, and do not let an editor add a final newline.

Vector A body. This is the `JSON.stringify` output of the `var payload = {...}` object in razorpay-node `documents/paymentVerfication.md`, regenerated for this section by the same method as the verifier's `vecA.js`. It is 983 bytes, sha256 `986651c07d2a3e46d95cff0f9947a12f5c77b00d47c83c30be9f5c0283463b1b`, and with secret `123456` gives `55d3c166391ec51285b388f1bb9f0ba9b13dde1bece4484aaac6edd34a01459a`. The personal-looking values are Razorpay's own published sample data.

```text
{"entity":"event","account_id":"acc_Hn1ukn2d32Fqww","event":"payment.captured","contains":["payment"],"payload":{"payment":{"entity":{"id":"pay_JRP3Y66cNcf2qF","entity":"payment","amount":2244,"currency":"INR","status":"captured","order_id":"order_JROxH1kSf9IR6d","invoice_id":null,"international":false,"method":"card","amount_refunded":0,"refund_status":null,"captured":true,"description":"#J9iMHZMUTJlod8","card_id":"card_JRP3YBkFQYCmnR","card":{"id":"card_JRP3YBkFQYCmnR","entity":"card","name":"ankit das","last4":"4366","network":"Visa","type":"credit","issuer":"UTIB","international":false,"emi":true,"sub_type":"consumer","token_iin":null},"bank":null,"wallet":null,"vpa":null,"email":"you@example.com","contact":"+917000569565","notes":{"policy_name":"Jeevan Bima"},"fee":45,"tax":0,"error_code":null,"error_description":null,"error_source":null,"error_step":null,"error_reason":null,"acquirer_data":{"auth_code":"548669"},"created_at":1651722469}}},"created_at":1651722476}
```

Vector B body (`vectors/razorpay/B.body`). It is 781 bytes, sha256 `b17497e95dc61a3a75cddd63778f4cf2dd248f4a109d0b3349f11e9193defc56`, and with secret `autopilot_webhook_secret_test` gives `295edb02518396f42f7568c942c21def25aa3a7bb2a92cff001c25d6344d7bbc`:

```text
{"entity":"event","account_id":"acc_TESTACCOUNT01","event":"subscription.activated","contains":["subscription"],"payload":{"subscription":{"entity":{"id":"sub_TESTSUB000001","entity":"subscription","plan_id":"plan_TESTPLAN00001","customer_id":"cust_TESTCUST0001","status":"active","current_start":1790812800,"current_end":1793491200,"ended_at":null,"quantity":1,"notes":{"account_id":"acc-uuid-123"},"charge_at":1793491200,"start_at":1790812800,"end_at":2105980200,"auth_attempts":0,"total_count":120,"paid_count":1,"customer_notify":true,"created_at":1790812700,"expire_by":null,"short_url":"https://rzp.io/i/TESTLINK","has_scheduled_changes":false,"change_scheduled_at":null,"source":"api","payment_method":"card","offer_id":null,"remaining_count":119}}},"created_at":1790812805}
```

Vector C body (`vectors/razorpay/C.body`). It is 178 bytes of UTF-8, and with secret `s3cr3t-ütf8` (UTF-8) gives `4542d47ca6c160fb1323f7650cc30a070241d9d3afe9b2ea1601568bf3b25ac3`:

```text
{"entity":"event","event":"subscription.charged","payload":{"subscription":{"entity":{"id":"sub_TESTSUB000001","notes":{"company":"Café Zürich ₹"}}}},"created_at":1790812900}
```

Machine-readable form, copied verbatim from `vectors/razorpay/razorpay-vectors.out.json` (B and C carry their `raw_body` as JSON strings):

```json
{
  "sdk": "razorpay@2.9.8",
  "node": "v22.22.0",
  "vectors": [
    {
      "name": "A_sdk_documented_example",
      "secret": "123456",
      "body_sha256": "986651c07d2a3e46d95cff0f9947a12f5c77b00d47c83c30be9f5c0283463b1b",
      "body_length": 983,
      "documented_signature": "55d3c166391ec51285b388f1bb9f0ba9b13dde1bece4484aaac6edd34a01459a",
      "computed_signature": "55d3c166391ec51285b388f1bb9f0ba9b13dde1bece4484aaac6edd34a01459a",
      "sdk_validate_result": true
    },
    {
      "name": "B_subscription_activated",
      "secret": "autopilot_webhook_secret_test",
      "raw_body": "{\"entity\":\"event\",\"account_id\":\"acc_TESTACCOUNT01\",\"event\":\"subscription.activated\",\"contains\":[\"subscription\"],\"payload\":{\"subscription\":{\"entity\":{\"id\":\"sub_TESTSUB000001\",\"entity\":\"subscription\",\"plan_id\":\"plan_TESTPLAN00001\",\"customer_id\":\"cust_TESTCUST0001\",\"status\":\"active\",\"current_start\":1790812800,\"current_end\":1793491200,\"ended_at\":null,\"quantity\":1,\"notes\":{\"account_id\":\"acc-uuid-123\"},\"charge_at\":1793491200,\"start_at\":1790812800,\"end_at\":2105980200,\"auth_attempts\":0,\"total_count\":120,\"paid_count\":1,\"customer_notify\":true,\"created_at\":1790812700,\"expire_by\":null,\"short_url\":\"https://rzp.io/i/TESTLINK\",\"has_scheduled_changes\":false,\"change_scheduled_at\":null,\"source\":\"api\",\"payment_method\":\"card\",\"offer_id\":null,\"remaining_count\":119}}},\"created_at\":1790812805}",
      "body_length_bytes": 781,
      "expected_signature_hex": "295edb02518396f42f7568c942c21def25aa3a7bb2a92cff001c25d6344d7bbc",
      "sdk_utils_validate": true,
      "sdk_static_validate": true,
      "sdk_buffer_body_validate": true,
      "negative_reserialized_pretty_body": false,
      "negative_wrong_secret_key_secret": false,
      "negative_uppercase_hex_signature": false,
      "negative_trailing_newline_body": false
    },
    {
      "name": "C_utf8_body_and_secret",
      "secret": "s3cr3t-ütf8",
      "raw_body": "{\"entity\":\"event\",\"event\":\"subscription.charged\",\"payload\":{\"subscription\":{\"entity\":{\"id\":\"sub_TESTSUB000001\",\"notes\":{\"company\":\"Café Zürich ₹\"}}}},\"created_at\":1790812900}",
      "body_length_bytes": 178,
      "expected_signature_hex": "4542d47ca6c160fb1323f7650cc30a070241d9d3afe9b2ea1601568bf3b25ac3",
      "sdk_utils_validate": true,
      "sdk_buffer_body_validate": true
    },
    {
      "name": "D_checkout_subscription_payment_signature",
      "key_secret": "testkeysecret0000000000",
      "message": "pay_TESTPAY000001|sub_TESTSUB000001",
      "expected_signature_hex": "e877a2b95c3e1d1d5b9001ba8af2be9dd2129026e99137d5626667610a96d353",
      "sdk_validatePaymentVerification": true
    }
  ]
}
```

Empty-secret forgery, copied verbatim from `vectors/razorpay/sdk-behaviour.out.json`. The SDK returns `true`; OUR verifier must refuse to run with an empty secret:

```json
"empty_secret_forgery": {"body": "{\"event\":\"subscription.activated\"}", "secret": "", "forged_sig": "8d5d9f09e43d30e59e4bb9610080ca577b42035adb6784d6dbeee5ff186489a2", "accepted": true}
```

Negative cases that must return false (from the research and recheck records): vector B with a pretty-printed re-serialised body, B with the wrong secret (the key secret instead of the webhook secret), B with an UPPERCASE hex signature, and B with a trailing `"\n"` appended to the body.
