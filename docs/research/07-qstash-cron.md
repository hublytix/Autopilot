## 07. Upstash QStash and Vercel Cron

The QStash answers come from Upstash's docs source repo (upstash/docs @09b815ea, which renders to upstash.com/docs), the QStash and Developer API OpenAPI specs, and the official `@upstash/qstash` 2.12.0 SDK source, plus local experiments that ran that SDK. The one brief [VERIFY] marker in this area, the §5.6 QStash callback signature, is resolved. Each delivery carries an HS256 JWT in `Upstash-Signature`, keyed with the signing-key string itself, with `iss` `"Upstash"`, `sub` set to the destination URL, `body` set to the base64url SHA-256 of the raw body, and a 5-minute `exp`. `nbf` has been `0` since September 2024, and verifiers must accept the current or the next signing key. vercel.com and the Upstash pricing page were blocked in the sandbox, so Vercel Cron facts come from Vercel's CLI source, the `@vercel/config` types, Vercel's examples repo and Vercel's official agent plugin. Plan limits are **not officially documented here** and must be re-checked at WIRE_UP: Vercel Hobby cron frequency, and QStash daily quota, maximum retries, HTTP timeout and DLQ retention.

**The sources correct the brief in seven places:**
- **§3 Jobs (Vercel Cron runs the 5-minute poller and the hourly Monday check):** this is most likely impossible on the Vercel Hobby plan, which (per training knowledge only, not read from vercel.com) allows only daily crons. Either require Vercel Pro, or drive these two triggers from QStash schedules. Make the periodic routes accept both triggers.
- **§5.9 "where it is Monday 08:00 local time":** an equality check misses portals at +05:30 or +05:45 offsets, and a missed run skips the week. Use a catch-up due-check: local time ≥ Monday 08:00 and no `weekly_reports` row for this ISO week.
- **§5.6 "+2 days and +5 days" shifted out of quiet hours and weekends:** the shift can push the +5-day job to +7d10h. That exceeds the Free plan's 7-day maximum delay. Publish in hops, or require pay-as-you-go.
- **§5.6 dedupe IDs `lead:{id}:fu:{n}`:** the IDs are valid, but QStash deduplicates for only 10 minutes. Long-term idempotency must live in Postgres.
- **§7 "timestamps checked" (QStash):** QStash sends no timestamp header and `nbf` is `0`. The JWT `exp` (5 minutes, plus clock tolerance) is the only time bound.
- **§10 WIRE_UP step 4 "Set up QStash keys and the callback URL":** there is no console callback URL. The destination is passed with each publish, built from a new `APP_URL`. `QSTASH_URL` is region-specific and must match the token and keys.
- **§10 WIRE_UP step 3 "set environment variables and crons":** there is no dashboard step for crons. Crons deploy from `vercel.json`, run only on production deployments, are invoked with GET, and need a `CRON_SECRET` env var.

**The sources extend the brief with:**
- signing-key rotation (current/next) and its runbook;
- the exact `Receiver.verify` contract, and why we write our own helper instead of using the Next.js `verifySignatureAppRouter`;
- a security trap: `QSTASH_DEV` silently swaps in public signing keys, even with `NODE_ENV=production`, unless `devMode: false` is passed;
- the regional env layout;
- `Upstash-Not-Before` (unix seconds) for absolute scheduling;
- cancel semantics: 404 after delivery means done, and a bulk cancel with no ids or filter cancels **every** message;
- retry, backoff and `489` non-retryable semantics, plus at-least-once delivery;
- failure callbacks and the DLQ;
- the headers QStash sends to the destination;
- the exact publish wire format;
- the local dev server, which is no substitute for the time-travel fake;
- QStash schedules as a Vercel Cron alternative;
- function-duration limits that force the poller to fan out;
- Vercel Cron's lack of retries and its possible overlap (unverified).

### QS-SIG-JWT — Callback signature: an HS256 JWT in `Upstash-Signature`
- **Brief:** §5.6 "Verify the QStash signature on callbacks **[VERIFY]**"; §7 "Webhook signatures verified (HubSpot, QStash, Razorpay) and timestamps checked."
- **Resolves:** [VERIFY] §5.6 QStash signature on callbacks
- **Verdict:** Extended — high confidence. The verifier corrected the original research on `nbf`. Real deliveries carry `nbf: 0` (QStash changelog, September 2024). The docs' example token, which shows `nbf` = `iat`, is stale.
- **Finding:**
  - **Header:** every delivery carries a JWT in the `Upstash-Signature` header. Look it up case-insensitively, e.g. `request.headers.get('upstash-signature')`.
  - **Signing:** the JOSE header is `{"alg":"HS256","typ":"JWT"}` (HMAC-SHA256). The key is the signing-key string itself as UTF-8 bytes (the literal `sig_...` text), **not** base64-decoded. Both the SDK and the official AWS Lambda quickstart do this.
  - **Claims:**
    - `iss` = `"Upstash"` (always).
    - `sub` = the exact destination URL the message was published to.
    - `iat` = unix seconds.
    - `exp` = unix seconds. The default lifetime is 5 minutes.
    - `nbf` = `0` since September 2024 (QStash changelog), so it provides no lower bound. The docs' example token showing `nbf` = `iat` is outdated.
    - `jti` = a unique token id. The docs example is `jwt_67kxXD6UBAk7DqU6hzuHMDdXFXfP`.
    - `body` = base64url(SHA-256(raw request body bytes)), per RFC 4648 §5. It MAY carry trailing `=` padding (the docs example does). The SDK and the official manual verifier strip trailing `=` before comparing.
  - **Raw body:** the hash must be computed over the RAW body string. Re-serialised JSON fails; the docs warn about this and it was reproduced locally.
  - **Time window:** there is no separate timestamp header. The effective replay window is `exp` (5 min) plus `clockTolerance`.
  - **Keys:** verifiers accept the current OR the next signing key (see QS-SIG-KEYS-ROTATION).
- **Design consequence:**
  - The callback route reads `await request.text()` BEFORE any JSON parsing and passes that exact string to verify. Only then does it run `JSON.parse` and Zod.
  - Verify `url` against the same configured string used as the publish destination (e.g. `${APP_URL}/api/jobs/follow-up`), not `request.url`, which can differ behind proxies or hosts. Use a `clockTolerance` of a few seconds.
  - In Vitest, build JWTs with `jose` `SignJWT` using fixed keys and pin the clock with `vi.useFakeTimers()` + `vi.setSystemTime()`. jose reads the clock via `new Date()`, so stubbing only `Date.now` leaves verification on the real clock; the verifier's first run failed every case for this reason. See 07.y.
- **Open risk:** The docs do not say whether each retry attempt gets a fresh JWT (new `jti`/`exp`). Assume yes, since a 5-minute lifetime would otherwise break delayed retries. At WIRE_UP, decode one real delivery's token and confirm `nbf: 0`, a 5-minute `exp` and the padding of the `body` claim.
- **Sources:**
  - https://upstash.com/docs/qstash/features/security — official docs source repo (renders to the public docs URL) — "With each request we are sending a JWT inside the `Upstash-Signature` header." ... {"alg": "HS256", "typ": "JWT"} ... "Our JWTs have a lifetime of 5 minutes by default." ... "The body field is a base64 encoded sha256 hash of the request body. We use url encoding as specified in [RFC 4648]" ... "The issuer field is always `Upstash`."
  - https://upstash.com/docs/qstash/howto/signature — official docs source repo (renders to the public docs URL) — "`iss`: The issuer must be`Upstash`." "`sub`: The subject must the url of your API." "`body`: Hash the raw request body using `SHA-256` and compare it with the `body` claim." "Ensure you use the raw body string as is."
  - https://upstash.com/docs/qstash/overall/changelog — official docs source repo (renders to the public docs URL) — September 2024: "Set the `nbf` (not before) claim on Signing Keys to 0. This claim specifies the time before which the JWT must not be processed. Previously, this was incorrectly used, causing validation issues when there were minor clock discrepancies between systems."
  - https://upstash.com/docs/qstash/quickstarts/aws-lambda/nodejs — official docs source repo (renders to the public docs URL) — "createHmac("sha256", signingKey).update(`${header}.${payload}`).digest("base64url") ... if (p.body.replace(/=+$/, "") != createHash("sha256").update(body).digest("base64url"))"
  - https://github.com/upstash/qstash-js/blob/main/src/receiver.ts — official SDK source — "jose.jwtVerify(request.signature, new TextEncoder().encode(key), { issuer: "Upstash", clockTolerance: request.clockTolerance }) ... if (p.body.replace(padding, "") !== bodyHash.replace(padding, "")) { throw new SignatureError(`body hash does not match, ...`) }"
  - https://github.com/upstash/qstash-js/blob/main/src/receiver.ts — local experiment — "Ran the @upstash/qstash@2.12.0 Receiver (scratchpad/npm/qstash-exp/vector.mjs). Signed with current key -> OK. Next key -> OK. Unknown key -> SignatureError 'signature verification failed'. Body '{"leadId": "123", "n": 1}' (re-serialised with spaces) -> 'body hash does not match'. url+'?x=1' -> 'invalid subject'. t=exp+1 -> rejected. t=exp+1 with clockTolerance 5 -> OK. t=nbf-30 -> rejected."
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/receiver.ts — local experiment — "verify-qstash/nbf0.mjs (Receiver 2.12.0, devMode:false, Date constructor stubbed): payload {iss:'Upstash',sub:'https://autopilot.hublytix.ai/api/jobs/follow-up',exp:1790000300,nbf:0,iat:1790000000,jti:'jwt_testvector0002',body:'qNVP6CQwsonTFSALK0uh6BD1wlSMCinvpnjaxCrroEE='} ... t=1789999000 -> true; t=1790000010 -> true; t=1790000301 -> SignatureError 'signature verification failed'. With only Date.now stubbed, all three failed (jose uses new Date())."
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/receiver.ts — local experiment — "verify-qstash/recompute.mjs: HMAC-SHA256(key=utf8('sig_testCurrentKey000000000000'), base64url(header)+'.'+base64url(payload)) -> signature R-nyopTzF0Ee6ViDcsy-1RFjox__Jyrw96reksOrRHs (identical to the finding's JWT); next key -> v1AJuv88aNRvtemd74DjpqCIcxoIG5j9GmkWLmguke0 (identical)"

### QS-SIG-KEYS-ROTATION — Current and next signing keys, and how a key roll works
- **Brief:** not addressed (§10 WIRE_UP step 4 says only "Set up QStash keys").
- **Resolves:** supports [VERIFY] §5.6 QStash signature on callbacks
- **Verdict:** Extended — high confidence.
- **Finding:**
  - Each QStash account has two signing keys **per region**. `current` signs today; `next` will sign after a roll.
  - Roll keys with the Console "Roll keys" button or `POST /v2/keys/rotate`, which returns `{"current":"...","next":"..."}`. A roll does `currentKey = nextKey; nextKey = generateNewKey()`. `GET /v2/keys` returns the same `{current, next}` shape.
  - Verifiers must accept either key. Rolling twice without updating the app makes both configured keys stale, and every request is then rejected.
  - The SDK `Receiver` tries `currentSigningKey` first and falls back to `nextSigningKey`.
- **Design consequence:**
  - `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` are both required in live mode; fail fast at boot if either is missing.
  - WIRE_UP: copy both from Console > QStash > Quickstart.
  - Rotation runbook: roll once, update both env vars in Vercel, redeploy. Never roll twice in a row.
- **Open risk:** None significant.
- **Sources:**
  - https://upstash.com/docs/qstash/howto/roll-signing-keys — official docs source repo (renders to the public docs URL) — "currentKey = nextKey\nnextKey = generateNewKey()" ... "Rolling your keys twice without updating your applications will cause your apps to reject all requests, because both the current and next keys will have been replaced."
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "/v2/keys/rotate: post: summary: Rotate Signing Keys ... "During a rotation, the next key becomes the new current key, and a fresh next key is generated." SigningKeys: properties: current: {type: string}, next: {type: string}"
  - https://github.com/upstash/qstash-js/blob/main/src/receiver.ts — official SDK source — "try { payload = await this.verifyWithKey(signingKeys.currentSigningKey, request); } catch { payload = await this.verifyWithKey(signingKeys.nextSigningKey, request); }"
  - https://upstash.com/docs/qstash/howto/multi-region — official docs source repo (renders to the public docs URL) — "Each region has its own API tokens and signing keys"

