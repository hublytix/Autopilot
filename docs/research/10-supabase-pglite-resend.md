## 10. Supabase, PGlite, Resend and React Email

The official sources support the stack the brief picks for this area: Supabase Postgres with SQL migrations, RLS on every table, Supabase Auth magic links, Resend with React Email, and PGlite for database tests that need no Docker or credentials. A local build of Next.js 14.2.35 on Node 22 ran all of them together (10.1 V3). supabase.com, pglite.dev and resend.com were blocked in the sandbox, and the web-search budget was spent, so no search snippets were used. Instead, Supabase pages were read from the official docs source in the `supabase/supabase` repo (commit `be976bec`, 2026-10-01), PGlite from the `electric-sql/pglite` docs source plus the npm package 0.5.8 and local experiments, React Email from the `resend/react-email` docs source (commit `15419ff1`, 2026-09-23), and Resend from Resend's official GitHub repos (`resend-openapi`, `resend-node`, `resend-cli`, `resend-skills`, `resend-migration-skill` and two SMTP example repos). No brief [VERIFY] marker sits in this area, so this section resolves none directly; it checks the unmarked claims in §3 Stack, §6 RLS, §10 WIRE_UP steps 2 and 5 and the §12 RLS migration test, and the sources correct the brief in four places and extend it in many more.

**The sources correct the brief in four places:**
1. **§3 "Service-role key used only on the server":** the naming is legacy. Supabase is deprecating the JWT-based `anon` and `service_role` keys "by the end of 2026". Use the secret key `sb_secret_...` (env `SUPABASE_SECRET_KEY`, server only) and the publishable key `sb_publishable_...` (env `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) (SB-KEYS-MODEL).
2. **§3/§6 "RLS enabled on every table" is required but no longer enough:** Supabase projects created after 2026-05-30 do not auto-grant new `public` tables to `anon`, `authenticated` or `service_role`. Every migration must GRANT privileges to `service_role` explicitly, or the server gets `42501 permission denied` even with the secret key. The secret key also bypasses RLS only when the request carries no user access token (SB-DATA-API-GRANTS-2026, SB-ADMIN-CLIENT).
3. **§3 magic-link login and the §10 WIRE_UP order:** the brief assumes Supabase can send the login email. Supabase's built-in SMTP sends only to members of the project's organization team, at 2 emails per hour, so no real owner can log in until custom SMTP through Resend is configured (or the app sends the link itself, 10.1 V1). Supabase SMTP setup therefore depends on step 5 (Resend domain verification), even though the brief puts Supabase at step 2 (SB-AUTH-EMAIL-LIMITS, SB-SMTP-RESEND).
4. **§5.5 one-tap action links:** email security scanners (for example Microsoft Defender Safe Links) prefetch links in emails. A GET to `/a/{token}/dismiss` must not dismiss the lead; it must show a confirm button and dismiss on POST. A GET to `/a/{token}/send` can be a scanner, not the owner, so it is not a reliable "send clicked" signal (SB-EMAIL-PREFETCH).

**The sources extend the brief with:**
- **Runtime and versions:** `@supabase/supabase-js` 2.117.2 needs Node `>=22.0.0`; `@supabase/ssr` 0.12.7 always uses PKCE and passes cache headers to `setAll`. Pin exact versions and Node 22 on Vercel and in CI (SB-SDK-VERSIONS-NODE22).
- **Two Supabase client factories:** a cookie-based user client (publishable key) and a session-less admin client (secret key) (SB-ADMIN-CLIENT).
- **Magic-link flow:** the token-hash link plus `verifyOtp` works across devices; the default PKCE link works only on the same device and within 5 minutes. Both the "Confirm signup" and "Magic link" templates must change, because new users get "Confirm signup". Site URL and redirect allow-list settings are needed. `/login` must give a neutral response for unknown emails (`otp_disabled`, 422) (SB-MAGICLINK-FLOW, SB-MAGICLINK-TEMPLATES-NEWUSER, SB-URL-CONFIG, 10.1 V2).
- **An alternative login path:** `auth.admin.generateLink` lets the app send the login email through its own Resend `Mailer`, avoiding Supabase SMTP and template edits (10.1 V1).
- **Next.js 14 middleware:** the official Supabase example is `proxy.ts` (Next 16); Next 14 needs `src/middleware.ts` with the `getClaims()` pattern (SB-SSR-MIDDLEWARE-NEXT14).
- **RLS patterns and the migration test:** default-deny, server-only tables with no policies, the `(select auth.uid())` policy form, and a PGlite test that asserts RLS and grants on every table (SB-RLS-NOT-DEFAULT, SB-RLS-PATTERNS, PG-ROLES-RLS, PG-SUPABASE-SHIM).
- **Migration workflow:** the Supabase CLI path for WIRE_UP step 2, and the SQL-editor fallback (SB-MIGRATIONS-WORKFLOW).
- **A PLAN decision on the data-access layer:** PGlite cannot run supabase-js `.from()` code (there is no PostgREST), so choose SQL repositories (with a documented Postgres.js pipelining hazard on the transaction pooler) or supabase-js with fake repositories (SB-DB-ACCESS-LAYER).
- **PGlite specifics:** 0.5.8 embeds PostgreSQL 18.3 while hosted Supabase runs 15 or 17; contrib extensions must be loaded at startup; the instance has one exclusive connection and takes about 3 s to start (PG-VERSION-EXTENSIONS, PG-VITEST-USAGE).
- **Resend:** the SDK returns `{ data, error }` and never throws on API errors; the `react` option renders HTML only, so pass `text` yourself; `Idempotency-Key` semantics; a default rate limit of 2 requests per second; batch sending; test addresses (RS-SEND-API, RS-IDEMPOTENCY-LIMITS).
- **React Email 6:** a single `react-email` package that works with React 18; `render()` is async; `toPlainText()` gives the text part (RS-REACT-EMAIL).
- **WIRE_UP step 5 DNS:** concrete MX, SPF and DKIM records for `autopilot.hublytix.ai`, an immutable region, DMARC, and open/click tracking off (RS-DOMAIN-DNS).

**Still open:** the Resend facts come from Resend's official GitHub repos, not resend.com pages. The grants-change timeline was read from a WebFetch rendering of Supabase's GitHub announcement (the docs source independently says the default is changing). Supabase says its Auth email limits "can change without notice". Several Auth behaviours (which template a new user gets, `generateLink` sending nothing, `otp_disabled`) are derived from the Auth server source on `master`. All of these must be re-checked live during WIRE_UP.

### SB-KEYS-MODEL — Use the publishable and secret keys, not the legacy "service-role key"
- **Brief:** §3 "Service-role key used only on the server" (legacy naming); §7 "No secrets in client bundles"; §10 WIRE_UP steps 2 and 3.
- **Verdict:** Corrected — high confidence. The verifier corrected one overstatement in the original research: supabase-js does still send new-format keys as a Bearer token in some cases (see below).
- **Finding:**
  - **Deprecation:** Supabase is deprecating the legacy JWT-based `anon` and `service_role` keys "by the end of 2026" (no exact day is published).
  - **Publishable key `sb_publishable_...`:** safe in the browser. It resolves to Postgres role `anon`, or `authenticated` when the request carries a signed-in user's JWT.
  - **Secret key `sb_secret_...`:** server only. It resolves to `service_role`, which has `BYPASSRLS`.
  - **Coexistence:** both key systems work at the same time. Creating new keys does not revoke the legacy keys. Legacy keys are deactivated separately in Dashboard > Settings > API Keys, and can be re-activated (the step is reversible).
  - **Not JWTs:** the new keys are not JWTs. When calling Supabase APIs by hand (fetch, `pg_net`, Database Webhooks, Edge Functions), send them on the `apikey` header only.
  - **What supabase-js does:** supabase-js 2.117.2 always sets `apikey`. It also still sends the key as `Authorization: Bearer <key>` for PostgREST, Storage and Auth requests when there is no user session; only the Edge Functions client omits that. The platform accepts this ("For migration compatibility the `verify_jwt` check also accepts them on `Authorization: Bearer ...`"), so supabase-js users need no code change.
  - **Browser use:** a secret key used from a browser gets HTTP 401 (Supabase matches on the `User-Agent` header).
  - **Official Next.js env names:** `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (browser-safe); server-only `SUPABASE_URL` and `SUPABASE_SECRET_KEY` ("Never prefix these, or your bundler will ship the key").
  - **@supabase/ssr:** `createBrowserClient(url, publishableKey)` and `createServerClient(url, publishableKey, { cookies })`.
  - **Admin client:** `createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } })` from `@supabase/supabase-js`.
  - **Where to find the keys:** the Dashboard "Connect" dialog or Settings > API Keys ("there is no separate Settings > API page"), or `supabase projects api-keys --project-ref <ref>`.
  - **Logging:** never log a key. At most log 6 characters of the random part after the prefix, or store a SHA256 hash.
- **Design consequence:** Rename every "service-role key" reference to "secret key". `.env.example` lists `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (comment: `sb_secret_...`, server only, bypasses RLS). WIRE_UP step 2: Settings > API Keys > "Publishable and secret API keys" tab (click "Create new API keys" if shown); optionally deactivate the legacy keys. Mark the admin module `import 'server-only'`.
- **Open risk:** If an older project with only legacy keys is reused, its `service_role` JWT keeps working until it is deactivated or the end-2026 deprecation; the code is identical (the string passed to `createClient`). During WIRE_UP, confirm the dashboard tab and button labels and that the project shows publishable and secret keys.
- **Sources:**
  - https://supabase.com/docs/guides/getting-started/api-keys — official docs source repo (renders to the public docs URL) — "| Anything you control: server, Edge Function, cron job | Secret key | It bypasses Row Level Security, so it must never leave your control |" ... "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_..." ... "SUPABASE_SECRET_KEY=sb_secret_..." ... "Policies never apply to a secret key, because `service_role` has the `BYPASSRLS` attribute." ... "A secret key doesn't work in a browser. Supabase matches on the `User-Agent` header and returns HTTP 401 Unauthorized."
  - https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys — official docs source repo (renders to the public docs URL) — "Supabase is deprecating the `anon` and `service_role` keys by the end of 2026. Use the publishable (`sb_publishable_xxx`) and secret (`sb_secret_xxx`) keys instead." / "Creating the new keys is safe... Your legacy keys keep working." ... "Send publishable and secret keys on the `apikey` header. For migration compatibility the `verify_jwt` check also accepts them on `Authorization: Bearer ...`" ... "You can re-activate them if you find a client you missed, so this step is reversible."
  - https://github.com/supabase/supabase-js/blob/master/packages/core/supabase-js/src/lib/fetch.ts — official SDK source (npm `@supabase/supabase-js@2.117.2`; the comment states the intent, the code enforces it only for Edge Functions) — "New-format Supabase API keys (`sb_publishable_…` / `sb_secret_…`) are not JWTs and must never be sent as a Bearer token — they belong only in the `apikey` header." ... "const allowKeyAsBearer = !(options?.omitApiKeyAsBearer && isNewApiKey(supabaseKey)) ... if (!headers.has('Authorization')) { const bearer = realToken ?? (allowKeyAsBearer ? supabaseKey : null) ..."
  - https://github.com/supabase/supabase-js/blob/master/packages/core/supabase-js/src/SupabaseClient.ts — official SDK source — "// Edge Functions use a dedicated fetch that never falls back to a new-format API key in the Authorization header ... this.functionsFetch = fetchWithAuth(..., { omitApiKeyAsBearer: true }) ; _initSupabaseAuthClient: const authHeaders = { Authorization: `Bearer ${this.supabaseKey}`, apikey: `${this.supabaseKey}` }"
  - https://github.com/supabase/supabase/blob/master/examples/auth/nextjs/lib/supabase/server.ts — official docs source repo (Supabase's Next.js example used by the docs) — "createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll() {...}, setAll(cookiesToSet, _headers) {...} } })"

### SB-SDK-VERSIONS-NODE22 — Current Supabase SDK versions need Node 22
- **Brief:** Not addressed (§3 Stack: Next.js 14, Supabase).
- **Verdict:** Extended — high confidence
- **Finding:** As of 2026-10-01:
  - **`@supabase/ssr`:** latest is 0.12.7 (2026-09-08), with peerDependencies `{ '@supabase/supabase-js': '^2.114.0' }` and dependency `cookie` `^1.0.2`.
  - **`@supabase/supabase-js`:** latest is 2.117.2, with engines `{ node: '>=22.0.0' }`. The `>=22` requirement started between 2.105.0 (`>=20`) and 2.110.0.
  - **`createServerClient` hard-codes** `flowType 'pkce'`, `autoRefreshToken false` and `persistSession true`; these cannot be overridden.
  - **Cache headers:** since 0.10.0, `setAll(cookiesToSet, headers)` receives cache headers (`Cache-Control`, `Expires`, `Pragma`), and they must be applied to the response. For a server client the cache headers are delivered only with the first cookie write, so a new server client must be created for each request.
  - **Next.js:** `next@14.2.35` declares engines `{ node: '>=18.17.0' }`, so Next 14.2 runs on Node 22.
- **Design consequence:** Pin `engines` `node >=22` in `package.json`, set the Vercel Node.js version to 22.x (or 24.x) and use Node 22 in CI. Pin exact versions (`@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.117.2) and create a fresh Supabase server client per request.
- **Open risk:** Next 14 middleware runs only on the Edge runtime, and supabase-js might emit Edge warnings about Node APIs. The research did not verify this; the verifier's local `next build` showed no Edge-runtime warnings (10.1 V3). Keep middleware minimal, and check the first Vercel build log during WIRE_UP.
- **Sources:**
  - https://www.npmjs.com/package/@supabase/supabase-js — local experiment — "`npm view @supabase/supabase-js version engines` -> 2.117.2, { node: '>=22.0.0' }; @2.105.0 engines -> { node: '>=20.0.0' }; @2.110.0 -> { node: '>=22.0.0' }; `npm view @supabase/ssr version peerDependencies` -> 0.12.7, { '@supabase/supabase-js': '^2.114.0' }"
  - https://github.com/supabase/ssr/blob/main/src/createServerClient.ts — official SDK source (npm `@supabase/ssr@0.12.7`) — "auth: { ...options?.auth, flowType: "pkce", autoRefreshToken: false, detectSessionInUrl: false, persistSession: true, skipAutoInitialize: true, storage, ... }"
  - https://github.com/supabase/ssr/blob/main/CHANGELOG.md — official SDK source — "## [0.10.0] ... pass cache headers to setAll to prevent CDN caching of auth responses" ; "## [0.12.7] (2026-09-08)"
  - https://github.com/supabase/ssr/blob/main/src/types.ts — official SDK source — "For a server client, the cache headers are delivered only with the first cookie write. A new server client must be created for each request; reusing one across requests would leave later responses without the required cache headers."
  - https://github.com/vercel/next.js/blob/v14.2.35/docs/02-app/02-api-reference/02-file-conventions/middleware.mdx — official docs source repo (renders to the public docs URL) — "Middleware only supports the [Edge runtime](/docs/app/building-your-application/rendering/edge-and-nodejs-runtimes). The Node.js runtime cannot be used."
  - https://www.npmjs.com/package/next/v/14.2.35 — local experiment — "`npm view next@14.2.35 engines` -> { node: '>=18.17.0' }"
  - https://github.com/vercel/next.js/tree/v14.2.35 — local experiment — "npm i next@14.2.35 react@18.3.1 react-dom@18.3.1 react-email@6.11.0 @supabase/ssr@0.12.7 @supabase/supabase-js@2.117.2 resend@6.31.0 on Node v22.22.0 ... `next build` -> ' ✓ Compiled successfully', 'ƒ Middleware 87 kB', no Edge-runtime warnings."

