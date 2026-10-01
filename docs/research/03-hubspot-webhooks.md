## 03. HubSpot webhooks: v3 signature, payload, delivery, subscriptions

HubSpot signs each webhook delivery with `X-HubSpot-Signature-v3` = `Base64(HMAC-SHA256(clientSecret, method + requestUri + rawBody + timestamp))`, where `X-HubSpot-Request-Timestamp` is a millisecond epoch string, and the docs say to reject requests older than 5 minutes. We confirmed this byte for byte against all four official SDKs (Node, Python, PHP, Ruby) and two vendor-published test vectors. The developers.hubspot.com pages themselves were blocked in the sandbox, so their text comes from search summaries and a verbatim January 2025 community mirror. Both [VERIFY] markers in this area are resolved. The §5.2 algorithm is confirmed, with URI, raw-body and boundary rules the brief does not state. For §5.1, HubSpot does **not** push an uninstall webhook; uninstall exists only as a pull-based Webhooks Journal event, so a refresh-token failure stays the detection path.

The sources **correct** the brief in four places:
- **§5.2 / §6 `eventId` unique:** the docs say `eventId` "is not guaranteed to be unique" and that duplicates and out-of-order deliveries happen. `webhook_events` needs a composite key, and `leads` needs its own business-level unique key.
- **§5.2 poller rationale ("conversion-date properties are calculated, so they can't be webhook-subscribed"):** this is not officially documented. The official exclusion list names only `num_unique_conversion_events` and `hs_lastmodifieddate`. The poller stays for other reasons.
- **§5.1 uninstall:** there is no push uninstall notification. "Disconnect" should call `DELETE /appinstalls/2026-09/external-install`, which marketplace certification has required since May 2026 (per a search summary of the changelog).
- **§10 WIRE_UP step 1 ("click-by-click" webhook URL and subscriptions):** on the current developer platform, webhooks are configured in `src/app/webhooks/webhooks-hsmeta.json` and deployed with `hs project upload`. Settings changes can take up to 5 minutes to apply.