### QS-RECEIVER-API — `Receiver.verify` contract and the Next.js helper's pitfalls
- **Brief:** not addressed (§8 Tests: "signature verification with known vectors").
- **Resolves:** supports [VERIFY] §5.6 QStash signature on callbacks
- **Verdict:** Extended — high confidence.
- **Finding:**
  - **Version:** the latest `@upstash/qstash` is **2.12.0** (npm, published 2026-09-29).
  - **Constructor:** `new Receiver({ currentSigningKey?, nextSigningKey?, devMode? })`.
  - **Verify:** `await receiver.verify({ signature: string, body: string, url?: string, clockTolerance?: number /* seconds, default 0 */, upstashRegion?: string })`.
    - It resolves to `true` on success and THROWS `SignatureError` on any failure. It never resolves `false`.
    - If `url` is omitted, the `sub` claim is not checked. If `url` is given and differs, it throws `SignatureError` `invalid subject: ${p.sub}, want: ${request.url}`.
    - Constructor keys are used only if BOTH are provided. Otherwise it reads env `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY`, or region-prefixed vars in multi-region mode.
    - If no keys are found, verify throws a plain `Error('[Upstash QStash] No signing keys available for verification...')`.
  - **Next.js helper:** `verifySignatureAppRouter(handler, config?)` from `'@upstash/qstash/nextjs'`:
    - returns 403 if the header is missing;
    - does NOT pass `url`, so there is no `sub` check;
    - does not catch `SignatureError`, so an invalid signature surfaces as an unhandled exception (500) rather than 401/403.
- **Design consequence:**
  - Write a thin `verifyQStash(req)` helper instead of using `verifySignatureAppRouter`. It reads the raw text and calls `receiver.verify({ signature, body, url: EXPECTED_URL, clockTolerance: 5, upstashRegion: req.headers.get('upstash-region') ?? undefined })` inside try/catch.
  - Return 401 on `SignatureError`. QStash retries any non-2xx, which is harmless for forged requests.
  - Put it behind the `Scheduler` interface so the fake needs no keys.
- **Open risk:** SDK internals (multi-region key resolution) may change in later minor versions. Pin the version (2.12.0).
- **Sources:**
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/receiver.ts — official SDK source — ""URL of the endpoint where the request was sent to. Omit empty to disable checking the url." url?: string; "Number of seconds to tolerate when checking `nbf` and `exp` claims ... @default 0" clockTolerance?: number; upstashRegion?: string; "If that fails, the signature is invalid and a `SignatureError` is thrown.""
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/receiver.ts — official SDK source — "if (request.url !== undefined && p.sub !== request.url) { throw new SignatureError(`invalid subject: ${p.sub}, want: ${request.url}`); }"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/multi-region/incoming.ts — official SDK source — "// 1. Check for config overrides\n if (config?.currentSigningKey && config.nextSigningKey) { ... } ... // 3. Use default credentials const defaultCreds = readReceiverEnvironmentVariables(environment);"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/platforms/nextjs.ts — official SDK source — "if (!signature) { return new Response(new TextEncoder().encode("`Upstash-Signature` header is missing"), { status: 403 }); } ... const isValid = await receiver.verify({ signature, body, clockTolerance: config?.clockTolerance, upstashRegion: upstashRegion ?? undefined });"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/platforms/nextjs.ts — official SDK source — "const devMode = shouldUseDevelopmentMode(config?.devMode, process.env); if (!devMode && !currentSigningKey && !nextSigningKey && !process.env.QSTASH_REGION) { throw new Error("currentSigningKey and nextSigningKey are required, either in the config or as env variables (QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY)"); }"
  - https://www.npmjs.com/package/@upstash/qstash — official SDK source (npm registry metadata) — "npm view @upstash/qstash dist-tags -> latest: '2.12.0'; time['2.12.0'] = '2026-09-29T07:31:21.302Z'; dependencies { jose: '^5.2.3', uncrypto: '^0.1.3', neverthrow: '^7.0.1' }"

### QS-DEVMODE-KEY-OVERRIDE — `QSTASH_DEV` silently replaces the production signing keys
- **Brief:** not addressed (§7 Security checklist; §8 `APP_MODE=fake|live`).
- **Resolves:** supports [VERIFY] §5.6 QStash signature on callbacks
- **Verdict:** Extended — high confidence. The SDK source shows the behaviour and a local experiment reproduced it.
- **Finding:**
  - When env `QSTASH_DEV` is `'true'` or `'1'` and `Receiver`/`Client` `devMode` is not explicitly `false`, the SDK IGNORES the signing keys and token passed in config. It uses the public, documented dev-server credentials instead:
    - currentSigningKey `'sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r'`;
    - nextSigningKey `'sig_5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs'`;
    - base URL `http://127.0.0.1:8080`.
  - The docs say dev mode is "a no-op when `NODE_ENV=production`". In the source, only the dev-server spawn is skipped in production; the credential override still applies.
  - Local experiment with `NODE_ENV=production QSTASH_DEV=true`: a JWT forged with the public dev key was ACCEPTED by `new Receiver({currentSigningKey, nextSigningKey})`. It was REJECTED when `devMode: false` was passed.
  - An explicit `devMode` always wins. A `QSTASH_DEV` value of `''`, `'false'` or `'0'` means off, and `'true'` or `'1'` means on. Any other value throws `[QStash Dev] Invalid value for QSTASH_DEV in environment: <value>`; the verifier confirmed this with `QSTASH_DEV=yes`.
- **Design consequence:**
  - In `APP_MODE=live`, always construct `new Receiver({..., devMode: false})` and `new Client({..., devMode: false})`.
  - Add a boot assertion that `QSTASH_DEV` is unset when `APP_MODE=live` or `VERCEL_ENV=production`.
  - Add a unit test proving that a JWT signed with the public dev key is rejected.
  - Do not list `QSTASH_DEV` in the production section of `.env.example`.
- **Open risk:** Future SDK versions might change dev-mode semantics. The explicit `devMode: false` keeps the behaviour pinned.
- **Sources:**
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/multi-region/incoming.ts — official SDK source — "// 0. Dev mode takes highest priority\n if (shouldUseDevelopmentMode(devMode, environment)) { ... "Dev mode is active. Ignoring signing keys from config. " ... return { currentSigningKey: developmentCreds.currentSigningKey, nextSigningKey: developmentCreds.nextSigningKey };"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/dev-server/constants.ts — official SDK source — "currentSigningKey: "sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r", nextSigningKey: "sig_5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs""
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/dev-server/index.ts — official SDK source — "export const shouldUseDevelopmentMode = (devMode, env) => { if (devMode !== undefined) return devMode; const value = env?.QSTASH_DEV ?? getProcessEnvironment("QSTASH_DEV"); if (value === undefined || value === "" || value === "false" || value === "0") return false; if (value === "true" || value === "1") return true; throw new Error(`[QStash Dev] Invalid value for QSTASH_DEV in environment: ${value}`); }; ... // Also short-circuit in production so an accidental devMode: true in prod doesn't try to download a binary. ... if (procEnv?.NODE_ENV === "production") return;"
  - https://upstash.com/docs/qstash/howto/local-development — official docs source repo (renders to the public docs URL) — "Override the `baseUrl`, `token`, and signing keys you provide and use the dev server's instead." "Dev mode is automatically a no-op when `NODE_ENV=production` and in browser/edge runtimes."
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/receiver.ts — local experiment — "devmode.mjs with @upstash/qstash@2.12.0: 'NODE_ENV=production QSTASH_DEV=true devMode=undefined: forged JWT ACCEPTED'; 'NODE_ENV=production QSTASH_DEV=true devMode=false: rejected (SignatureError: signature verification failed)'; without QSTASH_DEV both rejected."
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/dev-server/index.ts — local experiment — "Re-ran devmode.mjs: 'NODE_ENV=production QSTASH_DEV=true devMode=undefined: forged JWT ACCEPTED'; 'devMode=false: rejected (SignatureError: signature verification failed)'; NODE_ENV=production QSTASH_DEV=yes devMode=undefined -> 'rejected (Error: [QStash Dev] Invalid value for QSTASH_DEV in environment: yes)'"

### QS-ENV-REGION — Env var names; QStash is regional and `QSTASH_URL` must match the region
- **Brief:** not addressed (§10 WIRE_UP step 4; the `.env.example` deliverable).
- **Verdict:** Extended — high confidence.
- **Finding:**
  - **Env names read by the SDK:** `QSTASH_TOKEN`, `QSTASH_URL`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`. Optional: `QSTASH_REGION` (migration mode), `QSTASH_DEV` / `QSTASH_DEV_PORT` (local dev) and `UPSTASH_DISABLE_TELEMETRY`.
  - **Regions:** QStash is now regional. Each region has its own token, signing keys, usage, messages, schedules and DLQ.
  - **Base URLs:**
    - EU: `https://qstash-eu-central-1.upstash.io` or `https://qstash.upstash.io`.
    - US: `https://qstash-us-east-1.upstash.io`.
  - `QSTASH_URL` is optional and defaults to the EU URL `https://qstash.upstash.io`. A US-region account with `QSTASH_URL` unset would therefore send its US token to the EU endpoint.
  - Deliveries carry an `upstash-region` header (e.g. `US-EAST-1`). Given an invalid value, the SDK logs a warning and falls back to the default signing keys.
  - **Migration mode** (SDK ≥ 2.9.0): set `QSTASH_REGION=US_EAST_1` or `EU_CENTRAL_1`, plus `<REGION>_QSTASH_URL`, `<REGION>_QSTASH_TOKEN`, `<REGION>_QSTASH_CURRENT_SIGNING_KEY` and `<REGION>_QSTASH_NEXT_SIGNING_KEY`.
- **Design consequence:**
  - `.env.example` lists `QSTASH_URL` (required in live mode; copy it exactly from the Console Quickstart for the chosen region), `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY`.
  - Pass the token and base URL explicitly: `new Client({ token, baseUrl, devMode: false })`.
  - WIRE_UP: pick the region closest to the Vercel function region. All four values must come from the same region.
- **Open risk:** None.
- **Sources:**
  - https://upstash.com/docs/qstash/howto/multi-region — official docs source repo (renders to the public docs URL) — "- **EU Region**: `https://qstash-eu-central-1.upstash.io`, or `https://qstash.upstash.io`" "- **US Region**: `https://qstash-us-east-1.upstash.io`" "`QSTASH_URL` is optional. When it is not set, SDKs default to the EU region (`https://qstash.upstash.io`)." "Each region has its own API tokens and signing keys" "upstash-region: US-EAST-1"
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "servers: - url: https://qstash-{region}.upstash.io ... region: default: eu-central-1, enum: [us-east-1, eu-central-1]"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/multi-region/utils.ts — official SDK source — "export const DEFAULT_QSTASH_URL = "https://qstash.upstash.io"; ... readEnvironmentVariables(["QSTASH_URL", "QSTASH_TOKEN"] ...) ... ["QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY"]"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/multi-region/incoming.ts — official SDK source — "`[Upstash QStash] Invalid UPSTASH_REGION header value: "${regionFromHeader}". Expected one of: EU-CENTRAL-1, US-EAST-1. Falling back to default signing keys.`"

### QS-DELAY-HEADERS — `Upstash-Delay` (relative) vs `Upstash-Not-Before` (absolute unix seconds)
- **Brief:** §5.6 "enqueue QStash jobs at +2 days and +5 days. Shift each job to the next allowed hour outside quiet hours and weekends."
- **Verdict:** Confirmed — high confidence.
- **Finding:**
  - `Upstash-Delay` is a relative duration `<number><unit>`. Units are `s`, `m`, `h` and `d`; combinations are allowed, e.g. `1d10h30m`.
  - `Upstash-Not-Before` is an absolute unix timestamp in **SECONDS** (UTC).
  - If both are sent, `Upstash-Not-Before` wins.
  - **SDK `publish`/`publishJSON`:**
    - `delay?: number | Duration`. A number is seconds and is sent as `${n}s`. The `Duration` type is `` `${bigint}${'s'|'m'|'h'|'d'}` ``.
    - `notBefore?: number` is unix seconds, sent as `Upstash-Not-Before`.
  - The Message object returned by `GET /v2/messages/{id}` reports `notBefore` and `createdAt` in **MILLISECONDS**.
  - Local wire capture (SDK 2.12.0): `notBefore: 1790432000, delay: '2d'` produced the headers `upstash-not-before: 1790432000` and `upstash-delay: 2d`.
- **Design consequence:**
  - Compute the absolute UTC instant in app code, timezone-aware, after applying the quiet-hours and weekend shift.
  - Publish with `notBefore` (seconds) only; never mix it with `delay`.
  - Store the target instant in `scheduled_jobs.run_at` so the fake `Scheduler` can time-travel to it.