### SB-ADMIN-CLIENT — The secret key bypasses RLS only without a user token, and only after grants
- **Brief:** §3 "Service-role key used only on the server"; §6 RLS. The brief implies the server key bypasses RLS.
- **Verdict:** Extended — high confidence
- **Finding:**
  - **When RLS is bypassed:** secret-key requests run as `service_role` (`BYPASSRLS`) ONLY when no user access token is attached: "A secret key bypasses RLS only when the request carries no user access token. If the request carries one, it runs under the RLS policies of that signed-in user, even when the client library was initialized with a secret key."
  - **Grants come first:** a missing GRANT returns a permission error (`42501`) even for `service_role`.
  - **How to build the admin client:** plain `createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })`. Never build it through `createServerClient` with request cookies.
- **Design consequence:** Two factories: `createUserClient()` (`@supabase/ssr`, publishable key, cookies) for auth and session; `createAdminClient()` (supabase-js, secret key, no session) for jobs, webhooks, cron and dashboard data after authorization. The admin module imports `'server-only'`.
- **Open risk:** None significant.
- **Sources:**
  - https://supabase.com/docs/guides/database/postgres/row-level-security#bypassing-row-level-security — official docs source repo (renders to the public docs URL) — "A secret key bypasses RLS only when the request carries no user access token. If the request carries one, it runs under the RLS policies of that signed-in user, even when the client library was initialized with a secret key."
  - https://supabase.com/docs/guides/getting-started/api-keys#postgres-roles-and-row-level-security — official docs source repo (renders to the public docs URL) — "A missing grant returns a permission error, including for `service_role`, whereas a policy that matches no rows returns an empty result."
  - https://github.com/supabase/supabase/blob/master/apps/docs/spec/supabase_js_v2.yml — official docs source repo (renders to the public supabase-js reference) — "id: admin-api ... '- Any method under the `supabase.auth.admin` namespace requires a `secret` key.' ... const supabase = createClient(supabase_url, secret_key, { auth: { autoRefreshToken: false, persistSession: false } })"
  - https://supabase.com/docs/guides/auth/users — official docs source repo (renders to the public docs URL) — "const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false,"

### SB-MAGICLINK-FLOW — Use the token-hash link and `verifyOtp`, not the default PKCE code link
- **Brief:** §3 "Supabase Auth email magic link for dashboard login"; §4 step 2.1 "Owner email and magic-link login". No details.
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Request:** `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo?: string, shouldCreateUser?: boolean /* default true */, data?: object, captchaToken?: string } })`. It sends a magic link by default; the email template decides whether it is a link or a `{{ .Token }}` code.
  - **PKCE is always on:** `@supabase/ssr` clients always use PKCE. With PKCE, the default `{{ .ConfirmationURL }}` redirects with `?code=...`, which must be exchanged via `exchangeCodeForSession(code)` within 5 minutes and on the SAME browser and device that started the flow (it needs the verifier cookie). That is fragile for owners who request the link on a desktop and open it on a phone.
  - **The documented SSR approach is the token-hash flow:**
    - Email template: `<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Sign in</a>`. Use `{{ .RedirectTo }}` instead of `{{ .SiteURL }}` when passing `emailRedirectTo`.
    - In `app/auth/confirm/route.ts`, call `supabase.auth.verifyOtp({ type, token_hash })` with the cookie-based server client, then redirect (on error, to an error page).
    - `verifyOtp` with `token_hash` needs no code verifier, so it works across devices.
  - **`EmailOtpType`:** `'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email'`.
  - **Defaults:** one magic-link request per user per 60 s; links are valid for 1 hour (governed by the Email OTP expiration setting; more than 86400 s is strongly discouraged).
- **Design consequence:** Use `token_hash` + `verifyOtp`, not `exchangeCodeForSession`. The `/login` server action calls `signInWithOtp` with `shouldCreateUser: false` (only owners created at install or onboarding may log in); use `shouldCreateUser: true` only in the onboarding step that sets the owner email. Validate that `next` is a same-origin relative path. Rate-limit `/login` (brief §7). Put the `verifyOtp` call behind a click-to-confirm POST (SB-EMAIL-PREFETCH).
- **Open risk:** Template edits are manual Dashboard steps (or Management API `PATCH /v1/projects/{ref}/config/auth` with `mailer_templates_magic_link_content` / `mailer_templates_confirmation_content`), so they must be in WIRE_UP. 10.1 V1 describes a path that avoids them.
- **Sources:**
  - https://supabase.com/docs/guides/auth/auth-email-passwordless — official docs source repo (renders to the public docs URL) — "If you're using PKCE flow, edit the Magic Link email template to send a token hash: ... <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Sign in</a> ... At the `/auth/confirm` endpoint, exchange the hash for the session: ... supabase.auth.verifyOtp({ token_hash: 'hash', type: 'email' })"
  - https://supabase.com/docs/guides/auth/auth-email-passwordless — official docs source repo (renders to the public docs URL; values from the docs' `packages/shared-data/config.ts`) — "magic_link.period value 60 unit 'seconds', magic_link.validity value 1 unit 'hour'; doc: 'An expiry duration of more than 86,400 seconds (one day) is strongly discouraged'"
  - https://supabase.com/docs/guides/auth/sessions/pkce-flow — official docs source repo (renders to the public docs URL) — "the code has a validity of 5 minutes and can only be exchanged for an access token once" ... "the code exchange must be initiated on the same browser and device where the flow was started."
  - https://supabase.com/docs/guides/auth/passwords — official docs source repo (renders to the public docs URL) — "Next.js `app/auth/confirm/route.ts`: const token_hash = searchParams.get('token_hash'); const type = searchParams.get('type') as EmailOtpType | null; ... const { error } = await supabase.auth.verifyOtp({ type, token_hash }); if (!error) { redirect(next) } ... redirect('/auth/auth-code-error')"
  - https://github.com/supabase/auth-js/blob/master/src/lib/types.ts — official SDK source (npm `@supabase/auth-js@2.117.2`) — "SignInWithPasswordlessCredentials options: emailRedirectTo?: string; shouldCreateUser?: boolean ('Defaults to true'); data?: object; captchaToken?: string. EmailOtpType = 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email'"
  - https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/src/lib/types.ts — official SDK source — "/** The redirect url embedded in the email link */ emailRedirectTo?: string /** If set to false, this method will not create a new user. Defaults to true. */ shouldCreateUser?: boolean"
  - https://github.com/supabase/auth/blob/master/internal/api/mail.go — official SDK source (Supabase Auth server source) — "token := crypto.GenerateTokenHash(u.GetEmail(), otp) u.RecoveryToken = addFlowPrefixToToken(token, flowType) ... tokenHashWithPrefix: u.RecoveryToken,"
  - https://github.com/supabase/auth/blob/master/internal/api/otp.go — official SDK source (Supabase Auth server source) — "if ok, err := a.shouldCreateUser(r, params); !ok { return apierrors.NewUnprocessableEntityError(apierrors.ErrorCodeOTPDisabled, "Signups not allowed for otp")"

### SB-MAGICLINK-TEMPLATES-NEWUSER — A new email gets the "Confirm signup" template, so edit both templates
- **Brief:** Not addressed (§4 step 2.1 "Owner email and magic-link login").
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Which email is sent:** for an email that doesn't exist yet (or is unconfirmed), with email confirmations on (the default), Supabase Auth's `/otp` handler signs the user up and sends the "Confirm signup" email (the source comment: "otherwise confirmation email already contains magic link"), not the "Magic link" template. Only confirmed users get the Magic Link template.
  - **Consequence:** BOTH the "Confirm signup" and the "Magic link or OTP" templates must be changed to the token-hash link. `type=email` works for both; Supabase quickstarts put `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email` into Confirm signup.
- **Design consequence:** WIRE_UP step 2: Authentication > Emails > Templates; edit "Confirm signup" AND "Magic link" to `<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Sign in to Hublytix Autopilot</a>`. Keep the auth templates plain (few links, no marketing).
- **Open risk:** Derived from the Auth server source on `master`, not from a single docs sentence; low risk. During WIRE_UP, sign in once with a brand-new address and confirm the email uses the edited template and signs in.
- **Sources:**
  - https://github.com/supabase/auth/blob/master/internal/api/magic_link.go — official SDK source (Supabase Auth server source) — "if user != nil { isNewUser = !user.IsConfirmed() } if isNewUser { // User either doesn't exist or hasn't completed the signup process. ... if config.Mailer.Autoconfirm { ... return a.MagicLink(w, r) } // otherwise confirmation email already contains 'magic link' if err := a.Signup(fakeResponse, r); ..."
  - https://supabase.com/docs/guides/auth/quickstarts/astrojs — official docs source repo (renders to the public docs URL) — "Select the **Confirm signup** template - Change `{{ .ConfirmationURL }}` to `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email`."
  - https://github.com/supabase/auth/blob/master/internal/api/verify.go — official SDK source (Supabase Auth server source) — "case mail.EmailOTPVerification: // need to find user by confirmation token or recovery token with the token hash user, err = models.FindUserByOneTimeToken(conn, params.TokenHash, models.ConfirmationToken, models.RecoveryToken)"
  - https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/src/lib/types.ts — official SDK source — "AdminUserAttributes: ... * Only a service role can modify. */ email_confirm?: boolean"

### SB-EMAIL-PREFETCH — Email scanners consume one-time links; confirm with a button and POST
- **Brief:** Not addressed. It affects §3 magic links and the §5.5 action links `/a/{token}/send` and `/a/{token}/dismiss`.
- **Verdict:** Extended — high confidence
- **Finding:**
  - **The problem:** Supabase documents that providers such as Microsoft Defender Safe Links prefetch links, so `{{ .ConfirmationURL }}` "will be consumed instantly which leads to a "Token has expired or is invalid" error".
  - **Documented mitigations:** (1) send an OTP code `{{ .Token }}`, verified with `verifyOtp({ email, token, type: 'email' })`; or (2) link to your own page where the user must click a button. Supabase troubleshooting recommends an intermediary page with a user-initiated button, because link scanners "pre-click" links.
- **Design consequence:**
  - (a) `/auth/confirm`: GET renders a "Sign in" button; a POST (server action) calls `verifyOtp`. GET never consumes the token.
  - (b) The same risk applies to Autopilot's own owner-email links. GET `/a/{token}/dismiss` must NOT dismiss: show a confirm button, and dismiss on POST, or corporate scanners will auto-dismiss leads. GET `/a/{token}/send` will be hit by scanners, so a "send clicked" recorded on GET may be a false positive: record on user action or flag bot-like hits, and never count clicks as confirmed sends (product law 3).
  - (c) Disable Resend click tracking so links aren't rewritten.