The sources **extend** the brief in these ways:
- **Subscription type:** subscribe with `object.creation` + `objectType: "contact"` (the brief's `contact.creation` still works) and accept both payload shapes.
- **Signing input:** sign against a configured `HUBSPOT_WEBHOOK_TARGET_URL` and the raw body, never against a URL rebuilt from headers or re-serialised JSON.
- **Verifier:** write our own. The official Node `Signature.isValid` defaults to v1, throws, compares in non-constant time, and skips the age check for a non-numeric timestamp.
- **Delivery:** the body is a JSON array of up to 100 events. HubSpot waits 5 seconds for a response and retries any 4xx or 5xx up to 10 times over 24 hours, so deliberately ignored events must get a 200.
- **GDPR:** add a `contact.privacyDeletion` subscription that purges data immediately.
- **No form-submission webhook exists,** so the poller stays.

### HS-WH-SIG-V3-ALGO — v3 signature algorithm, headers and the 5-minute window
- **Brief:** §5.2 "Verify the HubSpot v3 signature and reject requests older than 5 minutes **[VERIFY algorithm]**"; §7 "Webhook signatures verified (HubSpot, QStash, Razorpay) and timestamps checked."
- **Resolves:** [VERIFY] §5.2 algorithm
- **Verdict:** Confirmed — high confidence. The docs page could not be fetched; its text comes from a search summary and a verbatim January 2025 community mirror. All four official SDKs and two vendor-published vectors corroborate it byte for byte.
- **Finding:**
  - **Headers** (case-insensitive on receipt):
    - `X-HubSpot-Signature-v3`: a base64 string.
    - `X-HubSpot-Request-Timestamp`: Unix epoch in **milliseconds**, as a decimal string, e.g. `1790000001000`.
    - The docs spell the first header both `X-HubSpot-Signature-V3` and `X-HubSpot-Signature-v3`. Node exposes both headers in lowercase (`x-hubspot-signature-v3`, `x-hubspot-request-timestamp`), as in the docs sample.
  - **Source string:** `requestMethod + requestUri + requestBody + timestamp`, concatenated with NO separators and UTF-8 encoded. `timestamp` is the exact header string. HS-WH-SIG-V3-URI defines `requestUri`, and HS-WH-SIG-V3-SDK-PITFALLS covers `requestBody`.
  - **Signature:** `Base64( HMAC-SHA256( key = app client secret (UTF-8), message = sourceString ) )`. This is standard base64 with `+`, `/` and `=` padding (44 characters).
  - **Max age:** reject if `now_ms - timestamp_ms > 300000` (5 minutes). All four official SDKs implement exactly this:
    - Node `MAX_ALLOWED_TIMESTAMP = 300000` ms;
    - PHP `300000` ms;
    - Ruby `300_000` ms;
    - Python `300` s, after dividing the ms value by 1000.

    The exact boundary differs by SDK (see 03.1 V2).
  - **Comparison:** compare in constant time. The docs example uses `crypto.timingSafeEqual`, and the docs say "It's recommended that you use constant-time string comparison to guard against timing attacks." The Python, PHP and Ruby SDKs use `compare_digest`, `hash_equals` and `secure_compare`.
  - **SDK behaviour on a stale timestamp:** PHP `isValid` returns false; Node, Python and Ruby throw.
  - **SDK default signature version:** Node and PHP default to `'v1'`, Python and Ruby `is_valid` to `'v2'`. Any SDK call must pass `v3` explicitly.
  - **Per-attempt timestamp (inference, not documented):** retries arrive up to 24 h after the event and must still pass the 5-minute check. So the timestamp is the time of each delivery attempt, and each attempt is freshly signed. This is consistent with the header name.
  - **Scope of v3:** v3 headers come with Webhooks-API CRM subscription deliveries (e.g. `contact.creation`), not only with workflow or CRM-card requests. Community trigger code (Ballerina) that validates `X-HubSpot-Signature-v3` on those deliveries corroborates this.
- **Design consequence:** Implement our own `verifyHubSpotV3({clientSecret, method, uri, rawBody, signatureHeader, timestampHeader, nowMs})` with `node:crypto`: `createHmac`, then `timingSafeEqual` on equal-length Buffers (false on a length mismatch).
  - Require both headers, and require `timestampHeader` to match `/^\d{13}$/`.
  - Reject if `nowMs - ts > 300000`. ALSO reject if `ts - nowMs > 300000` (future skew). This is our own hardening; the docs only say "older than".
  - Return 401 on failure.
  - Do not depend on `@hubspot/api-client` for this: it is an 8,800-file package, and its `isValid` has the pitfalls in HS-WH-SIG-V3-SDK-PITFALLS.
- **Open risk:** The primary docs page (developers.hubspot.com) could not be fetched. The algorithm text comes from search snippets, corroborated byte for byte by four official SDKs and their published fixed vectors. During WIRE_UP:
  - re-read the request-validation page live;
  - confirm that a real HubSpot delivery, signed with the real client secret, passes our verifier;
  - if a retried delivery is seen, confirm the per-attempt timestamp inference on it.
- **Sources:**
  - https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation — official page via search summary — direct fetch blocked in sandbox — "The X-HubSpot-Signature-v3 header will be an HMAC SHA-256 hash built using the client secret of your app combined with details of the request. The timestamp is provided by the X-HubSpot-Request-Timestamp header." ... "Reject the request if the timestamp is older than 5 minutes." "Create a utf-8 encoded string that concatenates together: requestMethod + requestUri + requestBody + timestamp." ... "Base64 encode the result of the HMAC function."
  - https://developers.hubspot.com/changelog/introducing-version-3-of-webhook-signatures — official page via search summary — direct fetch blocked in sandbox — "HubSpot added two new headers to outgoing requests for OAuth Apps: X-HubSpot-Signature-v3 and X-HubSpot-Request-Timestamp. Prior versions of the X-HubSpot-Signature header continue to be included for backward compatibility."
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/src/utils/signature.ts — official SDK source — "case 'v3': sourceString = method + options.url + options.requestBody + options.timestamp; return crypto.createHmac('sha256', options.clientSecret).update(sourceString).digest('base64') ... public static readonly MAX_ALLOWED_TIMESTAMP = 300000"
  - https://github.com/HubSpot/hubspot-api-python/blob/master/hubspot/utils/signature.py — official SDK source — "source_string = f"{http_method}{http_uri}{request_body}{timestamp}" ... base64.b64encode(hmac.new(client_secret.encode("utf-8"), msg=source_string.encode("utf-8"), digestmod=hashlib.sha256).digest()) ... MAX_ALLOWED_TIMESTAMP = 300 ... return hmac.compare_digest(hashed_signature, signature)"
  - https://github.com/HubSpot/hubspot-api-python/blob/master/hubspot/utils/signature.py — official SDK source — "request_time = datetime.fromtimestamp(timestamp_float // 1000, tz=timezone.utc) ... return current_time - request_time < timedelta(seconds=Signature.MAX_ALLOWED_TIMESTAMP) (strict '<', second granularity); signature_version: str = "v2" default"
  - https://github.com/HubSpot/hubspot-api-php/blob/master/lib/Utils/Signature.php — official SDK source — "Reject the request if the timestamp is older than 5 minutes ... 5 minutes in milliseconds. public const MAX_ALLOWED_TIMESTAMP = 300000; ... return base64_encode(hash_hmac('sha256', $sourceString, static::getOptionOrThrow($options, 'secret'), true)); ... return hash_equals(...)"
  - https://github.com/HubSpot/hubspot-api-php/blob/master/lib/Utils/Signature.php — official SDK source — "if (($currentTimestamp - $timestamp) > static::MAX_ALLOWED_TIMESTAMP) { return false; } (returns false, does not throw; default signatureVersion 'v1')"
  - https://github.com/HubSpot/hubspot-api-ruby/blob/master/lib/hubspot/helpers/signature.rb — official SDK source — "MAX_ALLOWED_TIMESTAMP = 300_000 ... source_string = "#{http_method}#{http_uri}#{request_body}#{timestamp}"; OpenSSL::HMAC.base64digest('SHA256', client_secret, normalize_to_utf8(source_string)) ... secure_compare(signature, hashed_signature)"
  - https://github.com/HubSpot/hubspot-api-ruby/blob/master/lib/hubspot/helpers/signature.rb — official SDK source — "get_current_timestamp_microseconds - timestamp.to_i < MAX_ALLOWED_TIMESTAMP (strict '<'); signature_version: 'v2' default"
  - file:///tmp/claude-0/-home-user-Autopilot/93edeaab-e8bf-5524-b325-7fb2eb252823/scratchpad/vectors/hubspot-v3-vectors.js — local experiment — "node hubspot-v3-vectors.js (Node v22.22.0) requiring npm-packed official @hubspot/api-client@14.0.1 lib/src/utils/signature.js: all 5 vectors sdkEqualsIndependent=true; HS-V3-PY-SDK matchesPublished=true (K36dawei4A+QBNolUOqo7s91KQDWQ5MXZ/QufNYuk/Y=); HS-V3-RB-SDK matchesPublished=true (RnbPH7+UMKVkbV32P8bz450N4M56aPmcru1+D3kSDtw=); cross-check with official Python get_signature: all True."
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/validating-requests/content.txt — community, non-authoritative (Jan 2025 mirror of the official https://developers.hubspot.com/docs/api/webhooks/validating-requests) — "The X-HubSpot-Signature-v3 header will be an HMAC SHA-256 hash built using the client secret of your app combined with details of the request. It will also include a X-HubSpot-Request-Timestamp header." ... "Create a utf-8 encoded string that concatenates together the following: requestMethod + requestUri + requestBody + timestamp. The timestamp is provided by the X-HubSpot-Request-Timestamp header." ... "const MAX_ALLOWED_TIMESTAMP = 300000; // 5 minutes in milliseconds"
  - https://github.com/ballerina-platform/asyncapi-triggers/blob/main/asyncapi/hubspot/dispatcher_service.bal — community, non-authoritative — "string signatureV3 = check request.getHeader("X-HubSpot-Signature-v3"); ... string generatedHash = string `POST${self.listenerConfig.callbackURL}${payload.toString()}${timestamp}`; ... "contact.creation" => ..."

### HS-WH-SIG-V3-URI — what `requestUri` is, and which characters to decode
- **Brief:** Not addressed. It affects the §5.2 webhook route and the webhook URL in §10 WIRE_UP step 1.
- **Verdict:** Extended — high confidence. The decode table is not officially documented in any directly fetched source: it comes from a search summary and a January 2025 mirror of the official page. The SDK behaviour and the local experiments are first-hand.
- **Finding:**
  - **What it is:** `requestUri` is the FULL URL that HubSpot called: scheme + host + path + query string, e.g. `https://example.com/api/hubspot/webhooks`. The SDK tests use `https://www.example.com/webhook_uri`, and the docs Node example builds `` `https://${hostname}${url}` ``.
  - **Decode before computing:** the docs say to decode these percent-encodings in the URI first. The docs also say "you do not need to decode the question mark that denotes the beginning of the query string".

    | Encoded | Decoded |
    |---|---|
    | `%3A` | `:` |
    | `%2F` | `/` |
    | `%3F` | `?` |
    | `%40` | `@` |
    | `%21` | `!` |
    | `%24` | `$` |
    | `%27` | `'` |
    | `%28` | `(` |
    | `%29` | `)` |
    | `%2A` | `*` |
    | `%2C` | `,` |
    | `%3B` | `;` |
  - **Everything else stays encoded:** nothing else is listed. For example, `%20`, `%26` and `%3D` are not in the table, so leave them encoded.
  - **The SDKs do not decode:** the official Node, Python, PHP and Ruby SDKs use the `url` argument verbatim.
  - **Experiment:** using `http://` instead of `https://`, or adding a trailing `/`, each produces a different signature, so validation fails.
  - **Exact match (legacy v2 section of the same page):** "The URI used to build the source string must exactly match the original request, including the protocol. If you're having trouble validating the signature, ensure that any query parameters are in the exact same order they were listed in the original request." Community trigger code (Ballerina) also signs against the configured callback URL, not a URL rebuilt from the request.
- **Design consequence:** Do NOT reconstruct the URI from request headers on Vercel, because Host and X-Forwarded-* differ between preview and prod.
  - Add env `HUBSPOT_WEBHOOK_TARGET_URL`, set to the exact `targetUrl` in `webhooks-hsmeta.json` (e.g. `https://autopilot.hublytix.ai/api/hubspot/webhooks`, with no query string and no trailing slash), and sign against it.
  - If a query string is present, append it after applying the 12-entry decode map.
  - Put no redirect in front of the route (apex→www, trailing-slash 308).
  - WIRE_UP must say that `targetUrl` and the env var must be byte-identical.
- **Open risk:** Behaviour for characters outside the 12-entry table (e.g. `%20`) is undocumented, and no live HubSpot signature over a query-string URL was observed. Avoid both by never putting a query string in `targetUrl`. During WIRE_UP, confirm that a live delivery validates against `HUBSPOT_WEBHOOK_TARGET_URL` on the production domain.
- **Sources:**
  - https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation — official page via search summary — direct fetch blocked in sandbox — "In the request URI, decode any of the URL-encoded characters, but you do not need to decode the question mark that denotes the beginning of the query string." Table: %3A (:), %2F (/), %3F (?), %40 (@), %21 (!), %24 ($), %27 ('), %28 ((), %29 ()), %2A (*), %2C (,), %3B (;). Node example: "MAX_ALLOWED_TIMESTAMP = 300000", URI built as `https://${hostname}${url}`, digest("base64"), compared with crypto.timingSafeEqual.
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/src/utils/signature.ts — official SDK source — "sourceString = method + options.url + options.requestBody + options.timestamp (no decoding of options.url)"
  - file:///tmp/claude-0/-home-user-Autopilot/93edeaab-e8bf-5524-b325-7fb2eb252823/scratchpad/vectors/hubspot-v3-vectors.js — local experiment — "For every vector: sdkIsValid_http_instead_of_https={result:false}; sdkIsValid_trailing_slash={result:false}. HS-V3-AUTOPILOT-3-QUERY: raw 'https://example.com/api/hubspot/webhooks?src=hs%3Aapp%2Fv3&x=%28a%29' signed as decoded '...?src=hs:app/v3&x=(a)' -> G8ddQlikFQ0ScZOZn+MHQ0E3WCV7vOJTzKlvrkvbvuk=; over undecoded URI -> KKwrtu49d26FrUsDQdYcfAcwFssKn+cmyppOAUwOO/Q= (differs)."
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/validating-requests/content.txt — community, non-authoritative (Jan 2025 mirror of the official validating-requests page) — "In the request URI, decode any of the URL-encoded characters listed in the table below. You do not need to decode the question mark that denotes the beginning of the query string." Table: %3A : | %2F / | %3F ? | %40 @ | %21 ! | %24 $ | %27 ' | %28 ( | %29 ) | %2A * | %2C , | %3B ; Node sample: "const uri = `https://${hostname}${url}`;"
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/validating-requests/content.txt — community, non-authoritative (same mirror, v2 section) — "The URI used to build the source string must exactly match the original request, including the protocol. If you're having trouble validating the signature, ensure that any query parameters are in the exact same order they were listed in the original request."

### HS-WH-SIG-V3-SDK-PITFALLS — why we don't use `@hubspot/api-client`'s `Signature.isValid`, and how to pass the body
- **Brief:** Not addressed. It affects the §5.2 webhook route and the §8 test "signature verification with known vectors".
- **Verdict:** Extended — high confidence
- **Finding:** The signature is `@hubspot/api-client@14.0.1` (npm `latest`) `Signature.isValid({signature, clientSecret, requestBody, url, method='POST', signatureVersion='v1', timestamp})`. It has six pitfalls:
  1. **Wrong default version.** The default `signatureVersion` is `'v1'`, so you must pass `'v3'` explicitly. Under the default, a valid v3 signature returns false.
  2. **Throws instead of returning false.** It throws `Error('Timestamp is invalid, reject request')` when `timestamp` is undefined or `Date.now() - timestamp > 300000`. Exactly 300000 ms passes (strict `>`).
  3. **No future check.** A timestamp 10 min in the future validated true. The Python, Ruby and PHP SDKs have no future check either, because a negative age passes.
  4. **Not constant-time.** It compares with `options.signature === hash`.
  5. **No URI decoding.**
  6. **Non-numeric timestamps skip the age check.** A non-numeric timestamp gives NaN arithmetic, and the check is skipped silently. If the signature was computed over the same non-numeric timestamp, `isValid` returns **true**: `Date.now() - 'abc'` is NaN, and `NaN > 300000` is false. A numeric string such as `'1693657561000'` is coerced and works, even though `ISignatureOptions` types `timestamp?: number`.

  Two rules for the body:
  - **Raw body only.** `requestBody` must be the RAW body string, exactly as received (UTF-8). Re-serialising parsed JSON can change bytes. The docs' Node sample uses `JSON.stringify(body)`, which only works if serialisation round-trips identically.
  - **UTF-8 bytes.** Non-ASCII bodies are hashed as UTF-8 bytes (vector `HS-V3-AUTOPILOT-2-UTF8`).

  **Don't copy the docs' own Node sample; it has three bugs:**
  - it reads `timestampHeader` but compares and concatenates an undeclared `timestamp`;
  - it calls `response.status(200).send(...)` BEFORE validating;
  - it hashes `JSON.stringify(body)` instead of the raw body.
- **Design consequence:** In the Next.js route handler, read `const raw = await req.text()` BEFORE JSON parsing. Verify against `raw`, then `JSON.parse(raw)` and Zod-validate. Never log the raw body (PII).

  Unit tests:
  - **Positive:** the 5 fixed vectors, expected true with injected now = ts+1000.
  - **Negative:** tampered body; ts+1; wrong secret; `GET`; `http://`; trailing slash; stale ts+300001; future ts-600000 (rejected by our policy); missing headers; non-digit timestamp.
- **Open risk:** None.
- **Sources:**
  - https://www.npmjs.com/package/@hubspot/api-client/v/14.0.1 — official SDK source — "lib/src/utils/signature.js: static isValid(_a) { var { method = 'POST', signatureVersion = 'v1' } = _a, ... if (signatureVersion === 'v3') { const currentTime = Date.now(); if (options.timestamp === undefined || currentTime - options.timestamp > Signature.MAX_ALLOWED_TIMESTAMP) { throw new Error('Timestamp is invalid, reject request'); } } return options.signature === hash;"
  - file:///tmp/claude-0/-home-user-Autopilot/93edeaab-e8bf-5524-b325-7fb2eb252823/scratchpad/vectors/sdk-extra-checks.txt — local experiment — "With Date.now frozen at 1790000002000: 'v3 string-ts isValid true'; 'v3 NaN-ts isValid false' (no throw); 'v3 default signatureVersion (v1!) with v3 sig false'. Vector runs: sdkIsValid_at_exactly_300000ms={result:true}; sdkIsValid_at_300001ms_stale={threw:'Timestamp is invalid, reject request'}; sdkIsValid_future_ts_10min={result:true}."
  - https://www.npmjs.com/package/@hubspot/api-client/v/14.0.1 — local experiment — "node verify-wh/nan.js with Date.now frozen at 1790000000000: options {clientSecret:'s', requestBody:'[]', url:'https://example.com/x', method:'POST', signatureVersion:'v3', timestamp:'abc'} with signature = getSignature(same) -> 'non-numeric ts signed consistently -> isValid true'; timestamp '1000' (numeric string, ancient) -> threw 'Timestamp is invalid, reject request'. reverify.js: defaultV1 -> false, exact300000 -> true, stale300001 -> threw, future10m -> true, undefTs -> threw, strTs -> true."
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/validating-requests/content.txt — community, non-authoritative (Jan 2025 mirror of the official validating-requests page) — Docs Node sample: "response.status(200).send('Received webhook subscription trigger'); ... const timestampHeader = headers["x-hubspot-request-timestamp"]; ... if (currentTime - timestamp > MAX_ALLOWED_TIMESTAMP) { ... const rawString = `${method}${uri}${JSON.stringify(body)}${timestamp}`;" (timestamp never declared; 200 sent before validation)

### HS-WH-SIG-V3-VECTORS — known-answer test vectors for the v3 signature
- **Brief:** §8 Tests: "signature verification with known vectors".
- **Verdict:** Confirmed — high confidence
- **Finding:** There are five vectors. Two are published in official SDK test suites and three were generated for Autopilot; full inputs are in 03.2.

  | Vector | Inputs | Expected signature |
  |---|---|---|
  | `HS-V3-PY-SDK` | secret `yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy`, `POST`, `https://www.example.com/webhook_uri`, body `{'example_field':'example_value'}`, ts `1693657560000` | `K36dawei4A+QBNolUOqo7s91KQDWQ5MXZ/QufNYuk/Y=` |
  | `HS-V3-RB-SDK` | same, but ts `1700000300000` | `RnbPH7+UMKVkbV32P8bz450N4M56aPmcru1+D3kSDtw=` |
  | `HS-V3-AUTOPILOT-1` | secret `autopilot-test-client-secret-0001`, `POST`, `https://example.com/api/hubspot/webhooks`, a 2-event `contact.creation` body, ts `1790000001000` | `vc6X4JO1KMElXem9r7vSovD2GajkBW8j6R1JB/N89Rk=` |
  | `HS-V3-AUTOPILOT-2-UTF8` | see 03.2 | `iwUOcQxOJMXtoVai85f7uLyYuAp58oXpeyP5gPQKS2k=` |
  | `HS-V3-AUTOPILOT-3-QUERY` | see 03.2 | `G8ddQlikFQ0ScZOZn+MHQ0E3WCV7vOJTzKlvrkvbvuk=` |

  The verifier re-ran all five independently, and they reproduce byte for byte with:
  - the official Node SDK `getSignature`;
  - independent `node:crypto`;
  - the official Python `get_signature` (5/5);
  - the official Ruby `get_signature` (4/4 run);
  - the official PHP `getHashedSignature` (3/3 run).

  The body byte lengths are 33, 33, 449, 253 and 2.
- **Design consequence:** Copy the vectors verbatim into `test/fixtures/hubspot-signature-v3.json`, with each body stored as an exact string (no pretty-printing). The verifier takes an injectable `nowMs`, so the fixed timestamps are testable.
- **Open risk:** `HS-V3-AUTOPILOT-3-QUERY` encodes our reading of the documented decode table. No HubSpot-generated query-string signature was observed live.
- **Sources:**
  - file:///tmp/claude-0/-home-user-Autopilot/93edeaab-e8bf-5524-b325-7fb2eb252823/scratchpad/vectors/hubspot-v3-vectors.js — local experiment — "Official SDK Signature.getSignature == independent node:crypto for all 5; Signature.isValid (Date.now=ts+1000) true for all; false for tampered body / ts+1 / wrong secret / GET / http:// / trailing slash; official Python get_signature reproduces all 5 (True)."
  - https://github.com/HubSpot/hubspot-api-python/blob/master/tests/spec/utils/test_signature.py — official SDK source — ""signature": "K36dawei4A+QBNolUOqo7s91KQDWQ5MXZ/QufNYuk/Y=", "signature_version": "v3" ... data["timestamp"] = "1693657560000"; TEST_DATA client_secret "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy", request_body "{'example_field':'example_value'}", url "https://www.example.com/webhook_uri", http_method "POST""
  - https://github.com/HubSpot/hubspot-api-ruby/blob/master/spec/helpers/signature_spec.rb — official SDK source — ":timestamp=> 1_700_000_300_000, ... :v3_hash=> "RnbPH7+UMKVkbV32P8bz450N4M56aPmcru1+D3kSDtw=""
  - https://www.npmjs.com/package/@hubspot/api-client/v/14.0.1 — local experiment — "node verify-wh/reverify.js (Node v22.22.0): every vector eq=true (SDK getSignature == node:crypto == claimed), len 44; HS-V3-AUTOPILOT-3-QUERY-RAW(undecoded) -> KKwrtu49d26FrUsDQdYcfAcwFssKn+cmyppOAUwOO/Q= as claimed; v1 232db2615f3d666fe21a8ec971ac7b5402d33b9a925784df3ca654d05f4817de; v2 9569219f8ba981ffa6f6f16aa0f48637d35d728c7e4d93d0d52efaa512af7900"
  - https://github.com/HubSpot/hubspot-api-python/blob/master/hubspot/utils/signature.py — local experiment — "python3 verify-wh/pyverify.py <official signature.py>: True K36dawei4A+QBNolUOqo7s91KQDWQ5MXZ/QufNYuk/Y= / True RnbPH7+UMKVkbV32P8bz450N4M56aPmcru1+D3kSDtw= / True vc6X4JO1KMElXem9r7vSovD2GajkBW8j6R1JB/N89Rk= / True iwUOcQxOJMXtoVai85f7uLyYuAp58oXpeyP5gPQKS2k= / True G8ddQlikFQ0ScZOZn+MHQ0E3WCV7vOJTzKlvrkvbvuk="
  - https://github.com/HubSpot/hubspot-api-ruby/blob/master/lib/hubspot/helpers/signature.rb — local experiment — "ruby verify-wh/rbverify.rb <official signature.rb>: true for HS-V3-PY-SDK, HS-V3-RB-SDK, HS-V3-AUTOPILOT-2-UTF8 (iwUOcQ...), HS-V3-AUTOPILOT-3-QUERY (G8ddQl...)"
  - https://github.com/HubSpot/hubspot-api-php/blob/master/lib/Utils/Signature.php — local experiment — "php verify-wh/phpverify.php <official Signature.php>: true K36daw..., true vc6X4J..., true G8ddQl..."
  - https://github.com/HubSpot/hubspot-api-php/blob/master/tests/Unit/Utils/SignatureTest.php — official SDK source — "'signature' => '232db2615f3d666fe21a8ec971ac7b5402d33b9a925784df3ca654d05f4817de' ... 'signature' => '9569219f8ba981ffa6f6f16aa0f48637d35d728c7e4d93d0d52efaa512af7900'"

### HS-WH-SIG-V1-V2 — legacy v1/v2 signatures, which we do not accept
- **Brief:** §5.2 says "Verify the HubSpot v3 signature" and does not mention v1 or v2, so v3 only is implied.
- **Verdict:** Confirmed — high confidence
- **Finding:** HubSpot has two older signature versions:
  - **v1:** header `X-HubSpot-Signature`, a lowercase hex SHA-256 (a plain hash, not an HMAC) of `clientSecret + requestBody`, sent with `X-HubSpot-Signature-Version: v1`. The docs say v1 is what Webhooks-API CRM object subscriptions carry: "If your app is subscribed to CRM object events via the webhooks API, requests from HubSpot will be sent with the X-HubSpot-Signature-Version header set to v1." The research had labelled v1 "legacy app webhooks"; the verifier corrected that.
  - **v2:** a hex SHA-256 of `clientSecret + httpMethod + URI + requestBody`, sent with `X-HubSpot-Signature-Version: v2`. It is used for workflow webhook actions and CRM card fetches.

  Neither version has a timestamp, so neither resists replay. HubSpot sends the v3 headers alongside the older `X-HubSpot-Signature` for backward compatibility. The docs say: "For backwards compatibility, requests from HubSpot also include older versions of the signature."
- **Design consequence:** Ignore `X-HubSpot-Signature` and `X-HubSpot-Signature-Version`. Reject with 401 any request that lacks `X-HubSpot-Signature-v3` or `X-HubSpot-Request-Timestamp`.
- **Open risk:** None, beyond the live-delivery check in HS-WH-SIG-V3-ALGO, which confirms that both v3 headers arrive.
- **Sources:**
  - https://developers.hubspot.com/docs/apps/legacy-apps/authentication/validating-requests — official page via search summary — direct fetch blocked in sandbox — "To validate a request using the latest version of the HubSpot signature, use the X-HubSpot-Signature-V3 header, while to validate an older version of the signature, check the X-HubSpot-Signature-Version header, then follow the associated instructions based on whether the version is v1 or v2."
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/src/utils/signature.ts — official SDK source — "case 'v1': sourceString = options.clientSecret + options.requestBody; return crypto.createHash('sha256').update(sourceString).digest('hex') case 'v2': sourceString = options.clientSecret + method + options.url + options.requestBody; return crypto.createHash('sha256').update(sourceString).digest('hex')"
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/validating-requests/content.txt — community, non-authoritative (Jan 2025 mirror of the official validating-requests page) — "If your app is subscribed to CRM object events via the webhooks API, requests from HubSpot will be sent with the X-HubSpot-Signature-Version header set to v1." ... "If your app is handling data from a webhook action in a workflow, or if you're returning data for a custom CRM card, the request from HubSpot is sent with the X-HubSpot-Signature-Version header set to v2." ... ">>> hashlib.sha256(source_string).hexdigest() '232db2615f3d666fe21a8ec971ac7b5402d33b9a925784df3ca654d05f4817de'"
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/test/unit/signature.spec.ts — official SDK source — "signature: '9569219f8ba981ffa6f6f16aa0f48637d35d728c7e4d93d0d52efaa512af7900', ... requestBody: '{"example_field":"example_value"}', url: 'https://www.example.com/webhook_uri', method: 'POST', signatureVersion: 'v2'"

### HS-WH-PAYLOAD — shape of the request body
- **Brief:** Not addressed, though the brief implies that events carry `eventId`. §3 requires "Zod for every external payload".
- **Verdict:** Extended — high confidence. The common fields are first-hand from the official SDK fixture. The rest of the field table rests on search summaries and community mirrors of official pages, so it is not officially documented in any directly fetched source.
- **Finding:** The body is a JSON ARRAY of event objects, up to 100 per request. The docs say "Each request can contain up to 100 events" and also "The batch size can vary, but will be under 100 notifications".
  - **Common fields:**
    - `eventId` (number)
    - `subscriptionId` (number)
    - `portalId` (number, the HubSpot account ID)
    - `appId` (number)
    - `occurredAt` (number, epoch ms)
    - `subscriptionType` (string, e.g. `'contact.creation'` or `'object.creation'`)
    - `attemptNumber` (number; starts at 0 and increments per retry)
    - `objectId` (number)
    - `changeSource` (string, e.g. `'CRM'`)
    - `sourceId` (string, optional, e.g. `'userId:864745280'`)
    - `changeFlag` (string, on creation/deletion; the official SDK fixture shows `'NEW'` for `contact.creation`)
  - **Type key:** the docs field table labels the type field `eventType`, but every official payload example (guide, sensitive-data page, docs v1 example, SDK fixture) uses the key `subscriptionType`. Parse `subscriptionType`, and optionally tolerate `eventType`.
  - **New-format `object.*` events** add `objectTypeId` (string; `'0-1'` = contacts).
  - **`propertyChange` events** add `propertyName` and `propertyValue`, plus `isSensitive` for sensitive-data properties. In the classic format, the official example sends a sensitive property with `propertyValue` `"REDACTED"` and no `isSensitive` key. `isSensitive` appears only in the generic `object.*` payload.
  - **Merge events** add `primaryObjectId`, `mergedObjectIds[]`, `newObjectId` and `numberOfPropertiesMoved`.
  - **Association events** add `associationType`, `fromObjectId`, `toObjectId`, `associationRemoved` and `isPrimaryAssociation`.
  - **`conversation.newMessage`** adds `messageId` and `messageType` (`MESSAGE|COMMENT`). For conversations, `objectId` is the thread ID.
  - **No contact properties are included,** apart from a changed one, so the app must fetch the contact.
  - **The `changeFlag` enum** is undocumented in any reachable text.
- **Design consequence:** Validate with this Zod schema:

  ```ts
  z.array(HubSpotEvent).max(100)

  HubSpotEvent = z.object({
    eventId: z.number().int(),
    subscriptionId: z.number().int(),
    portalId: z.number().int(),
    appId: z.number().int(),
    occurredAt: z.number().int(),
    subscriptionType: z.string(),
    attemptNumber: z.number().int().min(0),
    objectId: z.number().int(),
    objectTypeId: z.string().optional(),
    changeSource: z.string().optional(),
    changeFlag: z.string().optional(),
    sourceId: z.string().optional(),
    propertyName: z.string().optional(),
    propertyValue: z.string().optional(),
  }).passthrough()
  ```

  - **Which events to handle:** `subscriptionType==='contact.creation' || (subscriptionType==='object.creation' && objectTypeId==='0-1')`. Ignore everything else with a 200.
  - **Which portals to trust:** check that `appId == HUBSPOT_APP_ID` and that `portalId` maps to an active connection. Ignore unknown or revoked portals with a 200, because a 4xx triggers retries.
  - **IDs:** store them as bigint or text (int64).
- **Open risk:** The full field table (the `changeFlag` enum, association fields) was seen only via search snippets and mirrors, so use passthrough and optional fields. int64 IDs above 2^53 would lose precision in `JSON.parse`; HubSpot IDs are currently far below that. During WIRE_UP, record the field names and types (not values) of one real `object.creation` delivery in a developer test account to confirm the shape.
- **Sources:**
  - https://developers.hubspot.com/docs/apps/legacy-apps/public-apps/create-generic-webhook-subscriptions — official page via search summary — direct fetch blocked in sandbox — field table: objectId, eventId, subscriptionId, portalId, appId, attemptNumber ("Starting at 0, which number attempt this is to notify your service of this event"), subscriptionType (object.creation, object.deletion, object.merge, object.restore, object.propertyChange, object.associationChange), objectTypeId, sourceId, propertyName/propertyValue, isSensitive; "For creation, deletion, merge, restore, and property change events, the associated object type is provided in the objectTypeId field of the payload."
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/test/unit/signature.spec.ts — official SDK source — "requestBody: '[{"eventId":1,"subscriptionId":12345,"portalId":62515,"occurredAt":1564113600000,"subscriptionType":"contact.creation","attemptNumber":0,"objectId":123,"changeSource":"CRM","changeFlag":"NEW","appId":54321}]'"
  - https://developers.hubspot.com/docs/api-reference/webhooks-webhooks-v3/guide — official page via search summary — direct fetch blocked in sandbox — "Each request can contain up to 100 events."
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/content.txt — community, non-authoritative (Jan 2025 mirror of the official https://developers.hubspot.com/docs/api/webhooks) — "eventId The ID of the event that triggered this notification. This value is not guaranteed to be unique." "portalId The customer's HubSpot account ID where the event occurred." "appId The ID of your application. This is used in case you have multiple applications pointing to the same webhook URL." "occurredAt When this event occurred as a millisecond timestamp." "eventType The type of event this notification is for." "attemptNumber Starting at 0, which number attempt this is to notify your service of this event." ... "The batch size can vary, but will be under 100 notifications."
  - https://github.com/teostereciu/mcpsynth/blob/4d6c087e40e32edb8d86e8f7468c86627bf779bd/benchmark/datasets/hubspot/docs/api_properties_sensitive-data.md — community, non-authoritative (mirror of the official https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/sensitive-data) — "// Example webhook payload [ { "eventId": 3029365631, "subscriptionId": 686627, "portalId": 891472211, "appId": 7906213, "occurredAt": 1715203101896, "subscriptionType": "contact.propertyChange", "attemptNumber": 0, "objectId": 847297356, "propertyName": "passport_number", "propertyValue": "REDACTED", "changeSource": "CRM_UI", "sourceId": "userId:882761034" } ]"
  - https://github.com/NicoLafakis/hs-trining-docs/blob/main/docs-guides-crm_transformed.json — community, non-authoritative (mirror of the official https://developers.hubspot.com/docs/guides/crm/public-apps/webhooks) — 'Response payloads' code tokens: "object.associationChange attemptNumber 0 objectId objectId changeSource objectTypeId propertyName object.propertyChange propertyValue object.propertyChange isSensitive true sourceId"

### HS-WH-DELIVERY — batch size, 5-second timeout, retries and concurrency
- **Brief:** §5.2 "Respond 200 fast and process asynchronously."
- **Verdict:** Confirmed — high confidence. The official OpenAPI spec backs the one-URL rule and `maxConcurrentRequests`. The timeout, retry and concurrency figures are not officially documented in any directly fetched source: they come from search summaries and a verbatim January 2025 mirror of the official guide.
- **Finding:**
  - **Batch size:** up to 100 events per POST.
  - **Timeout:** the endpoint must respond within **5 seconds**.
  - **Retry triggers:** HubSpot retries when the connection fails, when the response takes > 5 s, or when the status is **any 4xx or 5xx**.
  - **Retry schedule:** up to 10 retries spread over 24 hours, with randomised delays. This changed in Dec 2018 from 2^n-second backoff; that history is uncorroborated but irrelevant.
  - **Concurrency:** the docs say "HubSpot sets a concurrency limit of 10 requests when sending subscription event data associated with an account that installed your app".
    - It is configurable via `settings.maxConcurrentRequests`; the docs say it "must be a number greater than five", and the official template uses 10.
    - The 2026-09 spec describes `ThrottlingSettings.maxConcurrentRequests` (required, int32) as "The maximum number of concurrent requests allowed."
    - The v3 spec's wording about a `period` is legacy.
  - **One URL per app:** there is only one `targetUrl` per app.
- **Design consequence:** The route runs: verify signature → Zod → `INSERT` into `webhook_events` `ON CONFLICT DO NOTHING` → enqueue QStash job(s) → 200, well under 5 s.
  - Never return a 4xx or 5xx for a deliberately skipped event.
  - Do the heavy work (HubSpot fetch, LLM) in the QStash consumer.
  - Set `maxConcurrentRequests: 10`.
- **Open risk:** Whether one batch can mix portals is undocumented, so group by `portalId` defensively. During WIRE_UP, re-check the 5 s timeout and the 10-retries-over-24-h figures on the live docs page.
- **Sources:**
  - https://developers.hubspot.com/docs/api-reference/webhooks-webhooks-v3/guide — official page via search summary — direct fetch blocked in sandbox — "HubSpot will attempt to re-send failed notifications up to 10 times. These retries will be spread out over the next 24 hours, with varying delays between requests." "Each request can contain up to 100 events." "HubSpot sets a concurrency limit of 10 requests when sending subscription event data associated with an account that installed your app." Retries on "Connection failed", "Timeout (your service takes longer than five seconds to send back a response to a batch of notifications)", "Error codes (your service responds with any HTTP status code 4xx or 5xx)".
  - https://developers.hubspot.com/changelog/2018-12-10-updated-webhook-retry-logic — official page via search summary — direct fetch blocked in sandbox — "Failed webhook notifications will be retried a maximum of ten times, spread out over a 24 hour period." "Randomization is being introduced into the delay to prevent large numbers of concurrent failures to be continuously retried at the exact same interval."
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/147891/v3/webhooks.json — official OpenAPI spec — info.description: "There can only be one target URL for receiving event notifications per app." ThrottlingSettings.maxConcurrentRequests: "The maximum number of HTTP requests HubSpot will attempt to make to your app in a given time frame determined by `period`."
  - https://developers.hubspot.com/docs/apps/developer-platform/add-features/configure-webhooks — official page via search summary — direct fetch blocked in sandbox — maxConcurrentRequests "must be a number greater than five"
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/content.txt — community, non-authoritative (Jan 2025 mirror of the official webhooks guide) — "HubSpot sets a concurrency limit of 10 requests when sending subscription event data associated with an account that installed your app. This concurrency limit is the maximum number of in-flight requests that HubSpot will attempt at a time. Each request can contain up to 100 events." ... "maxConcurrentRequests The concurrency limit for the webhook URL. This value must be a number greater than five." ... "Timeout: your service takes longer than five seconds to send back a response to a batch of notifications. Error codes: your service responds with any HTTP status code (4xx or 5xx). Notifications will be retried up to 10 times. These retries will be spread out over the next 24 hours, with varying delays between requests."
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/147891/2026-09/webhooks.json — official OpenAPI spec — "ThrottlingSettings: {"required": ["maxConcurrentRequests"], ... "description": "The maximum number of concurrent requests allowed.", "format": "int32"}"

### HS-WH-IDEMPOTENCY — `eventId` is not guaranteed unique
- **Brief:** §5.2 "Be idempotent on `eventId`"; §6 `webhook_events` (`eventId` unique).
- **Verdict:** Corrected — high confidence. The official wording is not officially documented in any directly fetched source: it was seen via search summaries and a verbatim January 2025 mirror of the official guide.
- **Finding:** The docs say three things:
  - **`eventId` is not unique:** "The ID of the event that triggered this notification. This value is not guaranteed to be unique."
  - **Duplicates happen:** HubSpot "does not guarantee that you'll only get a single notification for an event. Though this should be rare, it is possible that HubSpot will send you the same notification multiple times".
  - **Order is not guaranteed:** HubSpot "does not guarantee that you'll receive these notifications in the order they occurred". Use `occurredAt` for ordering.

  Retries carry an incremented `attemptNumber`. The docs never say explicitly that a retry reuses the same `eventId`; they only say HubSpot "will attempt to send the notification again".
- **Design consequence:** Replace "`eventId` unique" with a composite key on `webhook_events` that excludes `attemptNumber`, e.g. `UNIQUE(portal_id, subscription_type, object_id, event_id, occurred_at)`.
  - Add business-level idempotency with `UNIQUE(portal_id, contact_id, submission_ts)` on `leads`, so the webhook and the poller collapse one submission into one lead.
  - The §8 "idempotent webhook replay" test replays the same body with `attemptNumber` 0 and 1 and expects one lead.
- **Open risk:** The "not guaranteed to be unique" wording comes from a search snippet and a community mirror of the official guide. Whether a retry reuses `eventId` is undocumented. The composite key is safe either way.
- **Sources:**
  - https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide — official page via search summary — direct fetch blocked in sandbox — "The eventId is the ID of the event that triggered the notification, and this value is not guaranteed to be unique."
  - https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide — official page via search summary — direct fetch blocked in sandbox — "HubSpot does not guarantee that you'll only get a single notification for an event. Though this should be rare, it is possible that HubSpot will send you the same notification multiple times." "HubSpot does not guarantee that you'll receive these notifications in the order they occurred." "Use the occurredAt property for each notification to determine when the event that triggered the notification occurred."
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/content.txt — community, non-authoritative (Jan 2025 mirror of the official webhooks guide) — "HubSpot does not guarantee that you'll receive these notifications in the order they occurred. Use the occurredAt property for each notification to determine when the event that triggered the notification occurred. HubSpot also does not guarantee that you'll only get a single notification for an event. Though this should be rare, it is possible that HubSpot will send you the same notification multiple times." Field table: "eventId The ID of the event that triggered this notification. This value is not guaranteed to be unique."

### HS-WH-SUBTYPE-CONTACT-CREATION — `object.creation` vs `contact.creation`, and the required scope
- **Brief:** §5.2 "Handle `contact.creation`"; the subscriptions in §10 WIRE_UP step 1.
- **Verdict:** Extended — high confidence. The brief's `contact.creation` is still valid, but the current platform prefers the generic form. The research first said "corrected"; the verifier relabelled it "extended". The scope requirement rests on a search summary and a community mirror of the official guide.
- **Finding:** Both types exist.
  - **The current developer platform** (projects, platform 2025.2/2026.03/2026.09) keeps subscriptions in the `crmObjects` array, in the generic format `{"subscriptionType": "object.creation", "objectType": "contact", "active": true}`. Deliveries then carry `subscriptionType` `"object.creation"` and `objectTypeId` `"0-1"`.
  - **Classic `contact.creation`** is still accepted in `legacyCrmObjects`. The docs say `crmObjects` "should be used for all events in the new format (object.*)", and that `legacyCrmObjects` holds "classic subscription types, such as contact.creation".
  - **`contact.privacyDeletion` and `conversation.*`** have no generic form and go in `hubEvents`.
  - **Scope:** all contact subscriptions require `crm.objects.contacts.read`.
  - **Enum:** both `'contact.creation'` and `'object.creation'` are in the 2026-09 `eventType` enum. That enum has 48 values and is identical across v3, 2025-09, 2026-03, 2026-09 and 2027-03-beta.
  - **Templates:** the 2025.2, 2026.03, 2026.09-beta and 2027.03-beta templates are JSON-identical to the 2026.09 one.
  - **Key name:** the 2023 projects-beta docs used the key `objectName`. Current templates use `objectType`, so use `objectType`.
- **Design consequence:** Subscribe with `object.creation` / `objectType: "contact"`, and make the handler accept both shapes.
  - `contact.creation` fires for every new contact (imports, API, manual entry, forms). It does NOT fire for repeat submissions by existing contacts.
  - So the handler must still fetch the contact and check form provenance (see the lead-intake section).
  - The scopes must include `crm.objects.contacts.read`.
- **Open risk:** None.
- **Sources:**
  - https://github.com/HubSpot/hubspot-project-components/blob/main/2026.09/components/webhooks/src/app/webhooks/webhooks-hsmeta.json — official SDK source — ""crmObjects": [{"subscriptionType": "object.creation", "objectType": "contact", "active": false}, ...], "legacyCrmObjects": [{"subscriptionType": "contact.propertyChange", "propertyName": "lastname", "active": false}, {"subscriptionType": "contact.deletion", "active": false}], "hubEvents": [{"subscriptionType": "contact.privacyDeletion", "active": false}]"
  - https://developers.hubspot.com/docs/apps/developer-platform/add-features/configure-webhooks — official page via search summary — direct fetch blocked in sandbox — "crmObjects: ... the standard array to include and should be used for all events in the new format (object.*)"; "legacyCrmObjects: An array containing classic subscription types, such as contact.creation and deal.deletion"; "hubEvents: An array containing the classic subscription types contact.privacyDeletion and conversation.*"
  - https://developers.hubspot.com/changelog/public-beta-generic-webhook-subscriptions — official page via search summary — direct fetch blocked in sandbox — new format uses object.creation "with the related object defined in the response objectTypeId field"; "generic webhook subscriptions are not currently supported for conversation.* and contact.privacyDeletion events"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/147891/2026-09/webhooks.json — official OpenAPI spec — "SubscriptionCreateRequest.eventType enum includes "contact.creation" and "object.creation""
  - https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide — official page via search summary — direct fetch blocked in sandbox — "All contact subscription types require the crm.objects.contacts.read scope, including: contact.creation, contact.deletion, contact.merge, contact.associationChange, contact.restore, contact.privacyDeletion, and contact.propertyChange."
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/content.txt — community, non-authoritative (Jan 2025 mirror of the official webhooks guide) — Scope table: "contact.creation crm.objects.contacts.read Get notified if any contact is created in a customer's account."
  - https://github.com/HubSpot/hubspot-project-components/blob/main/2027.03-beta/components/webhooks/src/app/webhooks/webhooks-hsmeta.json — official SDK source — "json.tool diff vs 2026.09 template: same (also same for 2025.2, 2026.03, 2026.09-beta)"
  - https://github.com/NicoLafakis/hs-trining-docs/blob/main/docs-guides-crm_transformed.json — community, non-authoritative (mirror of the 2023-era official https://developers.hubspot.com/docs/guides/crm/public-apps/webhooks) — "webhooks.json settings targetUrl maxConcurrentRequests ... subscriptions crmObjects object.* legacyCrmObjects hubEvents subscriptionType objectName propertyName active legacyCrmObjects contact.creation deal.deletion hubEvents contact.privacyDeletion conversation.*" (older key objectName)

### HS-WH-HSMETA-CONFIG — configuring webhooks with `webhooks-hsmeta.json`
- **Brief:** §10 WIRE_UP step 1: "Create the HubSpot public app (scopes, redirect URL, webhook URL and subscriptions)", as "exact click-by-click steps".
- **Verdict:** Extended — high confidence
- **Finding:** On the developer platform, webhooks are not configured by clicking. They are a project feature file, `src/app/webhooks/webhooks-hsmeta.json`, a singular sub-component of the app, deployed with the HubSpot CLI (`hs project upload`).
  - **Which app types:** the research said the file is "supported for oauth marketplace and private apps". No local official source corroborates that; `@hubspot/project-parsing-lib` only declares webhooks as a singular sub-component of the app.
  - **Shape:**

    ```text
    {"uid": string, "type": "webhooks", "config": {
      "settings": {"targetUrl": string, "maxConcurrentRequests": number},
      "subscriptions": {
        "crmObjects": [{"subscriptionType": "object.creation"|"object.propertyChange"|..., "objectType": "contact", "propertyName"?: string, "active": boolean}],
        "legacyCrmObjects": [{"subscriptionType": "contact.creation"|..., "propertyName"?: string, "active": boolean}],
        "hubEvents": [{"subscriptionType": "contact.privacyDeletion"|"conversation.*", "active": boolean}]
      }}}
    ```
  - **API endpoints:**
    - The legacy `/webhooks/v3/{appId}/...` endpoints are for legacy public apps.
    - Date-versioned `/app-webhooks/2026-09/{appId}/settings|subscriptions` endpoints also exist, authenticated with the developer API key (`hapikey` query param).
    - The path prefixes are not uniform. 2025-09 and 2026-09 use `/app-webhooks/{ver}/{appId}/...`, while 2026-03 uses `/webhooks/2026-03/{appId}/...`. 2027-03-beta adds `subscriptions/batch/create` and `batch/archive`.
    - `SettingsChangeRequest` requires `targetUrl` and `throttling`, and `ThrottlingSettings` requires `maxConcurrentRequests`.
  - **Settings cache:** settings can be cached for up to 5 minutes (03.1 V1).
  - **Private apps:** the legacy docs say private apps cannot edit webhook settings through the API. This does not affect our OAuth app.
- **Design consequence:** Ship `hubspot-project/src/app/webhooks/webhooks-hsmeta.json`:

  ```json
  {"uid":"autopilot_webhooks","type":"webhooks","config":{"settings":{"targetUrl":"https://autopilot.hublytix.ai/api/hubspot/webhooks","maxConcurrentRequests":10},"subscriptions":{"crmObjects":[{"subscriptionType":"object.creation","objectType":"contact","active":true}],"hubEvents":[{"subscriptionType":"contact.privacyDeletion","active":true}]}}}
  ```

  WIRE_UP step 1:
  1. Install the HubSpot CLI.
  2. Run `hs project upload`.
  3. Copy the client ID and secret from the app's Auth tab.
  4. Check that `targetUrl` is identical to `HUBSPOT_WEBHOOK_TARGET_URL`.
  5. Allow up to 5 minutes for settings changes to apply.
- **Open risk:** The `app-hsmeta.json` scopes and redirect fields belong to the OAuth section. During WIRE_UP, confirm that `hs project upload` accepts the webhooks file for our app type, because the "oauth marketplace and private apps" claim is uncorroborated.
- **Sources:**
  - https://github.com/HubSpot/hubspot-project-components/blob/main/2026.09/components/webhooks/src/app/webhooks/webhooks-hsmeta.json — official SDK source — "{"uid": "webhooks", "type": "webhooks", "config": {"settings": {"targetUrl": "https://example.com/webhook", "maxConcurrentRequests": 10}, "subscriptions": {"crmObjects": [...], "legacyCrmObjects": [...], "hubEvents": [...]}}}"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/147891/2026-09/webhooks.json — official OpenAPI spec — "GET/PUT/DELETE /app-webhooks/2026-09/{appId}/settings and /app-webhooks/2026-09/{appId}/subscriptions with security [{"developer_hapikey": []}]; developer_hapikey: {"type": "apiKey", "name": "hapikey", "in": "query"}; SettingsChangeRequest required ["targetUrl","throttling"]; ThrottlingSettings required ["maxConcurrentRequests"]"
  - https://developers.hubspot.com/docs/apps/developer-platform/add-features/configure-webhooks — official page via search summary — direct fetch blocked in sandbox — "Webhook subscriptions are defined in a configuration file using the naming convention *-hsmeta.json, located in the src/app/webhooks/ directory." uid and type ("webhooks") required; settings object required with targetUrl and maxConcurrentRequests; subscriptions object required.
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/147891/2026-03/webhooks.json — official OpenAPI spec — "GET/PUT/DELETE /webhooks/2026-03/{appId}/settings; GET/POST /webhooks/2026-03/{appId}/subscriptions (no 'app-' prefix in 2026-03)"
  - https://www.npmjs.com/package/@hubspot/project-parsing-lib/v/0.23.4 — official SDK source — "[WEBHOOKS_KEY]: { dir: WEBHOOKS_KEY, parentComponent: APP_KEY, userFriendlyName: 'Webhooks', ...SUB_COMPONENT_FIELDS, singularComponent: true }"

### HS-WH-CALC-PROPS — can conversion properties trigger `propertyChange` webhooks?
- **Brief:** §5.2 Poller: "conversion-date properties are calculated, so they can't be webhook-subscribed."
- **Verdict:** Not officially documented — medium confidence. The research said "confirmed"; the verifier corrected that to unverifiable-officially.
- **Finding:** The legacy Webhooks API guide documents this: "Certain properties are not available for CRM property change subscriptions. These properties are: num_unique_conversion_events, hs_lastmodifieddate."
  - **What is undocumented:** no reachable official source names `recent_conversion_date` or `num_conversion_events`. So whether a `(contact|object).propertyChange` subscription on them fires is UNDOCUMENTED.
  - **Supporting signals (non-authoritative):**
    - HubSpot Community answers say calculated properties do not produce webhooks.
    - Properties API metadata marks `recent_conversion_date`, `num_conversion_events`, `num_unique_conversion_events` and `first_conversion_date` as `calculated:true`.
    - `hs_lastmodifieddate` is `calculated:false`, so the official exclusion is not purely "calculated" properties.
  - **Conclusion:** do not rely on a `propertyChange` webhook for repeat submissions. Keep the 5-minute `recent_conversion_date` poller as the source of truth.
  - **Optional test:** test `object.propertyChange` on `recent_conversion_date` in a developer test account during WIRE_UP by submitting the same form twice as an existing contact. Treat any webhook it produces as a latency optimisation only.
- **Design consequence:** Keep the 5-minute poller (a search for `recent_conversion_date` > cursor) as the source of truth for repeat submissions; the webhook only speeds up new contacts. Add no `propertyChange` subscription on conversion properties.
- **Open risk:** The "calculated properties don't fire" rule rests only on a community answer seen via search snippet. It can be tested live in a developer test account during WIRE_UP (subscribe `object.propertyChange` on `recent_conversion_date` and submit twice), but not in the sandbox.
- **Sources:**
  - https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide — official page via search summary — direct fetch blocked in sandbox — "Certain properties are not available for CRM property change subscriptions, including num_unique_conversion_events and hs_lastmodifieddate."
  - https://community.hubspot.com/t5/APIs-Integrations/Trigger-webhook-when-Deal-associations-changes/m-p/290766 — community, non-authoritative (search summary; direct fetch blocked) — "HubSpot Webhooks do not support num_associated_contacts as this property (known as a calculated property) is treated differently on the backend. A list of calculated properties includes recent_conversion_date and num_conversion_events."
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/content.txt — community, non-authoritative (Jan 2025 mirror of the official webhooks guide) — "Certain properties are not available for CRM property change subscriptions. These properties are: num_unique_conversion_events hs_lastmodifieddate"
  - https://github.com/Tracardi/tracardi/blob/master/tracardi/process_engine/action/v1/connectors/hubspot/properties.json — community, non-authoritative — "Properties API dump: recent_conversion_date calculated True; num_conversion_events calculated True; num_unique_conversion_events calculated True; first_conversion_date calculated True; hs_lastmodifieddate calculated False (all readOnlyValue True)"

### HS-WH-FORM-SUBMISSION-EVENT — there is no webhook for form submissions
- **Brief:** Implied: there is none, so the §5.2 poller is needed.
- **Verdict:** Confirmed — high confidence
- **Finding:** No webhook exists for form submissions.
  - **Webhooks API:** the official 2026-09 and 2027-03-beta specs list the full `eventType` enum. It contains only these types, none of them a form-submission type:
    - `company`/`contact`/`deal`/`line_item`/`product`/`ticket`/`object` `.creation`/`.deletion`/`.merge`/`.restore`/`.propertyChange`/`.associationChange`;
    - `contact`/`conversation` `.privacyDeletion`;
    - `conversation.creation`/`.deletion`/`.newMessage`/`.propertyChange`;
    - `event.completed`.
  - **Webhooks Journal:** its subscription types are `OBJECT`, `ASSOCIATION`, `APP_LIFECYCLE_EVENT`, `LIST_MEMBERSHIP` and `GDPR_PRIVACY_DELETION`, again with no forms.
  - **Residual unknown:** the enum includes `event.completed`, which is used with the optional `eventTypeName` field. The v3 spec describes `eventTypeName` as "The name of the event to listen for. This is used with custom objects to specify custom event types beyond the standard eventType enum values." Its semantics are not documented in any reachable source, and nothing suggests it covers native form submissions.
  - **Non-webhook routes:** push routes outside webhooks do exist: a workflow "webhook action", or an app-defined custom workflow action triggered by a form-submission workflow. They need the customer to build a workflow and are tier-gated (tier not verified here), so they don't fit v1.
- **Design consequence:** Lead intake uses three paths:
  - the contact-creation webhook, as the fast path;
  - the poller over `recent_conversion_date`, as the complete path;
  - the Forms submissions API, for the message text (see the lead-intake section).
- **Open risk:** None. The only residual unknown is `event.completed`/`eventTypeName`, which is not relevant to native forms.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/147891/2026-09/webhooks.json — official OpenAPI spec — "SubscriptionCreateRequest.eventType enum: "company.associationChange" ... "contact.creation" ... "conversation.newMessage" ... "event.completed" ... "object.creation" ... "ticket.restore" (48 values, none for forms or app lifecycle)"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/334885/2027-03-beta/webhooks.json — official OpenAPI spec — "2027-03-beta eventType enum identical to 2026-09; only new schemas BatchInputSubscriptionCreateRequest, CrmBulkSnapshotRequest, CrmBulkSnapshotResponse"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks%20Journal/Webhooks%20Journal/Rollouts/284944/2026-09/webhooksJournal.json — official OpenAPI spec — "SubscriptionUpsertRequest oneOf [ObjectSubscriptionUpsertRequest, AssociationSubscriptionUpsertRequest, AppLifecycleEventSubscriptionUpsertRequest, ListMembershipSubscriptionUpsertRequest, GdprPrivacyDeletionSubscriptionUpsertRequest]"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/147891/v3/webhooks.json — official OpenAPI spec — "SubscriptionCreateRequest.eventTypeName: "The name of the event to listen for. This is used with custom objects to specify custom event types beyond the standard eventType enum values."; enum includes "event.completed""
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/validating-requests/content.txt — community, non-authoritative (Jan 2025 mirror of the official validating-requests page) — "If your app is handling data from a webhook action in a workflow, or if you're returning data for a custom CRM card, the request from HubSpot is sent with the X-HubSpot-Signature-Version header set to v2."

### HS-WH-JOURNAL — the Webhooks Journal, a pull-based event log
- **Brief:** Not addressed (relates to the §5.2 poller).
- **Verdict:** Extended — medium confidence. The endpoints, the tier, the rate-limit exemptions and the request/response schemas come from the official OpenAPI spec. The snapshot scopes, 3-day retention, the 10,000-event/5 MB file size and the gating history rest only on search summaries, so they are not officially documented in any directly fetched source.
- **Finding:** The Journal is a pull-based event log ("webhooks v4"). Its 2026-09 endpoints:
  - **Subscriptions:**
    - `POST`/`GET /webhooks-journal/subscriptions/2026-09`
    - `GET`/`DELETE /webhooks-journal/subscriptions/2026-09/{subscriptionId}`
    - `DELETE /webhooks-journal/subscriptions/2026-09/portals/{portalId}`
  - **Filters:**
    - `POST /webhooks-journal/subscriptions/2026-09/filters`, with body `{subscriptionId, filter:{conditions:[{filterType:'CRM_OBJECT_PROPERTY', property, operator: EQ|N_EQ|LT|GT|LTE|GTE|CONTAINS|STARTS_WITH|ENDS_WITH|IN|NOT_IN|IS_EMPTY|IS_NOT_EMPTY, value|values}]}}`
    - also `GET filters/subscription/{subscriptionId}` and `GET`/`DELETE filters/{filterId}`
  - **Journal reads:**
    - `GET /webhooks-journal/journal/2026-09/earliest|latest|offset/{offset}/next`
    - batch reads: `GET /batch/earliest/{count}`, `/batch/latest/{count}`, `/batch/{offset}/next/{count}`, `POST /batch/read` and `GET /status/{statusId}`
    - per-install variants under `/webhooks-journal/journal-local/2026-09/...?installPortalId=`
  - **Snapshots:** `POST /webhooks-journal/snapshots/2026-09/crm`, with body `({snapshotRequests:[{portalId, objectId, objectTypeId, properties[]}]})`.

  How it behaves:
  - **Read responses:** reads return `{currentOffset (uuid), expiresAt, url (presigned S3 file)}`. In the spec, `JournalFetchResponse` appears only in the batch responses; the single reads declare only a `default` response. Community code verified against the live API on 2026-09-03 reports that the single reads return `{url, expiresAt, currentOffset}`, or 204 when empty.
  - **The file:** it holds `{offset, journalEvents[], publishedAt}`, with up to 10,000 events or 5 MB per file (July 2026).
  - **`OBJECT` subscriptions** require `portalId`, `objectTypeId`, `actions` (`CREATE|UPDATE|DELETE|MERGE|RESTORE...`), `properties[]` and `objectIds[]`. You need one subscription per installed portal.
  - **Auth:** an app-level client-credentials token (`POST /oauth/2026-09/token`, `grant_type=client_credentials`; `client_credentials` is a valid `grant_type` in the official OAuth 2026-09 spec). The scopes are:
    - `developer.webhooks_journal.read`
    - `developer.webhooks_journal.subscriptions.read` / `.write`
    - `developer.webhooks_journal.snapshots.read` / `.write`

    Community code corroborates three of the five scope strings and the client-credentials usage.
  - **Retention:** the past 3 days.
  - **Tier and limits:** the spec says `FREE` for all hubs, and journal operations are exempt from the daily and ten-secondly rate limits.
  - **Availability:**
    - It was a gated beta in late 2025 (scopes were rejected, per the community).
    - The 2026-03/2026-09 docs and the Spring and July 2026 changelogs show active development.
    - `@hubspot/project-parsing-lib` 0.23.4 knows a `'webhooks-journal'` project component, but no public template exists.
    - A community integration says it was verified against the live 2026-09 API on 2026-09-03, and that the `/v4` paths go unsupported on 2027-03-30. That suggests the Journal is usable now, but this is not confirmed officially.
  - **Could it replace polling?** Only if a journal `OBJECT` `UPDATE` subscription on contacts with `properties ['recent_conversion_date']` records changes to that calculated property, which is undocumented.
- **Design consequence:** v1 keeps the CRM-search poller, which is documented and works on Free/Starter with `crm.objects.contacts.read`. Put intake behind a `LeadSource` interface so that a `JournalLeadSource` can replace the poller later.

  DECISIONS.md records that the Journal is rejected for v1 because:
  - (a) journaling of calculated properties is undocumented;
  - (b) it needs extra `developer.*` scopes and a client-credentials flow;
  - (c) availability and gating are uncertain;
  - (d) 3-day retention needs robust offset persistence.
- **Open risk:** The Journal's GA status and whether it journals calculated properties must be tested with a real developer account.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks%20Journal/Webhooks%20Journal/Rollouts/284944/2026-09/webhooksJournal.json — official OpenAPI spec — "info.version "2026-09", x-hubspot-product-tier-requirements all "FREE"; operations "x-hubspot-rate-limit-exemptions": ["daily","ten-secondly"], "security": []; ObjectSubscriptionUpsertRequest required ["actions","objectIds","objectTypeId","portalId","properties","subscriptionType"]; JournalFetchResponse required ["currentOffset","expiresAt","url"]; Condition.filterType enum ["CRM_OBJECT_PROPERTY"]"
  - https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/guide — official page via search summary — direct fetch blocked in sandbox — "The webhooks journal API uses a client credentials token to authorize actions on behalf of your app." Scopes developer.webhooks_journal.read, developer.webhooks_journal.subscriptions.read/.write, developer.webhooks_journal.snapshots.read/.write; "query for changes that occurred for your subscriptions for the past 3 days"; token POST /oauth/2026-09/token grant_type=client_credentials.
  - https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/journal-entries/guide — official page via search summary — direct fetch blocked in sandbox — journal file has offset, journalEvents [{type: crmObject | association | app_lifecycle_event, portalId, occurredAt (ISO 8601), action, objectTypeId, objectId, propertyChanges}], publishedAt; local journal scoped by installPortalId.
  - https://developers.hubspot.com/changelog/july-2026-rollup — official page via search summary — direct fetch blocked in sandbox — "HubSpot is increasing the Webhooks Journal batch size from batches of 100 records per S3 file to up to 10,000 or 5MB (whichever comes first)."
  - https://developers.hubspot.com/changelog/spring-2026-spotlight — official page via search summary — direct fetch blocked in sandbox — Spring 2026 added "batched reads", "CRM object filtering on subscriptions", "list membership subscriptions", "snapshot status polling endpoint".
  - https://community.hubspot.com/t5/Third-Party-Apps/Webhooks-v4-API-Required-Scopes-Not-Available-in-Developer/m-p/1218755 — community, non-authoritative (search summary, late 2025; direct fetch blocked) — "[ERROR] The scope developer.webhooks_journal.read could not be recognized."; access gated / limited rollout.
  - https://www.npmjs.com/package/@hubspot/project-parsing-lib/v/0.23.4 — official SDK source — "src/lib/constants.js: export const WEBHOOKS_JOURNAL_KEY = 'webhooks-journal'; [WEBHOOKS_JOURNAL_KEY]: { dir: WEBHOOKS_JOURNAL_KEY, parentComponent: APP_KEY, userFriendlyName: 'Webhooks Journal', ...SUB_COMPONENT_FIELDS, singularComponent: true }"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Auth/Oauth/Rollouts/279897/2026-09/oauth.json — official OpenAPI spec — "POST /oauth/2026-09/token application/x-www-form-urlencoded: "grant_type": {"type": "string", ... "enum": ["authorization_code", "client_credentials", "refresh_token"]}, "scope": {"type": "string"}"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks%20Journal/Webhooks%20Journal/Rollouts/284944/2026-09/webhooksJournal.json — official OpenAPI spec — "GET /webhooks-journal/journal/2026-09/earliest responses: ['default'] only; GET /webhooks-journal/journal/2026-09/batch/earliest/{count} 200 -> BatchResponseJournalFetchResponse; AppLifecycleEventSubscriptionUpsertRequest.eventTypeId description: "A string representing the unique identifier for the event type that the subscription is related to." (no IDs listed in 2026-09)"
  - https://github.com/usertour/usertour/blob/main/apps/server/src/modules/integrations/sync/hubspot-journal-api.ts — community, non-authoritative — "Verified against the live API on 2026-09-03: `earliest` / `latest` / `offset/{offset}/next` answer `{ url, expiresAt, currentOffset }` (204 when there is nothing), and the page at `url` is `{ offset, journalEvents: [...], publishedAt }`. The date-versioned paths keep those shapes; the `/v4` ones they replace go unsupported on 2027-03-30." ... HUBSPOT_JOURNAL_SCOPES = 'developer.webhooks_journal.read developer.webhooks_journal.subscriptions.read developer.webhooks_journal.subscriptions.write'; grant_type: 'client_credentials' to https://api.hubapi.com/oauth/2026-09/token

### HS-WH-UNINSTALL-EVENT — HubSpot does not push an uninstall notification
- **Brief:** §5.1 "Uninstall or disconnect: stop all processing immediately and purge the portal's data after 30 days **[VERIFY whether HubSpot notifies apps of uninstall]**."
- **Resolves:** [VERIFY] §5.1 whether HubSpot notifies apps of uninstall
- **Verdict:** Extended — medium confidence. The official OpenAPI specs back the absence of a push event, the Journal subscription shape and the uninstall endpoint. Three things rest only on search summaries, so they are not officially documented in any directly fetched source: the Journal lifecycle-event payload fields, lifecycle events coming "soon" to push webhooks, and the May 2026 certification rule.
- **Finding:** HubSpot gives no push notification of an uninstall, only a pull-based Journal event.
  - **No push webhook:** the Webhooks API `eventType` enum has no install or uninstall type in any of the five spec versions checked (v3, 2025-09, 2026-03, 2026-09 and 2027-03-beta, all identical), and `webhooks-hsmeta.json` has no lifecycle array.
  - **Yes via the Webhooks Journal (pull):**
    - **Subscription:** `{"subscriptionType": "APP_LIFECYCLE_EVENT", "eventTypeId": "4-1916193" (uninstall) | "4-1909196" (install), "properties": [...]}`. The required fields are `eventTypeId`, `properties` and `subscriptionType`. There is no `portalId`; the subscription is app-wide.
    - **Where the IDs appear:** the event type IDs are in the Webhooks 2026-09 spec and the Journal 2027-03-beta spec, but NOT in the Journal 2026-09 spec's description.
    - **Journal events:** `{type: 'app_lifecycle_event', action: 'APP_UNINSTALL'|'APP_INSTALL', portalId, occurredAt, eventTypeId, properties: {hs_app_id, hs_app_install_level, hs_initiating_user_id, hs_user_id}}`.
  - **Push support is only promised:** the docs say lifecycle events are coming "soon" to the v3 (push) Webhooks API. They are not in the specs as of 2026-09 and 2027-03-beta.
  - **The app can uninstall itself:** `DELETE https://api.hubapi.com/appinstalls/2026-09/external-install` (legacy `/appinstalls/v3/external-install`; a `2026-03` version also exists).
    - **Auth:** it is called with the portal's OAuth Bearer token. The spec declares `security: []`, but HubSpot's official Postman collection in the same repo uses OAuth2 (`authorization_code`, scope `oauth`) with a bearer token.
    - **Result:** it returns 204, and the account's admins get an email. It removes the app's features and webhooks for that account.
    - **Certification:** it has been REQUIRED for new and re-certified marketplace apps since May 2026.
- **Design consequence:** For v1, treat a refresh failure (`invalid_grant`/`BAD_REFRESH_TOKEN`), and a 401 on API calls, as revoked/uninstalled, because no push notification exists. On that signal:
  - stop processing;
  - cancel jobs;
  - start the 30-day purge clock.

  Later, a `JournalSource` could optionally poll `APP_LIFECYCLE_EVENT` `4-1916193`.

  The owner's "Disconnect" action should call `DELETE /appinstalls/2026-09/external-install` with the portal's access token, then delete the tokens locally; marketplace certification needs this. `HubSpotClient` gains `uninstallApp(portalId)`, and the fake records the call.
- **Open risk:** The Journal lifecycle payload fields come from search snippets. Push-webhook lifecycle support ("soon") may land later. Re-check both, and the May 2026 certification requirement, before marketplace submission. During WIRE_UP, call the uninstall endpoint once against a developer test account and confirm the 204 and the bearer-token auth.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/147891/2026-09/webhooks.json — official OpenAPI spec — "AppLifecycleEventSubscriptionUpsertRequest: required ["eventTypeId","properties","subscriptionType"]; eventTypeId description: "4-1909196: App install event\n4-1916193: App uninstall event"; subscriptionType enum ["APP_LIFECYCLE_EVENT"]; actions enum includes "APP_INSTALL", "APP_UNINSTALL"; SubscriptionCreateRequest.eventType enum has no lifecycle value"
  - https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/guide — official page via search summary — direct fetch blocked in sandbox — "App lifecycle events (app_install and app_uninstall) are available through both the Webhooks Journal API and soon the v3 Webhooks API"; "To subscribe to app install or app uninstall events, use your client credentials token to make a POST request to /webhooks-journal/subscriptions/2026-03"
  - https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/journal-entries/guide — official page via search summary — direct fetch blocked in sandbox — app lifecycle journal events have type "app_lifecycle_event", action APP_INSTALL / APP_UNINSTALL, portalId, eventTypeId, properties hs_app_id, hs_app_install_level, hs_initiating_user_id, hs_user_id.
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/App%20Uninstalls/Rollouts/209039/2026-09/appUninstalls.json — official OpenAPI spec — "DELETE /appinstalls/2026-09/external-install "Uninstall app": "Use this endpoint to uninstall your app from a customer's HubSpot account. If successful, this endpoint will return a 204 and the customer will receive an email notification that the developer has uninstall the app from their account.""
  - https://developers.hubspot.com/changelog/app-listing-and-app-certification-requirement-updates-for-may-2026 — official page via search summary — direct fetch blocked in sandbox — "For all new app certification submissions and apps undergoing recertification, your app must use the Uninstall App API endpoint: DELETE /appinstalls/v3/external-install. This endpoint requires an active OAuth access token and fully removes your app from a customer's HubSpot account, including all associated features and webhooks."
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/App%20Uninstalls/Rollouts/209039/v3/App%20Uninstall%20API%20Collection%20Directory/App%20Management%20-%20Uninstall%20API%20Collection.json — official OpenAPI spec (HubSpot's Postman collection in the spec repo) — ""request": {"auth": {"type": "oauth2", "oauth2": [{"key": "scope", "value": "oauth"}, ... {"key": "grant_type", "value": "authorization_code"}]}, "method": "DELETE", ... "path": ["appinstalls", "v3", "external-install"]; response "No content" code 204"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks%20Journal/Webhooks%20Journal/Rollouts/334885/2027-03-beta/webhooksJournal.json — official OpenAPI spec — "AppLifecycleEventSubscriptionUpsertRequest.eventTypeId: "A string representing the unique identifier for the event type associated with the app lifecycle event. ... 4-1909196: App install event 4-1916193: App uninstall event""

### HS-WH-GDPR-PRIVACY-DELETION — reacting to HubSpot GDPR deletions
- **Brief:** Not addressed. It relates to §2 product law 4 (data minimisation) and §5.14 retention.
- **Verdict:** Extended — high confidence. The subscription type, its placement and the scope come from the official template and spec. The rule that a privacy deletion also sends a contact-deletion event rests only on a community mirror of the official guide, so it is not officially documented in any directly fetched source.
- **Finding:** HubSpot offers `contact.privacyDeletion`, which requires `crm.objects.contacts.read`.
  - **Placement:** it is a classic type that goes in `hubEvents`; there is no generic `object.*` equivalent. The official `webhooks-hsmeta` template includes it under `hubEvents`.
  - **Journal equivalent:** the Journal also has `subscriptionType` `GDPR_PRIVACY_DELETION` (action `GDPR_DELETE`).
  - **Double notification:** a privacy deletion ALSO triggers the ordinary contact deletion event. The two notifications may arrive in either order and in different batches, and must be matched by `objectId`. The docs: "A privacy deletion event will also trigger the contact deletion event, so you will receive two notifications if you are subscribed to both events."
- **Design consequence:** Subscribe to `contact.privacyDeletion` and immediately purge that contact's `lead_messages` and `drafts` and cancel its follow-ups, rather than waiting for the 30-day job. This is read-only and in line with product law 4.
  - Key the purge on `(portalId, objectId)` and make it idempotent, because a duplicate or reordered `contact.deletion`/`object.deletion` may also arrive.
  - Consider also subscribing to `object.deletion` for contacts. That would purge drafts and cancel follow-ups for ordinary deletes too, which serves product law 4 and the §5.6 "contact deleted" hard stop.
- **Open risk:** The `privacyDeletion` payload was not retrieved; assume the common fields plus `objectId`. During WIRE_UP, record the shape of one live privacy deletion in a developer test account (field names only).
- **Sources:**
  - https://github.com/HubSpot/hubspot-project-components/blob/main/2026.09/components/webhooks/src/app/webhooks/webhooks-hsmeta.json — official SDK source — ""hubEvents": [{"subscriptionType": "contact.privacyDeletion", "active": false}]"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/147891/2026-09/webhooks.json — official OpenAPI spec — "eventType enum includes "contact.privacyDeletion"; GdprPrivacyDeletionSubscriptionUpsertRequest subscriptionType enum ["GDPR_PRIVACY_DELETION"], "Valid action is 'GDPR_DELETE'""
  - https://developers.hubspot.com/changelog/public-beta-generic-webhook-subscriptions — official page via search summary — direct fetch blocked in sandbox — "generic webhook subscriptions are not currently supported for conversation.* and contact.privacyDeletion events, so you should use the old format for webhooks for these cases."
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/content.txt — community, non-authoritative (Jan 2025 mirror of the official webhooks guide) — "You can subscribe to the contact.privacyDeletion subscription type to receive webhook notifications when a user performs a privacy compliant contact deletion. Privacy deletion notifications have some special behavior: A privacy deletion event will also trigger the contact deletion event, so you will receive two notifications if you are subscribed to both events. These notifications will not necessarily be sent in any specific order or in the same batch of messages. You will need to use the object ID to match the separate messages."

### 03.1 Verifier-added items

#### V1 — Operational limits that affect WIRE_UP and ops
- **Brief:** Not addressed. It relates to §10 WIRE_UP step 1 and the §5.2 webhook route.
- **Verdict:** Not officially documented — medium confidence. These limits appear only in a January 2025 community mirror of the official webhooks guide, and the live page could not be fetched.
- **Finding:**
  1. **Settings cache:** webhook settings (target URL, concurrency, subscriptions) can be cached for up to 5 minutes, so changes may take up to 5 minutes to take effect. WIRE_UP should wait about 5 minutes before the live test.
  2. **Rate limits:** webhook POSTs from HubSpot do not count against the app's API rate limits.
  3. **Subscription cap:** at most 1000 subscriptions per application, with a 400 when exceeded. This is irrelevant to us (1–2 subscriptions).
  4. **Per-account concurrency:** the concurrency limit (default 10, `maxConcurrentRequests` > 5) applies per installing account, so a busy portal cannot use up another portal's in-flight slots.

  Whether one request can mix portals is still undocumented, so group by `portalId`.
- **Design consequence:** WIRE_UP step 1 waits about 5 minutes after `hs project upload` (or any settings change) before the live webhook test. The webhook route groups each batch by `portalId`.
- **Open risk:** During WIRE_UP, re-check all four figures on the live developers.hubspot.com webhooks guide.
- **Sources:**
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/content.txt — community, non-authoritative (Jan 2025 mirror of the official webhooks guide) — "Webhook settings can be cached for up to five minutes. When making changes to the webhook URL, concurrency limits, or subscription settings, it may take up to five minutes to see your changes go into effect." ... "POST requests that HubSpot sends to your service via your webhook subscriptions will not count against your app's API rate limits. You can create a maximum of 1000 subscriptions per application." ... "HubSpot sets a concurrency limit of 10 requests when sending subscription event data associated with an account that installed your app."

#### V2 — The official SDKs disagree on the 5-minute boundary; our verifier rule
- **Brief:** §5.2 "reject requests older than 5 minutes"; §8 "signature verification with known vectors".
- **Verdict:** Extended — high confidence
- **Finding:** The official SDK validators do NOT agree on the exact boundary or on timestamp parsing:
  - **Node and PHP:** Node (`@hubspot/api-client` 14.0.1) and PHP reject only when age > 300000 ms, so exactly 300000 ms passes.
  - **Ruby:** rejects at age >= 300000 ms; a request is valid only when age < 300000.
  - **Python:** floors the timestamp to whole seconds and accepts only age < 300 s.
  - **Node string handling:** Node also coerces strings. A non-numeric timestamp makes the age check NaN, so the check is silently skipped: `isValid` returns true if the signature was computed over the same garbage timestamp.
- **Design consequence:** Our verifier rule:
  - require `/^\d{13}$/` and parse with `Number()`;
  - reject if `nowMs - ts > 300000` or `ts - nowMs > 300000`;
  - then compare with `crypto.timingSafeEqual` on equal-length Buffers.

  Add unit tests at age 300000 (accept) and 300001 (reject), so the boundary is explicit.
- **Open risk:** None.
- **Sources:**
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/src/utils/signature.ts — official SDK source — "if (options.timestamp === undefined || currentTime - options.timestamp > Signature.MAX_ALLOWED_TIMESTAMP) { throw new Error('Timestamp is invalid, reject request') }"
  - https://github.com/HubSpot/hubspot-api-ruby/blob/master/lib/hubspot/helpers/signature.rb — official SDK source — "get_current_timestamp_microseconds - timestamp.to_i < MAX_ALLOWED_TIMESTAMP"
  - https://github.com/HubSpot/hubspot-api-python/blob/master/hubspot/utils/signature.py — official SDK source — "request_time = datetime.fromtimestamp(timestamp_float // 1000, tz=timezone.utc) ... return current_time - request_time < timedelta(seconds=Signature.MAX_ALLOWED_TIMESTAMP)"
  - https://www.npmjs.com/package/@hubspot/api-client/v/14.0.1 — local experiment — "verify-wh/nan.js: timestamp 'abc' with signature computed over 'abc' -> isValid true (age check skipped); verify-wh/reverify.js: exact300000 -> {result:true}, stale300001 -> {threw:'Timestamp is invalid, reject request'}"

### 03.2 Test vectors

Every vector uses `signature = base64(HMAC_SHA256(key=clientSecret, msg=UTF8(method + signedUri + body + timestampHeader)))`.

Where they come from:
- **Published by the vendor:** `HS-V3-PY-SDK` (official Python SDK tests) and `HS-V3-RB-SDK` (official Ruby SDK spec). The legacy v1 and v2 reference values are in the official Node and PHP SDK tests, and the v1 value is also printed on the docs page.
- **Generated locally for Autopilot:** `HS-V3-AUTOPILOT-1`, `HS-V3-AUTOPILOT-2-UTF8` and `HS-V3-AUTOPILOT-3-QUERY`. Each was checked with the unmodified official `@hubspot/api-client@14.0.1` `Signature.getSignature`, the official Python `get_signature` and independent `node:crypto`. The verifier then reproduced them with the official Ruby and PHP code as well.

`HS-V3-AUTOPILOT-3-QUERY` encodes our reading of the docs' decode table; HubSpot has not been observed signing a query-string URL. The three blocks below are copied verbatim from the research record, the verifier's recheck and the machine-readable vector file.

**Research vectors (verbatim):**

```text
All vectors: signature = base64(HMAC_SHA256(key=clientSecret, msg=UTF8(method + signedUri + body + timestampHeader))). Verified identical by (a) official @hubspot/api-client@14.0.1 Signature.getSignature (npm-packed, unmodified), (b) official hubspot-api-python hubspot/utils/signature.py get_signature, (c) independent node:crypto. Official Node SDK Signature.isValid (Date.now frozen at ts+1000) returned true for each; false for tampered body, ts+1, wrong secret, GET, http://, trailing '/'; threw 'Timestamp is invalid, reject request' at ts+300001 ms; returned true at exactly ts+300000 and for a timestamp 10 min in the FUTURE (SDK has no future-skew check).
[HS-V3-PY-SDK] secret="yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"; method=POST; signedUri="https://www.example.com/webhook_uri"; body="{'example_field':'example_value'}" (33 UTF-8 bytes); X-HubSpot-Request-Timestamp=1693657560000; X-HubSpot-Signature-v3=K36dawei4A+QBNolUOqo7s91KQDWQ5MXZ/QufNYuk/Y= (matches value published in official Python SDK tests)
[HS-V3-RB-SDK] secret="yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"; method=POST; signedUri="https://www.example.com/webhook_uri"; body="{'example_field':'example_value'}" (33 UTF-8 bytes); X-HubSpot-Request-Timestamp=1700000300000; X-HubSpot-Signature-v3=RnbPH7+UMKVkbV32P8bz450N4M56aPmcru1+D3kSDtw= (matches value published in official Ruby SDK tests)
[HS-V3-AUTOPILOT-1] secret="autopilot-test-client-secret-0001"; method=POST; signedUri="https://example.com/api/hubspot/webhooks"; body=[{"eventId":4100000001,"subscriptionId":5100001,"portalId":12345678,"appId":7100001,"occurredAt":1790000000000,"subscriptionType":"contact.creation","attemptNumber":0,"objectId":901,"changeFlag":"NEW","changeSource":"FORM"},{"eventId":4100000002,"subscriptionId":5100001,"portalId":12345678,"appId":7100001,"occurredAt":1790000000500,"subscriptionType":"contact.creation","attemptNumber":0,"objectId":902,"changeFlag":"NEW","changeSource":"CRM_UI"}] (449 UTF-8 bytes, exact string, no whitespace); X-HubSpot-Request-Timestamp=1790000001000; X-HubSpot-Signature-v3=vc6X4JO1KMElXem9r7vSovD2GajkBW8j6R1JB/N89Rk=
[HS-V3-AUTOPILOT-2-UTF8] secret="autopilot-test-client-secret-0001"; method=POST; signedUri="https://example.com/api/hubspot/webhooks"; body=[{"appId":7100001,"eventId":4100000003,"subscriptionId":5100002,"portalId":12345678,"occurredAt":1790000002000,"subscriptionType":"object.creation","attemptNumber":1,"objectId":903,"objectTypeId":"0-1","changeSource":"FORM","note":"Zoë — café ☕"}] (253 UTF-8 bytes; contains U+00EB, U+2014, U+00E9, U+2615); X-HubSpot-Request-Timestamp=1790000003000; X-HubSpot-Signature-v3=iwUOcQxOJMXtoVai85f7uLyYuAp58oXpeyP5gPQKS2k=
[HS-V3-AUTOPILOT-3-QUERY] secret="autopilot-test-client-secret-0001"; method=POST; rawRequestUri="https://example.com/api/hubspot/webhooks?src=hs%3Aapp%2Fv3&x=%28a%29"; signedUri (after HubSpot decode table)="https://example.com/api/hubspot/webhooks?src=hs:app/v3&x=(a)"; body="[]"; X-HubSpot-Request-Timestamp=1790000004000; X-HubSpot-Signature-v3=G8ddQlikFQ0ScZOZn+MHQ0E3WCV7vOJTzKlvrkvbvuk= ; signature over the undecoded raw URI would be KKwrtu49d26FrUsDQdYcfAcwFssKn+cmyppOAUwOO/Q= (must NOT validate)
Legacy reference only (we accept v3 only): v1 [official Node/PHP SDK test] secret='yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy', body='[{"eventId":1,"subscriptionId":12345,"portalId":62515,"occurredAt":1564113600000,"subscriptionType":"contact.creation","attemptNumber":0,"objectId":123,"changeSource":"CRM","changeFlag":"NEW","appId":54321}]' -> X-HubSpot-Signature=232db2615f3d666fe21a8ec971ac7b5402d33b9a925784df3ca654d05f4817de (hex sha256(secret+body)); v2 [official Node/PHP SDK test] same secret, POST, uri='https://www.example.com/webhook_uri', body='{"example_field":"example_value"}' -> 9569219f8ba981ffa6f6f16aa0f48637d35d728c7e4d93d0d52efaa512af7900 (hex sha256(secret+method+uri+body)).
Machine-readable copy: /tmp/claude-0/-home-user-Autopilot/93edeaab-e8bf-5524-b325-7fb2eb252823/scratchpad/vectors/hubspot-v3-vectors.json (generator: /tmp/claude-0/-home-user-Autopilot/93edeaab-e8bf-5524-b325-7fb2eb252823/scratchpad/vectors/hubspot-v3-vectors.js).
```

**Verifier recheck (verbatim):**

```text
Re-executed independently (verify-wh/reverify.js, pyverify.py, rbverify.rb, phpverify.php). @hubspot/api-client@14.0.1 freshly npm-packed (signature.js IDENTICAL to agent copy; npm latest=14.0.1). All 5 v3 vectors REPRODUCE byte-for-byte with SDK getSignature, independent node:crypto HMAC-SHA256 over UTF-8 Buffers, official Python get_signature (5/5 True), official Ruby get_signature (4/4 run True), official PHP getHashedSignature (3/3 run True): HS-V3-PY-SDK K36dawei4A+QBNolUOqo7s91KQDWQ5MXZ/QufNYuk/Y= (matches official Python test); HS-V3-RB-SDK RnbPH7+UMKVkbV32P8bz450N4M56aPmcru1+D3kSDtw= (matches official Ruby spec); HS-V3-AUTOPILOT-1 vc6X4JO1KMElXem9r7vSovD2GajkBW8j6R1JB/N89Rk= (449 bytes); HS-V3-AUTOPILOT-2-UTF8 iwUOcQxOJMXtoVai85f7uLyYuAp58oXpeyP5gPQKS2k= (253 bytes); HS-V3-AUTOPILOT-3-QUERY G8ddQlikFQ0ScZOZn+MHQ0E3WCV7vOJTzKlvrkvbvuk= (decoded URI) and undecoded-URI negative KKwrtu49d26FrUsDQdYcfAcwFssKn+cmyppOAUwOO/Q=. SDK isValid (Date.now frozen): ts+1000 true; exactly ts+300000 true; ts+300001 throws 'Timestamp is invalid, reject request'; ts-600000 (future) true; tampered body/ts+1/wrong secret/GET/http:///trailing slash false; default signatureVersion (v1) false; numeric-string ts true; undefined ts throws; NON-NUMERIC ts signed consistently -> TRUE (age check bypass, stronger than finding stated). Legacy: v1 232db2615f3d666fe21a8ec971ac7b5402d33b9a925784df3ca654d05f4817de and v2 9569219f8ba981ffa6f6f16aa0f48637d35d728c7e4d93d0d52efaa512af7900 reproduce and appear in official Node+PHP tests (v1 also printed in the official docs page). Review saved to /tmp/claude-0/-home-user-Autopilot/93edeaab-e8bf-5524-b325-7fb2eb252823/scratchpad/research/hubspot-webhooks.verify.json.
```

**Fixture form (verbatim `inputs` and `expectedSignatureV3` from the machine-readable copy `vectors/hubspot-v3-vectors.json`; use these exact strings in `test/fixtures/hubspot-signature-v3.json`):**

```json
[
  {
    "id": "HS-V3-PY-SDK",
    "inputs": {
      "clientSecret": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
      "method": "POST",
      "signedUri": "https://www.example.com/webhook_uri",
      "body": "{'example_field':'example_value'}",
      "bodyUtf8Bytes": 33,
      "timestampHeader": "1693657560000",
      "sourceString": "POSThttps://www.example.com/webhook_uri{'example_field':'example_value'}1693657560000"
    },
    "expectedSignatureV3": "K36dawei4A+QBNolUOqo7s91KQDWQ5MXZ/QufNYuk/Y="
  },
  {
    "id": "HS-V3-RB-SDK",
    "inputs": {
      "clientSecret": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
      "method": "POST",
      "signedUri": "https://www.example.com/webhook_uri",
      "body": "{'example_field':'example_value'}",
      "bodyUtf8Bytes": 33,
      "timestampHeader": "1700000300000",
      "sourceString": "POSThttps://www.example.com/webhook_uri{'example_field':'example_value'}1700000300000"
    },
    "expectedSignatureV3": "RnbPH7+UMKVkbV32P8bz450N4M56aPmcru1+D3kSDtw="
  },
  {
    "id": "HS-V3-AUTOPILOT-1",
    "inputs": {
      "clientSecret": "autopilot-test-client-secret-0001",
      "method": "POST",
      "signedUri": "https://example.com/api/hubspot/webhooks",
      "body": "[{\"eventId\":4100000001,\"subscriptionId\":5100001,\"portalId\":12345678,\"appId\":7100001,\"occurredAt\":1790000000000,\"subscriptionType\":\"contact.creation\",\"attemptNumber\":0,\"objectId\":901,\"changeFlag\":\"NEW\",\"changeSource\":\"FORM\"},{\"eventId\":4100000002,\"subscriptionId\":5100001,\"portalId\":12345678,\"appId\":7100001,\"occurredAt\":1790000000500,\"subscriptionType\":\"contact.creation\",\"attemptNumber\":0,\"objectId\":902,\"changeFlag\":\"NEW\",\"changeSource\":\"CRM_UI\"}]",
      "bodyUtf8Bytes": 449,
      "timestampHeader": "1790000001000",
      "sourceString": "POSThttps://example.com/api/hubspot/webhooks[{\"eventId\":4100000001,\"subscriptionId\":5100001,\"portalId\":12345678,\"appId\":7100001,\"occurredAt\":1790000000000,\"subscriptionType\":\"contact.creation\",\"attemptNumber\":0,\"objectId\":901,\"changeFlag\":\"NEW\",\"changeSource\":\"FORM\"},{\"eventId\":4100000002,\"subscriptionId\":5100001,\"portalId\":12345678,\"appId\":7100001,\"occurredAt\":1790000000500,\"subscriptionType\":\"contact.creation\",\"attemptNumber\":0,\"objectId\":902,\"changeFlag\":\"NEW\",\"changeSource\":\"CRM_UI\"}]1790000001000"
    },
    "expectedSignatureV3": "vc6X4JO1KMElXem9r7vSovD2GajkBW8j6R1JB/N89Rk="
  },
  {
    "id": "HS-V3-AUTOPILOT-2-UTF8",
    "inputs": {
      "clientSecret": "autopilot-test-client-secret-0001",
      "method": "POST",
      "signedUri": "https://example.com/api/hubspot/webhooks",
      "body": "[{\"appId\":7100001,\"eventId\":4100000003,\"subscriptionId\":5100002,\"portalId\":12345678,\"occurredAt\":1790000002000,\"subscriptionType\":\"object.creation\",\"attemptNumber\":1,\"objectId\":903,\"objectTypeId\":\"0-1\",\"changeSource\":\"FORM\",\"note\":\"Zoë — café ☕\"}]",
      "bodyUtf8Bytes": 253,
      "timestampHeader": "1790000003000",
      "sourceString": "POSThttps://example.com/api/hubspot/webhooks[{\"appId\":7100001,\"eventId\":4100000003,\"subscriptionId\":5100002,\"portalId\":12345678,\"occurredAt\":1790000002000,\"subscriptionType\":\"object.creation\",\"attemptNumber\":1,\"objectId\":903,\"objectTypeId\":\"0-1\",\"changeSource\":\"FORM\",\"note\":\"Zoë — café ☕\"}]1790000003000"
    },
    "expectedSignatureV3": "iwUOcQxOJMXtoVai85f7uLyYuAp58oXpeyP5gPQKS2k="
  },
  {
    "id": "HS-V3-AUTOPILOT-3-QUERY",
    "inputs": {
      "clientSecret": "autopilot-test-client-secret-0001",
      "method": "POST",
      "rawRequestUri": "https://example.com/api/hubspot/webhooks?src=hs%3Aapp%2Fv3&x=%28a%29",
      "signedUri": "https://example.com/api/hubspot/webhooks?src=hs:app/v3&x=(a)",
      "body": "[]",
      "bodyUtf8Bytes": 2,
      "timestampHeader": "1790000004000",
      "sourceString": "POSThttps://example.com/api/hubspot/webhooks?src=hs:app/v3&x=(a)[]1790000004000"
    },
    "expectedSignatureV3": "G8ddQlikFQ0ScZOZn+MHQ0E3WCV7vOJTzKlvrkvbvuk="
  }
]
```