- **Open risk:** None.
- **Sources:**
  - https://upstash.com/docs/qstash/features/delay — official docs source repo (renders to the public docs URL) — "The format for the duration is `<number><unit>`" ... "You can send this duration inside the `Upstash-Delay` header." ... "The format is a unix timestamp in seconds, based on the UTC timezone." "`Upstash-Not-Before` will override the `Upstash-Delay` header when both are used together."
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "Upstash-Delay examples: "50s", "1d10h30m", "10h", "1d" ... "- `d` for days."; Upstash-Not-Before schema: type: integer "When both `Upstash-Not-Before` and `Upstash-Delay` headers are provided, `Upstash-Not-Before` will take precedence."; Message.notBefore: "The unix timestamp in milliseconds before which the message should not be delivered.""
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/utils.ts — official SDK source — "headers.set("Upstash-Delay", `${request.delay.toFixed(0)}s`); ... headers.set("Upstash-Not-Before", request.notBefore.toFixed(0));"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/duration.ts — official SDK source — "type Unit = "s" | "m" | "h" | "d"; // Using "bigint" instead of "number" as number allows "20 s" while bigint does not. export type Duration = `${bigint}${Unit}`;"

### QS-DELAY-MAX-PER-PLAN — The +5-day job can exceed the Free plan's 7-day maximum delay
- **Brief:** §5.6 "+2 days and +5 days", shifted to the next allowed hour outside quiet hours and weekends.
- **Verdict:** Extended — high confidence.
- **Finding:**
  - **Maximum delay by plan:** Free 7 days; pay-as-you-go 1 year; Fixed custom/unlimited ("you may delay as much as needed").
  - +5 days by itself is allowed on Free. **But** the brief's quiet-hours and weekend shift can push the +5-day job past 7 days. Example: first notification Sunday 23:00 local → +5d = Friday 23:00 (quiet) → next allowed slot Monday 09:00 = **+7d10h**. That exceeds the Free limit, so the publish would be rejected.
  - The +2-day job maxes out around +4.5 days and is always safe.
- **Design consequence:**
  - Add `QSTASH_MAX_DELAY_SECONDS` (default 604800 minus a 3600 margin). If the target is later than now + max, publish a "hop" message at now + max carrying the real target. The handler re-checks and re-publishes until the target is reached; this is cheap and idempotent. Alternatively, document that pay-as-you-go is required.
  - Unit-test the Sunday-late-night case.
- **Open risk:** The exact HTTP status and error body for an over-limit delay are not documented; expect 400. Handle any non-2xx publish as a failed schedule and alert. Re-check the plan's maximum delay on the pricing page at WIRE_UP.
- **Sources:**
  - https://upstash.com/docs/qstash/features/delay — official docs source repo (renders to the public docs URL) — "For free: The maximum allowed delay is  **7 days**." "For pay-as-you-go: The maximum allowed delay is  **1 year**." "For fixed pricing: The maximum allowed delay is  **Custom(you may delay as much as needed)**."
  - https://upstash.com/docs/qstash/overall/usecases — official docs source repo (renders to the public docs URL) — "QStash holds it until then — up to 7 days on the free plan and up to a year on pay-as-you-go."
  - https://github.com/upstash/docs/blob/main/devops/developer-api/openapi.yaml — official OpenAPI spec — "QStashUser.max_delay: description: Maximum delay for scheduled messages in seconds, example: 604800 (same example object has type: free)"

### QS-DEDUPLICATION — `Upstash-Deduplication-Id` lasts only 10 minutes; `lead:{id}:fu:{n}` is a valid ID
- **Brief:** §5.6 "Dedupe IDs: `lead:{id}:fu:{n}`".
- **Verdict:** Extended — medium confidence. The 10-minute window is official, but the SDK JSDoc contradicts it and the allowed character set is undocumented.
- **Finding:**
  - **Header:** `Upstash-Deduplication-Id` (SDK `deduplicationId`).
  - **Duplicates** are accepted but not enqueued. The response is **HTTP 202 Accepted** with the EXISTING `messageId` and `deduplicated: true`. The SDK return type `PublishToUrlResponse` is `{ messageId, url, deduplicated? }`, but see QS-PUBLISH-WIRE: the server documents no `url` for a single-URL publish.
  - **Window: 10 MINUTES** per the official docs and the OpenAPI spec. The SDK JSDoc still says "90 days", which the docs contradict; treat 10 minutes as authoritative.
  - **Content-based dedupe:** `Upstash-Content-Based-Deduplication: true` (SDK `contentBasedDeduplication: true`) hashes the destination, the body, `Content-Type` and all `Upstash-Forward-*` headers. It uses the same 10-minute window.
  - **Allowed characters:** not documented. The ID is an ordinary HTTP header value. `lead:123:fu:1` uses only visible ASCII (`:` is 0x3A), which is legal in a header field value. The SDK sends it verbatim; the local wire capture shows `upstash-deduplication-id: lead:123:fu:1`.
  - **Scope:** per QStash account and region.
- **Design consequence:**
  - Keep `lead:{id}:fu:{n}`; it is valid. It only protects against a double publish within about 10 minutes, e.g. from SDK network retries or a retried notification handler.
  - Long-term idempotency must live in Postgres: `UNIQUE(lead_id, kind)` on `scheduled_jobs`, store the returned `messageId`, and have the job handler check lead and job state before acting.
  - Treat `deduplicated: true` as success and store the returned (existing) `messageId`.
  - If several environments share one QStash account, prefix the ID with an environment namespace (e.g. `prod:lead:123:fu:1`).
- **Open risk:** The dedupe ID's character set and maximum length are undocumented. Avoid non-ASCII and keep it short (under 100 chars).
- **Sources:**
  - https://upstash.com/docs/qstash/features/deduplication — official docs source repo (renders to the public docs URL) — "In case a message is a duplicate, we will accept the request and return the messageID of the existing message. ... We'll send HTTP `202 Accepted` code in case of a duplicate message." ... "The deduplication window is 10 minutes. After that, messages with the same ID or content can be sent again." ... "**Header**: This includes the `Content-Type` header and all headers, that you forwarded with the `Upstash-Forward-` prefix."
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "Upstash-Deduplication-Id: "If a message with the same deduplication ID was published in the last 10 minutes, the new message will be ignored." PublishResponse.deduplicated: "Whether this message is a duplicate and was not sent to the destination.""
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/client.ts — official SDK source — ""We store deduplication ids for 90 days. Afterwards it is possible that the message with the same deduplication id is delivered again." (JSDoc on deduplicationId — conflicts with docs) ... export type PublishToUrlResponse = PublishToApiResponse & { url: string; deduplicated?: boolean; };"
  - https://www.rfc-editor.org/rfc/rfc9110#section-5.5 — RFC/standard — "field-value    = *field-content" ... "field-vchar    = VCHAR / obs-text" (VCHAR is %x21-7E per RFC 5234; ':' is 0x3A)
  - https://github.com/vercel/vercel/blob/main/internals/cli-builder-integration/src/validate-cron-secret.ts — official SDK source (Vercel CLI source; corroborates header-value rules) — "According to RFC 7230, HTTP header field values may only contain: - Visible ASCII characters (0x21-0x7E) - Space (0x20) and horizontal tab (0x09) - but not at the start or end"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/utils.ts — local experiment — "wire.mjs (fetch stubbed) publishJSON({deduplicationId: 'lead:123:fu:1', ...}) -> captured header "upstash-deduplication-id": "lead:123:fu:1""
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/http.ts — official SDK source — "attempts: config.retry?.retries ?? 5, backoff: config.retry?.backoff ?? ((retryCount) => Math.exp(retryCount) * 50) ... for (let index = 0; index <= this.retry.attempts; index++) { try { response = await fetch(url.toString(), requestOptions); break; } catch (error_) {"

### QS-CANCEL — Cancelling scheduled messages: 404 after delivery, and a bulk cancel that can wipe every message
- **Brief:** §5.6 "cancel the remaining job"; §5.5 "[Not a real lead] … cancels its follow-ups"; §5.1 Revoked: "cancel that portal's scheduled jobs".
- **Verdict:** Extended — high confidence. The verifier corrected the original by adding a reproduced runtime hazard (an undefined filter value cancels everything) and the `topicName` filter.
- **Finding:**
  - **Cancel one message:**
    - REST: `DELETE {QSTASH_URL}/v2/messages/{messageId}` returns **202** `{"cancelled":1}`, or **404** "Message not found".
    - SDK: `await client.messages.cancel(messageId)` returns `{cancelled:number}`. `messages.delete(id)` is deprecated.
  - **Already delivered:** messages are removed from the database shortly after delivery, so cancel returns 404 and the SDK throws `QstashError` with `.status === 404`. Treat that as "already done".
  - **In flight:** "it might be too late to cancel". `CANCEL_REQUESTED` is logged, and the message becomes `CANCELLED` at its next delivery time.
  - **Bulk cancel:** `DELETE /v2/messages` with `messageIds` is synchronous and returns the exact count. With filters, it runs as a background bulk action.
    - Filters: `topicName`, `queueName`, `url`, `host`, `path`, `label`, `flowControlKey`, `fromDate`, `toDate` (Unix ms), `scheduleId`, `callerIp`. Values within one filter are OR'd; separate filters are AND'd. Multiple values can be repeated or comma-separated.
    - A filter cancel waits up to 1 minute (otherwise it returns 429 and the action continues), or returns an `actionId` immediately with `async=true`.
    - SDK: `client.messages.cancel([ids])` or `client.messages.cancel({ filter: { label: 'portal-42' } })`. The latter sends `DELETE .../v2/messages?label=portal-42&count=100`.
  - **DANGER:** the server cancels ALL messages (in the account and region) if no `messageIds` and no filter are sent. The SDK's compile-time `RequireAtLeastOne` guard does not stop a runtime-undefined filter value. Verified: `cancel({filter:{label: undefined}})` sends `DELETE /v2/messages?count=100`. `count` is deprecated and ignored.
  - **SDK guards that do exist:**
    - `cancel('')` throws `'Message id cannot be empty'`.
    - `cancel([])` returns `{cancelled:0}` without sending a request.
    - `cancel({messageIds: []})` throws `'Empty messageIds array provided. If you intend to target all messages, use { all: true } explicitly.'`.
  - **`Scheduler.cancel` requirements:**
    - (a) Prefer cancel-by-id from `scheduled_jobs`.
    - (b) If filter-cancel by label is used, assert the label is a non-empty string matching `^portal-[0-9]+$` BEFORE calling. Never pass a filter object built from optional values.
    - (c) Map 404 to success.
    - (d) The handler must still re-check the stop rules, because a cancel can lose the race with an in-flight delivery.
- **Design consequence:**
  - `Scheduler.cancel(messageId)` treats 404 as success (already delivered or cancelled). Never call the bulk endpoint with an empty id list or no filter.
  - The follow-up handler re-checks the stop rules and no-ops with 200: replied, dismissed, paused, trial/subscription, revoked, contact deleted/opted out, max 2.
  - Publish with `label: ['portal-<portalId>', 'lead-<leadId>']`, so revocation can cancel a portal's jobs with one filtered call. Keep per-message ids in `scheduled_jobs` as the primary path.
- **Open risk:** Label character rules are undocumented; use `[a-z0-9-]` only. The 404 body in the local test was stubbed, not a real server response.
- **Sources:**
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "/v2/messages/{messageId}: delete: summary: Cancel a Message ... '202': description: Message canceled successfully ... cancelled: "Number of messages cancelled. Always `1`." '404': description: Message not found. GET note: "Messages are removed from the database shortly after they’re delivered". /v2/messages delete: "If a message is in flight to your API, it might be too late to cancel." "If no filter or messageIds are sent, QStash will cancel all of your messages.""
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "If no filter or messageIds are sent, QStash will cancel all of your messages. ... - name: count ... deprecated: true ... description: Deprecated. This parameter is ignored, and all messages matching the filters are cancelled."
  - https://upstash.com/docs/qstash/howto/debug-logs — official docs source repo (renders to the public docs URL) — "When the request is received, `CANCEL_REQUESTED` will be logged first. If retries are not exhausted yet, in the next deliver time, the message will be marked as `CANCELLED` and will be completely removed from the system."
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/messages.ts — official SDK source — "public async cancel(request: string | string[] | MessageCancelFilters): Promise<{ cancelled: number }> { if (typeof request === "string") { ... method: "DELETE", path: ["v2", "messages", request] ... /** Delete a message. @deprecated Use `cancel(messageId: string)` instead */"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/utils.ts — official SDK source — "export function buildBulkActionFilterPayload(request) { ... // Filter branch\n const count = "count" in request ? request.count ?? DEFAULT_BULK_COUNT : DEFAULT_BULK_COUNT; return { ...renameUrlGroup(request.filter ...), count, cursor, }; } ; http.ts: for (const [key, value] of Object.entries(request.query)) { if (value === undefined) continue;"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/http.ts — local experiment — "wire.mjs (fetch stubbed to return 404): client.messages.cancel('msg_fake123') sent DELETE https://qstash.upstash.io/v2/messages/msg_fake123 and threw QstashError status=404 ... The 404 body was stubbed, not a real server response."
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/messages.ts — local experiment — "verify-qstash/cancel-hazard.mjs (SDK 2.12.0, fetch stubbed): cancel({filter:{label: undefined}}) -> sent 'DELETE https://qstash.upstash.io/v2/messages?count=100'; cancel([]) -> {cancelled:0}, no request; cancel('') -> QstashError 'Message id cannot be empty'; cancel({messageIds: []}) -> QstashError 'Empty messageIds array provided. If you intend to target all messages, use { all: true } explicitly.'; cancel({filter:{label:'portal-42'}}) -> 'DELETE .../v2/messages?label=portal-42&count=100'"