- **Open risk:** Scanner behaviour varies. The heuristics for `/send` are a design choice, not vendor-documented.
- **Sources:**
  - https://supabase.com/docs/guides/auth/auth-email-templates#email-prefetching — official docs source repo (renders to the public docs URL) — "Certain email providers may have spam detection or other security features that prefetch URL links from incoming emails (e.g. Safe Links in Microsoft Defender for Office 365). In this scenario, the `{{ .ConfirmationURL }}` sent will be consumed instantly which leads to a "Token has expired or is invalid" error."
  - https://supabase.com/docs/guides/troubleshooting/pkce-flow-errors-cannot-parse-response-or-zgotmplz-in-magic-link-emails-433665 — official docs source repo (renders to the public docs URL) — "Many email providers and security tools automatically scan or "pre-click" links in emails ... this automated scanning can inadvertently consume the authentication token before the legitimate user even clicks the link." ... "Add a User-Initiated Button"

### SB-SSR-MIDDLEWARE-NEXT14 — Session refresh in Next.js 14 needs `src/middleware.ts`, not `proxy.ts`
- **Brief:** Not addressed (§3 Next.js 14 App Router; §7 auth routes).
- **Verdict:** Extended — high confidence
- **Finding:**
  - **File name:** the official example is named `proxy.ts` (Next 16). On Next.js 15 and earlier it must be `middleware.ts` exporting `export async function middleware(request)`; with a `src/` directory, Next 14 requires `src/middleware.ts`.
  - **Pattern:**
    ```ts
    let supabaseResponse = NextResponse.next({ request })
    createServerClient(url, publishableKey, { cookies: {
      getAll() { return request.cookies.getAll() },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({name,value}) => request.cookies.set(name,value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({name,value,options}) => supabaseResponse.cookies.set(name,value,options));
        Object.entries(headers).forEach(([k,v]) => supabaseResponse.headers.set(k,v))
      } } })
    ```
    Immediately `await supabase.auth.getClaims()` (no code in between); redirect unauthenticated users except on `/login` and `/auth/*`; `return supabaseResponse` (or copy its cookies and cache headers to any new response).
  - **Elsewhere:** Server Components, Server Actions and Route Handlers use `createServerClient` with `cookies()` from `next/headers` and a try/catch around `setAll`.
  - **Trust:** never trust `getSession()` on the server. Use `getClaims()` (local JWT verification with asymmetric signing keys, the default for new projects) or `getUser()`.
  - **Cookie name:** `sb-<project_ref>-auth-token`.
  - **Matcher:** excludes `_next/static`, `_next/image`, `favicon.ico` and image files.
- **Design consequence:** Create `src/middleware.ts` (not `proxy.ts`) and `src/lib/supabase/{client,server,middleware}.ts`. Exclude `/api/hubspot/webhooks`, `/api/razorpay/webhook`, the QStash callbacks, `/api/cron/*` and `/a/*` from the auth redirect, because they are authenticated by token or signature. In Next 14 `cookies()` is synchronous; `await cookies()` is harmless.
- **Open risk:** Possible Edge-runtime warnings (see SB-SDK-VERSIONS-NODE22); none appeared in the local Next 14.2.35 build.
- **Sources:**
  - https://supabase.com/docs/guides/auth/server-side/creating-a-client — official docs source repo (renders to the public docs URL) — "On Next.js 15 and earlier, a `proxy.ts` file is never called, so sessions never refresh and users get signed out. ... Before that, it's `middleware.ts` and the function is `export async function middleware`." ... "_Never_ trust `supabase.auth.getSession()` inside server code such as Proxy." ... "The cookie is named `sb-<project_ref>-auth-token` by default."
  - https://github.com/supabase/supabase/blob/master/examples/auth/nextjs/lib/supabase/proxy.ts — official docs source repo (Supabase's Next.js example used by the docs) — "// Do not run code between createServerClient and // supabase.auth.getClaims()." ... "IMPORTANT: You *must* return the supabaseResponse object as it is." ... "Object.entries(headers).forEach(([key, value]) => supabaseResponse.headers.set(key, value))"
  - https://github.com/supabase/supabase/blob/master/examples/auth/nextjs/lib/supabase/server.ts — official docs source repo (Supabase's Next.js example used by the docs) — "setAll(cookiesToSet, _headers) { try { cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) } catch { // The `setAll` method was called from a Server Component."
  - https://github.com/vercel/next.js/blob/v14.2.35/docs/02-app/02-api-reference/02-file-conventions/middleware.mdx — official docs source repo (renders to the public docs URL) — "Use the file `middleware.ts` (or .js) in the root of your project to define Middleware. For example, at the same level as `app` or `pages`, or inside `src` if applicable."
  - https://github.com/vercel/next.js/tree/v14.2.35 — local experiment — "src/middleware.ts = Supabase updateSession pattern (createServerClient + getAll/setAll(cookiesToSet, headers) + getClaims()) ... `next start`: GET / -> 307 location: /login (middleware, no cookie); GET /auth/confirm (no params) -> 307 location: /auth/error"

### SB-URL-CONFIG — Site URL and redirect allow-list for magic links
- **Brief:** Not addressed (§10 WIRE_UP step 2).
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Where:** Dashboard > Authentication > URL Configuration.
  - **Site URL:** set it to the production app origin. It is the default redirect when no `redirectTo` is given, and it feeds `{{ .SiteURL }}`. Change it from `http://localhost:3000`.
  - **Redirect URLs allow-list:** supports globs (`*` matches non-separator characters, `**` matches anything). For Vercel previews add `https://*-<team-or-account-slug>.vercel.app/**` and `http://localhost:3000/**`; prefer exact paths in production.
  - **Templates:** when passing `emailRedirectTo`, use `{{ .RedirectTo }}` in templates instead of `{{ .SiteURL }}`.
  - **Management API fields:** `site_url`, `uri_allow_list`.
- **Design consequence:** WIRE_UP: Site URL = `APP_URL`; Redirect URLs: `${APP_URL}/auth/confirm`, `http://localhost:3000/**` and the preview glob. One server env `APP_URL` is used to build all links.
- **Open risk:** The brief has not decided the final app domain (`autopilot.hublytix.ai` is only suggested as the sending domain). Fill in the real domain and Vercel team slug during WIRE_UP.
- **Sources:**
  - https://supabase.com/docs/guides/auth/redirect-urls — official docs source repo (renders to the public docs URL) — "The Site URL in URL Configuration defines the **default redirect URL** when no `redirectTo` is specified in the code. Change this from `http://localhost:3000` to your production URL" ... "- `http://localhost:3000/**` - `https://*-<team-or-account-slug>.vercel.app/**`"
  - https://supabase.com/docs/reference/api/v1-update-auth-service-config — official OpenAPI spec (Supabase Management API) — "UpdateAuthConfigBody properties include site_url, uri_allow_list, smtp_admin_email, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_max_frequency, smtp_sender_name, rate_limit_email_sent, mailer_templates_magic_link_content, mailer_templates_confirmation_content, mailer_otp_exp"

### SB-AUTH-EMAIL-LIMITS — Built-in Auth email is not for production; custom SMTP is required
- **Brief:** Not addressed. The brief implicitly assumes Supabase sends the magic links.
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Built-in SMTP is not for production:** it only delivers to members of the project's organization team ("Email address not authorized" otherwise), is limited to 2 emails per hour (which may change without notice), and has no SLA.
  - **After custom SMTP is configured:** Auth sends to all addresses, but starts at 30 messages per hour, adjustable at Authentication > Rate Limits (`rate_limit_email_sent`).
  - **Other defaults:**
    - per user, 60 s between OTP or magic-link requests (`/auth/v1/otp`);
    - per IP, 30 requests per 5 minutes (burst 30) for `/auth/v1/signup`, `/recover`, `/resend`, `/magiclink`, `/otp` and `/user`;
    - `/auth/v1/verify`: 30 per 5 minutes per IP;
    - `/auth/v1/token`: 150 per 5 minutes per IP;
    - HTTP 429 when a limit is exceeded.
  - **Server-side calls share the server's IP** unless you forward the client IP in the `Sb-Forwarded-For` header with a SECRET key and enable IP Address Forwarding (`security_sb_forwarded_for_enabled`).
- **Design consequence:** Custom SMTP (Resend) is mandatory before any real owner can log in. In WIRE_UP, configure Supabase SMTP right after the Resend domain is verified (cross-reference steps 2 and 5) and raise `rate_limit_email_sent` (for example to 100 per hour). Keep app-level rate limiting on `/login`; optionally forward the client IP with `Sb-Forwarded-For`.
- **Open risk:** Supabase says these limits "can change without notice". Re-check Authentication > Rate Limits during WIRE_UP.
- **Sources:**
  - https://supabase.com/docs/guides/auth/auth-smtp — official docs source repo (renders to the public docs URL) — "Unless you configure a custom SMTP server for your project, Supabase Auth will refuse to deliver messages to addresses that are not part of the project's team." ... "Currently this value is set to <SharedData inbuilt_smtp_per_hour> messages per hour." (config value 2) ... "a low rate-limit of 30 messages per hour is imposed."
  - https://supabase.com/docs/guides/auth/rate-limits — official docs source repo (renders to the public docs URL) — "Rate-limit table + packages/shared-data/config.ts: inbuilt_smtp_per_hour 2; sign_in_sign_ups requests_per_five_minutes 30, requests_burst 30; otp.period 60 seconds; verification 30/5min; token_refresh 150/5min. 'set the `Sb-Forwarded-For` header to the end-user IP address and make a request with a secret API key.'"
  - https://supabase.com/docs/guides/auth/rate-limits#ip-address-forwarding — official docs source repo (renders to the public docs URL) — "IP address forwarding must be explicitly enabled for new projects. You can enable this feature in your project under the **IP Address Forwarding** section of your project's rate limit settings" ... "createServerClient('https://<your-project-id>.supabase.co', '<your-secret-key>', // Key should start with sb_secret { global: { headers: { 'sb-forwarded-for': request.headers.get('x-forwarded-for'), } } })"
  - https://github.com/supabase/auth/blob/master/internal/api/mail.go — official SDK source (Supabase Auth server source) — "// since Magic Link is just a recovery with a different template and behaviour ... if err := validateSentWithinFrequencyLimit(u.RecoverySentAt, config.SMTP.MaxFrequency); err != nil {"