### QS-RETRIES-SUCCESS — Success is any 2xx; 3 retries by default; `489` stops retries
- **Brief:** not addressed (§5.6 job handler; §5.12 Admin "failed jobs").
- **Verdict:** Extended — high confidence. The per-plan maximum retries is not officially documented here (see 07.x V3).
- **Finding:**
  - **Success** is any 2xx (200-299). Anything else, or no response within the plan's Max HTTP Response Duration, is retried.
  - **Retries:** the default is 3, so total deliveries = 1 + retries. Override per message with `Upstash-Retries` (SDK `retries`), capped by the plan's maximum retries. That cap is only on the pricing page, which was not reachable.
  - **Default backoff:** delay = `min(86400, e^(2.5*n))` seconds, i.e. 12s, 2m28s, 30m8s, 6h7m6s, then 24h. The default 3 retries span about 33 minutes.
  - **Custom backoff:** `Upstash-Retry-Delay` is a math expression in milliseconds using `retried` (0 for the first retry), e.g. `pow(2, retried) * 1000`.
  - **Destination-steered retries:** `Retry-After` or `X-RateLimit-Reset*` (seconds, an RFC 1123 date or a duration; max 1 day).
  - **Stopping retries:** respond **489** with header `Upstash-NonRetryable-Error: true`. The message becomes FAILED and moves to the DLQ.
- **Design consequence:**
  - Handler contract:
    - 200 for done or no-op, including stop-rule hits and already-processed messages;
    - 489 + `Upstash-NonRetryable-Error: true` for permanent errors (bad payload, lead missing);
    - 5xx/429 (optionally with `Retry-After`) for transient HubSpot or LLM errors.
  - A revoked HubSpot token is permanent, so it gets 489, not 5xx.
  - Publish with an explicit `retries: 3`, which is the default on every plan.
- **Open risk:** The per-plan maximum retries cannot be verified here (pricing page blocked). 3 is the documented default, so it is safe on all plans. Re-check only if more retries are wanted.
- **Sources:**
  - https://upstash.com/docs/qstash/features/retry — official docs source repo (renders to the public docs URL) — "If your API does not respond with a success status code (2XX), we retry the request" "By default, we retry a failed delivery 3 times." "delay =  min(86400, e ** (2.5*n)) // in seconds" "respond with a 489 status code and include the header `Upstash-NonRetryable-Error: true`" "The message will then be forwarded to the Dead Letter Queue (DLQ)"
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "Upstash-Retries: "The total number of deliveries is 1 (initial attempt) + retries. If it is not provided, the default of 3 retries is used.""
  - https://upstash.com/docs/qstash/overall/compare — official docs source repo (renders to the public docs URL) — "QStash's default is 3 retries over roughly 33 minutes"
  - https://upstash.com/docs/qstash/howto/publishing — official docs source repo (renders to the public docs URL) — "If your API is down or does not respond with a success status code (200-299), the message will be retried"

### QS-HTTP-TIMEOUT — Per-plan HTTP response timeout
- **Brief:** not addressed (§5.6 job handler).
- **Verdict:** Not officially documented — medium confidence. The docs confirm that a plan-specific timeout exists, but its values appear only on the blocked pricing page.
- **Finding:**
  - QStash aborts an attempt if the endpoint does not respond within the plan's "Max HTTP Response Duration". That value is listed only on the pricing page.
  - **Indirect official evidence:**
    - the Developer API example account (`type: free`) shows `timeout: 900` (seconds, i.e. 15 min);
    - the LLM integration page says "QStash offers an HTTP timeout of 2 hours" (top paid tiers).
  - `Upstash-Timeout` (SDK `timeout`, e.g. `'60s'`) can only **shorten** the plan default.
  - In practice the binding limit is the Vercel function `maxDuration` (300 s on Hobby and by default; see VC-FUNCTION-DURATION). After that, Vercel returns 504 and QStash retries.
- **Design consequence:**
  - Keep the follow-up handler well under 60 s: one HubSpot read, one LLM call, one email.
  - Optionally publish with `timeout: '120s'` so a hung attempt is retried sooner.
  - Set `export const maxDuration = 60` (or up to 300) on the job route.
- **Open risk:** The exact per-plan values are on https://upstash.com/pricing/qstash (blocked). Re-check them at WIRE_UP.
- **Sources:**
  - https://upstash.com/docs/qstash/features/retry — official docs source repo (renders to the public docs URL) — "QStash will abort a delivery attempt if **the HTTP call to your endpoint does not return within the plan-specific Max HTTP Response Duration**."
  - https://github.com/upstash/docs/blob/main/devops/developer-api/openapi.yaml — official OpenAPI spec — "QStashUser.timeout: description: Request timeout in seconds, example: 900 ... type: enum [free, paid], example: free"
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "Upstash-Timeout: "This parameter can be used to shorten the default allowed timeout value on your plan. See `Max HTTP Connection Timeout` on the pricing page""
  - https://upstash.com/docs/qstash/overall/pricing — official docs source repo (renders to the public docs URL) — "Please check our [pricing page](https://upstash.com/pricing/qstash) for the most up-to-date information on pricing and limits." (the docs page is only a redirect stub)
  - https://upstash.com/docs/qstash/integrations/llm — official docs source repo (renders to the public docs URL) — "QStash offers an HTTP timeout of 2 hours, which is sufficient for most LLM use cases."

### QS-DESTINATION-HEADERS — Headers QStash sends to the job endpoint
- **Brief:** not addressed (§5.6; §6 `scheduled_jobs`; §5.12 Admin).
- **Verdict:** Extended — high confidence.
- **Finding:** Headers sent to the destination:
  - `User-Agent: Upstash-QStash`;
  - `Content-Type` (the original value);
  - `Upstash-Signature`;
  - `Upstash-Message-Id`;
  - `Upstash-Retried` (0 on the first attempt, 1 on the second, ...);
  - `Upstash-Topic-Name` (URL Group only);
  - `Upstash-Schedule-Id` (schedule-originated messages only);
  - `Upstash-Caller-Ip`;
  - `upstash-region` (e.g. `EU-CENTRAL-1` / `US-EAST-1`);
  - every publish header prefixed `Upstash-Forward-<Name>`, delivered as `<Name>`.

  The method comes from `Upstash-Method` (enum `GET`, `POST`, `PUT`, `PATCH`, `DELETE`; default `POST`). The body is passed through unmodified.
- **Design consequence:**
  - Log `Upstash-Message-Id` and `Upstash-Retried` (no bodies) into `scheduled_jobs`/audit for the admin "failed jobs" view. Use `Upstash-Message-Id` as an idempotency key.
  - Never put secrets or lead text in the message body. Send only `{leadId, n, targetAt}`.
- **Open risk:** None.
- **Sources:**
  - https://upstash.com/docs/qstash/howto/receiving — official docs source repo (renders to the public docs URL) — "| `User-Agent` | Will be set to `Upstash-QStash` | ... | `Upstash-Retried` | How often the message has been retried so far. Starts with 0. | | `Upstash-Message-Id` | The message id of the message. | | `Upstash-Schedule-Id` | ... | `Upstash-Caller-Ip` | ... "The body is passed as is, we do not modify it at all.""
  - https://upstash.com/docs/qstash/howto/multi-region — official docs source repo (renders to the public docs URL) — "QStash includes an `upstash-region` header with every request to indicate the source region: upstash-region: US-EAST-1"
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "| Upstash-Forward-My-Header: my-value | My-Header: my-value | ... Upstash-Method enum: [ GET, POST, PUT, PATCH, DELETE ] default: POST"
  - https://upstash.com/docs/qstash/features/retry — official docs source repo (renders to the public docs URL) — "Upstash-Retried: 0 // This is the first attempt"

### QS-FAILURE-CALLBACK-DLQ — Failure callbacks and the dead letter queue
- **Brief:** not addressed (§5.12 Admin "failed jobs and error counts").
- **Verdict:** Extended — high confidence. The DLQ retention value is an example value, not a published plan figure.
- **Finding:**
  - After retries are exhausted, the message is FAILED and moved to the DLQ. Retention depends on the plan. The Developer API free-type example shows `max_dlq_retention_time_milis` `259200000` (3 days), but that example object is not a plan table (see QS-FREE-QUOTA).
  - The optional `Upstash-Failure-Callback: <url>` (SDK `failureCallback`) makes QStash POST a JSON payload to that URL. Fields: `status`, `header`, `body` (base64), `retried`, `maxRetries`, `dlqId`, `sourceMessageId`, `topicName`, `endpointName`, `url`, `method`, `sourceHeader`, `sourceBody` (base64), `notBefore`, `createdAt`, `scheduleId`, `callerIP`.
  - **Failure callbacks:**
    - are charged as a regular message;
    - reuse the original retry settings;
    - are signed, so verify them with the same `Receiver`;
    - are configurable via `Upstash-Failure-Callback-Retries|Timeout|Method|Retry-Delay` and `Upstash-Failure-Callback-Forward-*`.
  - **DLQ API:** `GET /v2/dlq`, `DELETE /v2/dlq/{dlqId}`, `POST /v2/dlq/retry/{dlqId}`.
- **Design consequence:**
  - Add `POST /api/jobs/failed` (signature-verified). It marks `scheduled_jobs.status='failed'` (looked up by `sourceMessageId`) and raises a Sentry alert. This feeds the Admin "failed jobs" panel without polling the DLQ.
  - Do not log `sourceBody` or `body`.
- **Open risk:** Each failure callback costs one message against the daily quota. DLQ retention per plan is on the blocked pricing page ("Max DLQ Retention" row); re-check at WIRE_UP.
- **Sources:**
  - https://upstash.com/docs/qstash/features/callbacks — official docs source repo (renders to the public docs URL) — "Failure callbacks are similar to callbacks but they are called only when all the retries are exhausted" ... "dlqId": "1725323658779-0", // Dead Letter Queue id ... "sourceMessageId": "msg_xxx" ... "Make sure you verify the authenticity of the callback request made to your API by [verifying the signature]"
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "Upstash-Failure-Callback: "- Failure callbacks are charged as a regular message. - Failure callbacks will use the retry setting from the original request.""
  - https://upstash.com/docs/qstash/features/dlq — official docs source repo (renders to the public docs URL) — "Dead letter queues are subject only to a retention period that depends on your plan. Messages are deleted when their retention period expires. See the “Max DLQ Retention” row on the [QStash Pricing](https://upstash.com/pricing/qstash) page."
  - https://github.com/upstash/docs/blob/main/devops/developer-api/openapi.yaml — official OpenAPI spec — "max_dlq_retention_time_milis: description: Maximum retention time for dead letter queue in milliseconds, example: 259200000"

### QS-AT-LEAST-ONCE — Delivery is at-least-once, even after a 2xx
- **Brief:** not addressed (§5.6; §8 Tests "idempotent webhook replay").
- **Verdict:** Extended — high confidence.
- **Finding:** QStash is at-least-once. The same message can be delivered more than once even after a 2xx, e.g. if the server crashes mid-delivery. The official guidance is to use the `Upstash-Message-Id` header as an idempotency key, or to make operations idempotent.
- **Design consequence:** In the follow-up handler, atomically move `scheduled_jobs` from `'scheduled'` to `'running'`/`'done'` (`UPDATE ... WHERE status='scheduled' RETURNING`) before drafting or sending, so a duplicate delivery cannot send a second owner email. Add a replay test.
- **Open risk:** None.
- **Sources:**
  - https://upstash.com/docs/qstash/features/at-least-once — official docs source repo (renders to the public docs URL) — "in rare cases, QStash may deliver the same message more than once, even if your endpoint has already processed it successfully." "Each QStash message includes a unique `Upstash-Message-Id` header, which you can use for this purpose."

### QS-PUBLISH-WIRE — Publish endpoint, response and captured wire format
- **Brief:** §5.6 "enqueue QStash jobs" (§8 `Scheduler` fake/live).
- **Verdict:** Extended — high confidence. The verifier corrected the response body: a single-URL publish documents no `url` field.
- **Finding:**
  - **Endpoint:** `POST {QSTASH_URL}/v2/publish/{destination}`. The destination is the full URL appended raw, e.g. `https://qstash.upstash.io/v2/publish/https://app.example.com/api/jobs/follow-up`. It must be publicly reachable over the internet.
  - **Auth:** `Authorization: Bearer <QSTASH_TOKEN>`.
  - **Response for a single URL destination:** 200 `{"messageId":"msg_..."}`, with `deduplicated` (boolean) documented in the schema. A duplicate returns 202 with the EXISTING `messageId`.
    - Do not depend on a `url` field. The OpenAPI documents it only for URL-Group publishes (`PublishToUrlGroupResponse`), and the batch example shows direct-URL entries as just `{"messageId": "msg_..."}`. The SDK type `PublishToUrlResponse` declares `url: string`, but the server is not documented to return it for a single URL.
    - The OpenAPI lists only 200/400/401 for publish. The 202-for-duplicate comes from the deduplication docs.
  - **SDK call:** `client.publishJSON({ url, body, notBefore, deduplicationId, retries, label, failureCallback, timeout })`.
  - **Captured wire format (SDK 2.12.0, fetch stubbed):**
    - Headers: `authorization: Bearer <token>`, `content-type: application/json`, `upstash-method: POST`, `upstash-not-before: <unix s>`, `upstash-deduplication-id: lead:123:fu:1`, `upstash-retries: 3`, `upstash-label: portal-42` (arrays are joined with `,`), `upstash-failure-callback: <url>`.
    - Body: `{"leadId":"123","n":1}`.
    - Non-Upstash custom headers become `Upstash-Forward-*`.
  - **SDK HTTP client:**
    - It retries NETWORK errors up to 5 times (6 attempts; backoff `Math.exp(i)*50` ms). It does not retry HTTP error statuses.
    - Non-2xx → `QstashError(status)`. The response body goes on `.message`, not to the log.
    - 429 → `QstashDailyRatelimitError` (`RateLimit-Limit`/`Remaining`/`Reset`) or `QstashRatelimitError` (`Burst-RateLimit-*`). The verifier found a third mapping in `http.ts`: `QstashChatRatelimitError` (`x-ratelimit-*`).
    - `enableTelemetry: false` (or env `UPSTASH_DISABLE_TELEMETRY`) drops the `Upstash-Telemetry-Sdk`/`Platform`/`Runtime` headers.
- **Design consequence:**
  - `Scheduler` interface: `schedule({leadId, n, runAt, dedupeId, labels}) -> {messageId, deduplicated}`; `cancel(messageId) -> void` (404 = ok). Rely only on `messageId` (and optional `deduplicated`), and accept any 2xx.
  - The live implementation is about 30 lines over `publishJSON` and `messages.cancel`. The fake stores jobs in memory/PGlite and exposes `advanceTo(time)`.
  - Set `enableTelemetry: false` if SDK telemetry headers are unwanted.
- **Open risk:** None.
- **Sources:**
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/client.ts — official SDK source — "path: ["v2", "publish", getRequestPath(request)], body: request.body, headers, method: "POST" ... export type PublishToApiResponse = { messageId: string; };"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/client.ts — official SDK source — ""Upstash-Telemetry-Sdk": `upstash-qstash-js@${VERSION}`, "Upstash-Telemetry-Platform": ... const enableTelemetry = environment.UPSTASH_DISABLE_TELEMETRY ? false : config?.enableTelemetry ?? true;"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/http.ts — official SDK source — "attempts: config.retry?.retries ?? 5, backoff: config.retry?.backoff ?? ((retryCount) => Math.exp(retryCount) * 50), ... } else if (response.headers.get("RateLimit-Limit")) { return new QstashDailyRatelimitError({"
  - https://github.com/upstash/qstash-js/blob/v2.12.0/src/client/utils.ts — local experiment — "wire.mjs captured: {"method":"POST","url":"https://qstash.upstash.io/v2/publish/https://autopilot.hublytix.ai/api/jobs/follow-up","headers":{"authorization":"Bearer test-token","content-type":"application/json","upstash-deduplication-id":"lead:123:fu:1","upstash-delay":"2d","upstash-failure-callback":"https://autopilot.hublytix.ai/api/jobs/failed","upstash-label":"portal-42","upstash-method":"POST","upstash-not-before":"1790432000","upstash-retries":"3"},"body":"{\"leadId\":\"123\",\"n\":1}"}"
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "/v2/publish/{destination}: ... "Note that destination must be publicly accessible over the internet. If you are working with local endpoints, consider using QStash local development server or a public tunnel service.""
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "PublishResponse: type: object properties: messageId: ... description: Unique identifier for the published message or the old message ID if deduplicated; deduplicated: type: boolean ... PublishToUrlGroupResponse: ... url: type: string description: Destination URL of the URL Group endpoint."
  - https://upstash.com/docs/qstash/features/batch — official docs source repo (renders to the public docs URL) — "[ [ { "messageId": "msg_...", "url": "https://myUrlGroup-endpoint1.com" }, ... ], { "messageId": "msg_..." }, { "messageId": "msg_..." } ]"

### QS-LOCAL-DEV — The QStash dev server cannot replace the time-travel fake
- **Brief:** §8 "`Scheduler` (time-travel capable)" has a fake implementation.
- **Verdict:** Extended — high confidence.
- **Finding:**
  - **Ways to run the official local server:**
    - `npx @upstash/qstash-cli dev` (npm `@upstash/qstash-cli` latest 2.37.18). Flags: `-port` (default 8080, env `QSTASH_DEV_PORT`), `-log-port` (default port+1, env `QSTASH_DEV_LOG_PORT`), `-quota payg|pro` (env `QSTASH_DEV_QUOTA`, default `payg`).
    - Docker: `docker run -p 8080:8080 public.ecr.aws/upstash/qstash:latest qstash dev`.
    - Set `QSTASH_DEV=true` or `devMode: true`, and the JS SDK downloads, spawns and points at the binary automatically.
  - **Behaviour:** in-memory (state is lost on restart); supports schedules, URL groups and logs. Licensed for development and testing only.
  - **Predefined test user 1:**
    - `QSTASH_URL=http://localhost:8080`
    - `QSTASH_TOKEN=eyJVc2VySUQiOiJkZWZhdWx0VXNlciIsIlBhc3N3b3JkIjoiZGVmYXVsdFBhc3N3b3JkIn0=`
    - `QSTASH_CURRENT_SIGNING_KEY=sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r`
    - `QSTASH_NEXT_SIGNING_KEY=sig_5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs`
  - The server runs in real time with no clock control, so it cannot replace the time-travel fake.
  - In this sandbox the binary hosts (artifacts.upstash.com, and CloudFront behind public.ecr.aws) are blocked. The npm wrapper only downloads the binary at postinstall.
- **Design consequence:**
  - Keep the in-process time-travel fake as the default for tests and `simulate`: no binary, deterministic.
  - Optionally document the dev server as a manual "live-ish" smoke path (`APP_MODE=live` + `QSTASH_DEV=true`, locally only). Never set `QSTASH_DEV` in Vercel envs.
- **Open risk:** No risk to the design. The dev server could not be run in this sandbox.
- **Sources:**
  - https://upstash.com/docs/qstash/howto/local-development — official docs source repo (renders to the public docs URL) — "npx @upstash/qstash-cli dev" ... "-quota string The quota of users [env QSTASH_DEV_QUOTA] (default \"payg\")" ... "Since the development server operates entirely in-memory, all data is reset when the server restarts." ... "restricts its use to development and testing purposes only."
  - https://www.npmjs.com/package/@upstash/qstash-cli — official SDK source (npm registry metadata and tarball) — "npm view @upstash/qstash-cli -> version 2.37.18; install.js downloads `${baseUrl}/${version}/qstash-server_${version}_${platform}_${arch}${extension}`; bin/qstash is an empty placeholder in the tarball"