### SB-SMTP-RESEND — Supabase custom SMTP values for Resend
- **Brief:** Not addressed (§10 WIRE_UP steps 2 and 5).
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Where:** Supabase Dashboard > Authentication > Emails > SMTP Settings (`/project/_/auth/smtp`); enable custom SMTP.
  - **Sender email:** an address on the Resend-verified domain (for example `login@autopilot.hublytix.ai`).
  - **Sender name:** `PRODUCT_NAME`.
  - **Host:** `smtp.resend.com`.
  - **Port:** 465 (implicit TLS) or 587 (STARTTLS). Resend also accepts 25, 2465 and 2587.
  - **Username:** `resend` (literal).
  - **Password:** a Resend API key (`re_...`); a Sending-access key restricted to the domain is enough.
  - **Management API equivalents:** `smtp_admin_email`, `smtp_sender_name`, `smtp_host`, `smtp_port` (a string), `smtp_user`, `smtp_pass`, plus `rate_limit_email_sent`.
  - **Supabase lists Resend as a supported provider** (https://resend.com/docs/send-with-supabase-smtp). Supabase Studio also has an in-development Resend marketplace integration that sets `SMTP_HOST=smtp.resend.com`.
- **Design consequence:** WIRE_UP: create a dedicated Resend API key `supabase-smtp` (Sending access, domain `autopilot.hublytix.ai`), separate from the app's `RESEND_API_KEY`, so each can be rotated on its own. Don't mix auth and marketing mail; keep email tracking off.
- **Open risk:** The resend.com docs page was unreachable (egress blocked); the values are corroborated by three official Resend repos. During WIRE_UP, check them against https://resend.com/docs/send-with-supabase-smtp and send one test login email.
- **Sources:**
  - https://github.com/resend/resend-nodemailer-smtp-example/blob/main/index.ts — official SDK source (official Resend example repo) — "host: 'smtp.resend.com', secure: true, port: 465, auth: { user: 'resend', pass: 're_123456789' }"
  - https://github.com/resend/resend-migration-skill/blob/main/migrate-sendgrid/references/smtp.md — official docs source repo (Resend's official migration-skill repo on GitHub, read via GitHub code search; not a rendered resend.com page) — "| Host | `smtp.sendgrid.net` | `smtp.resend.com` |" "| Port | 25, 465, 587, or 2525 | 25, 465, 587, 2465, or 2587 |" "| Username | The string `apikey` | The string `resend` |" "| Password | SendGrid API key | Resend API key |"
  - https://github.com/resend/resend-django-smtp-example/blob/main/resend_django_smtp_example/settings.py — official SDK source (official Resend example repo, read via GitHub code search) — "EMAIL_HOST = 'smtp.resend.com' EMAIL_PORT = 587 EMAIL_HOST_USER = 'resend' EMAIL_HOST_PASSWORD = os.environ.get("RESEND_API_KEY") EMAIL_USE_TLS = True"
  - https://supabase.com/docs/guides/auth/auth-smtp — official docs source repo (renders to the public docs URL) — "- [Resend](https://resend.com/docs/send-with-supabase-smtp)" ... "PATCH .../config/auth -d '{ "smtp_admin_email": "no-reply@example.com", "smtp_host": "smtp.example.com", "smtp_port": 587, "smtp_user": "your-smtp-user", "smtp_pass": "your-smtp-password", "smtp_sender_name": "Your App Name" }'"
  - https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/Integrations/Landing/Landing.utils.ts — official SDK source (Supabase Studio source) — "// Special-case logic for in-development integrations if (integration.id === 'resend') { return ( projectData.authConfig?.SMTP_HOST === 'smtp.resend.com' && ..."
  - https://github.com/resend/resend-openapi/blob/main/resend.yaml — official OpenAPI spec — "The API key can have full access to Resend’s API or be only restricted to send emails. * full_access - Can create, delete, get, and update any resource. * sending_access - Can only send emails." / "Restrict an API key to send emails only from a specific domain. Only used when the permission is sending_access."

### SB-RLS-NOT-DEFAULT — Tables created by SQL migrations do not get RLS automatically
- **Brief:** §3 "RLS enabled on every table"; §6 "RLS is enabled on every table"; §12 "RLS is enabled on every table; a migration test asserts it."
- **Verdict:** Confirmed — high confidence
- **Finding:**
  - **No automatic RLS for SQL tables:** only tables created in the Dashboard Table Editor get RLS automatically. Tables created with SQL (SQL editor, migrations, other tools) need `alter table <t> enable row level security;`.
  - **Optional auto-enable:** Supabase documents an event trigger (`ensure_rls` on `ddl_command_end`, calling `rls_auto_enable()`) that auto-enables RLS on new `public` tables. It is opt-in, not a platform default, and applies only to tables created after it is installed.
  - **The 2026 platform change is about GRANTs, not RLS** (see SB-DATA-API-GRANTS-2026).
- **Design consequence:** Every `CREATE TABLE` in `supabase/migrations` is followed by `alter table public.<t> enable row level security;`. The DoD test (PGlite) runs `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity` and expects zero rows. Optionally install the `ensure_rls` event trigger as well; it works in PGlite 0.5.8 (tested).
- **Open risk:** None.
- **Sources:**
  - https://supabase.com/docs/guides/api/securing-your-api#enable-rls-policies — official docs source repo (renders to the public docs URL) — "Tables created through the Supabase Dashboard have RLS enabled by default. Enable RLS explicitly for tables created in the SQL Editor or through another tool"
  - https://supabase.com/docs/guides/database/tables — official docs source repo (renders to the public docs URL) — "The Table Editor enables row level security for you when you create a table in the Dashboard. When you create a table with SQL, enable it yourself."
  - https://supabase.com/docs/guides/database/postgres/event-triggers — official docs source repo (renders to the public docs URL) — "CREATE EVENT TRIGGER ensure_rls ON ddl_command_end WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') EXECUTE FUNCTION rls_auto_enable();" ... "this applies to tables created after the trigger is installed." ... "With our `Supautils` extension (installed automatically for all Supabase projects), the `postgres` user has the ability to create and manage event triggers." ... "Only the `postgres` user can create event triggers"
  - https://github.com/electric-sql/pglite — local experiment — "verify/v1.mjs (PGlite 0.5.8, Node 22.22.0) executing the docs' rls_auto_enable() + CREATE EVENT TRIGGER ensure_rls verbatim -> 'install rls_auto_enable: ok(3)'; then create table public.a1 / public.a2 AS / private.p1 -> relrowsecurity: public.a1 true, public.a2 true, private.p1 false"

### SB-DATA-API-GRANTS-2026 — New tables no longer get automatic grants; every migration must GRANT
- **Brief:** Not addressed (§3/§6 RLS; §10 WIRE_UP step 2).
- **Verdict:** Extended — high confidence
- **Finding:**
  - **The change:** a breaking platform change (GitHub discussion #45329, 2026-04-28, "Tables not exposed to Data and GraphQL API automatically"). Timeline:
    - 2026-04-28: opt-in toggle at project creation;
    - 2026-05-30: the default for all NEW projects;
    - 2026-10-30: enforced on all existing projects for newly created tables (existing tables keep their grants).
  - **Effect:** new `public` tables no longer get automatic `SELECT`/`INSERT`/`UPDATE`/`DELETE` for `anon`, `authenticated` AND `service_role`.
  - **Failure mode:** missing grants fail before RLS, with PostgREST `42501` "permission denied for table <t>" (the hint names the GRANT).
  - **Docs guidance:** "Bundle grants with your RLS setup in the same migration." On older projects that still auto-grant, revoke `anon`/`authenticated` explicitly ("Adding policies doesn't take those grants back").
- **Design consequence:** The Autopilot project will be created after 2026-05-30, so every migration must include explicit grants or the secret-key server gets `42501`. Per server-only table: `alter table public.X enable row level security; revoke all on table public.X from anon, authenticated; grant select, insert, update, delete on table public.X to service_role;`. For tables the owner reads through the publishable key, add `grant select ... to authenticated` plus policies. Prefer uuid primary keys (default `gen_random_uuid()`) or identity columns: identity inserts need no sequence grant, `serial` does (tested). The migration test asserts `has_table_privilege('service_role', 'public.X', 'select,insert,update,delete')` and `not has_table_privilege('anon', 'public.X', 'select')` for every table.
- **Open risk:** The discussion page was read through a WebFetch rendering; the docs source independently states that the default is changing. During WIRE_UP, after the first `db push`, run the same `has_table_privilege` checks in the SQL editor of the real project.
- **Sources:**
  - https://github.com/orgs/supabase/discussions/45329 — official docs (Supabase's official GitHub announcement, read via a WebFetch rendering) — "Breaking Change: Tables not exposed to Data and GraphQL API automatically #45329" ... "2026-04-28: Changelog published; opt-in toggle available at project creation; 2026-05-30: New behavior becomes the default for all new projects; 2026-10-30: New behavior enforced on all existing projects" ... "2026-05-18: pg_graphql will not be enabled by default" ... "alter default privileges for role postgres in schema public revoke usage, select on sequences from anon, authenticated, service_role;" ... "grant select, insert, update, delete on public.your_table to service_role; alter table public.your_table enable row level security;"
  - https://supabase.com/docs/guides/api/securing-your-api#default-privileges — official docs source repo (renders to the public docs URL) — "On existing projects, tables created in `public` receive `SELECT`, `INSERT`, `UPDATE`, and `DELETE` privileges for `anon`, `authenticated`, and `service_role` by default. ... Supabase is changing the platform default to revoke these automatic grants so that exposure becomes opt-in." ... "Bundle grants with your RLS setup in the same migration."
  - https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies — official docs source repo (renders to the public docs URL) — "Adding policies doesn't take those grants back. A table protected only by policies still hands `anon` an insert path if you never revoke the grant."
  - https://github.com/electric-sql/pglite — local experiment — "PGlite 0.5.8: table with RLS but no GRANT to service_role (role created BYPASSRLS): `set local role service_role; select * from public.t_identity` -> 'ERR: permission denied for table t_identity'"

### SB-RLS-PATTERNS — Default-deny RLS, policy form, and server-only tables
- **Brief:** §6 "RLS is enabled on every table"; §3 service key used only on the server.
- **Verdict:** Confirmed — high confidence
- **Finding:**
  - **Enable:** `alter table public.t enable row level security;`.
  - **Default deny:** RLS on with no policies means the Data API returns nothing for `anon`/`authenticated` ("RLS with no policies denies every request"). The table owner and `BYPASSRLS` roles (`postgres`, `service_role`) are not subject to policies.
  - **Policy form:** one policy per operation, `to authenticated`, with JWT helpers wrapped in a sub-select for initPlan caching: `create policy "owner reads" on public.t for select to authenticated using ((select auth.uid()) = owner_user_id);`. An update policy needs both `using` and `with check`.
  - **Helpers:** `auth.uid()` = `coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid`; it returns null when there is no authenticated user. `auth.jwt()` is the non-deprecated helper.
  - **Views:** views bypass RLS by default (security definer). Use `security_invoker` or keep them unexposed.
  - **Server-only tables:** RLS on, NO policies, revoke `anon`/`authenticated`, grant `service_role` only (or use a non-exposed `private` schema).
- **Design consequence:** The simplest compliant design: every table has RLS on, no anon access, and `service_role` grants. Dashboard reads go through server code using the admin client, after `getClaims()` and a single `requireAccount()` scoping helper; RLS stays as defence in depth, and no `authenticated` policies are needed. The alternative is `authenticated` select policies via `users.auth_user_id = (select auth.uid())`. Record the choice in DECISIONS.md.
- **Open risk:** With server-side authorization, RLS does not catch an app-level scoping bug; mitigate with one helper and tests.
- **Sources:**
  - https://supabase.com/docs/guides/database/postgres/row-level-security — official docs source repo (renders to the public docs URL) — "create policy "Individuals can view their own todos." on todos for select to authenticated using ( (select auth.uid()) = user_id );" ... "Wrapping the function causes an `initPlan` to be run by the Postgres optimizer, which allows it to "cache" the results per-statement" ... "Views bypass RLS by default"
  - https://supabase.com/docs/guides/database/postgres/row-level-security#authuid — official docs source repo (renders to the public docs URL) — "When a request is made without an authenticated user (e.g., no access token is provided or the session has expired), `auth.uid()` returns `null`." ... "USING (auth.uid() IS NOT NULL AND auth.uid() = user_id)"
  - https://supabase.com/docs/guides/database/connecting-to-postgres — official docs source repo (renders to the public docs URL) — "RLS with no policies denies every request."
  - https://github.com/supabase/auth/blob/master/migrations/20220224000811_update_auth_functions.up.sql — official SDK source (Supabase Auth server migrations) — "create or replace function {{ index .Options "Namespace" }}.uid() returns uuid language sql stable as $$ select coalesce( nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub') )::uuid $$;"
  - https://github.com/electric-sql/pglite — local experiment — "PGlite 0.5.8 + shim: user1 (set_config('request.jwt.claims', {sub,role}), set local role authenticated) with policy using ((select auth.uid()) = owner_user_id) -> [{name:'A'}]; RLS-on/no-policy table -> []; anon insert -> 'new row violates row-level security policy for table "webhook_events"'; service_role -> 2 rows"
  - https://github.com/electric-sql/pglite — local experiment — "verify/v1.mjs: as authenticated -> {"uid":[{"u":"6e82e0b6-..."}],"jwtsub":[{"s":"6e82e0b6-..."}],"rows":[{"name":"L1"}]}; anon select (no grant): ERR: permission denied for table leads; privs: [ { sr: true, anon_sel: false } ]"

### SB-MIGRATIONS-WORKFLOW — Supabase CLI migrations, and the SQL-editor fallback
- **Brief:** §3 "SQL migrations in `supabase/migrations/`"; §10 WIRE_UP step 2 "Create the Supabase project and run the migrations **before** deploying code that uses them."
- **Verdict:** Confirmed — high confidence
- **Finding:**
  - **CLI install:** as a dev dependency, `npm install supabase --save-dev`, run as `npx supabase ...` (latest npm `supabase` is 2.119.0).
  - **Commands:**
    - `supabase init` creates `supabase/config.toml`;
    - `supabase migration new <name>` creates `supabase/migrations/<timestamp>_<name>.sql` (for example `20230306095710_schema_test.sql`; a 14-digit `YYYYMMDDHHMMSS` timestamp);
    - `supabase login` (personal access token);
    - `supabase link --project-ref <ref>` prompts for the DB password; `SUPABASE_DB_PASSWORD` avoids the prompt;
    - `supabase db push --dry-run`, then `supabase db push`, which records versions in `supabase_migrations.schema_migrations` (flags `--include-seed`, `--db-url`, `--include-all`);
    - `supabase migration list` and `supabase migration repair --status applied|reverted <version>` fix drift.
  - **Without the CLI:** paste each file, in filename order, into Dashboard > SQL Editor. Supabase warns that remote changes made outside migration files bypass the history, so a later `db push` fails with sync errors; reconcile afterwards with `migration repair --status applied <timestamp>`.
- **Design consequence:** WIRE_UP step 2 primary path: create the project (choose a region, save the DB password) → `npx supabase login` → `npx supabase link --project-ref <ref>` → `npx supabase db push --dry-run` → `npx supabase db push` → verify in the SQL editor that the RLS-check query returns zero rows, and run `select version from supabase_migrations.schema_migrations`. Fallback: SQL editor in order, then `migration repair`. Never edit applied migrations; don't commit `supabase/.temp`.
- **Open risk:** `supabase start` and `db reset` need Docker, which the sandbox lacks; PGlite covers the tests.
- **Sources:**
  - https://supabase.com/docs/reference/cli/supabase-migration-new — official docs source repo (renders to the public docs URL) — "All schema migration files must be created in this directory following the pattern `<timestamp>_<name>.sql`." "Created new migration at supabase/migrations/20230306095710_schema_test.sql."
  - https://supabase.com/docs/reference/cli/supabase-db-push — official docs source repo (renders to the public docs URL) — "Requires your local project to be linked to a remote database by running `supabase link`." ... "a migration history table will be created under `supabase_migrations.schema_migrations`" ... flags --db-url, --dry-run, --include-all, --include-roles, --include-seed
  - https://supabase.com/docs/reference/cli/supabase-link — official docs source repo (renders to the public docs URL) — "you may specify it explicitly via the `SUPABASE_DB_PASSWORD` environment variable." example: supabase link --project-ref ********************
  - https://supabase.com/docs/guides/deployment/database-migrations — official docs source repo (renders to the public docs URL) — "Making schema changes directly on your **remote** database (via the SQL editor or Table Editor) bypasses the migration history and will cause `db push` to fail with sync errors."
  - https://supabase.com/docs/guides/local-development/cli/getting-started — official docs source repo (renders to the public docs URL) — "npm install supabase --save-dev" ... "Run it through your package runner instead, for example `npx supabase <command>`."

### SB-DB-ACCESS-LAYER — PGlite cannot run supabase-js queries; the PLAN must pick a data-access design
- **Brief:** §3 "PGlite (`@electric-sql/pglite`) so database tests run without Docker or credentials"; §8 tests.
- **Verdict:** Extended — high confidence. The verifier corrected the original answer by adding Supabase's documented Postgres.js pipelining caution and the transaction-mode limits.
- **Finding:**
  - **The constraint:** PGlite is Postgres only (no PostgREST/Data API), so supabase-js `.from()` code cannot run against it.
  - **Option A, a SQL repository layer:** in tests, PGlite runs the same SQL. Live, it uses Supabase's shared pooler in transaction mode, `postgresql://postgres.[PROJECT-REF]:[PASSWORD]@[POOLER-HOST]:6543/postgres` (copy the host from the Connect dialog; the `aws-[INDEX]-[REGION]` pooler host can't be derived), with Postgres.js `postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: 'require' })` created once at module scope.
    - **Pipelining hazard:** Supabase warns that "postgres.js pipelines queries by default. Combined with the shared pooler transaction mode, this can hang queries or return mismatched rows", and that `max_pipeline: 0` breaks `sql.begin()`.
    - **Lost session state:** transaction mode drops session state (SET, session advisory locks, LISTEN/NOTIFY, temp tables) between transactions.
    - **So, with option A,** do one of: enforce strictly sequential queries per client (no `Promise.all` on one `sql` instance, multi-statement work inside `sql.begin()`, and `SET LOCAL` only); or use the session pooler (port 5432); or use node-postgres.
  - **Option B:** the supabase-js admin client (secret key, PostgREST) live, with fake repositories in tests; PGlite then validates only migrations, RLS and grants.
  - **In both designs** the `postgres` role (A) and `service_role` (B) bypass RLS, so authorization lives in server code. B additionally needs explicit GRANTs to `service_role` on every table (platform change #45329).
- **Design consequence:** A PLAN decision. (A) SQL repositories: Postgres.js on `DATABASE_URL` live, PGlite in tests, so the same SQL is exercised and the retention-purge and idempotent-webhook SQL get real coverage. (B) supabase-js admin client live plus fake repositories in tests; PGlite only validates migrations and RLS. Both must apply the same migration files in tests.
- **Open risk:** Option A adds `DATABASE_URL` (which contains the DB password) as another server secret, and it carries the documented pipelining hazard that the code must guard against. During WIRE_UP for option A, copy the pooler host from the Connect dialog.
- **Sources:**
  - https://supabase.com/docs/guides/database/connecting-to-postgres#configure-your-client — official docs source repo (renders to the public docs URL) — "In a serverless function: 1. Create the client once at module scope ... 2. Set the pool to 1 connection. ... 3. Turn off prepared statements" ... "export const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: 'require' })"
  - https://supabase.com/docs/guides/database/postgres-js — official docs source repo (renders to the public docs URL) — "`postgres.js` pipelines queries by default. Combined with the [shared pooler transaction mode](...), this can hang queries or return mismatched rows. `postgres.js` has no working option to turn pipelining off directly: `max_pipeline: 0` breaks `sql.begin()` transactions instead, a known upstream [bug](https://github.com/porsager/postgres/issues/1189)."
  - https://supabase.com/docs/guides/database/connecting-to-postgres#transaction-mode-limitations — official docs source repo (renders to the public docs URL) — "**Session-level state** is lost between transactions. This covers `set` and `reset`, session-level advisory locks, `listen` and `notify`, and temporary tables." ... "**Query pipelining** isn't supported" ... "`postgres.js` pipelines queries by default, so this combination can hang queries or return mismatched rows"
  - https://supabase.com/docs/guides/database/postgres/row-level-security#avoid-recursive-policies — official docs source repo (renders to the public docs URL) — "On Supabase the owner is `postgres`, which has `bypassrls`."

### PG-VERSION-EXTENSIONS — PGlite 0.5.8 is PostgreSQL 18.3; extensions load at startup
- **Brief:** §3 PGlite for database tests (no version detail); §9 M1 "PGlite test harness".
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Version:** `@electric-sql/pglite` 0.5.8 (latest) embeds PostgreSQL 18.3 ("PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten ... 32-bit"). The 0.5.0 changelog says "Upgrade to Postgres 18.3".
  - **UUIDs:** `gen_random_uuid()` is core and works without extensions.
  - **Contrib extensions** ship in the package but must be passed at startup, then created:
    ```ts
    import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
    import { citext } from '@electric-sql/pglite/contrib/citext';
    import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
    const db = await PGlite.create({ extensions: { pgcrypto, citext, uuid_ossp } });
    await db.exec('create extension if not exists pgcrypto; create extension if not exists citext; create extension if not exists "uuid-ossp";')
    ```
  - **Availability:** only loaded extensions appear in `pg_available_extensions` (plus `plpgsql`). Versions: citext 1.8, pgcrypto 1.4, uuid-ossp 1.1.
  - **Supabase-style schema:** `create extension if not exists pgcrypto with schema extensions;` works after `create schema extensions`.
  - **Other extensions** (pgvector, pgtap, pg_uuidv7 and others) are separate npm packages since 0.5.0 (for example `@electric-sql/pglite-pgtap` 0.0.9).
- **Design consequence:** Hosted Supabase Postgres is 15 or 17 (the CLI's `db.major_version` defaults to `'15'`), while PGlite is 18.3. Avoid PG18-only features (built-in `uuidv7()`, virtual generated columns, OLD/NEW in RETURNING) and use `gen_random_uuid()`. Hash action tokens in Node crypto, not pgcrypto. Pin `@electric-sql/pglite` exactly (minor versions can break; upgrade via dump and restore).
- **Open risk:** The 18 vs 15/17 version skew could hide incompatibilities, so keep the SQL conservative. During WIRE_UP, run `SHOW server_version;` on the real project and record the major version.
- **Sources:**
  - https://github.com/electric-sql/pglite — local experiment — "node t1.mjs with @electric-sql/pglite@0.5.8: 'PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten, compiled by emcc ... 3.1.74 ..., 32-bit'; gen_random_uuid (no ext) -> uuid; available_extensions: citext,pgcrypto,plpgsql,uuid-ossp; installed citext 1.8, pgcrypto 1.4, uuid-ossp 1.1"
  - https://github.com/electric-sql/pglite — local experiment — "verify/v2.mjs: PGlite.create() with no extensions -> 'no-ext available: plpgsql'; 'pgcrypto w/o loading: ERR extension "pgcrypto" is not available'; 'uuidv7 exists (PG18): 2'"
  - https://github.com/electric-sql/pglite/blob/main/packages/pglite/CHANGELOG.md — official SDK source — "## 0.5.0 ### Minor Changes - 93d50aa: Upgrade to Postgres 18.3; move other extensions to their own npm packages;"
  - https://pglite.dev/extensions/ — official docs source repo (renders to the public docs URL) — "extensions.data.ts: name 'pgcrypto' importPath '@electric-sql/pglite/contrib/pgcrypto' importName 'pgcrypto'; name 'uuid-ossp' importPath '@electric-sql/pglite/contrib/uuid_ossp' importName 'uuid_ossp'; name 'citext' importPath '@electric-sql/pglite/contrib/citext'"
  - https://supabase.com/docs/guides/local-development/cli/config#db.major_version — official docs source repo (renders to the public docs URL) — "id: 'db.major_version' ... default: '15' ... 'The database major version to use. This has to be the same as your remote database's. Run `SHOW server_version;` on the remote database to check.'"

### PG-ROLES-RLS — PGlite supports roles, SET ROLE and RLS enforcement
- **Brief:** §12 "RLS is enabled on every table; a migration test asserts it"; §6.
- **Verdict:** Confirmed — high confidence (tested locally)
- **Finding:**
  - **Default session bypasses RLS:** the default user, role and database are all `postgres` (superuser, `rolbypassrls=true`), so default-session queries bypass RLS.
  - **What works:** `CREATE ROLE anon/authenticated/service_role`, `GRANT`, `ALTER DEFAULT PRIVILEGES`, `SECURITY DEFINER ... SET search_path = ''`, event triggers, and `SET LOCAL ROLE` inside `db.transaction()`.
  - **Enforcement:** RLS is enforced for non-`BYPASSRLS` roles: policy filtering, `WITH CHECK` violations, and "permission denied" on missing grants.
  - **Introspection:** `pg_class.relrowsecurity` is readable.
  - **Alternative:** a PGlite `username` option exists ("Permissions will be applied in the context of this user"), but `SET LOCAL ROLE` per transaction is simpler.
- **Design consequence:** The migration test checks: (1) zero `public` tables with `relrowsecurity=false`; (2) `service_role` has CRUD and `anon` has none on every table (`has_table_privilege`); (3) optionally, an `authenticated` policy, exercised via `db.transaction(async tx => { await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, role: 'authenticated' })]); await tx.exec('set local role authenticated'); ... })`. App-logic tests that don't SET ROLE won't see RLS.
- **Open risk:** None.
- **Sources:**
  - https://github.com/electric-sql/pglite — local experiment — "t2.mjs: current_user postgres, rolsuper true, rolbypassrls true; relrowsecurity accounts true, no_rls false, webhook_events true; user1 sees [{name:'A'}]; authenticated on RLS/no-policy table -> []; anon -> []; service_role -> 2 rows; anon insert -> 'new row violates row-level security policy for table "webhook_events"'. t3.mjs: identity insert as authenticated w/o sequence grant -> ok; serial -> 'permission denied for sequence t_serial_id_seq'; service_role w/o table grant -> 'permission denied for table t_identity'; event trigger -> ok"
  - https://github.com/electric-sql/pglite — local experiment — "verify/v1.mjs: db2.exec(`create role app_user login; create table public.x(id int); insert into public.x values (1); alter table public.x enable row level security; grant select on public.x to app_user;`); PGlite.create({ loadDataDir: dump, username: 'app_user' }) -> 'username option current_user: [ { current_user: 'app_user' } ] rows visible: [ { n: 0 } ]'"
  - https://pglite.dev/docs/api — official docs source repo (renders to the public docs URL) — "- `username?: string` The username of the user to connect to the database as. Permissions will be applied in the context of this user."
  - https://github.com/electric-sql/pglite/blob/main/packages/pglite/CHANGELOG.md — official SDK source — "- 2ae666f: Default database, user and role are now all "postgres""

### PG-SUPABASE-SHIM — A test-only shim for Supabase roles, the `auth` schema and `auth.uid()`
- **Brief:** Not addressed (§9 M1 "PGlite test harness").
- **Verdict:** Extended — high confidence
- **Finding:** Run a test-only shim before the migrations:
  - **Roles:** create `anon` and `authenticated` (`NOLOGIN NOINHERIT`) and `service_role` (`NOLOGIN NOINHERIT BYPASSRLS`), each guarded by `if not exists (select 1 from pg_roles ...)` in a DO block.
  - **Schemas:** `create schema if not exists auth; create schema if not exists extensions;`.
  - **Users table:** a minimal `auth.users (id uuid primary key default gen_random_uuid(), email text)`.
  - **Helpers (Supabase's canonical definitions, `language sql stable`):**
    - `auth.uid()` = `select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid`;
    - `auth.jwt()` = `select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb`.
  - **Usage:** `grant usage on schema auth, public to anon, authenticated, service_role`.
  - **Simulating a request:** `set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', true)` plus `set local role authenticated`, inside a transaction.
  - **Placement:** the shim must never live in `supabase/migrations`.
- **Design consequence:** Ship `test/db/supabase-shim.sql` and `test/db/harness.ts` (`createTestDb()`: PGlite with the needed extensions → exec the shim → exec the migrations sorted by filename). Foreign keys to `auth.users(id)` are satisfied by the shim table.
- **Open risk:** The shim can diverge from the real `auth.users` columns, so keep migration dependencies on `auth.*` minimal (`auth.users(id)`, `auth.uid()`).
- **Sources:**
  - https://github.com/supabase/auth/blob/master/migrations/20220224000811_update_auth_functions.up.sql — official SDK source (Supabase Auth server migrations) — "create or replace function ... .uid() returns uuid language sql stable as $$ select coalesce( nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub') )::uuid $$;"
  - https://github.com/supabase/auth/blob/master/migrations/20220531120530_add_auth_jwt_function.up.sql — official SDK source (Supabase Auth server migrations) — "comment on function ...uid() is 'Deprecated. Use auth.jwt() -> ''sub'' instead.'; create or replace function {{ index .Options "Namespace" }}.jwt() returns jsonb language sql stable as $$ select coalesce( nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), '') )::jsonb $$;"
  - https://github.com/electric-sql/pglite — local experiment — "Vitest 3.2.7 test applying test/shim.sql + supabase/migrations/*.sql to `await PGlite.create()`: '✓ test/rls.test.ts (2 tests) 4370ms' — asserts no public table without relrowsecurity, authenticated without grant -> /permission denied/, service_role reads 1 row."

### PG-VITEST-USAGE — Using PGlite under Vitest: in-memory, `exec`, transactions, clones, limits
- **Brief:** §3 "PGlite (`@electric-sql/pglite`) so database tests run without Docker or credentials"; §8 Vitest.
- **Verdict:** Extended — high confidence
- **Finding:**
  - **In-memory:** `new PGlite()` / `await PGlite.create()` with no `dataDir` (or `'memory://'`) is ephemeral and in-memory. It works under Vitest's default pool (tested with Vitest 3.2.7 on Node 22).
  - **API:**
    - `db.exec(sql)` runs multiple statements without parameters ("useful for applying database migrations") and returns `Array<Results>`;
    - `db.query(sql, params)` runs a single parameterized statement;
    - `db.transaction(async tx => ...)` commits on resolve and rolls back on reject; `tx.rollback()` is available;
    - `db.sql` tagged templates;
    - `db.clone()` duplicates an instance for tests.
  - **Limits:**
    - a single exclusive connection, so concurrent queries are serialized (two concurrent `pg_sleep(0.3)` took 605 ms);
    - startup takes about 2.7–3.0 s per instance and a clone about 1.3 s (in the sandbox);
    - close every instance and clone (an unclosed clone kept Node alive);
    - WASM, 32-bit.
- **Design consequence:** One migrated DB per test file in `beforeAll` (Vitest `hookTimeout` about 30 s), then `clone()` per test or wrap each test in a rolled-back transaction. Don't test concurrency or locking semantics (`FOR UPDATE SKIP LOCKED` races) on PGlite. `@electric-sql/pglite-pgtap` is optional for pgTAP-style RLS tests (Supabase's `supabase test db` needs Docker).
- **Open risk:** The timings are sandbox-specific.
- **Sources:**
  - https://pglite.dev/docs/api — official docs source repo (renders to the public docs URL) — "### exec `.exec(query: string, options?: QueryOptions): Promise<Array<Results>>` Execute one or more statements. _(note that parameters are not supported)_ This is useful for applying database migrations" ... "### transaction ... committed when the promise returned from your callback resolves, and automatically rolled back if the promise is rejected." ... "### clone ... useful when a series of operations, like unit or integration test, need to be run on the same database"
  - https://pglite.dev/docs/ — official docs source repo (renders to the public docs URL) — "As PGlite only has a single exclusive connection to the database, we provide a multi-tab worker ..."
  - https://github.com/electric-sql/pglite — local experiment — "t5.mjs: 'create ms 3020', '2nd create ms 2727', 'clone ms 1279', '2 concurrent 300ms sleeps took 605 ms'"
  - https://github.com/electric-sql/pglite — local experiment — "verify/v1.mjs: db.exec(`create table public.e1(id int); select 1/0; create table public.e2(id int);`) -> 'ERR: division by zero'; then select to_regclass('public.e1'), to_regclass('public.e2') -> [ { e1: null, e2: null } ]; db.transaction(async tx => { await tx.exec('create table public.t_rb(id int)'); throw new Error('boom') }) -> 'tx threw: boom', to_regclass('public.t_rb') -> null; '2x concurrent 300ms sleep took 603 ms'"
  - https://github.com/electric-sql/pglite/blob/main/packages/pglite/CHANGELOG.md — official SDK source — "## 0.5.8 ### Patch Changes - c771db3: Do not set process.exitCode at all" ... "## 0.5.6 ... 69b7d87: Apply the second options argument when calling `PGlite.create(undefined, options)`."

### RS-SEND-API — Resend Node SDK: send call, payload, response and error shape
- **Brief:** §3 "Email: Resend with React Email templates"; §8 `Mailer` interface.
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Client:** `import { Resend } from 'resend'; const resend = new Resend(process.env.RESEND_API_KEY);`. It falls back to env `RESEND_API_KEY` and throws "Missing API key..." if there is none.
  - **Call:** `const { data, error, headers } = await resend.emails.send(payload, { idempotencyKey })`.
  - **Payload (camelCase):**
    - `from` (`'Name <a@b>'`);
    - `to` (string | string[], max 50);
    - `subject`;
    - at least one of `react` (ReactNode) | `html` | `text`;
    - optional `cc`, `bcc`, `replyTo` (string | string[]), `headers` (`Record<string,string>`), `tags` (`{name,value}[]`, ASCII letters/digits/`_`/`-` only, ≤256 chars), `attachments`, `scheduledAt` (ISO 8601), `topicId`;
    - or `template {id, variables}` (exclusive with `react`/`html`/`text`).

    The SDK maps these to the API's snake_case (`reply_to`, `scheduled_at`, `topic_id`).
  - **Response:** `{ data: { id: string }, error: null, headers } | { data: null, error: { message: string, statusCode: number | null, name: RESEND_ERROR_CODE_KEY }, headers }`. The SDK does NOT throw on API errors; a network failure gives `name` `'application_error'` with `statusCode` null.
  - **Error names:** `invalid_idempotency_key`, `validation_error`, `missing_api_key`, `restricted_api_key`, `invalid_api_key`, `not_found`, `method_not_allowed`, `invalid_idempotent_request`, `concurrent_idempotent_requests`, `invalid_attachment`, `invalid_from_address`, `invalid_access`, `invalid_parameter`, `invalid_region`, `missing_required_field`, `monthly_quota_exceeded`, `daily_quota_exceeded`, `rate_limit_exceeded`, `security_error`, `application_error`, `internal_server_error`.
  - **`react` renders HTML only:** with `react`, the SDK renders only `html` (by dynamically importing `@react-email/render`); no `text` is generated.
  - **Logging:** when `NODE_ENV` is not production, the SDK `console.error`s API errors.
  - **Version:** latest `resend` is 6.31.0 (engines node `>=20`).
- **Design consequence:** `Mailer` interface: `send({ from, to, subject, html, text, replyTo?, headers?, tags?, idempotencyKey })` → `{ id } | MailerError`. The live implementation maps `error.name` to retryable (`rate_limit_exceeded`, `application_error`, `internal_server_error`, `concurrent_idempotent_requests`) or permanent. Render React Email to `html` and `text` ourselves, so the live and fake Mailers produce the same output (fake mode writes it to `./outbox`). Tags are ASCII only (kind, ids), never names or emails. Don't log payloads.
- **Open risk:** None.
- **Sources:**
  - https://github.com/resend/resend-node/blob/canary/src/emails/interfaces/create-email-options.interface.ts — official SDK source — "interface CreateEmailBaseOptions { attachments?; bcc?: string | string[]; cc?; from: string; headers?: Record<string, string>; replyTo?: string | string[]; subject: string; tags?: Tag[]; to: string | string[]; topicId?; scheduledAt?: string } ... export interface CreateEmailResponseSuccess { id: string; }"
  - https://github.com/resend/resend-node/blob/canary/src/interfaces.ts — official SDK source — "export type Response<T> = ({ data: T; error: null; } | { error: ErrorResponse; data: null }) & { headers: Record<string, string> | null; }; export type ErrorResponse = { message: string; statusCode: number | null; name: RESEND_ERROR_CODE_KEY; };"
  - https://github.com/resend/resend-node/blob/canary/src/emails/emails.ts — official SDK source — "if (payload.react) { body.html = await render(payload.react); }"
  - https://github.com/resend/resend-node/blob/canary/src/render.ts — official SDK source — "try { ({ render } = await import('@react-email/render')); } catch { throw new Error('Failed to render React component. Make sure to install `@react-email/render` or `@react-email/components`.',"
  - https://github.com/resend/resend-node/blob/canary/src/resend.ts — official SDK source — "if (!key) { if (typeof process !== 'undefined' && process.env) { this.key = process.env.RESEND_API_KEY; } if (!this.key) { throw new Error('Missing API key. Pass it to the constructor `new Resend("re_123")`', ); } } ... process.env.RESEND_BASE_URL || defaultBaseUrl"
  - https://github.com/resend/resend-openapi/blob/main/resend.yaml — official OpenAPI spec — "SendEmailRequest required: [from, to, subject]; to: 'Max 50.'; reply_to; headers: 'Custom headers to add to the email.'; SendEmailResponse { id }"
  - https://www.npmjs.com/package/resend/v/6.31.0 — local experiment — "`npm view resend@6.31.0 dependencies peerDependencies peerDependenciesMeta` -> dependencies { 'postal-mime': '2.7.6', standardwebhooks: '1.1.1' }, peerDependencies { '@react-email/render': '*' }, peerDependenciesMeta { '@react-email/render': { optional: true } }"
  - https://github.com/resend/resend-node — local experiment (resend 6.31.0 with a mocked `globalThis.fetch`; full output in 10.2) — "429 -> {"data":null,"error":{"statusCode":429,"name":"rate_limit_exceeded","message":"Too many requests"},"headers":{"content-type":"application/json","retry-after":"1"}}; new Resend() without key -> 'Missing API key. Pass it to the constructor `new Resend("re_123")`'"

### RS-IDEMPOTENCY-LIMITS — Resend idempotency keys, rate limit, batch send and test addresses
- **Brief:** Not addressed (§5.5/§5.6 owner emails; §7 reliability).
- **Verdict:** Extended — medium confidence (from Resend's official OpenAPI spec, SDK and skills repo; the resend.com docs pages could not be read)
- **Finding:**
  - **Idempotency:** the SDK option `{ idempotencyKey: string }` is sent as the HTTP header `Idempotency-Key` (OpenAPI: header, string, `maxLength` 256) on `POST /emails` and `POST /emails/batch`. Resend's guidance:
    - keys expire after 24 hours;
    - same key + same payload returns the original response without resending;
    - same key + different payload → 409 (`invalid_idempotent_request`);
    - a concurrent duplicate → 409 `concurrent_idempotent_requests`;
    - key format `<event-type>/<entity-id>`.
  - **Rate limit:** Resend's official skill states "by default, rate limit is 2 requests per second" (429 `rate_limit_exceeded`; honour `retry-after`). The account's actual limit is exposed by `GET /usage` as `rate_limit: { limit, duration }` (example `{ limit: 10, duration: '1000ms' }`).
  - **Batch:** `resend.batch.send(emails[], { idempotencyKey, batchValidation?: 'strict'|'permissive' })` → `POST /emails/batch`, up to 100 emails, no attachments or `scheduled_at`, header `x-batch-validation` (default `strict` = atomic).
  - **Test recipients:** `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`.
  - **Sandbox sender:** `onboarding@resend.dev` only delivers to the account owner's address (403 otherwise).
- **Design consequence:** Deterministic idempotency keys: `lead-notify/{leadId}`, `followup/{leadId}/{n}`, `reply-stop/{leadId}`, `weekly-report/{accountId}/{isoWeek}`, `revoked/{connectionId}`, `billing-inactive/{subscriptionId}/{period}`, plus a unique constraint on `notifications_sent` for dedupe beyond 24 hours. Throttle cron fan-out to ≤2 requests per second, or batch in chunks of ≤100. The WIRE_UP smoke test sends to `delivered@resend.dev`.
- **Open risk:** The resend.com docs were unreachable. The 2 requests per second figure comes from Resend's official skills repo and may vary by plan, so rely on 429 and `retry-after` at runtime. During WIRE_UP, call `GET /usage` (or check the dashboard) for the account's real limit, and confirm the 24-hour idempotency window on resend.com.
- **Sources:**
  - https://github.com/resend/resend-openapi/blob/main/resend.yaml — official OpenAPI spec — "/emails post parameters: - in: header name: Idempotency-Key required: false schema: type: string maxLength: 256 ... /emails/batch summary: 'Trigger up to 100 batch emails at once.'" ... "rate_limit: type: object properties: limit: type: integer description: The number of requests allowed per `duration`. duration: type: string description: The rate-limit window, e.g. `'1000ms'`."
  - https://github.com/resend/resend-node/blob/canary/src/common/interfaces/idempotent-request.interface.ts — official SDK source — "'idempotencyKey?: string; ... If provided, will be sent as the `Idempotency-Key` header.' ; resend.ts: headers.set('Idempotency-Key', options.idempotencyKey); batch.ts: 'x-batch-validation': options?.batchValidation ?? 'strict'"
  - https://github.com/resend/resend-skills/blob/main/skills/resend/SKILL.md — official docs source repo (Resend's official `resend-skills` repo on GitHub; not a rendered resend.com page) — "| **Expiration** | 24 hours | | **Max length** | 256 characters | | **Same key + same payload** | Returns original response without resending | | **Same key + different payload** | Returns 409 error |" ... "| 429 | Rate limited — retry with exponential backoff (default rate limit: 2 req/s) |" ... "`delivered@resend.dev` | Simulates successful delivery", "`bounced@resend.dev` | Simulates hard bounce", "`complained@resend.dev` | Simulates spam complaint" ... "The default `onboarding@resend.dev` is a sandbox — it can only deliver to your Resend account email"
  - https://github.com/resend/resend-skills/blob/main/skills/resend/references/usage.md — official docs source repo (Resend's official `resend-skills` repo on GitHub; not a rendered resend.com page) — '"rate_limit": { "limit": 10, "duration": "1000ms" }' ... "| `rate_limit.limit` | number | No | Max API requests allowed per `duration` window |"
  - https://github.com/resend/resend-skills/blob/main/skills/resend/references/sending/overview.md — official docs source repo (Resend's official `resend-skills` repo on GitHub; not a rendered resend.com page) — "Reducing API calls is important (by default, rate limit is 2 requests per second)"

### RS-REACT-EMAIL — React Email 6 is one `react-email` package; `render()` is async
- **Brief:** §3 "Resend with React Email templates" (Next 14 / React 18).
- **Verdict:** Extended — high confidence
- **Finding:**
  - **One package:** React Email 6 (current `react-email` 6.11.0) consolidated components and rendering into the single package `react-email`: `import { Html, Head, Body, Text, Button, Link, Preview, render, toPlainText, pretty } from 'react-email'` (it re-exports `@react-email/render` 2.1.0).
  - **Peers:** react `'^18.0 || ^19.0'`, react-dom `'^18.0 || ^19.0'`; engines node `>=20.19.0`.
  - **`render` is async:** `render(node, options?)` has the signature `(node: React.ReactNode, options?: { pretty?: boolean; plainText?: boolean; htmlToTextOptions?: HtmlToTextOptions }) => Promise<string>`. `renderAsync` was removed in v5.
  - **Plain text:** `toPlainText(await render(el))` or `await render(el, { plainText: true })`. `data-skip-in-text="true"` excludes an element from the text.
  - **Node build:** dynamically imports `react-dom/server`, which is safe in App Router route handlers.
  - **Legacy alternative, still published:** `@react-email/components` 1.0.12 (peer react `^18||^19`).
  - **Preview server:** moved to `@react-email/ui` (dev-only; it depends on next 16.3.3, so it is optional).
  - **Verified locally** with React 18.3.1.
- **Design consequence:** Depend on `react-email@6.11.0` (exact). Templates live in `src/emails/*.tsx` and import from `'react-email'`. `renderEmail(el)` → `{ html, text }` is shared by the live and fake `Mailer` (fake mode writes `outbox/*.html`). Always pass `text` to Resend. Skip `@react-email/ui`, which would pull Next 16 into a Next 14 app.
- **Open risk:** react-email 6 lists CLI dependencies (esbuild, tailwindcss 4, socket.io) as runtime dependencies, so the install is larger; Next output tracing bundles only the imported files.
- **Sources:**
  - https://react.email/docs/getting-started/updating-react-email — official docs source repo (renders to the public docs URL; `resend/react-email` @15419ff1) — "## Update from React Email 5.0 to 6.0 All components (previously in `@react-email/components` or individual packages like `@react-email/button`) and rendering utilities (previously in `@react-email/render`) are now exported directly from `react-email`." ... "Replace all `renderAsync` uses with `render`."
  - https://react.email/docs/utilities/render — official docs source repo (renders to the public docs URL; `resend/react-email` @15419ff1) — "import { render, pretty } from 'react-email'; const html = await pretty(await render(<MyTemplate />));" ... "import { toPlainText, render } from 'react-email'; const html = await render(<MyTemplate />); const text = toPlainText(html);" ... "Add `data-skip-in-text="true"` to an element to exclude the element"
  - https://www.npmjs.com/package/@react-email/render — official SDK source — "dist/node/index.d.mts: 'declare const render: (node: React.ReactNode, options?: Options) => Promise<string>;' 'declare function toPlainText(html: string, options?: HtmlToTextOptions): string;'; node impl: 'const reactDOMServer = await import("react-dom/server")'"
  - https://www.npmjs.com/package/react-email — local experiment — "npm i react@18.3.1 react-dom@18.3.1 react-email@6.11.0; render(h(Html,{lang:'en'}, h(Text,null,'New lead: Asha'), h(Button,{href:'https://example.com/a/tok/send'},'Send from my email'))) -> 'render returns Promise: true'; HTML starts '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" ...<html dir="ltr" lang="en">'; toPlainText -> "New lead: Asha\n\nSend from my email https://example.com/a/tok/send"; render(el,{plainText:true}) -> same; React.version 18.3.1"
  - https://github.com/vercel/next.js/tree/v14.2.35 — local experiment — "src/app/auth/render/route.ts = render()/toPlainText() from 'react-email'. `next build` -> ' ✓ Compiled successfully' ... GET /auth/render -> {"html":"<!DOCTYPE html PUBLIC ...","text":"New lead: Asha\n\nSend from my email https://example.com/a/tok/send"}"

### RS-DOMAIN-DNS — Resend sending-domain DNS records for `autopilot.hublytix.ai`
- **Brief:** §10 WIRE_UP step 5 "Verify the Resend sending domain (suggest `autopilot.hublytix.ai`) and its DNS records" (records unspecified).
- **Verdict:** Extended — medium confidence (from Resend's official OpenAPI spec, SDK, CLI and skills repos; the resend.com dashboard docs could not be read)
- **Finding:**
  - **Add the domain:** add `autopilot.hublytix.ai` in Resend (Domains > Add) and choose a region: `us-east-1` (default), `eu-west-1`, `sa-east-1` or `ap-northeast-1`. The region is immutable.
  - **Records:** Resend returns the exact records (record kinds SPF, DKIM, optional Receiving, Tracking/TrackingCAA). With the default custom return path `send` ("Defaults to 'send' (i.e., send.yourdomain.tld)"), the sending records are:
    1. MX, name `send.autopilot.hublytix.ai`, value `feedback-smtp.<region>.amazonses.com` (for example `feedback-smtp.us-east-1.amazonses.com`), priority 10;
    2. TXT, name `send.autopilot.hublytix.ai`, value `v=spf1 include:amazonses.com ~all`;
    3. DKIM, name `resend._domainkey.autopilot.hublytix.ai`, type TXT, value `p=MIGf...` (the public key). The SDK types also allow DKIM as CNAMEs (`<token>._domainkey` → `<token>.dkim...`), so copy exactly what the dashboard shows.

    TTL: Auto.
  - **Verify:** verification is asynchronous; the status goes from `pending` to `verified`, `failed` or `partially_verified`.
  - **DMARC (recommended, not required):** a TXT record at `_dmarc.autopilot.hublytix.ai` (or inherit `hublytix.ai`'s policy), starting `v=DMARC1; p=none; rua=mailto:dmarc@hublytix.ai`, later moving to quarantine or reject.
  - **DNS-host pitfalls:** disable Cloudflare proxying for these records. Watch for registrars auto-appending the zone: in the `hublytix.ai` zone, enter `send.autopilot` and `resend._domainkey.autopilot`.
  - **Tracking:** keep open and click tracking OFF on the domain (pixel and link rewriting; brief §11 excludes tracking pixels).
- **Design consequence:** WIRE_UP step 5 lists the 3 sending records with concrete names, says "copy values exactly from the Resend dashboard (DKIM is account-specific)", adds DMARC, and verifies with `dig MX send.autopilot.hublytix.ai +short`, `dig TXT send.autopilot.hublytix.ai +short` and `dig TXT resend._domainkey.autopilot.hublytix.ai +short`. Choose `us-east-1` unless data residency requires otherwise. Env: `RESEND_API_KEY` (a sending-access key scoped to the domain), `EMAIL_FROM='Hublytix Autopilot <notify@autopilot.hublytix.ai>'`, `EMAIL_REPLY_TO` (a monitored address; Resend advises against no-reply). Do this before configuring Supabase SMTP.
- **Open risk:** The resend.com dashboard docs could not be fetched. DKIM may be shown as TXT `resend._domainkey` or as CNAMEs depending on the account, so WIRE_UP must say "use the dashboard values" and check them with `dig`.
- **Sources:**
  - https://github.com/resend/resend-openapi/blob/main/resend.yaml — official OpenAPI spec — "CreateDomainRequest: region enum [us-east-1, eu-west-1, sa-east-1, ap-northeast-1] default us-east-1; custom_return_path: "For advanced use cases, choose a subdomain for the Return-Path address. Defaults to 'send' (i.e., send.yourdomain.tld)." DomainRecord: record enum [SPF, DKIM, Receiving, Tracking, TrackingCAA]; type enum [MX, TXT, CNAME, CAA]; status enum [pending, verified, failed, temporary_failure, not_started]"
  - https://github.com/resend/resend-cli/blob/main/tests/commands/domains/utils.test.ts — official SDK source (Resend CLI tests) — "{ record: 'SPF', type: 'MX', name: 'send', ttl: 'Auto', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 } -> 'Name   send.example.com'; { record: 'SPF', type: 'TXT', name: 'send.example.com', value: 'v=spf1 include:amazonses.com ~all' }; { record: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=MIIG...' }"
  - https://github.com/resend/resend-node/blob/canary/src/domains/interfaces/domain.ts — official SDK source — "export interface DomainDkimRecord { record: 'DKIM'; name: string; value: string; type: 'CNAME' | 'TXT'; ttl: string; status: DomainRecordStatus; ... } export interface DomainSpfRecord { record: 'SPF'; ... type: 'MX' | 'TXT' | 'CNAME'; ... priority?: number; }" ... "export type DomainStatus = | 'pending' | 'verified' | 'failed' | 'not_started' | 'partially_verified' | 'partially_failed';"
  - https://github.com/resend/resend-skills/blob/main/skills/resend/references/domains.md — official docs source repo (Resend's official `resend-skills` repo on GitHub; not a rendered resend.com page) — "| `region` | `us-east-1`, `eu-west-1`, `sa-east-1`, `ap-northeast-1` | `us-east-1` | **Immutable** after creation |" ... "MX must be region-specific (`feedback-smtp.{region}.amazonses.com`) — use the exact records from the create response" ... "Disable proxy (orange → gray cloud) for all Resend DNS records" ... "GoDaddy/Namecheap may turn `resend._domainkey.send.acme.com` into `resend._domainkey.send.acme.com.acme.com`" ... "| DNS records added to root instead of subdomain | DKIM CNAMEs go on `resend._domainkey.send.example.com`, not `resend._domainkey.example.com` |" ... "dig CNAME resend._domainkey.send.example.com +short" (context: the domain added to Resend there is `send.example.com`)
  - https://github.com/resend/resend-skills/blob/main/skills/email-best-practices/references/deliverability.md — official docs source repo (Resend's official `resend-skills` repo on GitHub; not a rendered resend.com page) — "v=spf1 include:amazonses.com ~all" ... "v=DMARC1; p=none; rua=mailto:dmarc@example.com" ... "**Rollout:** `p=none` (monitor) → `p=quarantine; pct=25` → `p=reject`" ... "dig TXT resend._domainkey.example.com +short"
  - https://github.com/resend/resend-skills/blob/main/skills/email-best-practices/references/transactional-emails.md — official docs source repo (Resend's official `resend-skills` repo on GitHub; not a rendered resend.com page) — "Avoid `noreply@` - users reply to transactional emails."

### 10.1 Verifier-added items

#### V1 — Send the login email through Autopilot's own Mailer with `auth.admin.generateLink`
- **Brief:** Not addressed (§3 magic-link login; §10 WIRE_UP steps 2 and 5).
- **Verdict:** Extended — high confidence. The method and its purpose are documented in the official auth-js source and the supabase-js reference; the caveats come from the Auth server source on `master`.
- **Finding:**
  - **Supported:** `supabase.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo } })`, called with the secret-key admin client, is documented in auth-js as "Generates email links and OTPs to be sent via a custom email provider".
  - **Response:** `data.properties` contains `action_link`, `email_otp`, `hashed_token`, `redirect_to` and `verification_type`.
  - **No email is sent:** the Auth server's `adminGenerateLink` handler has no `sendEmail` call; it only stores the token and returns it.
  - **Flow:** the app emails `${APP_URL}/auth/confirm?token_hash=${hashed_token}&type=magiclink` (or `type=email`) through its own `Mailer` (Resend, with an idempotency key and the same fake-mode outbox), and `/auth/confirm` calls `verifyOtp({ token_hash, type })` as before.
  - **Benefits:** no dependency on Supabase custom SMTP or dashboard template edits; login emails can be tested in fake mode; the app's own rate limiting applies.
  - **Caveats from the server source:**
    1. For an email with no user, `type: 'magiclink'` is silently converted to a signup and CREATES the user. Call it only for emails that already belong to an owner row (look up `users` first).
    2. The per-user frequency limits that apply to `/otp` may not apply, so the app must rate-limit `/login` itself (brief §7 already requires this).
    3. It requires the secret key on the server.
  - **Fallback:** Supabase custom SMTP is still advisable for any email that Auth sends itself (for example, email change).
- **Design consequence:** A PLAN choice between Supabase-sent magic links (custom SMTP plus two template edits) and app-sent links via `generateLink` (one `Mailer` for every email, testable in fake mode). Either way `/auth/confirm` uses `verifyOtp` behind a click-to-confirm POST. Record the choice in DECISIONS.md.
- **Open risk:** The "sends no email" and "creates the user for an unknown email" behaviours are read from the Auth server source, not a docs sentence. During WIRE_UP, call `generateLink` once for an existing owner and confirm no Supabase email arrives and the link signs in.
- **Sources:**
  - https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/src/GoTrueAdminApi.ts — official SDK source — "'Generates email links and OTPs to be sent via a custom email provider.' ... @example Generate a magic link const { data, error } = await supabase.auth.admin.generateLink({ type: 'magiclink', email: 'email@example.com' })"
  - https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/src/lib/types.ts — official SDK source — "export type GenerateLinkProperties = { action_link: string ... email_otp: string ... /** The hashed token appended to the action link. */ hashed_token: string /** The URL appended to the action link. */ redirect_to: string ... verification_type: GenerateLinkType }"
  - https://github.com/supabase/auth/blob/master/internal/api/mail.go — official SDK source (Supabase Auth server source) — "func (a *API) adminGenerateLink(...) { ... user, err := models.FindUserByEmailAndAudience(db, params.Email, aud) if err != nil { if models.IsNotFoundError(err) { switch params.Type { case mail.MagicLinkVerification: params.Type = mail.SignupVerification ... resp := GenerateLinkResponse{ User: *user, ActionLink: url, EmailOtp: otp, HashedToken: hashedToken, (no a.sendEmail call between lines 52 and 318; sendEmail is used only by sendConfirmation/sendInvite/sendPasswordRecovery/sendMagicLink etc.)"
  - https://github.com/supabase/supabase/blob/master/apps/docs/spec/supabase_js_v2.yml — official docs source repo (renders to the public supabase-js reference) — "supabase_js_v2.yml: '- id: generate-link $ref: '@supabase/auth-js.GoTrueAdminApi.generateLink'' under admin-api ('Any method under the `supabase.auth.admin` namespace requires a `secret` key.')"

#### V2 — `signInWithOtp` for an unknown email returns `otp_disabled`; `/login` must not reveal it
- **Brief:** Not addressed (§4 step 2.1 magic-link login; §7 rate limits on auth routes).
- **Verdict:** Extended — high confidence (from the Auth server source and the auth-js error-code list)
- **Finding:**
  - **The error:** when `create_user` is false and no user with that email exists, the Auth server's `/otp` handler returns HTTP 422 with error code `otp_disabled` and message "Signups not allowed for otp". auth-js surfaces it as an `AuthApiError` with code `'otp_disabled'`.
  - **Do not show it:** showing that error would reveal which emails are registered. The `/login` server action must map both success and `otp_disabled` to the same neutral response, "If this email belongs to an Autopilot account, a sign-in link is on its way", log the code internally, and rate-limit by IP and by email.
  - **Other relevant code:** `over_email_send_rate_limit` (429) when the email-sent limit is hit.
- **Design consequence:** The `/login` action returns one neutral message for success, `otp_disabled` and `over_email_send_rate_limit`, logs only the error code, and has unit tests for all three paths with a fake auth client.
- **Open risk:** Derived from the Auth server source. During WIRE_UP, submit `/login` once with an unregistered address and confirm the neutral message and the `otp_disabled` code in the logs.
- **Sources:**
  - https://github.com/supabase/auth/blob/master/internal/api/otp.go — official SDK source (Supabase Auth server source) — "if ok, err := a.shouldCreateUser(r, params); !ok { return apierrors.NewUnprocessableEntityError(apierrors.ErrorCodeOTPDisabled, "Signups not allowed for otp") } ... func (a *API) shouldCreateUser(...) { if !params.CreateUser { ... _, err = models.FindUserByEmailAndAudience(db, params.Email, aud) ... if err != nil && models.IsNotFoundError(err) { return false, nil }"
  - https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/src/lib/error-codes.ts — official SDK source — "| 'otp_disabled'"
  - https://github.com/supabase/auth/blob/master/internal/api/mail.go — official SDK source (Supabase Auth server source) — "if errors.Is(err, EmailRateLimitExceeded) { return apierrors.NewTooManyRequestsError(apierrors.ErrorCodeOverEmailSendRateLimit, "%s", EmailRateLimitExceeded.Error())"

#### V3 — The chosen versions build and run together on Node 22
- **Brief:** §3 Stack: Next.js 14 App Router, Supabase Auth, Resend with React Email.
- **Verdict:** Confirmed — high confidence (local experiment)
- **Finding:**
  - **Setup:** a minimal app on Next.js 14.2.35 with:
    - `src/middleware.ts` (the Supabase `updateSession` pattern renamed for Next 14);
    - `app/auth/confirm/route.ts` (`verifyOtp` with the `cookies()` store);
    - a route handler rendering a react-email template.
  - **Build:** `next build` succeeded (" ✓ Compiled successfully", Middleware 87 kB, no Edge-runtime warnings, type-check passed).
  - **Run:** served correctly with `next start` on Node v22.22.0. The middleware redirected an unauthenticated `GET /` to `/login`; `/auth/confirm` without params redirected to the error page; the render route returned HTML plus the expected plain text.
  - **Advice:** pin these exact versions. Next 14 middleware is Edge-only, so keep it limited to the Supabase session refresh and redirect logic.
- **Design consequence:** Pin `next@14.2.35`, `react@18.3.1`, `react-dom@18.3.1`, `react-email@6.11.0`, `@supabase/ssr@0.12.7`, `@supabase/supabase-js@2.117.2` and `resend@6.31.0` in M1, on Node 22.
- **Open risk:** The experiment ran locally, not on Vercel. Check the first Vercel build log for Edge-runtime warnings during WIRE_UP.
- **Sources:**
  - https://github.com/vercel/next.js/tree/v14.2.35 — local experiment — "verify/next14-app: npm i next@14.2.35 react@18.3.1 react-dom@18.3.1 react-email@6.11.0 @supabase/ssr@0.12.7 @supabase/supabase-js@2.117.2 resend@6.31.0 on Node v22.22.0 ... `next build` -> ' ✓ Compiled successfully', 'ƒ Middleware 87 kB', no Edge-runtime warnings. `next start`: GET / -> 307 location: /login (middleware, no cookie); GET /auth/confirm (no params) -> 307 location: /auth/error; GET /auth/render -> {"html":"<!DOCTYPE html PUBLIC ...","text":"New lead: Asha\n\nSend from my email https://example.com/a/tok/send"}"

### 10.2 Test vectors

**Where they come from:** none of these vectors was published by a vendor. All were generated locally in the sandbox with the official packages (`@electric-sql/pglite` 0.5.8, `react-email` 6.11.0 with React 18.3.1, `resend` 6.31.0 with a mocked `fetch`, and `next` 14.2.35) on Node v22.22.0, then reproduced by the verifier. Both pgcrypto digests equal `node:crypto` SHA-256. They are useful as fixtures for the M1 PGlite harness, the RLS/grants migration test, the `renderEmail()` helper and the live `Mailer`'s error mapping.

The first two blocks are copied verbatim from the research record and the verifier's recheck. The last two are copied verbatim from the local-experiment evidence cited under RS-SEND-API and 10.1 V3.

**Research vectors (verbatim):**

```text
PGlite 0.5.8 (local-experiment): `select version()` -> 'PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten, compiled by emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.74 (1092ec30a3fb1d46b1782ff1b4db5094d3d06ae5), 32-bit'; `select encode(digest('abc','sha256'),'hex')` (pgcrypto) -> 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'; `select encode(extensions.digest('a','sha256'),'hex')` -> 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'. RLS check query: `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')` -> accounts true / no_rls false / webhook_events true. Role behaviour: authenticated with claims sub=u1 and policy ((select auth.uid()) = owner_user_id) -> 1 of 2 rows; RLS-on/no-policy -> 0 rows; anon INSERT -> 'new row violates row-level security policy for table "webhook_events"'; service_role without GRANT -> 'permission denied for table t_identity'; serial insert without sequence grant -> 'permission denied for sequence t_serial_id_seq'; identity insert without sequence grant -> ok. React Email 6.11.0 + React 18.3.1: render(<Html lang="en"><Text>New lead: Asha</Text><Button href="https://example.com/a/tok/send">Send from my email</Button></Html>) returns a Promise; toPlainText(html) === "New lead: Asha\n\nSend from my email https://example.com/a/tok/send"; render(el,{plainText:true}) gives the same string.
```

**Verifier recheck (verbatim):**

```text
All reproduced. PGlite 0.5.8 on Node v22.22.0: t1.mjs -> 'PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten, compiled by emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.74 (1092ec30a3fb1d46b1782ff1b4db5094d3d06ae5), 32-bit'; available citext,pgcrypto,plpgsql,uuid-ossp; installed citext 1.8 / pgcrypto 1.4 / uuid-ossp 1.1; digest('abc','sha256') = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad and extensions.digest('a','sha256') = ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb (both equal node:crypto sha256). t2.mjs: relrowsecurity accounts true / no_rls false / webhook_events true; user1 -> [{name:'A'}]; RLS-on/no-policy -> []; anon -> []; service_role -> 2; anon insert -> 'new row violates row-level security policy for table "webhook_events"'. t3.mjs: identity insert ok, serial -> 'permission denied for sequence t_serial_id_seq', service_role w/o grant -> 'permission denied for table t_identity', event trigger ok (process hangs afterwards because the clone isn't closed). t5.mjs: create 3386 ms / 2938 ms, clone 565 ms, 2 concurrent 300 ms sleeps 604 ms. Vitest 3.2.7: '✓ test/rls.test.ts (2 tests) 3218ms'. New: the docs' rls_auto_enable() event trigger enables RLS on new public tables in PGlite; multi-statement exec() is atomic; the `username` option works. React Email 6.11.0 + React 18.3.1 t.mjs output identical (render returns Promise; toPlainText = "New lead: Asha\n\nSend from my email https://example.com/a/tok/send"). New: Next 14.2.35 build/run experiment and a Resend 6.31.0 mocked-fetch experiment (Idempotency-Key header, snake_case body, 429 error shape with retry-after in headers, constructor throws without key). Experiment files: scratchpad/verify/{v1.mjs,v1b.out,v2.mjs,v2.out,t3.out,t5.out,rs.mjs,next14-app/}. Review JSON saved to /tmp/claude-0/-home-user-Autopilot/93edeaab-e8bf-5524-b325-7fb2eb252823/scratchpad/research/supabase-pglite-resend.verify.json (built by research/build_spr_verify.py).
```

**Resend 6.31.0 mocked-fetch request and 429 error shape (verbatim, from the RS-SEND-API local-experiment evidence):**

```text
verify/rs.mjs (resend 6.31.0, mocked globalThis.fetch): request {"url":"https://api.resend.com/emails","method":"POST","idem":"lead-notify/123","auth":"Bearer re_test","body":{"from":"Hublytix Autopilot <notify@autopilot.hublytix.ai>","headers":{"X-Entity-Ref-ID":"1"},"html":"<p>h</p>","reply_to":"owner@x.com","subject":"S","tags":[{"name":"kind","value":"lead_notify"}],"text":"t","to":"delivered@resend.dev"}}; 429 -> {"data":null,"error":{"statusCode":429,"name":"rate_limit_exceeded","message":"Too many requests"},"headers":{"content-type":"application/json","retry-after":"1"}}; new Resend() without key -> 'Missing API key. Pass it to the constructor `new Resend("re_123")`'
```

**Next.js 14.2.35 build and run (verbatim, from the 10.1 V3 local-experiment evidence):**

```text
verify/next14-app: npm i next@14.2.35 react@18.3.1 react-dom@18.3.1 react-email@6.11.0 @supabase/ssr@0.12.7 @supabase/supabase-js@2.117.2 resend@6.31.0 on Node v22.22.0. src/middleware.ts = Supabase updateSession pattern (createServerClient + getAll/setAll(cookiesToSet, headers) + getClaims()), src/app/auth/confirm/route.ts = verifyOtp({ type, token_hash }) with cookies() store, src/app/auth/render/route.ts = render()/toPlainText() from 'react-email'. `next build` -> ' ✓ Compiled successfully', 'ƒ Middleware 87 kB', no Edge-runtime warnings. `next start`: GET / -> 307 location: /login (middleware, no cookie); GET /auth/confirm (no params) -> 307 location: /auth/error; GET /auth/render -> {"html":"<!DOCTYPE html PUBLIC ...","text":"New lead: Asha\n\nSend from my email https://example.com/a/tok/send"}
```