### QS-FREE-QUOTA — Free-plan quotas (messages per day and related limits)
- **Brief:** not addressed (§3 Jobs; §10 WIRE_UP step 4).
- **Verdict:** Not officially documented — low confidence. The verifier found the evidence insufficient: the 1,000 messages/day figure rests only on an example object in the Developer API OpenAPI spec, not on a published limits table.
- **Finding:**
  - The pricing page (https://upstash.com/pricing/qstash) is blocked here. The best official evidence is the Upstash Developer API spec's example QStash account with `type: free`:
    - `max_requests_per_day` 1000 (soft and hard);
    - `max_message_size` 1048576 (1 MB);
    - `max_delay` 604800 (7 d);
    - `timeout` 900 s;
    - `max_dlq_retention` 3 days;
    - `max_schedules` 10;
    - `max_queues` 10.
  - **Verifier caveat:** that example is not a published limits table, and nothing else in the docs repo confirms the daily figure. `qstash/overall/pricing.mdx` is a redirect stub to the blocked pricing page; a git grep of `workflow/` and `qstash/` found no daily-quota figure. The same example mixes values that look like a non-free account, e.g. `max_retries` 999 and `max_topics` 1, so individual fields should not be read as Free-plan limits.
  - **What IS officially verified:**
    - message size 1 MB free / 10 MB pay-as-you-go / 50 MB fixed;
    - the 7-day maximum delay on Free;
    - `412` "Exceeded the maximum number of schedules allowed";
    - exceeding the daily quota returns HTTP 429 with `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers (SDK `QstashDailyRatelimitError`);
    - callbacks and failure callbacks are charged as messages.
- **Design consequence:**
  - Follow-ups alone (at most 2 per lead, plus rare failure callbacks) fit a 1,000/day quota easily.
  - If QStash schedules replace Vercel Cron (see VC-CRON-PLAN-LIMITS), the volume is 313 msgs/day before retries: a 5-minute poller is 288 msgs/day, plus 24 for the hourly report check and 1 for the daily purge. That is still under 1,000 but erodes headroom. A per-portal fan-out (one message per portal per tick) would exceed the quota quickly: 4 portals × 288 = 1,152.
  - Recommend pay-as-you-go for production, and surface `QstashDailyRatelimitError` to Sentry. These conclusions hold only if the unverified quota is right.
- **Open risk:** These values are schema examples, not a published limits table. Re-check the pricing page during WIRE_UP: messages/day, maximum schedules and DLQ retention for the chosen plan.
- **Sources:**
  - https://github.com/upstash/docs/blob/main/devops/developer-api/openapi.yaml — official OpenAPI spec — "max_requests_per_day: description: Soft limit for maximum requests per day, example: 1000; max_requests_per_day_hard: example: 1000; max_message_size: example: 1048576; max_schedules: example: 10; type: enum: [free, paid] example: free"
  - https://github.com/upstash/docs/blob/main/devops/developer-api/openapi.yaml — official OpenAPI spec — "QStashUser example values in the same object: max_retries: example: 999 ... max_topics: example: 1 ... max_requests_per_day: example: 1000 ... type: example: free"
  - https://upstash.com/docs/qstash/overall/compare — official docs source repo (renders to the public docs URL) — "QStash allows 1 MB on the free plan, 10 MB on pay-as-you-go, and 50 MB on fixed plans."
  - https://upstash.com/docs/qstash/api/api-ratelimiting — official docs source repo (renders to the public docs URL) — "import { QstashDailyRatelimitError } from "@upstash/qstash"; ... console.log("Daily rate limit exceeded. Retry after:", error.reset);"
  - https://upstash.com/docs/qstash/overall/pricing — official docs source repo (renders to the public docs URL) — "Please check our [pricing page](https://upstash.com/pricing/qstash) for the most up-to-date information on pricing and limits."
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "'412': description: Exceeded the maximum number of schedules allowed."

### QS-SCHEDULES-ALTERNATIVE — QStash schedules can replace Vercel Cron on any Vercel plan
- **Brief:** §3 "Vercel Cron for periodic jobs: lead poller every 5 minutes, Monday-report due-check hourly, retention purge daily."
- **Verdict:** Extended — high confidence.
- **Finding:**
  - Create with `client.schedules.create({ destination, cron, scheduleId? })`, or `POST /v2/schedules/{destination}` with header `Upstash-Cron`.
  - Cron is evaluated in UTC by default; a `CRON_TZ=<IANA> ` prefix is supported.
  - Passing an explicit `scheduleId` creates or overwrites idempotently. Schedule IDs may contain only alphanumeric characters, hyphens, periods and underscores (otherwise 400 "Schedule ID is invalid"). Exceeding the plan's schedule count returns 412.
  - A new schedule can take up to 60 s to become active.
  - Deliveries are signed (same `Receiver`), carry `Upstash-Schedule-Id`, and get QStash retries.
  - The Upstash docs explicitly contrast this with Vercel Cron: schedules are "not tied to a deploy, are not limited to one per plan tier, and retry on failure." (This is Upstash's characterisation of Vercel, not Vercel's own documentation.)
- **Design consequence:**
  - Make the periodic triggers transport-agnostic. Each periodic route accepts EITHER a valid Vercel `Authorization: Bearer ${CRON_SECRET}` (GET) OR a valid QStash signature (POST). The operator can then choose Vercel Cron (Pro) or QStash schedules (any Vercel plan) at WIRE_UP without code changes.
  - Provide an idempotent `npm run qstash:schedules` script that upserts fixed `scheduleId`s.
- **Open risk:** The free-plan schedule cap (example value 10) and the daily message quota; see QS-FREE-QUOTA.
- **Sources:**
  - https://upstash.com/docs/qstash/features/schedules — official docs source repo (renders to the public docs URL) — "add the `Upstash-Cron` header to your `publish` request." "By default, we evaluate cron expressions in `UTC`." "You can specify a different timezone using the `CRON_TZ` prefix" "It can take up to 60 seconds for the schedule to be loaded on an active node"
  - https://upstash.com/docs/qstash/overall/usecases — official docs source repo (renders to the public docs URL) — "Unlike platform-native cron (such as Vercel Cron), schedules are not tied to a deploy, are not limited to one per plan tier, and retry on failure."
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "'400': description: Schedule ID is invalid. Schedule IDs can only contain alphanumeric characters, hyphens, periods, and underscores. ... '412': description: Exceeded the maximum number of schedules allowed."
  - https://upstash.com/docs/qstash/overall/changelog — official docs source repo (renders to the public docs URL) — "Validated the scheduleId parameter. The scheduleId must now be alphanumeric or include hyphens, underscores, or periods."

### VC-CRON-CONFIG — `vercel.json` crons: syntax, GET method, production only
- **Brief:** §3 "Vercel Cron for periodic jobs"; §10 WIRE_UP step 3 "set environment variables and crons".
- **Verdict:** Confirmed — high confidence. vercel.com/docs was blocked, so this comes from Vercel's CLI source, the npm `vercel` and `@vercel/config` packages, Vercel's examples repo and Vercel's official agent plugin. It corrects one detail of WIRE_UP step 3: there is no "set crons" step in the dashboard.
- **Finding:**
  - **Config:** `vercel.json`: `{ "crons": [ { "path": "/api/cron/poll-leads", "schedule": "*/5 * * * *" } ] }`.
  - **Schema enforced by the Vercel CLI:** each item has only
    - `path`: string, 1-512 chars, must start with `/`;
    - `schedule`: string, 9-256 chars, exactly 5 fields (minute hour day-of-month month day-of-week).
  - **Production only:** crons are created only for PRODUCTION deployments ("won't be active until the project is deployed to production"). Preview deployments never run them.
  - **Method:** Vercel invokes the path with an HTTP **GET**.
  - **CLI helpers:** `vercel crons ls`; `vercel crons add --path ... --schedule ...`; `vercel crons run <path>` (manual trigger via `POST /v1/projects/{id}/crons/run`).
  - There is no "set crons" step in the dashboard; crons deploy from `vercel.json`.
- **Design consequence:**
  - Export `GET` from `app/api/cron/*/route.ts`. In Next 14, GET route handlers can be statically cached unless they read the Request, so read `request.headers` and add `export const dynamic = 'force-dynamic'`.
  - Exclude `/api/cron/*` and `/api/jobs/*` from any auth middleware and redirects.
  - Local runs and `simulate` call the handlers directly.
- **Open risk:** None for the design. vercel.com/docs/cron-jobs was not read (egress-blocked).
- **Sources:**
  - https://github.com/vercel/vercel/blob/main/packages/cli/src/util/validate-config.ts — official SDK source (Vercel CLI source) — "const cronsSchema = { type: 'array', ... required: ['path', 'schedule'], properties: { path: { type: 'string', minLength: 1, maxLength: 512, pattern: '^/.*' }, schedule: { type: 'string', minLength: 9, maxLength: 256 } } }"
  - https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/crons/add.ts — official SDK source (Vercel CLI source) — "Schedule must have exactly 5 fields (minute hour day-of-month month day-of-week)" ... "This cron job won't be active until the project is deployed to production."
  - https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/agent/init.ts — official SDK source (Vercel CLI source) — "- Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET" (Vercel CLI best-practices text, line 26; same string shipped in npm vercel@62.1.0 dist/commands-bulk.js)
  - https://www.npmjs.com/package/@vercel/config — official SDK source (npm package types) — "@vercel/config@0.7.2 dist/types.d.ts: "An array of cron jobs that should be created for production Deployments." crons?: CronJob[]; interface CronJob { schedule: string; path: string; }"
  - https://www.npmjs.com/package/vercel — official SDK source (npm package dist) — "npm view vercel dist-tags -> latest: '62.1.0' (time 2026-10-01T04:15:23.555Z); dist/chunks/chunk-Z26EOSNI.js: cronsSchema={type:"array",minItems:0,items:{type:"object",additionalProperties:!1,required:["path","schedule"],properties:{path:{type:"string",minLength:1,maxLength:512,pattern:"^/.*"},schedule:{type:"string",minLength:9,maxLength:256}}}}"
  - https://github.com/vercel/examples/blob/main/solutions/cron/vercel.json — official docs source repo (Vercel's official examples repo; not rendered on vercel.com/docs) — ""crons": [ { "path": "/api/cron/1m", "schedule": "* * * * *" }, { "path": "/api/cron/10m", "schedule": "*/10 * * * *" }, ..."
  - https://github.com/vercel/vercel-plugin/blob/main/skills/next-forge/references/packages.md — official docs source repo (Vercel's official agent plugin; not rendered on vercel.com/docs) — "Cron routes must use the `GET` HTTP method. Test locally via direct HTTP GET."

### VC-CRON-SECRET-UA — Securing cron routes with `CRON_SECRET`; the `vercel-cron/1.0` user agent
- **Brief:** not addressed (§3 Jobs; §7; §10 WIRE_UP step 3).
- **Verdict:** Extended — high confidence. The research verdict was "confirmed": the mechanism is confirmed in Vercel's CLI and runtime source and Vercel's official plugin, though the brief does not mention cron auth. The `vercel-cron/1.0` user agent rests only on Sentry's SDK source.
- **Finding:**
  - Set a project env var `CRON_SECRET`. Vercel then sends `Authorization: Bearer <CRON_SECRET>` on every cron invocation, and the handler must reject anything else with 401.
  - `CRON_SECRET` must be valid in an HTTP header: no leading or trailing whitespace, and only visible ASCII 0x20-0x7E or tab. Otherwise the build fails with code `INVALID_CRON_SECRET`. The check runs only when `crons` are defined.
  - Vercel's cron requests use the user agent `vercel-cron/1.0`. It is informational only; never use it for auth.
- **Design consequence:**
  - Add `CRON_SECRET` to `.env.example`; generate 32+ random URL-safe chars, e.g. `openssl rand -hex 32`.
  - Compare with `crypto.timingSafeEqual` on equal-length buffers. Fail closed if `CRON_SECRET` is unset in live mode.
  - WIRE_UP step 3: add `CRON_SECRET` for the Production environment before the first production deploy.
- **Open risk:** None for the design. vercel.com was not read; Vercel's CLI source links the docs page as `https://vercel.link/securing-cron-jobs`, which can be checked at WIRE_UP.
- **Sources:**
  - https://github.com/vercel/vercel/blob/main/internals/cli-builder-integration/src/validate-cron-secret.ts — official SDK source (Vercel CLI source) — "CRON_SECRET is sent as an Authorization header when Vercel invokes cron jobs, so it must contain only valid HTTP header characters." code: 'INVALID_CRON_SECRET', link: 'https://vercel.link/securing-cron-jobs'
  - https://github.com/vercel/vercel/blob/main/internals/cli-builder-integration/src/do-build.ts — official SDK source (Vercel CLI source) — "// Validate CRON_SECRET if crons are defined\n if (localConfig.crons && localConfig.crons.length > 0) { const cronSecretError = validateCronSecret(process.env.CRON_SECRET); if (cronSecretError) { throw cronSecretError; } }"
  - https://github.com/vercel/vercel/blob/main/packages/backends/templates/vc_cron_dispatch.mjs — official SDK source (Vercel runtime template) — "const secret = process.env.CRON_SECRET; if (secret) { const headers = req.headers || {}; const authorization = headers.authorization || headers.Authorization; if (!safeBearerEqual(authorization, secret)) { jsonResponse(res, 401, { error: 'unauthorized' });"
  - https://github.com/vercel/vercel-plugin/blob/main/skills/vercel-functions/SKILL.md — official docs source repo (Vercel's official agent plugin; not rendered on vercel.com/docs) — "const authHeader = req.headers.get('authorization') if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) { return new Response('Unauthorized', { status: 401 }) }"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/nextjs/src/server/vercelCronsMonitoring.ts — official SDK source (Sentry's Next.js SDK; official for Sentry, third-party evidence about Vercel) — "by checking the user agent, vercel always sets the user agent to 'vercel-cron/1.0'" ... if (!userAgent?.includes('vercel-cron')) { return; }

### VC-CRON-PLAN-LIMITS — Vercel Hobby likely cannot run the 5-minute poller or the hourly check
- **Brief:** §3 "Vercel Cron: lead poller every 5 minutes, Monday-report due-check hourly, retention purge daily."
- **Verdict:** Not officially documented — low confidence. **High impact.** The verifier found the evidence insufficient: the plan limits below are training knowledge only. Only the UTC timezone is officially corroborated (Vercel CLI source).
- **Finding:**
  - vercel.com could not be fetched (blocked) and the WebSearch budget was exhausted. The best-supported answer comes from training knowledge of Vercel's "Cron Jobs > Usage & Pricing" page:
    - **Hobby:** cron jobs run at most ONCE PER DAY and fire anywhere within the scheduled hour (±59 min precision). A more frequent expression such as `*/5 * * * *` or `0 * * * *` makes the deployment FAIL ("Hobby accounts are limited to daily cron jobs...").
    - **Pro/Enterprise:** down to once per minute, with per-minute precision.
    - **Count:** up to 100 cron jobs per project on all plans (older limits were 2 Hobby / 40 Pro).
    - **Timezone:** schedules are evaluated in UTC only; there is no timezone field. This one point is officially corroborated by Vercel's CLI source ("cron runs in UTC").
  - Therefore the brief's 5-minute poller and hourly Monday check are NOT possible on Hobby; only the daily purge is.
  - Separately, Vercel's fair-use guidelines restrict Hobby to non-commercial personal use (training knowledge), so a paid SaaS should be on Pro anyway.
  - **What the offline sources do and do not show:** the verifier searched every Vercel artifact available offline (vercel/vercel CLI source, the `vercel@62.1.0` dist, `@vercel/config` 0.7.2, `@vercel/sdk` 1.28.38 models, vercel/vercel-plugin skills, vercel/examples `solutions/cron`). None states Hobby cron frequency, precision or count. `@vercel/sdk`'s `AuthUser` model has a `cronJobsPerProject` field but no value. The CLI `cronsSchema` has no plan or frequency check, which shows only that any enforcement is server-side. The Upstash usecases sentence is a third party's characterisation of Vercel, not evidence of Vercel's limits.
- **Design consequence:**
  - Log the choice in `DECISIONS.md`: either (a) require Vercel Pro (WIRE_UP: "Hobby will reject these crons"), or (b) keep only the daily purge on Vercel Cron and drive the 5-minute poller and the hourly report check from QStash schedules (QS-SCHEDULES-ALTERNATIVE). Implement the routes so both triggers work.
  - Never rely on the exact firing minute. The poller uses a persisted cursor; the Monday check is a "due" check (VC-CRON-MONDAY-DUE).
- **Open risk:** HIGH impact. Not read from https://vercel.com/docs/cron-jobs/usage-and-pricing (egress-blocked; WebSearch budget exhausted); the answer is training knowledge with only indirect corroboration. Re-verify on that page during WIRE_UP and record the result in `DECISIONS.md`. The Hobby non-commercial restriction (https://vercel.com/docs/limits/fair-use-guidelines) is likewise unverified here.
- **Sources:**
  - https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/agent/init.ts — official SDK source (Vercel CLI source) — "- Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET" (Vercel CLI best-practices text, line 26; same string shipped in npm vercel@62.1.0 dist/commands-bulk.js)
  - https://github.com/vercel/vercel/blob/main/packages/cli/src/util/validate-config.ts — official SDK source (Vercel CLI source) — "The client-side schema has no frequency/plan check (schedule: { type: 'string', minLength: 9, maxLength: 256 }), i.e. plan limits are enforced server-side at deploy time."
  - https://www.npmjs.com/package/@vercel/sdk — official SDK source (npm package types) — "@vercel/sdk@1.28.38 esm/models/authuser.d.ts: cronJobsPerProject?: number | undefined; (field exists, no plan values documented)"
  - https://upstash.com/docs/qstash/overall/usecases — official docs source repo (renders to the public docs URL; Upstash's characterisation of Vercel, not authoritative for Vercel limits) — "Unlike platform-native cron (such as Vercel Cron), schedules are not tied to a deploy, are not limited to one per plan tier, and retry on failure."

### VC-CRON-MONDAY-DUE — "Monday 08:00 local" must be a catch-up due-check, not an equality check
- **Brief:** §5.9 "An hourly cron sends the report to portals where it is Monday 08:00 local time."
- **Verdict:** Extended — high confidence. In effect this corrects the brief's equality check.
- **Finding:** An hourly UTC cron does not reliably hit "Monday 08:00 local" with an equality check.
  - Vercel Cron and QStash schedules both evaluate in UTC, and an hourly job fires at :00 UTC (on Hobby, anywhere within the hour).
  - Portals at half- or quarter-hour offsets are never exactly at 08:00 local at :00 UTC. Examples: `Asia/Kolkata` UTC+05:30, `Asia/Kathmandu` +05:45, `Australia/Adelaide` +09:30/+10:30.
  - A missed or late run skips the week.

  The check must be: local time ≥ Monday 08:00 AND no `weekly_reports` row for this portal and ISO week. Catch up until, say, Monday 23:59 local.
- **Design consequence:**
  - Add `UNIQUE(portal_id, week_start)` on `weekly_reports`. The due-check selects portals whose local now ≥ Monday 08:00 of the current ISO week and that have no report. Insert the row, then send, for idempotency.
  - Add quiet-hours and timezone tests, including `Asia/Kolkata` and a DST transition week.
- **Open risk:** The "anywhere within the hour" precision on Hobby comes from training knowledge (vercel.com blocked). Vercel's UTC evaluation is now officially corroborated by Vercel's CLI source (07.x V1). The design is safe either way.
- **Sources:**
  - https://upstash.com/docs/qstash/features/schedules — official docs source repo (renders to the public docs URL) — "By default, we evaluate cron expressions in `UTC`."
  - https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/agent/init.ts — official SDK source (Vercel CLI source) — "- Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET" (Vercel CLI best-practices text, line 26; same string shipped in npm vercel@62.1.0 dist/commands-bulk.js)

### VC-CRON-RETRY-OVERLAP — Vercel Cron does not retry; runs may overlap or repeat
- **Brief:** not addressed (§3 Jobs; §5.2 Poller; §5.14 Retention).
- **Verdict:** Not officially documented — low confidence. The verifier found the evidence insufficient: these statements are training knowledge of https://vercel.com/docs/cron-jobs/manage-cron-jobs, which was blocked. The design is correct regardless.
- **Finding:**
  - Vercel Cron does not retry a failed invocation. Upstash's docs contrast QStash schedules, which "retry on failure", with Vercel Cron. That is a competitor's characterisation, not authoritative for Vercel.
  - From training knowledge of Vercel's cron docs (vercel.com blocked):
    - a run can overlap the next one if it lasts longer than the interval;
    - the same cron event can occasionally be delivered more than once;
    - redirects (3xx) are not followed; the 3xx is the final response.
  - Function duration limits apply to cron invocations like any other request.
  - No Vercel artifact available offline (CLI source/dist, `@vercel/config`, vercel-plugin, vercel/examples) addresses retries, concurrency or redirects for crons.
- **Design consequence:**
  - Poller: take a Postgres advisory lock (`pg_try_advisory_lock(hashtext('poller'))`) or a lease row. Advance each per-portal cursor only after successful processing; dedupe on (contact_id, submission_ts) is already planned.
  - Retention purge and the Monday check must be idempotent and safe to re-run.
  - No middleware redirect on cron paths.
  - Alert via Sentry on handler errors, since Vercel will not retry.
- **Open risk:** The no-retry, concurrency, duplicate-delivery and redirect statements were not read from https://vercel.com/docs/cron-jobs/manage-cron-jobs (egress-blocked). Re-verify during WIRE_UP. The design (locks + idempotency) is safe regardless.
- **Sources:**
  - https://upstash.com/docs/qstash/overall/usecases — official docs source repo (renders to the public docs URL; Upstash's characterisation of Vercel, not authoritative for Vercel behaviour) — "Unlike platform-native cron (such as Vercel Cron), schedules ... retry on failure."

### VC-FUNCTION-DURATION — Function duration limits force the poller to fan out
- **Brief:** not addressed (§5.2 "Poller (every 5 minutes per active portal)").
- **Verdict:** Extended — medium confidence. The values come from Vercel's official agent plugin, which cites the docs page, not from the docs site itself (blocked).
- **Finding:**
  - With Fluid Compute (the default for new projects since 2025-04-23):
    - Hobby: default = max = 300 s.
    - Pro/Enterprise: default 300 s, max 800 s (1800 s in the extended-duration beta).
  - Exceeding the limit returns `504 FUNCTION_INVOCATION_TIMEOUT`.
  - Configure per route in Next.js 14 with `export const maxDuration = <seconds>` in `route.ts` (requires Next.js ≥ 13.4.10), or in `vercel.json` `functions`. The server-side value is authoritative; the CLI only does a coarse client-side check.
  - Next 14 caches GET route handlers by default when they use the `Response` object without reading the `Request`.
- **Design consequence:**
  - Do not process all portals serially inside one 5-minute cron invocation. The cron handler only enumerates active portals and fans out: either publish one QStash message per portal with flowControl key `poll:<portalId>` and parallelism 1, or use bounded concurrency with a time budget of about 240 s and resume from the cursor.
  - Set `export const maxDuration = 300` on cron and job routes.
- **Open risk:** These values come from Vercel's official plugin repo rather than the docs site (blocked). Re-check them at WIRE_UP, and confirm Fluid Compute is on for the project.
- **Sources:**
  - https://github.com/vercel/vercel-plugin/blob/main/skills/vercel-functions/SKILL.md — official docs source repo (Vercel's official agent plugin, citing https://vercel.com/docs/functions/limitations#max-duration; not rendered on vercel.com/docs) — "| Hobby | 300s (5 min) | 300s (5 min) | — | | Pro | 300s (5 min) | 800s | 1800s (30 min) — Beta | ... "Exceeding the limit returns `504 FUNCTION_INVOCATION_TIMEOUT`.""
  - https://github.com/vercel/vercel-plugin/blob/main/skills/vercel-functions/SKILL.md — official docs source repo (Vercel's official agent plugin; not rendered on vercel.com/docs) — ""Fluid Compute is the execution model for Vercel Functions — **enabled by default for new projects since April 23, 2025**" ... "4. Confirm Fluid Compute is on (default since April 23, 2025) and redeploy.""
  - https://github.com/vercel/next.js/blob/v14.2.35/docs/02-app/02-api-reference/02-file-conventions/route-segment-config.mdx — official docs source repo (renders to the public docs URL) — ""Deployment platforms can use `maxDuration` from the Next.js build output to add specific execution limits." export const maxDuration = 5 "**Note**: This settings requires Next.js `13.4.10` or higher.""
  - https://github.com/vercel/vercel/blob/main/packages/build-utils/src/max-duration.ts — official SDK source (Vercel build-utils source) — "The authoritative limit is enforced by server-side validation at deploy time."
  - https://github.com/vercel/next.js/blob/v14.2.35/docs/02-app/01-building-your-application/01-routing/12-route-handlers.mdx — official docs source repo (renders to the public docs URL) — ""Route Handlers are cached by default when using the `GET` method with the `Response` object." ... "Using the `Request` object with the `GET` method.""

### WIREUP-QSTASH-CALLBACK-URL — There is no console "callback URL"; the destination is set per publish
- **Brief:** §10 WIRE_UP step 4 "Set up QStash keys and the callback URL."
- **Verdict:** Corrected — high confidence.
- **Finding:**
  - No account-level callback or destination URL exists.
    - The destination URL is supplied per publish, as the path parameter of `/v2/publish/{destination}`.
    - It must be publicly reachable: not localhost (use the dev server or a tunnel locally).
    - It is also the JWT `sub` that the receiver should check.
  - "Callback" in QStash terminology means the optional per-message `Upstash-Callback` / `Upstash-Failure-Callback` URLs.
  - **WIRE_UP step 4 should therefore be:**
    1. Copy `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` from the Console (same region) into the Vercel Production env. (The Console path: QStash tab, pick a region, Quickstart section.)
    2. Set `APP_URL` to the production domain.
    3. Optionally, create QStash schedules.
- **Design consequence:**
  - Add env `APP_URL`: the public production origin, e.g. `https://autopilot.hublytix.ai`. Use it both to build publish destinations and as the expected `sub` in verification.
  - Use the production custom domain, not a protected preview or deployment URL. Vercel Deployment Protection would answer QStash with 401, and every job would end in the DLQ.
- **Open risk:** Vercel Deployment Protection defaults were not verified (vercel.com blocked). Re-check at WIRE_UP that QStash can reach the production domain without a 401/403.
- **Sources:**
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "/v2/publish/{destination}: ... name: destination in: path ... "Destination can either be a valid URL where the message gets sent to, or a URL Group name." "Note that destination must be publicly accessible over the internet.""
  - https://upstash.com/docs/qstash/features/security — official docs source repo (renders to the public docs URL) — "go to the [QStash tab in the Console](https://console.upstash.com/qstash), pick a region, and copy the `QSTASH_TOKEN` from the **Quickstart** section."
  - https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/agent/init.ts — official SDK source (Vercel CLI source) — "- If a deployment URL returns a Vercel Deployment Protection 401/403, retry the same URL with `vercel curl <url>`; don't disable protection or manage bypass secrets manually" (line 28)

### 07.x Verifier-added items

#### V1 — Vercel Cron is UTC, GET and production-only, per Vercel's own CLI source
- **Brief:** §3 "Vercel Cron for periodic jobs"; §5.9 "Monday 08:00 local time" (no timezone or method stated).
- **Verdict:** Extended — high confidence. The source is Vercel's own CLI source and `@vercel/config` types; vercel.com/docs itself was not read.
- **Finding:** The original findings relied on training knowledge for UTC. Vercel's own CLI source (`packages/cli/src/commands/agent/init.ts`, also shipped in npm `vercel@62.1.0`) states: "Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET". `@vercel/config` 0.7.2 types describe `crons` as "An array of cron jobs that should be created for production Deployments." So:
  - Vercel Cron schedules are UTC;
  - the method is GET;
  - only production deployments get cron jobs;
  - `crons[]` items accept only `{path, schedule}`; there is no timezone field.
- **Design consequence:** Export GET from `app/api/cron/*/route.ts` and read request headers, so Next 14 does not statically cache the GET handler.
- **Open risk:** None.
- **Sources:**
  - https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/agent/init.ts — official SDK source (Vercel CLI source) — "- Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET" (Vercel CLI best-practices text, line 26; same string shipped in npm vercel@62.1.0 dist/commands-bulk.js)
  - https://www.npmjs.com/package/@vercel/config — official SDK source (npm package types) — "@vercel/config@0.7.2 dist/types.d.ts: "An array of cron jobs that should be created for production Deployments." crons?: CronJob[]; interface CronJob { schedule: string; path: string; }"

#### V2 — Vercel's new timezone-aware `schedules` (beta) exist, but are not for v1
- **Brief:** §5.9 Monday report "08:00 in the owner's timezone".
- **Verdict:** Extended — high confidence that the schema exists in Vercel's CLI and config packages. Its plan availability, limits and auth semantics are not documented here.
- **Finding:**
  - There is a NEW, separate `vercel.json` `schedules` array alongside `crons`. It is visible in vercel CLI 62.1.0 (published 2026-10-01), in vercel/vercel `validate-config.ts` ("Mirrors the server-side Build Output API `schedules` schema") and in `@vercel/config` 0.7.2, where the trigger type is `'schedule/v1beta'`.
  - **Each entry has:**
    - `name` (pattern `^[0-9A-Za-z][0-9A-Za-z._-]*$`);
    - `schedule` (cron) or `expression.cron`;
    - optional `timezone` ("IANA timezone for cron evaluation. Defaults to UTC.");
    - optional `jitter` (1-15);
    - a target: `path` (HTTP), `function`, `topic` (Vercel Queues) or `entrypoint`.
  - The array allows at most 100 entries. A `vercel schedules` CLI command (list/get/create/update/enable/disable/invoke/delete/executions) also exists.
  - It is beta. It would not solve per-portal local times anyway, since each schedule has one timezone.
- **Design consequence:** Do NOT use it in v1. Keep the UTC hourly due-check design (VC-CRON-MONDAY-DUE), and mention `schedules` in `DECISIONS.md` as a future option.
- **Open risk:** Beta status, plan availability, limits and auth semantics are undocumented here; re-check only if it is ever adopted.
- **Sources:**
  - https://github.com/vercel/vercel/blob/main/packages/cli/src/util/validate-config.ts — official SDK source (Vercel CLI source) — "// Mirrors the server-side Build Output API `schedules` schema.\nconst schedulesSchema = { type: 'array', minItems: 0, maxItems: 100, items: { ... required: ['expression', 'target', 'name'] ... jitter ... } } ; vercel@62.1.0 dist: scheduleTimezoneSchema={type:"string",minLength:1,maxLength:50,description:"IANA timezone for cron evaluation. Defaults to UTC."},scheduleJitterSchema={type:"integer",minimum:1,maximum:15}"
  - https://www.npmjs.com/package/@vercel/config — official SDK source (npm package types) — "@vercel/config@0.7.2 dist/types.d.ts: "An array of schedules that should be created" schedules?: Schedule[]; interface Schedule { expression: { cron: string; jitter?: number; }; ... /** IANA timezone for cron evaluation. Defaults to UTC. */ timezone?: string; } ... type: 'schedule/v1beta'"
  - https://www.npmjs.com/package/vercel — official SDK source (npm package dist) — "vercel@62.1.0 dist: schedulesCommand={name:"schedules",aliases:[],description:"Manage schedules for the current project",arguments:[],subcommands:[listSubcommand18,getSubcommand2,createSubcommand6,updateSubcommand9,enableSubcommand3,disableSubcommand3,invokeSubcommand,deleteSubcommand2,executionsSubcommand],...}"

#### V3 — QStash maximum retries per plan is not published in the docs
- **Brief:** not addressed (§5.6 job retries).
- **Verdict:** Not officially documented — low confidence for the per-plan cap. The default of 3 retries is official (high confidence).
- **Finding:**
  - The per-plan maximum is not published in the docs repo. `qstash/overall/pricing.mdx` only redirects to https://upstash.com/pricing/qstash, which is blocked.
  - The only machine-readable hint is the Developer API `QStashUser` example with `max_retries: 999`. It sits in an object labelled `type: free` that also has `max_requests_per_day` 1000. That example is not a plan table.
  - The documented default is 3 retries ("If it is not provided, the default of 3 retries is used"), giving 4 deliveries over about 33 minutes.
- **Design consequence:** Publishing with `retries: 3` (or omitting it) is safe on every plan.
- **Open risk:** Re-check the cap on the pricing page at WIRE_UP only if more retries are wanted.
- **Sources:**
  - https://github.com/upstash/docs/blob/main/devops/developer-api/openapi.yaml — official OpenAPI spec — "max_retries: type: integer description: Maximum number of retry attempts for failed messages example: 999"
  - https://github.com/upstash/docs/blob/main/qstash/openapi.yaml — official OpenAPI spec — "Upstash-Retries: "The total number of deliveries is 1 (initial attempt) + retries. If it is not provided, the default of 3 retries is used.""

### 07.y Test vectors

Upstash publishes no test vectors with expected results. Its docs show one example token, but that token's `nbf` = `iat` is outdated, and it is not reproduced here. **Every vector below was generated locally:**
- The JWTs were signed with `jose` 5.10 `SignJWT` (HS256) and verified with the official `@upstash/qstash@2.12.0` `Receiver` (`devMode: false`, clock pinned).
- The verifier recomputed both JWTs independently with `node:crypto` HMAC-SHA256 and got byte-identical results.
- The wire vectors were captured from SDK 2.12.0 with `fetch` stubbed.

**Caveat on `nbf`:** the research vectors use `nbf` = `iat` (1790000000). Real QStash tokens carry `nbf: 0` (September 2024 changelog), so the "nbf-30 → SignatureError" case tests a condition real tokens never produce. Vector (5) in the verifier block is the production-shaped token: `nbf: 0` and a `=`-padded `body` claim.

**Clock pinning:** use `vi.useFakeTimers()` + `vi.setSystemTime()`. Stubbing only `Date.now` is ignored by jose.

Both blocks below are copied verbatim from the research and verification records.

**Research vectors (generated locally with the official SDK):**

```text
QStash signature. Generated locally with jose 5.10 SignJWT (HS256) and verified with the official @upstash/qstash@2.12.0 Receiver, devMode:false, clock pinned.
currentSigningKey = "sig_testCurrentKey000000000000"
nextSigningKey    = "sig_testNextKey000000000000000"
url (sub)         = "https://autopilot.hublytix.ai/api/jobs/follow-up"
body (raw)        = {"leadId":"123","n":1}
sha256(body) hex  = a8d54fe82430b289d315200b2b4ba1e810f5c2548c0a29efa678dac42aeba041
body claim (base64url, unpadded) = qNVP6CQwsonTFSALK0uh6BD1wlSMCinvpnjaxCrroEE
payload = {"iss":"Upstash","sub":"https://autopilot.hublytix.ai/api/jobs/follow-up","exp":1790000300,"nbf":1790000000,"iat":1790000000,"jti":"jwt_testvector0001","body":"qNVP6CQwsonTFSALK0uh6BD1wlSMCinvpnjaxCrroEE"}
header  = {"alg":"HS256","typ":"JWT"}
JWT signed with CURRENT key = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJVcHN0YXNoIiwic3ViIjoiaHR0cHM6Ly9hdXRvcGlsb3QuaHVibHl0aXguYWkvYXBpL2pvYnMvZm9sbG93LXVwIiwiZXhwIjoxNzkwMDAwMzAwLCJuYmYiOjE3OTAwMDAwMDAsImlhdCI6MTc5MDAwMDAwMCwianRpIjoiand0X3Rlc3R2ZWN0b3IwMDAxIiwiYm9keSI6InFOVlA2Q1F3c29uVEZTQUxLMHVoNkJEMXdsU01DaW52cG5qYXhDcnJvRUUifQ.R-nyopTzF0Ee6ViDcsy-1RFjox__Jyrw96reksOrRHs
JWT signed with NEXT key    = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJVcHN0YXNoIiwic3ViIjoiaHR0cHM6Ly9hdXRvcGlsb3QuaHVibHl0aXguYWkvYXBpL2pvYnMvZm9sbG93LXVwIiwiZXhwIjoxNzkwMDAwMzAwLCJuYmYiOjE3OTAwMDAwMDAsImlhdCI6MTc5MDAwMDAwMCwianRpIjoiand0X3Rlc3R2ZWN0b3IwMDAxIiwiYm9keSI6InFOVlA2Q1F3c29uVEZTQUxLMHVoNkJEMXdsU01DaW52cG5qYXhDcnJvRUUifQ.v1AJuv88aNRvtemd74DjpqCIcxoIG5j9GmkWLmguke0

Expected results (system time pinned; Receiver({currentSigningKey, nextSigningKey, devMode:false})):
- t=1790000010, current-key JWT, exact body and url -> true
- t=1790000010, next-key JWT -> true
- JWT signed with any other key -> SignatureError "signature verification failed"
- body {"leadId":"124","n":1} -> SignatureError "body hash does not match, want: qNVP6CQwsonTFSALK0uh6BD1wlSMCinvpnjaxCrroEE, got: cnUKdahbiypr10PS3d6LTCklsvyCDrAEHoJw5ET4Qrg"
- body {"leadId": "123", "n": 1} (re-serialised) -> SignatureError, body hash mismatch (got xjB-huiSJYdfRfKR_msKabFvm2m7Bi12yPxw2ZIAAms)
- url + "?x=1" -> SignatureError "invalid subject: https://autopilot.hublytix.ai/api/jobs/follow-up, want: https://autopilot.hublytix.ai/api/jobs/follow-up?x=1"
- url omitted -> true (sub not checked)
- t=1790000301 (exp+1) -> SignatureError. The message reads "signature verification failed" because the next-key fallback error masks the exp error.
- t=1790000301 with clockTolerance 5 -> true
- t=1789999970 (nbf-30) -> SignatureError

Security vector: with env QSTASH_DEV=true and NODE_ENV=production, a JWT signed with the public dev key "sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r" is ACCEPTED by Receiver({currentSigningKey:'sig_realProdCurrent', nextSigningKey:'sig_realProdNext'}). It is REJECTED when devMode:false is passed.

Wire vector (SDK 2.12.0, fetch stubbed):
publishJSON({url:'https://autopilot.hublytix.ai/api/jobs/follow-up', body:{leadId:'123',n:1}, notBefore:1790432000, deduplicationId:'lead:123:fu:1', retries:3, label:'portal-42', failureCallback:'https://autopilot.hublytix.ai/api/jobs/failed'})
-> POST https://qstash.upstash.io/v2/publish/https://autopilot.hublytix.ai/api/jobs/follow-up
   headers: upstash-not-before: 1790432000, upstash-deduplication-id: lead:123:fu:1, upstash-retries: 3, upstash-label: portal-42, upstash-method: POST, content-type: application/json
messages.cancel('msg_fake123') -> DELETE https://qstash.upstash.io/v2/messages/msg_fake123
```

**Verifier recheck (re-executed locally; includes two new vectors):**

```text
ALL REPRODUCED.

(1) vector.mjs re-run with @upstash/qstash 2.12.0 and jose 5.10.0. Every listed outcome matches exactly:
- current/next key -> true;
- other key -> 'signature verification failed';
- body {"leadId":"124","n":1} -> 'body hash does not match, want: qNVP6CQwsonTFSALK0uh6BD1wlSMCinvpnjaxCrroEE, got: cnUKdahbiypr10PS3d6LTCklsvyCDrAEHoJw5ET4Qrg';
- spaced body -> got xjB-huiSJYdfRfKR_msKabFvm2m7Bi12yPxw2ZIAAms;
- url+'?x=1' -> 'invalid subject: ... want: ...?x=1';
- url omitted -> true;
- exp+1 -> 'signature verification failed';
- exp+1 with clockTolerance 5 -> true;
- nbf-30 -> rejected.

(2) Independent recomputation without jose (verify-qstash/recompute.mjs, node:crypto HMAC-SHA256 keyed with the UTF-8 key string). Both JWTs are byte-identical to the finding's:
- current key -> ...R-nyopTzF0Ee6ViDcsy-1RFjox__Jyrw96reksOrRHs;
- next key -> ...v1AJuv88aNRvtemd74DjpqCIcxoIG5j9GmkWLmguke0;
- sha256 hex a8d54fe8...aeba041 and base64url qNVP6CQwsonTFSALK0uh6BD1wlSMCinvpnjaxCrroEE match.

(3) wire.mjs re-run. The captured POST and DELETE requests match byte-for-byte; cancel threw QstashError status=404.

(4) devmode.mjs re-run with NODE_ENV=production QSTASH_DEV=true. The forged dev-key JWT is ACCEPTED with devMode undefined and rejected with devMode:false.

NEW vectors from this review:
(5) nbf0.mjs: a production-shaped token (nbf:0 per the QStash Sept-2024 changelog; body claim WITH '=' padding).
- JWT = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJVcHN0YXNoIiwic3ViIjoiaHR0cHM6Ly9hdXRvcGlsb3QuaHVibHl0aXguYWkvYXBpL2pvYnMvZm9sbG93LXVwIiwiZXhwIjoxNzkwMDAwMzAwLCJuYmYiOjAsImlhdCI6MTc5MDAwMDAwMCwianRpIjoiand0X3Rlc3R2ZWN0b3IwMDAyIiwiYm9keSI6InFOVlA2Q1F3c29uVEZTQUxLMHVoNkJEMXdsU01DaW52cG5qYXhDcnJvRUU9In0.A2lZR6hO_KOQfCB5FWTsKobjFxFXmiGQQe9Rh9jDp3Q
- Results: t=1789999000 -> true; t=1790000010 -> true; t=1790000301 -> SignatureError.
- Clock pinning must mock the Date constructor (vi.useFakeTimers + vi.setSystemTime); stubbing only Date.now is ignored by jose.

(6) cancel-hazard.mjs:
- cancel({filter:{label:undefined}}) -> 'DELETE https://qstash.upstash.io/v2/messages?count=100'. Per the OpenAPI, this cancels ALL messages.
- cancel([]) -> no request.
- cancel('') and cancel({messageIds:[]}) -> throw.

Scripts: scratchpad/verify-qstash/{recompute,nbf0,cancel-hazard}.mjs. They are run from scratchpad/npm/qstash-exp for module resolution. Review saved to scratchpad/research/qstash-cron.verify.json.
```

**How to use them in Vitest:**
- Turn the research block's expected results and vectors (5) and (6) into unit tests for `verifyQStash` and `Scheduler.cancel`.
- Add the security vector as a regression test with `devMode: false`. It must reject the dev-key JWT even when `QSTASH_DEV=true`.
- Treat the wire vector as the contract for the live `Scheduler.schedule`. The raw `wire.mjs` capture cited under QS-PUBLISH-WIRE also shows `upstash-delay: 2d`; the QS-DELAY-HEADERS capture set both `notBefore` and `delay: '2d'`. Production code sends `notBefore` only (QS-DELAY-HEADERS).
