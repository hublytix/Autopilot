## 09. Next.js version, instrumentation, security headers, Sentry

The answers in this section come from these sources:
- the Next.js docs source repo at tag v14.2.35 and at canary 16.4.0-canary.55 (rendered at nextjs.org/docs), and the Next.js framework source at those tags;
- the getsentry/sentry-docs source repo at commit 8bee088e, 2026-10-01 (rendered at docs.sentry.io);
- the published npm builds of `@sentry/nextjs`, `@sentry/node` and `@sentry/core` 11.2.0 (and 10.75.3);
- GitHub-reviewed advisory records and the npm registry;
- local experiments that ran the official SDK against an in-memory transport.

No brief **[VERIFY]** marker falls in this area. This section checks the brief's unmarked claims in §3 (Framework, Monitoring), §7 ("CSP and security headers", "Sentry `beforeSend` scrubbing"), §2 law 4 and §12 ("a test proves the scrubber").

The headline correction is that Next.js 14 is end-of-life. 14.2.35 (2025-12-11) is the last 14.x release, and it has 23 open advisories (2 critical, 8 high) that are fixed only in 15.x/16.x. The research therefore recommends Next.js 16.3.8, pinned exactly, on Node 24 LTS.

The brief's `src/instrumentation.ts` rule is correct only for a `src/app` layout. Its assumption that `beforeSend` scrubbing is enough is wrong for the current Sentry SDK (v11, released 2026-09-23). By default v11 collects request bodies, headers, cookies and query strings, and once tracing is on it also records Anthropic prompts and completions.

The live pages on nextjs.org, docs.sentry.io and vercel.com were blocked in the sandbox. The formal Next.js support-policy wording, Vercel's Node 24 support and the live Sentry settings labels must therefore be re-checked at WIRE_UP.

Note on source URLs: Sentry SDK links point at the TypeScript sources on the develop branch. The evidence quoted was read from the published npm build of the exact version named (normally 11.2.0).

**The sources correct the brief in these places:**
- **§3 Framework, "Next.js 14 (App Router)":**
  - 14.x is EOL and gets no security fixes: 14.2.35 is the last release, with 23 open advisories (2 critical RCEs and 8 high).
  - Move to Next.js 16.3.8, pinned exactly. Do not fall back to 15.5.27: a community tracker puts 15.x end-of-life at 2026-10-21.
  - Use Node 24 LTS, or Node 22.12+ if Vercel cannot run 24.
  - Record the change in `docs/DECISIONS.md` (NX-SUPPORT-STATUS, NX14-ADVISORIES, NX-RECOMMENDATION).
- **§3 Monitoring, "`instrumentation.ts` MUST live in `src/`; at the repo root it silently never initialises":** this holds only conditionally.
  - Next.js looks for the file only in the parent directory of the `pages`/`app` directory. With `src/app` the file must be `src/instrumentation.ts`; with a root `app/` it must be at the root.
  - A stray root `app/` or `pages/` folder moves the required location back to the repo root.
  - On Next 14 there is a second silent failure: without `experimental.instrumentationHook: true`, `register()` never runs (NX14-INSTR-LOCATION, NX14-INSTR-FLAG).
- **§7 "Sentry `beforeSend` scrubbing" and §2 law 4:** `beforeSend` alone is not enough on `@sentry/nextjs` v11.
  - `sendDefaultPii` was removed, and an unset `dataCollection` collects everything.
  - Request bodies are attached verbatim, with no key filtering.
  - `beforeSend` does not see breadcrumbs, spans, logs or the envelope-header trace context.
  - `beforeSendTransaction` does nothing by default in v11.
  - Every `Sentry.init` must therefore pass an explicit restrictive `dataCollection`, run errors-only (no tracing), filter out the `Anthropic_AI` and `Console` integrations, and scrub in both `beforeSend` and `beforeBreadcrumb` (SENTRY-V11-DATA-DEFAULTS, SENTRY-HOOKS-STREAMING, SENTRY-RECOMMENDED-CONFIG, 09.x V2).
- **§5.5 action links `/a/{token}/send|edit|dismiss`:** a token in the URL path always reaches Sentry, in `event.request.url` and in the transaction name `GET /a/<token>/send`.
  - This is safe only while tracing is off and `beforeSend` rewrites the URL and transaction.
  - The research recommends a recognisable token prefix (`apt_`), carrying the token in the query string or a POST body rather than the path, and `Referrer-Policy: no-referrer` on action pages (SENTRY-URL-QUERY-LEAK).

**The sources extend the brief with:**
- Next 14 mechanics, in case the upgrade is rejected:
  - `next.config.mjs` only; `next.config.ts` is a hard error;
  - no `onRequestError`;
  - webpack auto-instrumentation, which does not cover Server Actions;
  - edge `register()` runs lazily, on the first request in each isolate.
- What changes on Next 16:
  - `proxy.ts` replaces `middleware.ts` and runs on Node;
  - `onRequestError` is available;
  - `instrumentation-client.ts` is native;
  - Turbopack is the default.
- A concrete CSP and header set:
  - a per-request nonce CSP set in middleware/proxy, which forces dynamic rendering;
  - always strip inbound CSP request headers;
  - set HSTS explicitly;
  - `poweredByHeader: false`.
- Exact Sentry package pins and setup files, including `global-error.tsx`.
- No `tunnelRoute`, and a CSP `connect-src` derived from the DSN.
- An envelope-level scrubber test that runs the real SDK with an in-memory transport. Sentry Testkit does not support v11.
- WIRE_UP step 8 needs more than "add the DSN":
  - `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` as build-only env;
  - `SENTRY_TRACES_SAMPLE_RATE` must stay unset;
  - keep project Data Scrubbing on and enable "Prevent storing IP addresses";
  - put only distinctive token prefixes in Additional Sensitive Fields;
  - use Advanced Data Scrubbing selectors for content fields.

---

### NX-SUPPORT-STATUS — Next.js 14 is end-of-life; 14.2.35 is the last 14.x release
- **Brief:** §3 Stack > Framework: "Next.js 14 (App Router), TypeScript `strict`, Tailwind."
- **Verdict:** Corrected — high confidence for the release and advisory facts, which come from the npm registry and GitHub-reviewed advisories.
  - The formal EOL wording and date are **not officially documented here**. https://nextjs.org/support-policy was blocked in the sandbox, and the dates below come from a community tracker (see 09.x V1).
- **Finding:**
  - **14.2.35 is the last 14.x release:** npm dist-tag `next-14` = `14.2.35`, published 2025-12-11T23:36Z. No 14.x version has been published since 2025-12-12.
  - **npm on 2026-10-01:**
    - `latest` = `16.3.8` (2026-09-30);
    - `backport` = `15.5.27` (2026-09-30);
    - `canary` = `16.4.0-canary.55`.
  - **No 14.x security fixes:** every Next.js GitHub advisory published since January 2026 that affects 14.x lists its first patched version only in 15.x/16.x. Examples:
    - GHSA-h25m-26qc-wcjf: "introduced 13.0.0, fixed 15.0.8";
    - GHSA-2xp9-vwfh-vxw4: "introduced 10.0.0, fixed 15.5.24".
    - None of the 23 advisories open against 14.2.35 lists a 14.x fixed version, so 14.x no longer receives security fixes.
  - **Official policy page:** https://nextjs.org/support-policy was egress-blocked, so the official EOL wording and date are not quoted.
    - The de-facto status, from official advisories plus npm, is that 14.x no longer gets security fixes.
    - The community tracker endoflife.date lists 14.x as `lts: true`, `eol: 2025-10-26`.
- **Design consequence:** The brief's Next 14 pin conflicts with §0's docs-win rule. Record in `docs/DECISIONS.md` that 14.x is EOL with unpatched critical advisories, and adopt NX-RECOMMENDATION.
- **Open risk:** The formal support-policy wording is unverified. Re-read https://nextjs.org/support-policy at WIRE_UP, especially the 15.x end-of-life date that NX-RECOMMENDATION relies on.
- **Sources:**
  - https://registry.npmjs.org/next — local experiment — "npm view next dist-tags -> {"next-14":"14.2.35","latest":"16.3.8","backport":"15.5.27","canary":"16.4.0-canary.55"}; npm view next time -> 14.2.35: 2025-12-11T23:36:04.237Z, 15.5.27: 2026-09-30T16:19:50.862Z, 16.3.8: 2026-09-30T16:07:21.198Z"
  - https://registry.npmjs.org/next — local experiment — "npm view next time --json (2026-10-01): 14.2.34 2025-12-11T21:01:45Z, 14.2.35 2025-12-11T23:36:04Z; 14.x versions published after 2025-12-12: []"
  - https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2026/01/GHSA-h25m-26qc-wcjf/GHSA-h25m-26qc-wcjf.json — official docs (GitHub-reviewed advisory record, fetched directly) — "affects ... Next.js 13.x, 14.x, 15.x, and 16.x using the App Router ... ranges: introduced 13.0.0 -> fixed 15.0.8 (no 14.x fix)"
  - https://nextjs.org/support-policy — official page, UNREACHABLE (direct fetch blocked in sandbox; no text read) — "UNREACHABLE: WebFetch returned EGRESS_BLOCKED for nextjs.org; policy text not verified."
  - https://github.com/endoflife-date/endoflife.date/blob/master/products/nextjs.md — community, non-authoritative — "releaseCycle: "15" lts: true releaseDate: 2024-10-21 eol: 2026-10-21 latest: "15.5.27" ... releaseCycle: "14" lts: true releaseDate: 2023-10-26 eol: 2025-10-26 latest: "14.2.35" latestReleaseDate: 2025-12-11"

### NX14-ADVISORIES — 23 open advisories against 14.2.35, including 2 critical RCEs
- **Brief:** not addressed. The brief pins Next 14 (§3), and §7 asks for "CSP and security headers".
- **Verdict:** Extended — high confidence.
- **Finding:** npm's bulk advisory endpoint (GitHub-reviewed advisories) returns **23 OPEN advisories for `next@14.2.35`**, and 0 for `next@15.5.27` and `next@16.3.8`. The counts are 2 critical, 8 high, 11 moderate and 2 low.
  - **CRITICAL (2):**
    - **GHSA-2xp9-vwfh-vxw4** (2026-09-08), "Unauthenticated Remote Code Execution in Image Optimization API when AVIF files are used". The bug is in libheif, reached via `sharp`. Vulnerable `>=10.0.0 <15.5.24`; fixed in 15.5.24 and 16.3.3.
    - **GHSA-p293-qw3h-jr36 / CVE-2026-75604** (2026-09-08), "Unauthenticated Remote Code Execution on windows-hosted servers". Vulnerable `>=13.4.0 <15.5.24`; Linux/Vercel hosts are not affected.
  - **HIGH (8):**
    - GHSA-8h8q-6873-q5fj (CVE-2026-23870, RSC DoS, `<15.5.16`);
    - GHSA-q4gf-8mx6-v5v3 (RSC DoS, `<15.5.15`);
    - GHSA-h25m-26qc-wcjf (CVE-2026-23864, RSC deserialization DoS, `<15.0.8`);
    - GHSA-m99w-x7hq-7vfj (Server Actions DoS, `<15.5.21`);
    - GHSA-89xv-2m56-2m9x / CVE-2026-64649 (SSRF in Server Actions on custom servers; managed hosting not affected);
    - GHSA-p9j2-gv94-2wf4 / CVE-2026-64645 (SSRF via rewrites whose destination hostname comes from the request);
    - GHSA-c4j6-fc7j-m34r (SSRF via WebSocket upgrades);
    - GHSA-36qx-fr4f-26g5 (middleware bypass, Pages Router i18n).
  - **MODERATE (11) / LOW (2):**
    - GHSA-ffhc-5mcf-pf4q / CVE-2026-44581: stored XSS in App Router apps that use CSP nonces behind shared caches, `>=13.4.0 <15.5.16`;
    - GHSA-wfc6-r584-vfw7: RSC cache poisoning, `>=14.2.0`;
    - GHSA-ggv3-7p47-pfv8: request smuggling in rewrites;
    - GHSA-h64f-5h5j-jqjh, GHSA-9g9p-9gw9-jx7f and GHSA-3x4c-7xq6-9pq8: image optimizer DoS/disk;
    - GHSA-68g3-v927-f742 and GHSA-4633-3j49-mh5q: cache confusion;
    - GHSA-4c39-4ccg-62r3, GHSA-955p-x3mx-jcvp, GHSA-gx5p-jg67-6x7h, GHSA-3g8h-86w9-wvmq and GHSA-vfv6-92ff-j949.
  - **Already PATCHED in 14.2.35:**
    - CVE-2025-29927 (GHSA-f82v-jwr5-mffw, middleware auth bypass), fixed in 14.2.25;
    - CVE-2025-55184 RSC DoS (GHSA-mwv6-3258-q52c), fixed in 14.2.34;
    - CVE-2025-67779, the follow-up to an incomplete fix (GHSA-5j59-xgg2-r9c4), fixed in 14.2.35.
  - **NOT AFFECTED on stable 14.x:**
    - CVE-2025-55182 RSC RCE (GHSA-9qr9-h5gf-34mp) affects only 14.3.0-canary.77+ and 15.x/16.x;
    - CVE-2025-55183 source exposure (GHSA-w37m-7fhw-fmv9) starts at 15.0.0-canary.0.
  - **Practical-exposure caveats (added by the verifier):** the headline count overstates a Vercel-hosted app's exposure.
    - GHSA-2xp9 is a bug in the libheif library inside sharp. `next@14.2.35` has no `sharp` dependency (`next@16.3.8` has optionalDependency `sharp` `^0.35.4`). On 14 it bites only when sharp is installed and Next's own image optimiser runs.
    - GHSA-89xv: "Managed hosting pins the host upstream and is not affected; `next start` and standalone output do the same from version 14.2 onward."
    - GHSA-p293 affects only Windows-hosted servers.
    - Several advisories still apply to every App Router app: GHSA-h25m, GHSA-8h8q and GHSA-q4gf (RSC DoS), GHSA-m99w, GHSA-wfc6 and GHSA-ffhc. The conclusion stands.
- **Design consequence:** On 14.2.35 the app would knowingly ship 2 critical, 8 high, 11 moderate and 2 low open advisories. Several hit every App Router app (RSC/Server Action DoS, RSC cache poisoning), and one targets the nonce-CSP pattern implied by §7. This justifies the upgrade (NX-RECOMMENDATION).
  - If forced to stay on 14:
    - set `images.unoptimized: true` (no next/image optimiser);
    - host only on Vercel/Linux;
    - strip inbound `content-security-policy` and `content-security-policy-report-only` request headers in middleware on every route;
    - add no rewrites or redirects with dynamic hostnames (including the Sentry `tunnelRoute`);
    - use no Server Actions (Route Handlers only).
- **Open risk:** The advisory data is as of 2026-10-01. Run `npm audit` in CI, and re-run it on the exact `next` version at WIRE_UP.
- **Sources:**
  - https://registry.npmjs.org/-/npm/v1/security/advisories/bulk — local experiment — "POST {"next":["14.2.35","15.5.27","16.3.8"]} filtered with npm's semver.satisfies -> next@14.2.35: 23 advisories; next@15.5.27: 0; next@16.3.8: 0"
  - https://registry.npmjs.org/-/npm/v1/security/advisories/bulk — local experiment — "Re-run 2026-10-01T17:31Z: response keys = [next] only, next.length=23; semver.satisfies 14.2.35 true for all 23, 15.5.27 and 16.3.8 false for all; counts {critical:2, high:8, moderate:11, low:2}"
  - https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2026/09/GHSA-2xp9-vwfh-vxw4/GHSA-2xp9-vwfh-vxw4.json — official docs (GitHub-reviewed advisory record, fetched directly) — "A vulnerability in the underlying `libheif` library used by `sharp` which Next.js uses for image optimization can lead to remote code execution when AVIF files are optimized. ranges: introduced 10.0.0 fixed 15.5.24; introduced 16.0.0 fixed 16.3.3"
  - https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2026/09/GHSA-p293-qw3h-jr36/GHSA-p293-qw3h-jr36.json — official docs (GitHub-reviewed advisory record, fetched directly) — "aliases CVE-2026-75604: 'can lead to remote code execution when the server is hosted on machines using a Windows filesystem.' introduced 13.4.0 fixed 15.5.24"
  - https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2026/05/GHSA-ffhc-5mcf-pf4q/GHSA-ffhc-5mcf-pf4q.json — official docs (GitHub-reviewed advisory record, fetched directly) — "App Router applications that rely on CSP nonces can be vulnerable to stored cross-site scripting when deployed behind shared caches ... Workarounds: If you cannot upgrade immediately, strip inbound `Content-Security-Policy` request headers from untrusted traffic."
  - https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2025/03/GHSA-f82v-jwr5-mffw/GHSA-f82v-jwr5-mffw.json — official docs (GitHub-reviewed advisory record, fetched directly) — "CVE-2025-29927: 'For Next.js 14.x, this issue is fixed in `14.2.25`'"
  - https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2025/12/GHSA-9qr9-h5gf-34mp/GHSA-9qr9-h5gf-34mp.json — official docs (GitHub-reviewed advisory record, fetched directly) — "The vulnerability also affects experimental canary releases starting with 14.3.0-canary.77. Users on any of the 14.3 canary builds should either downgrade to a 14.x stable release"
  - https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2025/12/GHSA-mwv6-3258-q52c/GHSA-mwv6-3258-q52c.json — official docs (GitHub-reviewed advisory record, fetched directly) — "CVE-2025-55184 ranges: introduced 13.3.0 fixed 14.2.34"
  - https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2025/12/GHSA-5j59-xgg2-r9c4/GHSA-5j59-xgg2-r9c4.json — official docs (GitHub-reviewed advisory record, fetched directly) — "CVE-2025-67779 incomplete-fix follow-up: introduced 13.3.1-canary.0 fixed 14.2.35"
  - https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2026/07/GHSA-p9j2-gv94-2wf4/GHSA-p9j2-gv94-2wf4.json — official docs (GitHub-reviewed advisory record, fetched directly) — "A `rewrites()` or `redirects()` rule that builds its external destination hostname from request-controlled input can be pointed at an arbitrary hostname ... constrain the value to hostname-safe characters: value: '(?<region>[a-z0-9-]+)'"
  - https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2026/07/GHSA-89xv-2m56-2m9x/GHSA-89xv-2m56-2m9x.json — official docs (GitHub-reviewed advisory record, fetched directly) — "Managed hosting pins the host upstream and is not affected; `next start` and standalone output do the same from version 14.2 onward."
  - https://www.npmjs.com/package/next/v/14.2.35 — local experiment — "npm view next@14.2.35 dependencies -> {busboy, postcss, @next/env, styled-jsx, graceful-fs, @swc/helpers, caniuse-lite} (no sharp); npm view next@16.3.8 optionalDependencies -> "sharp": "^0.35.4""

### NX-RECOMMENDATION — Move to Next.js 16.3.8, pinned exactly, on Node 24 LTS
- **Brief:** §3 Stack > Framework: "Next.js 14 (App Router)."
- **Verdict:** Corrected — medium confidence. The verifier upheld the direction (leave 14.x) but corrected two points of the original research:
  1. 15.5.27 is **not** an acceptable fallback, because a community tracker puts 15.x EOL at 2026-10-21.
  2. Node 24 LTS is preferred over the originally proposed Node 22.
- **Finding:**
  - **Target:** move to Next.js 16 and pin it exactly: 16.3.8, npm `latest` on 2026-10-01, engines `node >=20.9.0`.
  - **No 15.x fallback:** do NOT treat 15.5.27 as acceptable. It has 0 open advisories today, but community EOL tracking (endoflife.date, which mirrors nextjs.org/support-policy; that page was not reachable) puts 15.x end-of-life at 2026-10-21. By contrast, 14.2.35 has 23 open advisories (2 critical, 8 high).
  - **Node:**
    - Prefer Node 24 LTS. The official schedule gives LTS from 2025-10-28, maintenance from 2026-10-20 and end-of-life 2028-04-30.
    - Node 24 satisfies Next 16 (`>=20.9.0`) and `@sentry/nextjs` 11 (engines `'>=20.19.0 <22.0.0 || >=22.12.0 <23.0.0 || >=23.2.0'`).
    - Use Node 22.12+ only if the Vercel project cannot use 24. Node 22 is in maintenance since 2025-10-21, with end-of-life 2027-04-30.
  - **What changes from the brief on 16:**
    - Instrumentation is stable, so drop `experimental.instrumentationHook`.
    - Export `onRequestError = Sentry.captureRequestError` from `src/instrumentation.ts`.
    - `src/instrumentation-client.ts` is native (15.3+). It should export `onRouterTransitionStart = Sentry.captureRouterTransitionStart`.
    - `next.config.ts` is supported.
    - The `middleware` convention is deprecated and renamed `proxy`: use `src/proxy.ts`, with the codemod `npx @next/codemod@canary middleware-to-proxy .`.
    - Proxy runs on the Node.js runtime and cannot set `runtime`; setting it throws. So `sentry.edge.config` is needed only for edge route segments.
    - `headers()` and `cookies()` are async (15+).
    - Turbopack is the default for dev and build, so the webpack-only Sentry options (`webpack.*`, `sentry.client.config.ts`) do not apply.
    - Sentry supports Turbopack from Next 15.4.1.
    - The `src/` placement rule is unchanged: `rootDir` is the parent of `(pagesDir || appDir)`.
  - **If the owner rejects the upgrade:**
    - apply the 14.x mitigations in NX14-ADVISORIES;
    - keep `experimental.instrumentationHook: true` in `next.config.mjs`;
    - run Node 22.12+ or 24. Sentry v11 needs `>=20.19`, and Node 20 reached end-of-life on 2026-04-30.
- **Design consequence:**
  - Add to `docs/DECISIONS.md`: "Next.js 16.x pinned exact (e.g. 16.3.8) instead of 14 — docs/advisories win per §0".
  - Pin Node 24 (`.nvmrc`, `engines.node`, and the Vercel project's Node.js version). Use 22.12+ only as the Vercel fallback.
  - This supersedes the original design note "Pin Node 22".
- **Open risk:**
  - The API changes (async `headers()`/`cookies()`, `proxy.ts`) need care; the fakes and tests are unaffected.
  - The formal Next support-policy text was not fetched, and the 15.x EOL date is community-sourced.
  - Vercel's support for Node 24 could not be checked (vercel.com was blocked). Confirm it in the Vercel project settings at WIRE_UP.
- **Sources:**
  - https://registry.npmjs.org/next — local experiment — "npm view next@16.3.8 engines -> {"node":">=20.9.0"}; next@15.5.27 engines -> {"node":"^18.18.0 || ^19.8.0 || >= 20.0.0"}; next@14.2.35 engines -> {"node":">=18.17.0"}, peer react ^18.2.0"
  - https://nextjs.org/docs/app/api-reference/file-conventions/proxy — official docs source repo (renders to the public docs URL) — "**Note**: The `middleware` file convention is deprecated and has been renamed to `proxy`. ... npx @next/codemod@canary middleware-to-proxy ."
  - https://nextjs.org/docs/app/api-reference/file-conventions/proxy — official docs source repo (renders to the public docs URL) — "Proxy defaults to using the Node.js runtime. The `runtime` config option is not available in Proxy files. Setting the `runtime` config option in Proxy will throw an error."
  - https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client — official docs source repo (renders to the public docs URL) — "| `v15.3`   | `instrumentation-client` introduced |"
  - https://nextjs.org/docs/app/guides/instrumentation — official docs source repo (renders to the public docs URL) — "If you're using the `src` folder, then place the file inside `src` alongside `pages` and `app`."
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/ — official docs source repo (renders to the public docs URL) — "This guide covers manual setup for **Next.js 15+ with Turbopack and App Router**."
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/nextjs/src/config/withSentryConfig/getFinalConfigObjectBundlerUtils.ts — official SDK source — "[@sentry/nextjs] WARNING: You are using the Sentry SDK with Turbopack. The Sentry SDK is compatible with Turbopack on Next.js version 15.4.1 or later."
  - https://github.com/nodejs/Release/blob/main/schedule.json — official docs (Node.js Release schedule, fetched directly) — "v20 {"end":"2026-04-30"}; v22 {"lts":"2024-10-29","maintenance":"2025-10-21","end":"2027-04-30"}; v24 {"lts":"2025-10-28","maintenance":"2026-10-20","end":"2028-04-30"}"
  - https://github.com/endoflife-date/endoflife.date/blob/master/products/nextjs.md — community, non-authoritative — "releaseCycle: "15" ... eol: 2026-10-21 latest: "15.5.27"; releaseCycle: "16" ... eol: false latest: "16.3.8""

### NX14-INSTR-LOCATION — `instrumentation.ts` must sit next to the `app`/`pages` directory, not always in `src/`
- **Brief:** §3 Monitoring: "`instrumentation.ts` MUST live in `src/`; at the repo root it silently never initialises."
- **Verdict:** Corrected — high confidence. The brief's rule holds only for the `src` layout.
- **Finding:**
  - **The rule:** Next.js looks for `instrumentation.{pageExtensions}` ONLY in the PARENT directory of the app/pages directory.
    - Build (14.2.35): `const rootDir = path.join((pagesDir || appDir)!, '..')`.
    - Dev: `getPossibleInstrumentationHookFilenames(path.join(rootDir!, '..'), ...)`.
  - **What it means:**
    - With the `src` layout (`src/app`), the file MUST be `src/instrumentation.ts`; a repo-root `instrumentation.ts` is never picked up.
    - With a root `app/` dir, the file must be at the repo root, and `src/instrumentation.ts` would be ignored.
    - Docs: "place the file in the root of your application or inside a src folder if using one" and "If you're using the src folder, then place the file inside src alongside pages and app".
  - **Precedence and other details (verifier):**
    - The parent is computed from `pagesDir || appDir`, so `pagesDir` wins.
    - `find-pages-dir.ts` prefers `./pages` and `./app` over `./src/pages` and `./src/app`. A stray root-level `pages/` (or `app/`) therefore moves the required location back to the repo root even when `src/app` exists. Docs: "`src/app` or `src/pages` will be ignored if `app` or `pages` are present in the root directory."
    - With a custom `pageExtensions`, the filename must match.
    - The same `rootDir` rule decides where `middleware.ts` is detected.
    - The official e2e fixture `test/e2e/instrumentation-hook-src` confirms the pattern: `src/instrumentation.js` together with `experimental.instrumentationHook: true`.
    - Current canary (16.4.0-canary.55) keeps the same rule.
  - **"Silently" is accurate, and the failure is even quieter than the brief says:**
    - Next prints no build or dev warning for a misplaced file.
    - The prod server's `prepareImpl` swallows `MODULE_NOT_FOUND` when loading `.next/server/instrumentation`.
    - `@sentry/nextjs`'s own check (`getInstrumentationFile`) accepts BOTH `src/instrumentation.*` and `./instrumentation.*`, so Sentry will not warn about a misplaced file either.
    - On Next 14, `@sentry/nextjs` warns about a missing instrumentation file only when the Next major is >= 15. So on Next 14 there is no Sentry warning even when no instrumentation file exists at all.
  - **Rule for this repo:** use the src layout (`src/app`) with `src/instrumentation.ts` next to `app/`. Keep `sentry.server.config.ts` and `sentry.edge.config.ts` beside it, because `register()` imports them by relative path.
- **Design consequence:**
  - Scaffold `src/app` and `src/instrumentation.ts`, plus `src/sentry.server.config.ts`, `src/sentry.edge.config.ts`, `src/instrumentation-client.ts`, and `src/middleware.ts` (or `src/proxy.ts` on 16).
  - Add a CI/unit check that fails if `./instrumentation.ts`, `./app` or `./pages` exists at the repo root, and that asserts `src/instrumentation.ts` exists. The verifier added root `pages/` to this check.
  - Do not set a custom `pageExtensions`.
- **Open risk:** The silent failure mode remains. Mitigate it with the file-layout assertion and a startup log line from `register()`. At WIRE_UP, confirm that the log line appears in the deployed function logs and that a test error reaches Sentry.
- **Sources:**
  - https://nextjs.org/docs/14/app/building-your-application/optimizing/instrumentation — official docs source repo (renders to the public docs URL) — "The `instrumentation` file should be in the root of your project and not inside the `app` or `pages` directory. If you're using the `src` folder, then place the file inside `src` alongside `pages` and `app`."
  - https://nextjs.org/docs/14/app/api-reference/file-conventions/instrumentation — official docs source repo (renders to the public docs URL) — "To use it, place the file in the **root** of your application or inside a [`src` folder](...) if using one."
  - https://nextjs.org/docs/14/app/building-your-application/configuring/src-directory — official docs source repo (renders to the public docs URL) — "`src/app` or `src/pages` will be ignored if `app` or `pages` are present in the root directory."
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/build/index.ts — official SDK source — "L888: const rootDir = path.join((pagesDir || appDir)!, '..') ... L900: const rootPaths = (await getFilesInDir(rootDir)).filter((file) => includes.some((include) => include.test(file)))"
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/server/lib/router-utils/setup-dev-bundler.ts — official SDK source — "const rootDir = pagesDir || appDir ... ...getPossibleInstrumentationHookFilenames(path.join(rootDir!, '..'), nextConfig.pageExtensions)"
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/server/next-server.ts — official SDK source — "L317-339: if (!this.serverOptions.dev && this.nextConfig.experimental.instrumentationHook) { ... await instrumentationHook.register?.() } catch (err) { if (err.code !== 'MODULE_NOT_FOUND') { ... throw err } }"
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/lib/find-pages-dir.ts — official SDK source — "// prioritize ./${name} over ./src/${name} ... const pagesDir = findDir(dir, 'pages') || undefined; const appDir = findDir(dir, 'app') || undefined"
  - https://github.com/vercel/next.js/tree/v14.2.35/test/e2e/instrumentation-hook-src — official SDK source — "files: src/instrumentation.js, src/pages/*.tsx; nextConfig: { experimental: { instrumentationHook: true } }; it('should run the instrumentation hook')"
  - https://github.com/vercel/next.js/blob/canary/packages/next/src/build/index.ts — official SDK source — "Current canary keeps the same rule: L1471 const rootDir = path.join((pagesDir || appDir)!, '..')"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/nextjs/src/config/webpack.ts — official SDK source — "getInstrumentationFile: paths = [['src', `instrumentation${extension}`], [`instrumentation${extension}`]] (accepts either location, so no Sentry warning when Next ignores it)"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/nextjs/src/config/webpack.ts — official SDK source — "if (runtime === "server") { if (major && major >= 15) { warnAboutMissingOnRequestErrorHandler(instrumentationFile, userSentryOptions.silent); } }  (the 'Could not find a Next.js instrumentation file' warning lives inside warnAboutMissingOnRequestErrorHandler)"

### NX14-INSTR-FLAG — Next 14 also needs `experimental.instrumentationHook: true` (a second silent failure)
- **Brief:** not addressed.
- **Verdict:** Extended — high confidence.
- **Finding:**
  - **The flag is required on 14.x.** The default is `instrumentationHook: false` (`config-shared.ts` L930).
    - Without the flag, the build never includes the instrumentation regexp and the prod server never calls `register()`. This is a SECOND silent failure mode.
    - Dev also registers the hook file only when the flag is set.
    - Docs: "Instrumentation is currently an experimental feature, to use the instrumentation file, you must explicitly opt-in by defining experimental.instrumentationHook = true; in your next.config.js".
  - **Sentry's handling:** `@sentry/nextjs`'s `withSentryConfig` auto-injects `experimental.instrumentationHook: true` when it detects Next < 15 (`maybeSetInstrumentationHookOption` / `requiresInstrumentationHook`), and warns if you set it to false.
  - **Next 15+:** instrumentation is stable (v15.0.0) and the flag is obsolete. Current Next warns: "`experimental.instrumentationHook` is no longer needed, because `instrumentation.js` is available by default." Sentry's v8 migration guide likewise marks it "Not required on Next.js 15+".
  - **Config file name:** Next 14 reads only `next.config.js` / `next.config.mjs` (`CONFIG_FILES = ['next.config.js','next.config.mjs']`). `next.config.ts`, used in Sentry's current examples, needs Next 15+.
    - On Next 14, a `next.config.ts` is a **hard error**, not a silent ignore: "Configuring Next.js via 'next.config.ts' is not supported. Please replace the file with 'next.config.js' or 'next.config.mjs'." (verifier precision).
- **Design consequence:**
  - If staying on 14: use `next.config.mjs` (not `.ts`) with `experimental: { instrumentationHook: true }` set explicitly (do not rely only on `withSentryConfig`'s injection), plus a config unit test.
  - If upgrading to 16 (recommended, NX-RECOMMENDATION): remove the flag.
- **Open risk:** None beyond the silent-failure mode, which the config unit test covers.
- **Sources:**
  - https://nextjs.org/docs/14/app/api-reference/file-conventions/instrumentation — official docs source repo (renders to the public docs URL) — "Instrumentation is currently an experimental feature, to use the `instrumentation` file, you must explicitly opt-in by defining `experimental.instrumentationHook = true;` in your `next.config.js`"
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/server/config-shared.ts — official SDK source — "L930: instrumentationHook: false,"
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/build/index.ts — official SDK source — "const instrumentationHookEnabled = Boolean(config.experimental.instrumentationHook) ... ...(instrumentationHookEnabled ? [instrumentationHookDetectionRegExp] : [])"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/nextjs/src/config/withSentryConfig/getFinalConfigObjectUtils.ts — official SDK source — "if (nextJsVersion && util.requiresInstrumentationHook(nextJsVersion)) { ... incomingUserNextConfigObject.experimental = { instrumentationHook: true, ...incomingUserNextConfigObject.experimental }"
  - https://github.com/vercel/next.js/blob/canary/packages/next/src/server/config.ts — official SDK source — "'experimental.instrumentationHook', `experimental.instrumentationHook` is no longer needed, because `instrumentation.js` is available by default."
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/shared/lib/constants.ts — official SDK source — "export const CONFIG_FILES = ['next.config.js', 'next.config.mjs']"
  - https://www.npmjs.com/package/next/v/14.2.35 — official SDK source (npm package dist) — "dist/server/config.js L800: throw new Error(`Configuring Next.js via '${basename(nonJsPath)}' is not supported. Please replace the file with 'next.config.js' or 'next.config.mjs'.`); dist/shared/lib/constants.js L319: const CONFIG_FILES = ["next.config.js", "next.config.mjs"]"
  - https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation — official docs source repo (renders to the public docs URL) — "Version History: `v15.0.0` | `onRequestError` introduced, `instrumentation` stable"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v7-to-v8/ — official docs source repo (renders to the public docs URL) — "First, enable the Next.js instrumentation hook by setting the `experimental.instrumentationHook` to true in your `next.config.js`. (This step is no longer required with Next.js 15) ... instrumentationHook: true, // Not required on Next.js 15+"

### NX14-REGISTER-RUNTIME — `register()` runs once per server instance, in every runtime; gate on `NEXT_RUNTIME`
- **Brief:** not addressed.
- **Verdict:** Confirmed — high confidence.
- **Finding:**
  - **When it runs:** `register` is called ONCE when a new Next.js server instance is initiated, and it may be async. The 14 docs mark it "required"; the current docs mark it optional.
    - Next awaits it before serving. In prod, `NextNodeServer.prepareImpl` runs `await instrumentationHook.register?.()`; in dev, `runInstrumentationHookIfAvailable` does.
    - Current docs: it "must complete before the server is ready to handle requests".
  - **Serverless (Vercel):** each cold-started instance is a new server instance, so init runs per cold start. This is an inference: no official doc says it, but it is consistent with "once per server instance".
  - **Runtimes:** Next calls `register` in ALL runtimes (the build emits both `instrumentation.js` and `edge-instrumentation.js`).
    - Gate on `process.env.NEXT_RUNTIME === 'nodejs'` / `=== 'edge'`, and use `await import(...)` inside `register`. The docs recommend imports inside `register` rather than at top level.
    - In the **Edge** runtime, `register()` does not run at server start. It runs lazily, on the first request handled by each edge isolate (see 09.x V3).
  - **Exact pattern:**
    ```ts
    export async function register() {
      if (process.env.NEXT_RUNTIME === 'nodejs') {
        await import('./sentry.server.config')
      }
      if (process.env.NEXT_RUNTIME === 'edge') {
        await import('./sentry.edge.config')
      }
    }
    ```
- **Design consequence:** Keep `register()` tiny: only `Sentry.init` via a runtime-gated dynamic import. With no DSN (`APP_MODE=fake`, tests) `Sentry.init` is a no-op, so tests need zero credentials.
- **Open risk:** The per-cold-start behaviour on Vercel is an inference. The startup log line (NX14-INSTR-LOCATION) makes it observable at WIRE_UP.
- **Sources:**
  - https://nextjs.org/docs/14/app/api-reference/file-conventions/instrumentation — official docs source repo (renders to the public docs URL) — "### `register` (required) The file exports a `register` function that is called **once** when a new Next.js server instance is initiated. `register` can be an async function."
  - https://nextjs.org/docs/14/app/building-your-application/optimizing/instrumentation — official docs source repo (renders to the public docs URL) — "Next.js calls `register` in all environments, so it's important to conditionally import any code that doesn't support specific runtimes ... if (process.env.NEXT_RUNTIME === 'nodejs') { await import('./instrumentation-node') } if (process.env.NEXT_RUNTIME === 'edge') { await import('./instrumentation-edge') }"
  - https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation — official docs source repo (renders to the public docs URL) — "called **once** when a new Next.js server instance is initiated, and must complete before the server is ready to handle requests."
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/build/index.ts — official SDK source — "L1322-1330: ...(hasInstrumentationHook ? [ ... `${INSTRUMENTATION_HOOK_FILENAME}.js` ... `edge-${INSTRUMENTATION_HOOK_FILENAME}.js` ..."
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/server/dev/next-dev-server.ts — official SDK source — "L588-605: private async runInstrumentationHookIfAvailable() { ... await instrumentationHook.register()"
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/server/web/globals.ts — official SDK source — "let registerInstrumentationPromise = null; export function ensureInstrumentationRegistered() { if (!registerInstrumentationPromise) { registerInstrumentationPromise = registerInstrumentation() } ..."
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/server/web/adapter.ts — official SDK source — "L88: await ensureInstrumentationRegistered()"

### NX14-ONREQUESTERROR — `onRequestError` does not exist in Next 14
- **Brief:** not addressed.
- **Verdict:** Confirmed — high confidence.
- **Finding:**
  - **Not available on 14:** `onRequestError` was introduced in Next v15.0.0, when instrumentation went stable. A grep of v14.2.35 `packages/next/src` finds no `onRequestError` symbol.
  - **Sentry:** "The onRequestError hook requires @sentry/nextjs version 8.28.0 or higher and Next.js 15." Sentry warns about a missing `onRequestError` only when the Next major is >= 15.
  - **How Sentry captures server errors on Next 14 + webpack:** by build-time wrapping, through `webpack.autoInstrumentServerFunctions`, `webpack.autoInstrumentMiddleware` and `webpack.autoInstrumentAppDirectory` (all default `true`).
    - Server Actions are NOT auto-instrumented; wrap them with `Sentry.withServerActionInstrumentation()`.
  - Exporting `onRequestError = Sentry.captureRequestError` on 14 is dead code.
- **Design consequence:**
  - On 14: rely on webpack auto-instrumentation, `global-error.tsx` and an explicit `captureException` in job handlers. Avoid Server Actions or wrap them.
  - On 15/16: add `export const onRequestError = Sentry.captureRequestError`. Its `request.headers` carry cookies and authorization, so scrubbing must clear `event.request.headers`.
- **Open risk:** None.
- **Sources:**
  - https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation — official docs source repo (renders to the public docs URL) — "| `v15.0.0` | `onRequestError` introduced, `instrumentation` stable |"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/ — official docs source repo (renders to the public docs URL) — "The `onRequestError` hook requires `@sentry/nextjs` version `8.28.0` or higher and Next.js 15."
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/webpack-setup/ — official docs source repo (renders to the public docs URL) — "These options instrument Pages Router pages, API routes, and App Router components, but do NOT automatically instrument Server Actions. Server Actions require manual wrapping using `withServerActionInstrumentation()`."
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/nextjs/src/config/webpack.ts — official SDK source — "if (runtime === 'server') { if (major && major >= 15) { warnAboutMissingOnRequestErrorHandler(instrumentationFile, ...) } }"
  - https://github.com/vercel/next.js/tree/v14.2.35/packages/next/src — local experiment — "grep -rln 'onRequestError' packages/next/src at tag v14.2.35 -> no matches"

### NX-CSP-HEADERS — Nonce CSP in middleware/proxy, static security headers, and the nonce-XSS caveat on 14
- **Brief:** §7: "CSP and security headers." No further detail.
- **Verdict:** Extended — high confidence. One sub-claim is a medium-confidence inference with no official source: that the official matcher lets prefetch requests bypass header stripping (see Open risk).
- **Finding:**
  - **(A) Nonce via Middleware (Next 14 docs):**
    - **Nonce:** generate one per request with `const nonce = Buffer.from(crypto.randomUUID()).toString('base64')`.
    - **Headers:** set `x-nonce` and `Content-Security-Policy` on the REQUEST headers passed to `NextResponse.next({ request: { headers } })`, and on the response.
    - **Policy:**
      ```text
      default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'nonce-${nonce}'; img-src 'self' blob: data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests;
      ```
    - **Dynamic rendering:** the docs say "you must use dynamic rendering to add nonces".
    - **How Next 14 applies the nonce:** it reads the nonce from the request `content-security-policy` header (or `content-security-policy-report-only`), taking `script-src` first, else `default-src`, and applies it to framework scripts.
      - Server Components read it via `headers().get('x-nonce')`.
      - `getScriptNonceFromHeader` throws if the nonce contains HTML escape characters.
    - **Matcher:**
      ```ts
      { source: '/((?!api|_next/static|_next/image|favicon.ico).*)', missing: [{ type: 'header', key: 'next-router-prefetch' }, { type: 'header', key: 'purpose', value: 'prefetch' }] }
      ```
    - **Version:** the docs recommend Next >= 13.4.20.
  - **(B) Without nonces:**
    - **14 docs:** a static CSP via `next.config.js` `headers()` for source `'/(.*)'`, with `script-src 'self' 'unsafe-eval' 'unsafe-inline'`.
    - **Current docs:** `'unsafe-inline'` plus `'unsafe-eval'` in development only ("In development, unsafe-eval is required ... not required for production").
    - **Cost of nonces:** they make all pages dynamic, so there is no static optimisation or ISR, and Partial Prerendering (PPR) is incompatible.
    - **Hash-based alternative:** experimental SRI (`experimental.sri.algorithm`, since v14.0.0).
  - **Other headers (Next `headers` docs):**
    - `X-DNS-Prefetch-Control: on`
    - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
    - `X-Frame-Options: SAMEORIGIN` (superseded by CSP `frame-ancestors`)
    - `Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()`
    - `X-Content-Type-Options: nosniff`
    - `Referrer-Policy: origin-when-cross-origin`
    - `poweredByHeader: false` removes `x-powered-by`.
  - **HSTS on Vercel:** the 14 docs said Vercel auto-adds HSTS "unless you declare `headers` in your `next.config.js`". That sentence was removed from the current docs, so set HSTS explicitly.
  - **14.2.35 caveat:** GHSA-ffhc-5mcf-pf4q (nonce XSS via a request-derived nonce behind shared caches) is unpatched on 14.
    - The workaround is to "strip inbound Content-Security-Policy request headers from untrusted traffic".
    - The official matcher SKIPS prefetch requests. Those requests then render with any attacker-supplied CSP request header. This is the agent's inference, not an official statement.
    - 16.3.8 is outside the advisory's vulnerable range (`>=13.4.0 <15.5.16`; NX14-ADVISORIES).
- **Design consequence:**
  - **CSP:** use a nonce-based CSP in middleware/proxy for all HTML routes; the app is mostly dynamic anyway.
    - The middleware must ALWAYS delete inbound `content-security-policy` and `content-security-policy-report-only` request headers before setting its own.
    - While on 14, it must also run on prefetch requests.
    - Put `frame-ancestors 'none'` in the CSP.
    - Set `connect-src` to `'self'` plus the Sentry ingest origin (SENTRY-TUNNEL-CSP).
  - **Static headers** go in `next.config` `headers()` with `poweredByHeader: false`:
    - HSTS;
    - `nosniff`;
    - `Permissions-Policy`;
    - `Referrer-Policy: no-referrer` for action pages, `strict-origin-when-cross-origin` elsewhere.
  - **Tests:** unit-test the CSP builder:
    - the nonce is present;
    - production `script-src` has no `'unsafe-inline'`;
    - `'unsafe-eval'` appears only in development.
- **Open risk:**
  - The prefetch-bypass point is a medium-confidence inference. It matters only if the app stays on 14, and the "always strip" rule covers it either way.
  - At WIRE_UP, check the live response headers on a page and on an action link (`curl -I`): CSP with a nonce, HSTS, no `x-powered-by`, and the Referrer-Policy values. This confirms Vercel's current HSTS behaviour, which the current docs no longer describe.
- **Sources:**
  - https://nextjs.org/docs/14/app/building-your-application/configuring/content-security-policy — official docs source repo (renders to the public docs URL) — "Every time a page is viewed, a fresh nonce should be generated. This means that you **must use dynamic rendering to add nonces**. ... const nonce = Buffer.from(crypto.randomUUID()).toString('base64') ... requestHeaders.set('x-nonce', nonce) ... We recommend using `v13.4.20+` of Next.js to properly handle and apply nonces."
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/server/app-render/app-render.tsx — official SDK source — "L898-902: req.headers['content-security-policy'] || req.headers['content-security-policy-report-only'] ... nonce = getScriptNonceFromHeader(csp)"
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/server/app-render/get-script-nonce-from-header.tsx — official SDK source — "directives.find((dir) => dir.startsWith('script-src')) || directives.find((dir) => dir.startsWith('default-src')) ... if (ESCAPE_REGEX.test(nonce)) { throw new Error('Nonce value from Content-Security-Policy contained HTML escape characters. ...') }"
  - https://nextjs.org/docs/app/guides/content-security-policy — official docs source repo (renders to the public docs URL) — "In development, `'unsafe-eval'` is required because React uses `eval` ... `unsafe-eval` is not required for production. ... When you use nonces in your CSP, **all pages must be dynamically rendered** ... **Partial Prerendering (PPR) is incompatible** with nonce-based CSP ... | `v14.0.0` | Experimental SRI support added for hash-based CSP |"
  - https://nextjs.org/docs/14/app/api-reference/next-config-js/headers — official docs source repo (renders to the public docs URL) — "If you're deploying to Vercel, this header is not necessary as it's automatically added to all deployments unless you declare `headers` in your `next.config.js`. { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' } ... { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' } ... { key: 'Referrer-Policy', value: 'origin-when-cross-origin' }"
  - https://nextjs.org/docs/app/api-reference/config/next-config-js/poweredByHeader — official docs source repo (renders to the public docs URL) — "By default Next.js will add the `x-powered-by` header. To opt-out of it ... poweredByHeader: false,"
  - https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2026/05/GHSA-ffhc-5mcf-pf4q/GHSA-ffhc-5mcf-pf4q.json — official docs (GitHub-reviewed advisory record, fetched directly) — "malformed nonce values derived from request headers could be reflected into rendered HTML in an unsafe way ... strip inbound `Content-Security-Policy` request headers from untrusted traffic."

### SENTRY-NEXTJS-VERSIONS — `@sentry/nextjs` majors, Next and Node ranges; pin 11.2.0 exactly
- **Brief:** not addressed. §3 says only "Monitoring: Sentry."
- **Verdict:** Extended — high confidence.
- **Finding:**
  - **npm dist-tags (2026-10-01):**
    - `latest` = `11.2.0` (11.0.0 was published 2026-09-23; 11.1.0 on 2026-09-28; 11.2.0 on 2026-10-01T11:07Z);
    - `v10` = `10.75.3`;
    - `v9` = `9.47.2`;
    - `v8` = `8.55.2`;
    - also `v7` = `7.120.4` and `next` = `11.0.0-rc.1`.
  - **`peerDependencies.next`:**
    - 8.55.2 and 9.47.2: `'^13.2.0 || ^14.0 || ^15.0.0-rc.0'`;
    - 10.75.3: `'^13.2.0 || ^14.0 || ^15.0.0-rc.0 || ^16.0.0-0'`;
    - 11.x: `'^14.0 || ^15.0.0-rc.0 || ^16.0.0-0'`. Next 13 is dropped: "The minimum version is 14".
  - **`engines.node`:**
    - 8.x: `'>=14.18'`;
    - 9.x/10.x: `'>=18'`;
    - 11.x: `'>=20.19.0 <22.0.0 || >=22.12.0 <23.0.0 || >=23.2.0'`.
  - **`@sentry/nextjs@11.2.0` dependencies:** it depends on `@sentry/node` `11.2.0` exactly. `@sentry/react` 11.2.0's peer `react` range is `'17.x || 18.x || 19.x'`.
  - **v11 breaking changes relevant here:**
    - `withSentryConfig` moved to `'@sentry/nextjs/config'`;
    - `sendDefaultPii` is replaced by `dataCollection`, whose defaults are permissive;
    - span streaming is the default, so `beforeSendTransaction` is a no-op;
    - `enableLogs` and `enableMetrics` are removed;
    - long-deprecated top-level `withSentryConfig` options are removed (use `webpack.*`);
    - the default `environment` on Vercel is `VERCEL_TARGET_ENV`.
  - **Recommendation:** `@sentry/nextjs` 11.2.x, pinned exactly, with an explicit restrictive `dataCollection`. 10.75.3 is the only option whose defaults are restrictive without config, but it is the previous major.
- **Design consequence:**
  - In `package.json`, pin `"@sentry/nextjs": "11.2.0"` exactly.
  - Import `withSentryConfig` from `'@sentry/nextjs/config'`.
  - TS strict rejects `sendDefaultPii` in v11, because it was removed from the `Options` type.
  - Node version: the original note said `engines.node ">=22.12.0"` and `.nvmrc 22`. NX-RECOMMENDATION's correction supersedes it: prefer Node 24, with 22.12+ only as the Vercel fallback. Either satisfies v11's range.
- **Open risk:** The v11 major is 8 days old, and 11.2.0 was published on the research day. Before M1 locks versions, and again at WIRE_UP, check for a newer 11.x patch and re-run the envelope test (SENTRY-SCRUBBER-TEST) after any bump.
- **Sources:**
  - https://www.npmjs.com/package/@sentry/nextjs — local experiment — "npm view @sentry/nextjs@11.2.0 peerDependencies engines -> {"next":"^14.0 || ^15.0.0-rc.0 || ^16.0.0-0"}, {"node":">=20.19.0 <22.0.0 || >=22.12.0 <23.0.0 || >=23.2.0"}; @10.75.3 -> next '^13.2.0 || ^14.0 || ^15.0.0-rc.0 || ^16.0.0-0', node '>=18'"
  - https://www.npmjs.com/package/@sentry/nextjs — local experiment — "npm view @sentry/nextjs time: 11.0.0 2026-09-23T12:38:07Z, 11.1.0 2026-09-28T15:09:14Z, 11.2.0 2026-10-01T11:07:43Z, 10.75.3 2026-09-23T14:05:14Z; @sentry/nextjs@11.2.0 dependencies -> "@sentry/node": "11.2.0""
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v10-to-v11/ — official docs source repo (renders to the public docs URL) — "Next.js 13 is no longer supported. The minimum version is **14**."
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v10-to-v11/ — official docs source repo (renders to the public docs URL) — "// After import { withSentryConfig } from "@sentry/nextjs/config"; ... The `SentryBuildOptions` type moved with it"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v10-to-v11/ — official docs source repo (renders to the public docs URL) — "Node.js 18 is no longer supported. The minimum is **20.19.0**, and Node.js 22 needs **22.12** or higher"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/ — official docs source repo (renders to the public docs URL) — "Prerequisites: A Next.js application on version 14 or higher; Node.js 20.19.0 or higher"

### SENTRY-SETUP-FILES — Sentry files, `global-error.tsx` and `withSentryConfig` options
- **Brief:** not addressed. §3 says "Monitoring: Sentry"; §10 WIRE_UP step 8 says "Add the Sentry DSN".
- **Verdict:** Extended — high confidence.
- **Finding:**
  - **Current Sentry setup:**
    - `instrumentation-client.ts` (browser);
    - `sentry.server.config.ts`;
    - `sentry.edge.config.ts`;
    - `instrumentation.ts`: `register` imports the server/edge configs, plus `export const onRequestError = Sentry.captureRequestError` on Next 15+;
    - `app/global-error.tsx`;
    - `withSentryConfig(nextConfig, {...})`.
    - The files go "in your application's root directory (or src folder if you have one)".
  - **Next 14 specifics:**
    - **(a) Client init file:**
      - Next only supports `instrumentation-client` from v15.3. On 14, `@sentry/nextjs`'s WEBPACK config injects the file itself into the `main-app` and `pages/_app` client entries. It looks for `src/instrumentation-client.(ts|js)` or `./instrumentation-client.(ts|js)`, and for the legacy `./sentry.client.config.(ts|js)`. The legacy file is ROOT ONLY, deprecated, and "ignored entirely by Turbopack builds".
      - So on 14 + webpack, use `src/instrumentation-client.ts`.
      - The `onRouterTransitionStart` export is a no-op on 14, but Sentry warns if it is missing; `warnIfMissingOnRouterTransitionStartHook` fires for any Next version.
      - The file is not injected under `next dev --turbo`. Sentry explicitly does not support Turbopack on 14 (it needs 15.4.1+), so do not use `next dev --turbo` with Sentry on 14.
    - **(b) Config file:** it must be `next.config.mjs` on 14. `next.config.ts` is a hard build error.
    - **(c) Tracing on the 14 App Router:** the root layout needs a `generateMetadata` that returns `other: { ...Sentry.getTraceData() }`. Sentry auto-adds `experimental.clientTraceMetadata` only for Next >=14.3/15, under the condition `major >= 15 || major === 14 && minor >= 3`. 14.3 shipped only as a canary, so stable 14.2.x needs the snippet. This applies only if tracing is ever enabled; v1 runs no tracing.
  - **`global-error.tsx` (Sentry docs):**
    ```tsx
    "use client";
    import * as Sentry from "@sentry/nextjs";
    import NextError from "next/error";
    import { useEffect } from "react";
    export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
      useEffect(() => { Sentry.captureException(error); }, [error]);
      return (<html><body><NextError statusCode={0} /></body></html>);
    }
    ```
    - If `app/global-error.*` is missing, Sentry logs a build-time notice via `logger.log` (not a warning): "It seems like you don't have a global error handler set up." It resolves the app dir as `./app` first, then `./src/app`.
  - **`withSentryConfig` build options (v11):**
    - credentials and identity: `org` (`SENTRY_ORG`), `project` (`SENTRY_PROJECT`), `authToken` (`SENTRY_AUTH_TOKEN`), `sentryUrl`, `headers`;
    - logging and behaviour: `telemetry`, `silent`, `debug`, `errorHandler`;
    - source maps: `sourcemaps.{disable,assets,ignore,deleteSourcemapsAfterUpload (default true),filesToDeleteAfterUpload}`;
    - releases: `release.{name,create,finalize,dist}`;
    - bundle size: `bundleSizeOptimizations.{excludeDebugStatements,excludeTracing}`;
    - other: `widenClientFileUpload`, `tunnelRoute`, `useRunAfterProductionCompileHook` (Next 15.4.1+), `routeManifestInjection`, `reactComponentAnnotation`, `applicationKey`, `buildTimeInstrumentation`;
    - webpack: `webpack.{autoInstrumentServerFunctions, autoInstrumentMiddleware, autoInstrumentAppDirectory (all default true), excludeServerRoutes, automaticVercelMonitors (default false), treeshake.removeDebugLogging}`;
    - also `_experimental.vercelCronsMonitoring` (verifier).
  - **Removed in v11** (moved under `webpack.*` etc.): `autoInstrumentServerFunctions`, `autoInstrumentMiddleware`, `autoInstrumentAppDirectory`, `automaticVercelMonitors`, `excludeServerRoutes`, `disableSentryWebpackConfig` (now `webpack.disableSentryConfig`), `disableLogger` (now `webpack.treeshake.removeDebugLogging`), `disableManifestInjection`, `_experimental.turbopackApplicationKey`, and `unstable_sentryWebpackPluginOptions` ("Set the plugin options as build options").
- **Design consequence:**
  - **File list (src layout):**
    - `src/instrumentation.ts`
    - `src/instrumentation-client.ts`
    - `src/sentry.server.config.ts`
    - `src/sentry.edge.config.ts`
    - `src/app/global-error.tsx`
    - ONE shared module (e.g. `src/lib/observability/sentry-options.ts`) that exports the scrubber and the `dataCollection` block, so all three inits use identical settings and the tests import the same module.
  - `global-error` must not render `error.message`.
  - Do not set `sideEffects: false` in `package.json`. The research design notes cite Sentry troubleshooting that it tree-shakes `Sentry.init`; that quote was not captured in the sources.
  - Set `SENTRY_AUTH_TOKEN` only as a CI/Vercel build env var, never as `NEXT_PUBLIC_`.
- **Open risk:** None.
- **Sources:**
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/ — official docs source repo (renders to the public docs URL) — "Create the following files in your application's root directory (or `src` folder if you have one): `instrumentation-client.ts` ... `sentry.server.config.ts` ... `sentry.edge.config.ts`"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/ — official docs source repo (renders to the public docs URL) — "global-error.tsx: useEffect(() => { Sentry.captureException(error); }, [error]); ... <NextError statusCode={0} />"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/nextjs/src/config/webpack.ts — official SDK source — "getClientSentryConfigFile: ['sentry.client.config.ts','sentry.client.config.js'] (projectDir only); getInstrumentationClientFile: [['src','instrumentation-client.js'],['src','instrumentation-client.ts'],['instrumentation-client.js'],['instrumentation-client.ts']]; addSentryToClientEntryProperty: if (entryPointName === 'pages/_app' || entryPointName === 'main-app') addFilesToWebpackEntryPoint(...)"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/nextjs/src/config/webpack.ts — official SDK source — "logger.log("[@sentry/nextjs] It seems like you don't have a global error handler set up. ...") (appDirPath resolved as ./app first, then ./src/app)"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/pages-router/ — official docs source repo (renders to the public docs URL) — "Older setups initialized the browser SDK in `sentry.client.config.ts`. That file is deprecated and is **ignored entirely by Turbopack builds**"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing/distributed-tracing/ — official docs source repo (renders to the public docs URL) — "In order to enable distributed tracing for App Router on Next.js 14 you need to add or modify the `generateMetadata` function of your root layout: ... other: { ...Sentry.getTraceData(), }"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/nextjs/src/config/withSentryConfig/getFinalConfigObjectUtils.ts — official SDK source — "if (major !== void 0 && minor !== void 0 && (major >= 15 || major === 14 && minor >= 3)) { ... experimental.clientTraceMetadata = ["baggage", "sentry-trace", ...] }"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/build/ — official docs source repo (renders to the public docs URL) — "SdkOption names: org, project, authToken, sentryUrl, headers, telemetry, silent, debug, errorHandler, sourcemaps.*, release.*, bundleSizeOptimizations.*, widenClientFileUpload, tunnelRoute, useRunAfterProductionCompileHook, routeManifestInjection, reactComponentAnnotation, applicationKey, buildTimeInstrumentation, webpack.autoInstrumentServerFunctions ... webpack.treeshake"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v10-to-v11/ — official docs source repo (renders to the public docs URL) — "Removed option -> Replacement: autoInstrumentServerFunctions -> webpack.autoInstrumentServerFunctions ... disableLogger -> webpack.treeshake.removeDebugLogging ... unstable_sentryWebpackPluginOptions -> Set the plugin options as build options"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/nextjs/src/config/withSentryConfig/getFinalConfigObjectBundlerUtils.ts — official SDK source — "[@sentry/nextjs] WARNING: You are using the Sentry SDK with Turbopack. The Sentry SDK is compatible with Turbopack on Next.js version 15.4.1 or later."

### SENTRY-TUNNEL-CSP — No `tunnelRoute` in v1; CSP `connect-src` must allow the DSN's ingest origin
- **Brief:** not addressed. §7 says "CSP and security headers".
- **Verdict:** Extended — medium confidence.
- **Finding:**
  - **How `tunnelRoute` works:** it takes a `'/path'` string, or `true` for a random route per build.
    - `withSentryConfig` implements it as a Next.js REWRITE from `${tunnelPath}(/?)` with has-query captures `o=(?<orgid>\d*)`, `p=(?<projectid>\d*)` and an optional `r=(?<region>[a-z]{2})`.
    - The destination is `https://o:orgid.ingest.:region.sentry.io/api/:projectid/envelope/?hsts=0`, or the same without the region.
    - It "doesn't currently work with self-hosted Sentry instances".
    - v11: "Webpack builds no longer bypass your middleware for tunnelRoute requests". Use a fixed string and exclude it from the middleware matcher.
  - **CSP:**
    - Without a tunnel, the browser posts envelopes to the DSN host, so `connect-src` must allow it. The Sentry loader docs give "connect-src: *.sentry.io" as the example.
    - With a same-origin tunnel, `connect-src 'self'` suffices.
    - Session Replay additionally needs `worker-src 'self' blob:`.
  - **Advisory exposure on 14:**
    - The tunnel rewrite builds its destination HOSTNAME from request query captures. That is the shape covered by GHSA-p9j2-gv94-2wf4, which is unpatched on 14.2.35.
    - Sentry constrains the captures to digits and `[a-z]{2}`, matching the advisory's workaround.
    - Next 14 anchors `has` values (`new RegExp("^" + hasItem.value + "$")`), so the captures really are restricted to digits and exactly two lowercase letters. That is stricter than the advisory's workaround `[a-z0-9-]+`.
    - The residual risk is theoretical, because the advisory does not publish its root cause. Still, on 14.x prefer no tunnel.
- **Design consequence:**
  - v1: no `tunnelRoute`, no Session Replay, no browser tracing.
  - CSP `connect-src` = `'self'` plus the DSN's ingest origin, derived at build time from `NEXT_PUBLIC_SENTRY_DSN`. The static alternative is `*.ingest.sentry.io` / `*.ingest.us.sentry.io` / `*.ingest.de.sentry.io`.
  - If a tunnel is added later on 15/16: use a fixed path, excluded from the proxy/middleware matcher and from the rate limiter.
- **Open risk:** The exact per-region ingest host format was not verified on live docs.sentry.io (blocked). Derive it from the DSN rather than hard-coding it. At WIRE_UP, trigger a browser-side test error with the CSP enforced, and confirm it arrives with no CSP violation in the console.
- **Sources:**
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/nextjs/src/config/withSentryConfig/tunnel.ts — official SDK source — "const destination = destinationOverride || "https://o:orgid.ingest.sentry.io/api/:projectid/envelope/?hsts=0"; const destinationWithRegion = ... "https://o:orgid.ingest.:region.sentry.io/api/:projectid/envelope/?hsts=0"; has: [{ type: 'query', key: 'o', value: '(?<orgid>\\d*)' }, ...]"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/build/ — official docs source repo (renders to the public docs URL) — "tunnelRoute: This feature requires **Next.js version 11+** and doesn't currently work with self-hosted Sentry instances. ... `true` for auto-generated routes, which are unpredictable and change with each deployment."
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v10-to-v11/ — official docs source repo (renders to the public docs URL) — "Webpack builds no longer bypass your middleware for `tunnelRoute` requests. If your middleware blocks unauthenticated requests globally, set `tunnelRoute` to a fixed string instead of `true` and exclude that path in your middleware `matcher`"
  - https://docs.sentry.io/platforms/javascript/install/loader/ — official docs source repo (renders to the public docs URL) — "If you have a Content Security Policy (CSP) set up on your site, you will need to add the `script-src` of wherever you're loading the SDK from, and the origin of your DSN. For example: ... `connect-src: *.sentry.io`"
  - https://docs.sentry.io/platforms/javascript/session-replay/troubleshooting/ — official docs source repo (renders to the public docs URL) — "make sure to include `worker-src 'self' blob:` in your `Content-Security-Policy` header"
  - https://www.npmjs.com/package/next/v/14.2.35 — official SDK source (npm package dist) — "dist/shared/lib/router/utils/prepare-destination.js L100: const matcher = new RegExp("^" + hasItem.value + "$");"

### SENTRY-V11-DATA-DEFAULTS — v11 removed `sendDefaultPii`, and an unset `dataCollection` collects everything
- **Brief:** §7 "Sentry `beforeSend` scrubbing" and §2 law 4 ("Never log tokens, message text or drafts; scrub them from logs and Sentry"). Both imply the defaults are safe and `beforeSend` is enough.
- **Verdict:** Corrected — high confidence.
- **Finding:**
  - **The change:** in `@sentry/*` v11, `sendDefaultPii` no longer exists. It is replaced by `dataCollection`: "In v10, an unset sendDefaultPii was restrictive. In v11, an unset dataCollection collects everything by default."
  - **v11 DEFAULTS** (`resolveDataCollectionOptions`):
    ```ts
    { userInfo: true, cookies: true, httpHeaders: { request: true, response: true }, httpBodies: ['incomingRequest','outgoingRequest','incomingResponse','outgoingResponse'], urlQueryParams: true, graphQL: { document: true, variables: true }, genAI: { inputs: true, outputs: true }, databaseQueryData: true, queues: true, stackFrameVariables: true, frameContextLines: 5 }
    ```
  - **The built-in denylist:** only VALUES whose KEY NAME partially matches it become `'[Filtered]'`:
    ```ts
    ['auth','token','secret','session','password','passwd','pwd','key','jwt','bearer','sso','saml','csrf','xsrf','credentials','sid','identity','set-cookie','cookie']
    ```
    - Sentry's own words: "The match runs on the key name, so treat it as best effort".
    - It does NOT filter `code` or `state` (the OAuth callback params), nor arbitrary JSON body fields such as the lead's `message`.
    - Cookies also go through an extra `SENSITIVE_COOKIE_NAME_SNIPPETS` list.
  - **Request bodies:**
    - Incoming request bodies are captured at `'medium'` size when `httpBodies` includes `'incomingRequest'`, which is the default. Webhook payloads and form posts therefore get attached to error events.
    - The denylist is applied only to headers, cookies and query params. Captured REQUEST BODIES are attached verbatim, with no key filtering (`requestdata.js`: `if (include.data) { requestData.data = normalizedRequest.data; }`). Even a body key named `token` is sent unfiltered.
    - Body capture runs in the Http integration's server `'request'` hook and does not depend on incoming-request spans, which `@sentry/nextjs` disables (`disableIncomingRequestSpans: true`). See 09.x V2.
  - **URLs:** "The full request URL of outgoing and incoming HTTP requests is always sent to Sentry."
  - **v10 comparison (`sendDefaultPii` unset):**
    - `userInfo: false`;
    - cookies/headers/query: `{deny: PII snippets}`;
    - `httpBodies: []`;
    - `genAI {inputs:false, outputs:false}`;
    - `databaseQueryData: false`.
    - The docs table says v10 cookies were "not collected", while the v10 SDK maps them to `{ deny: PII_HEADER_SNIPPETS }`.
  - **Related defaults:**
    - `includeLocalVariables` defaults to `false`, so `stackFrameVariables` has no effect unless that is enabled.
    - `frameContextLines: 0` disables source context (`contextlines.js`: `if (contextLines > 0 ...)`).
- **Design consequence:**
  - Every `Sentry.init` (server, edge, client) must pass the SAME explicit block:
    ```ts
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false }, databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0 }
    ```
  - Keep `includeLocalVariables` false (the default).
  - Unit-test that the exported options equal this block. This guards against future SDK default changes.
  - `httpBodies: []` is mandatory, because bodies bypass the denylist.
- **Open risk:** Future SDK default changes are caught only by the options-equality test.
- **Sources:**
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v10-to-v11/ — official docs source repo (renders to the public docs URL) — "`sendDefaultPii` is replaced by `dataCollection` ... This is a behavior change, not a rename. In v10, an unset `sendDefaultPii` was restrictive. In v11, an unset `dataCollection` collects everything by default."
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/utils/data-collection/resolveDataCollectionOptions.ts — official SDK source — "const DEFAULTS = { userInfo: true, cookies: true, httpHeaders: { request: true, response: true }, httpBodies: ["incomingRequest", "outgoingRequest", "incomingResponse", "outgoingResponse"], urlQueryParams: true, graphQL: { document: true, variables: true }, genAI: { inputs: true, outputs: true }, databaseQueryData: true, queues: true, stackFrameVariables: true, frameContextLines: 5 };"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/utils/data-collection/filtering-snippets.ts — official SDK source — "const FILTERED_VALUE = "[Filtered]"; const SENSITIVE_KEY_SNIPPETS = ["auth","token","secret","session","password","passwd","pwd","key","jwt","bearer","sso","saml","csrf","xsrf","credentials","sid","identity","set-cookie","cookie"]"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/integrations/http/server-subscription.ts — official SDK source — "const effectiveBodySize = configuredBodySize ?? (client.getDataCollectionOptions().httpBodies.includes("incomingRequest") ? "medium" : "none");"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/integrations/requestdata.ts — official SDK source — "function extractNormalizedRequestData(normalizedRequest, include) { ... if (include.data) { requestData.data = normalizedRequest.data; } ... }  (no filterKeyValueData call on data)"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/integrations/http/patch-request-to-capture-body.ts — official SDK source — "isolationScope.setSDKProcessingMetadata({ normalizedRequest: { data: truncatedBody } });"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/nextjs/src/server/index.ts — official SDK source — "node.getDefaultIntegrations(options).filter((integration) => integration.name !== "Http").concat(node.httpIntegration({ disableIncomingRequestSpans: true }))"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/data-management/data-collected/ — official docs source repo (renders to the public docs URL) — "The full request URL of outgoing and incoming HTTP requests is **always sent to Sentry**. ... By default, incoming and outgoing request bodies are collected. To disable body collection, set `dataCollection: { httpBodies: [] }`."
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/ — official docs source repo (renders to the public docs URL) — "dataCollection (availableSince 10.57.0): In version 10 of the SDK, the defaults below apply only when you set the `dataCollection` option. Without it, the deprecated `sendDefaultPii` option controls data collection. Starting with version 11, the defaults always apply. ... includeLocalVariables defaultValue='false'"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/utils/data-collection/defaultPiiToCollectionOptions.ts — official SDK source — "v10.75.3: sendDefaultPii !== true -> { userInfo: false, cookies: { deny: PII_HEADER_SNIPPETS }, ..., httpBodies: [], ..., genAI: { inputs: false, outputs: false }, databaseQueryData: false, ... }"

### SENTRY-GENAI-ANTHROPIC — With tracing on, Sentry records every Anthropic prompt and completion by default
- **Brief:** not addressed. Relevant to §2 law 4, §3 AI and §12.
- **Verdict:** Extended — high confidence.
- **Finding:**
  - **Yes, by default in v11 when tracing is on.** `anthropicAIIntegration` (integration name `'Anthropic_AI'`) is one of `@sentry/node`'s tracing-only default integrations.
  - **When tracing counts as on:** the integration is added when `hasSpansEnabled(options)` is true, i.e. `tracesSampleRate != null` or `tracesSampler` is set. If `tracesSampleRate` is undefined, the Node SDK falls back to the env var `SENTRY_TRACES_SAMPLE_RATE`.
    - Precision from a local experiment with `@sentry/nextjs` 11.2.0: its server init computes `defaultIntegrations` from the raw user options BEFORE `@sentry/node` resolves `SENTRY_TRACES_SAMPLE_RATE`.
    - So the env var alone gives `tracesSampleRate=1` but `Anthropic_AI=false`, while an explicit `tracesSampleRate: 0.1` gives `Anthropic_AI=true`.
    - The env var still turns tracing on, and with it the span/DSC leaks (SENTRY-HOOKS-STREAMING). So "must stay unset" remains correct.
  - **What it instruments:** `@anthropic-ai/sdk` `messages.create()`, `messages.stream()`, `completions.create()` and `beta.messages.create()`, for SDK versions `'>=0.19.2 <1.0.0'`. `@anthropic-ai/sdk` latest is 0.131.0, inside the range. The integration "Requires SDK version `11.0.0` or higher" (of the Sentry SDK).
  - **What it records:**
    - `recordInputs`/`recordOutputs` "Defaults to true if dataCollection.genAI.inputs/outputs is true, which is the default."
    - Inputs are system instructions, prompt messages, tool definitions and tool-call args. Outputs are completion text and tool results.
    - In this product, the lead's message and every draft would be sent as `gen_ai` span attributes.
  - **Database integrations:** the same tracing-only set includes Postgres, PostgresJs and Prisma. With `databaseQueryData` defaulting to true, they send bound params and rows.
- **Design consequence:**
  - The v1 server is errors-only: no `tracesSampleRate` or `tracesSampler`, and the docs must say that `SENTRY_TRACES_SAMPLE_RATE` stays unset.
  - As defence in depth, still set `dataCollection.genAI {inputs:false, outputs:false}` and `integrations: (d) => d.filter(i => i.name !== 'Anthropic_AI')`.
  - Test that the server options yield no `'Anthropic_AI'` integration and have `genAI` false.
- **Open risk:** At WIRE_UP, confirm that `SENTRY_TRACES_SAMPLE_RATE` does not exist in any Vercel environment.
- **Sources:**
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/integrations/anthropic/ — official docs source repo (renders to the public docs URL) — "This integration is enabled by default when tracing is enabled. ... recordInputs ... Defaults to `true` if `dataCollection.genAI.inputs` is `true`, which is the default."
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/integrations/anthropic/ — official docs source repo (renders to the public docs URL) — "Requires SDK version `11.0.0` or higher."
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/server-utils/src/integrations/index.ts — official SDK source — "function getTracingIntegrations() { return [ graphqlIntegration(), ..., postgresIntegration(), prismaIntegration(), ..., openAIIntegration(), anthropicAIIntegration(), ..., postgresJsIntegration(), ... ] }"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/node/src/sdk/index.ts — official SDK source — "...hasSpansEnabled(options) ? getTracingIntegrations() : [] ... const sampleRateFromEnv = process.env.SENTRY_TRACES_SAMPLE_RATE;"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/utils/hasSpansEnabled.ts — official SDK source — "(options.tracesSampleRate != null || !!options.tracesSampler)"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/data-management/data-collected/ — official docs source repo (renders to the public docs URL) — "The content of generative AI inputs (system instructions, prompt messages, tool definitions, and tool call arguments) and outputs (such as completion text and tool call results) might carry personal data. By default, the SDK records both inputs and outputs."
  - https://www.npmjs.com/package/@sentry/node/v/11.2.0 — local experiment — "node -e getDefaultIntegrations({tracesSampleRate:1}) -> includes 'Anthropic_AI','OpenAI','Postgres','PostgresJs','Console','Http','NodeFetch','RequestData','LocalVariablesAsync'; getDefaultIntegrations({}) -> no AI/DB integrations"
  - https://www.npmjs.com/package/@sentry/nextjs/v/11.2.0 — local experiment — "verify-nx/exp-nx2/t.cjs (npm i next@14.2.35 @sentry/nextjs@11.2.0; Node 22.22.0): no env -> {"tracesSampleRate":null,"Anthropic_AI":false,"Postgres":false}; SENTRY_TRACES_SAMPLE_RATE=1 -> {"tracesSampleRate":1,"Anthropic_AI":false,"Postgres":false}; tracesSampleRate:0.1 -> {"tracesSampleRate":0.1,"Anthropic_AI":true,"Postgres":true}"

### SENTRY-HOOKS-STREAMING — What each hook covers; `beforeSend` misses spans, logs and envelope headers
- **Brief:** §7 "Sentry `beforeSend` scrubbing."
- **Verdict:** Extended — high confidence.
- **Finding:**
  - **The hooks:**
    - `beforeSend(event, hint) => Event|null`: error and message events only. It runs after all scope data is applied; returning `null` drops the event.
    - `beforeBreadcrumb(breadcrumb, hint) => Breadcrumb|null`: runs before a breadcrumb is added to the scope; `null` drops it.
    - `beforeSendSpan(span: StreamedSpanJSON) => StreamedSpanJSON`: runs on every finished span. It can only MODIFY, not drop; use `ignoreSpans` to drop.
    - `beforeSendLog(log) => Log|null` and `beforeSendMetric(metric) => Metric|null`. v11 removed `enableLogs`/`enableMetrics`; logs are sent whenever `Sentry.logger.*` or a logging integration is used.
    - `beforeSendTransaction`: in v11 the default `traceLifecycle` is `'stream'`, so "beforeSendTransaction and ignoreTransactions no longer do anything". It works only with `traceLifecycle: 'static'`.
    - So `beforeSend` does NOT cover spans, logs or metrics.
  - **LOCAL EXPERIMENT (v11.2.0), span leak:**
    - With `tracesSampleRate` 1, a span named `'call hubspot <secret>'` was renamed in `beforeSendSpan`.
    - The secret still left the process in the envelope header's dynamic sampling context, `trace.transaction`. `beforeSend` was never called.
  - **The same leak hits ERROR events (verifier):** an error captured inside an active sampled span carries `trace.transaction` = the root span name in the error envelope header, and `beforeSend` cannot change it (`v1.mjs`: `errorEnvelopeHeaderContainsSecret=true` despite `beforeSend` scrubbing `event.transaction` and `request.url`).
  - **Propagation:**
    - The DSC also travels as the `baggage` header on outgoing HTTP. On the server, "all outgoing requests will be propagated by default" (`tracePropagationTargets`).
    - `tracePropagationTargets: []` does disable propagation: only a falsy option short-circuits to true, and an empty array matches nothing.
  - **Console breadcrumbs:** they come from the default `Console` integration; filter it out by name to disable them.
- **Design consequence:**
  - Write one pure scrubber and apply it in `beforeSend` AND `beforeBreadcrumb`, plus `beforeSendLog`/`beforeSendSpan` as no-harm extras.
  - Keep tracing OFF in v1 so spans and the DSC never exist, and set `tracePropagationTargets: []` anyway.
  - Never put tokens, emails or message text in span/transaction names, tags, extra, fingerprints or Error messages. Use IDs only.
- **Open risk:** None, as long as tracing stays off (see SENTRY-GENAI-ANTHROPIC for the env-var trap).
- **Sources:**
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/ — official docs source repo (renders to the public docs URL) — "beforeSend: ... can return a modified event object, or `null` to skip reporting the event ... beforeSendSpan: `beforeSendSpan` can only modify spans. It cannot drop them or return `null`. Use ignoreSpans ... beforeSendTransaction: This callback has no effect in stream mode."
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v10-to-v11/ — official docs source repo (renders to the public docs URL) — "Because no transaction events are produced, `beforeSendTransaction` and `ignoreTransactions` no longer do anything, and `beforeSendSpan` receives a different payload."
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/data-management/sensitive-data/ — official docs source repo (renders to the public docs URL) — "`beforeSend` applies to error and message events; `beforeSendSpan` applies to spans; `beforeSendLog` applies to logs; `beforeSendMetric` applies to metrics; `beforeSendTransaction` applies to transaction events in transaction mode"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/ — official docs source repo (renders to the public docs URL) — "tracePropagationTargets: ... On the server, all outgoing requests will be propagated by default."
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v10-to-v11/ — official docs source repo (renders to the public docs URL) — "To disable console breadcrumbs, filter out the `Console` integration: integrations: (integrations) => integrations.filter((integration) => integration.name !== "Console")"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/utils/tracePropagationTargets.ts — official SDK source — "function shouldPropagateTraceForUrl(url, tracePropagationTargets, decisionMap) { if (typeof url !== "string" || !tracePropagationTargets) { return true; } ... const decision = matchesTracePropagationTargets(url, tracePropagationTargets);"
  - https://www.npmjs.com/package/@sentry/node/v/11.2.0 — local experiment — "exp2.mjs: init({tracesSampleRate:1, memory transport, beforeSend counter, beforeSendSpan scrubs name+attributes}); startSpan({name:'call hubspot hsat_SECRET_ACCESS_TOKEN_123'}) -> {"envelopes":1,"beforeSendCalls":0,"beforeSendSpanCalls":1,"containsSecret":true}; leaked in envelope header: "transaction":"call hubspot hsat_SECRET_ACCESS_TOKEN_123""
  - https://www.npmjs.com/package/@sentry/node/v/11.2.0 — local experiment — "verify-nx/exp/v1.mjs: init({tracesSampleRate:1, memory transport, beforeSend rewrites event.transaction & request.url}); await startSpan({name:'GET /a/actiontok_SECRET_456', op:'http.server'}, async()=>captureException(new Error('boom'))) -> "errorEnvelopeHeaderContainsSecret= true  header.trace.transaction= GET /a/actiontok_SECRET_456""

### SENTRY-URL-QUERY-LEAK — Request URLs bypass default scrubbing (action-link tokens, OAuth `code`/`state`)
- **Brief:** not addressed. Relevant to §5.5 action links (`/a/{token}/send`, `/a/{token}/edit`, `/a/{token}/dismiss`), §5.1 OAuth and §7.
- **Verdict:** Corrected — high confidence. The verifier corrected two points of the original research:
  1. `beforeSend` suffices for error events only while tracing is off.
  2. Generic words must NOT go into Sentry's "Additional Sensitive Fields".
- **Finding:**
  - **URLs are always sent.** The request URL "is always sent".
  - **Path segments:** for every incoming request, the SDK sets the isolation-scope transaction name to `${METHOD} ${path-without-query}`. A token in a PATH segment therefore reaches `event.transaction` and `event.request.url`.
  - **Query params:**
    - They are sent by default, and filtered only when the KEY matches the SDK denylist. `code`, `state`, `t`, `id` and `sig` are not on it.
    - With `dataCollection.urlQueryParams: false`, the SDK filters query values out of both `request.query_string` and `request.url`. Path segments are never filtered.
  - **Server-side scrubbing:** Sentry's server-side scrubbing is on by default. It matches keys or values containing password, secret, passwd, api_key, apikey, auth, credentials, mysql_pwd, privatekey, private_key, token or bearer, plus credit-card-like values. It runs only after the data has left the process.
  - **When tracing is OFF** (no `tracesSampleRate`/`tracesSampler`, and `SENTRY_TRACES_SAMPLE_RATE` unset):
    - Error envelopes carry no transaction in the envelope-header DSC.
    - A `beforeSend` that rewrites `event.transaction`, `event.request.url` and `event.request.query_string` therefore fully covers error events (`exp3.mjs`).
  - **When tracing is ON:**
    - An error captured inside an active span carries the root span name in the envelope header (`trace.transaction`), and `beforeSend` cannot modify it (`v1.mjs`).
    - Spans leak the same way (`exp2.mjs`).
    - The guarantee therefore depends on keeping tracing off, or on never putting tokens in route paths or span names.
  - **Design (part of the corrected answer):**
    - Give action tokens a recognisable prefix (e.g. `apt_`), and prefer carrying them in the query string or a POST body over the path.
    - `beforeSend` and `beforeBreadcrumb` must rewrite `event.request.{url,query_string,data,cookies,headers}`, `event.transaction` and `breadcrumb.data.{url,to,from}`, and must redact token-pattern strings.
    - Set `Referrer-Policy: no-referrer` on action pages.
    - In the Sentry project settings, keep Data Scrubbing on and enable "Prevent storing IP addresses".
    - Add only distinctive token prefixes to Additional Sensitive Fields. An entry also deletes any value containing it, so never add generic words like `message`, `code`, `state` or `body`.
    - Use Advanced Data Scrubbing selectors such as `[Remove] [Anything] from [$http.data]` for content fields.
- **Design consequence:**
  - The scrubber's token regexes cover:
    - HubSpot access/refresh tokens;
    - `apt_…`;
    - `Bearer …`;
    - `code=` / `state=` params;
    - email addresses.
  - If PLAN keeps the brief's `/a/{token}/…` path shape, record in `docs/DECISIONS.md` that this is safe only while tracing is off and `beforeSend` rewrites the URL and transaction. The envelope test must include a path-token fixture.
  - WIRE_UP step 8 includes the project settings above. The original research's list of Additional Sensitive Fields (message, draft, body, code, state, email) is superseded: it would erase large parts of ordinary events.
- **Open risk:**
  - The "tracing off" guarantee must hold in production: `SENTRY_TRACES_SAMPLE_RATE` unset, and no `tracesSampleRate` anywhere.
  - The Sentry settings labels ("Data Scrubbing", "Prevent storing IP addresses", "Additional Sensitive Fields", "Advanced Data Scrubbing") were read from the docs source repo. Confirm them in the live Sentry UI at WIRE_UP.
- **Sources:**
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/integrations/http/server-subscription.ts — official SDK source — "const httpTargetWithoutQueryFragment = stripUrlQueryAndFragment(url); const bestEffortTransactionName = `${httpMethod} ${httpTargetWithoutQueryFragment}`; isolationScope.setTransactionName(bestEffortTransactionName);"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/integrations/requestdata.ts — official SDK source — "if (requestData.query_string) { requestData.query_string = normalizeAndFilterQueryString(requestData.query_string, dataCollection.urlQueryParams); } if (requestData.url) { requestData.url = filterUrlQuery(requestData.url, dataCollection.urlQueryParams); }"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/data-management/data-collected/ — official docs source repo (renders to the public docs URL) — "By default, the full request query string of outgoing and incoming HTTP requests is sent to Sentry. ... Values whose keys match the built-in sensitive denylist (terms like `auth`, `token`, `password`, and `secret`) are scrubbed automatically."
  - https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/ — official docs source repo (renders to the public docs URL) — "Values that themselves contain, or whose keynames contain, any of the following strings: password, secret, passwd, api_key, apikey, auth, credentials, mysql_pwd, privatekey, private_key, token, bearer"
  - https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/ — official docs source repo (renders to the public docs URL) — "An entry in "Additional Sensitive Fields" such as `mysekret`, for example, will cause the removal of any field named `mysekret`, but also removes any field _value_ that contains `mysekret`. ... the string `"Unexpected error"` will be removed from events if the entry `exp` is in "Additional Sensitive Fields"."
  - https://docs.sentry.io/security-legal-pii/scrubbing/advanced-datascrubbing/ — official docs source repo (renders to the public docs URL) — "- `$http`: Matches the HTTP request context of an event. Alias for `request` ... - `$message`: Matches the top-level log message ... - `$breadcrumb`: Matches a single breadcrumb ... [Remove] [Anything] from [extra.foo]"
  - https://www.npmjs.com/package/@sentry/node/v/11.2.0 — local experiment — "exp3.mjs: getIsolationScope().setTransactionName('GET /a/actiontok_SECRET_456'); captureException(new Error('boom')); beforeSend scrubs event.transaction & event.request.url -> {"tracing":false,"containsSecret":false} and {"tracing":true,"containsSecret":false}". The `tracing:true` result holds only because exp3 starts no span; see the next source.
  - https://www.npmjs.com/package/@sentry/node/v/11.2.0 — local experiment — "verify-nx/exp/v1.mjs (tracesSampleRate:1; startSpan name 'GET /a/actiontok_SECRET_456' wrapping captureException; beforeSend scrubs event.transaction/request.url) -> errorEnvelopeHeaderContainsSecret=true; verify-nx/exp/v3.mjs (tracing off, same span) -> containsSecret=false"

### SENTRY-SCRUBBER-TEST — Prove the scrubber at the envelope level with the real SDK and an in-memory transport
- **Brief:** §12: "No secrets, tokens or message text appear in logs or Sentry payloads; a test proves the scrubber."
- **Verdict:** Extended — high confidence.
- **Finding:**
  - **What Sentry's docs offer:**
    - Sentry Testkit is community-maintained, "not officially supported by Sentry", and documented as supporting SDK v8, v9 and v10 — not v11.
    - Custom transports can be built with `createTransport` from `@sentry/core`.
  - **Verified pattern:**
    1. Unit-test the pure scrubber with golden inputs.
    2. Integration-test the REAL SDK pipeline with an in-memory transport:
       ```ts
       transport: (o) => createTransport(o, (req) => { sink.push(typeof req.body === 'string' ? req.body : new TextDecoder().decode(req.body)); return Promise.resolve({ statusCode: 200 }) })
       ```
       Then call `Sentry.flush()` and assert that the serialized envelope text (headers and items) contains no secret or message substrings.
  - **LOCAL EXPERIMENT** (`@sentry/node` 11.2.0, Node 22.22):
    - Inputs: a breadcrumb with the lead message, `setExtra({token, note:'Authorization: Bearer …'})`, and an Error message containing a bearer token.
    - Without the scrubber: `containsToken=true`, `containsLeadMessage=true`.
    - With a restrictive `dataCollection` plus a deep `beforeSend`/`beforeBreadcrumb` scrubber: `containsToken=false`, `containsLeadMessage=false`.
    - The built-in key denylist did NOT remove `extra.debug.token`, nor the token inside the Error message. The custom scrubber is required.
  - **Caveat for the envelope test (verifier):**
    - The default ContextLines integration (`frameContextLines` 5) ships the source lines around in-app frames.
    - In `v2.mjs`, a secret literal defined in the test file near the throw site showed up in `pre_context` and gave a false positive.
    - Fix: set `frameContextLines: 0` in the shared options (already in the SENTRY-V11-DATA-DEFAULTS block), or keep fixtures in a separate module.
- **Design consequence:**
  - **Vitest files:**
    - `tests/observability/scrubber.test.ts`: pure golden cases.
    - `tests/observability/sentry-envelope.test.ts`: init `@sentry/node` with the shared options and the memory transport; capture an error, a breadcrumb, extra and a request using fixtures; flush; assert the envelope string excludes every fixture; close.
  - `@sentry/node` is a dependency of `@sentry/nextjs`; pin versions.
  - Reuse the same scrub function in the app logger.
- **Open risk:** None for the test design. Re-run it after any Sentry version bump (SENTRY-NEXTJS-VERSIONS).
- **Sources:**
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/best-practices/sentry-testkit/ — official docs source repo (renders to the public docs URL) — "Sentry Testkit is community-maintained and not officially supported by Sentry. ... Sentry Testkit supports the Sentry JavaScript SDK v8, v9, and v10."
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/transports/ — official docs source repo (renders to the public docs URL) — "You can also use the `createTransport` utility from `@sentry/core` to help with some boilerplate: ... return createTransport(options, makeRequest);"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/data-management/sensitive-data/ — official docs source repo (renders to the public docs URL) — "We recommend using these hooks in the SDKs to **scrub any data before it is sent**, to ensure that sensitive data never leaves the local environment."
  - https://www.npmjs.com/package/@sentry/node/v/11.2.0 — local experiment — "node exp.mjs -> [no-scrubber] envelopes=1 containsToken=true containsLeadMessage=true / [with-scrubber] envelopes=1 containsToken=false containsLeadMessage=false"
  - https://www.npmjs.com/package/@sentry/node/v/11.2.0 — local experiment — "verify-nx/exp/v1.mjs part B (default v11 options, no hooks): extra.debug= {"token":"hsat_SECRET_ACCESS_TOKEN_123","note":"Authorization: Bearer hsat_SECRET_ACCESS_TOKEN_123"} exception.value= HubSpot call failed with Bearer hsat_SECRET_ACCESS_TOKEN_123; verify-nx/exp/v2.mjs: secret found only in "pre_context":[..."const SECRET = 'actiontok_SECRET_456';""

### SENTRY-RECOMMENDED-CONFIG — Layered pattern so tokens and message text never leave the process
- **Brief:** §7 "Sentry `beforeSend` scrubbing"; §2 law 4; §12.
- **Verdict:** Extended — medium confidence. The regex scrubber's completeness is inherently medium-confidence.
- **Finding:** use five layers.
  1. **Collect less:**
     - pass the explicit `dataCollection` block (SENTRY-V11-DATA-DEFAULTS) in all three inits;
     - set no `tracesSampleRate`/`tracesSampler` anywhere in v1 (errors only), and document that `SENTRY_TRACES_SAMPLE_RATE` must be unset;
     - set `tracePropagationTargets: []`;
     - filter out the `'Anthropic_AI'` (and `'Console'`) integrations;
     - use no Replay, no `Sentry.logger` and no `consoleLoggingIntegration`;
     - keep `includeLocalVariables` false (the default).
     - Note: `attachStacktrace` now defaults to true in v11 (frames only).
  2. **Scrub what remains:** one pure `scrubEvent`, used by `beforeSend` and `beforeBreadcrumb` (and `beforeSendLog`/`beforeSendSpan`). It:
     - deletes `event.request.{data,cookies,headers,query_string}`;
     - rewrites `event.request.url` and `event.transaction`;
     - redacts exception values, messages, breadcrumb messages, extra and contexts strings that match secret regexes, plus content keys (`message`, `draft`, `body`, `text`, `prompt`, `completion`, `email`);
     - drops console breadcrumbs and the URL query strings in breadcrumb data.
  3. **Never feed content in:** pass only IDs to `setTag`/`setContext`, and write ID-only error messages.
  4. **Prove it:** scrubber golden tests plus the envelope integration test.
  5. **Last line:** Sentry server-side Data Scrubbing. It does not satisfy "never leave the process".
  - **Verifier additions:**
    - **(a)** With tracing on, error events inside spans also leak the span name via the envelope-header DSC. So "no `tracesSampleRate`/`tracesSampler` AND `SENTRY_TRACES_SAMPLE_RATE` unset" is a hard requirement. On `@sentry/nextjs`, the env var alone enables tracing (local experiment).
    - **(b)** Captured request bodies are attached verbatim with no key filtering, so `httpBodies: []` is mandatory.
    - **(c)** `frameContextLines: 0` also keeps source lines out of events and makes the envelope test deterministic.
    - **(d)** `tracePropagationTargets: []` works as intended.
    - **(e)** Keep Additional Sensitive Fields to distinctive token prefixes only (SENTRY-URL-QUERY-LEAK).
- **Design consequence:** `src/lib/observability/sentry-options.ts`, imported by all three init files:
  ```ts
  export const baseSentryOptions = {
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment,
    dataCollection: { /* SENTRY-V11-DATA-DEFAULTS block */ },
    tracePropagationTargets: [],
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    integrations: (d) => d.filter(i => !['Anthropic_AI','Console'].includes(i.name)),
  }
  ```
  Without a DSN, Sentry is a no-op (fake mode and tests).
- **Open risk:** The completeness of any regex scrubber is medium-confidence. The strongest guarantee is collecting nothing sensitive in the first place, verified by the envelope test. At WIRE_UP, send one deliberate server error from production and confirm the event in Sentry has no request body, headers, cookies or query string, and a rewritten URL/transaction.
- **Sources:**
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/data-management/sensitive-data/ — official docs source repo (renders to the public docs URL) — "filtering or scrubbing sensitive data within the SDK, so that data is _not sent to_ Sentry ... configuring server-side scrubbing to ensure Sentry does _not store_ data."
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v10-to-v11/ — official docs source repo (renders to the public docs URL) — "`Sentry.captureMessage()` events, and non-`Error` values passed to `Sentry.captureException()`, now attach a synthetic stack trace ... Set `attachStacktrace: false` to restore the previous behavior."
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v10-to-v11/ — official docs source repo (renders to the public docs URL) — "The `enableLogs` option was removed ... Logs are captured whenever you use their API (`Sentry.logger.*`) or add a logging integration such as `consoleLoggingIntegration()`."
  - https://www.npmjs.com/package/@sentry/node/v/11.2.0 — local experiment — "exp.mjs with dataCollection {userInfo:false,cookies:false,httpHeaders:false,httpBodies:[],urlQueryParams:false,genAI:{inputs:false,outputs:false},databaseQueryData:false,stackFrameVariables:false} + deep scrubber -> containsToken=false containsLeadMessage=false"
  - https://www.npmjs.com/package/@sentry/nextjs/v/11.2.0 — local experiment — "verify-nx/exp-nx2/t.cjs (npm i next@14.2.35 @sentry/nextjs@11.2.0; Node 22.22.0): ... SENTRY_TRACES_SAMPLE_RATE=1 -> {"tracesSampleRate":1,"Anthropic_AI":false,"Postgres":false}"

---

### 09.x Verifier-added items

#### V1 — The official Next.js support policy for 14.x and 15.x could not be read
- **Brief:** §3 "Next.js 14" (implicitly assumes a supported line).
- **Verdict:** Not officially documented — low confidence for the exact dates.
  - The dates rest on a community tracker. The de-facto status (no 14.x fixes) is officially corroborated by npm and the GitHub advisories.
- **Finding:**
  - **Why the official text is missing:** nextjs.org/support-policy is egress-blocked, WebSearch was exhausted, and the vercel/next.js repo contains no LTS/EOL policy text (neither in the docs nor in `contributing/release-channels-publishing.md`).
  - **Best-supported answer:** endoflife.date (community; it tracks the official policy) lists:
    - Next 14 as LTS with EOL 2025-10-26;
    - Next 15 as LTS with EOL 2026-10-21.
    - That is two years after each major's release.
  - **Official corroboration of the de-facto status:**
    - npm dist-tag `next-14` = 14.2.35 (2025-12-11), with no 14.x release since;
    - every advisory published in 2026 that affects 14.x is fixed only in 15.5.x/16.x;
    - the npm `backport` tag (15.5.27, 2026-09-30) is the only maintained non-latest line.
  - Next 15's EOL is 20 days away, so target 16.x, not 15.x.
- **Design consequence:** This supports NX-RECOMMENDATION's choice of 16.x only. `docs/DECISIONS.md` should cite the advisories and npm facts, not only the community dates.
- **Open risk:** The exact policy wording and dates are not officially quoted. Re-read https://nextjs.org/support-policy at WIRE_UP.
- **Sources:**
  - https://github.com/endoflife-date/endoflife.date/blob/master/products/nextjs.md — community, non-authoritative — "releaseCycle: "14" lts: true releaseDate: 2023-10-26 eol: 2025-10-26 latest: "14.2.35"; releaseCycle: "15" lts: true releaseDate: 2024-10-21 eol: 2026-10-21"
  - https://github.com/vercel/next.js/blob/canary/contributing/repository/release-channels-publishing.md — official docs source repo (vercel/next.js contributing docs; not rendered on nextjs.org) — "Next.js publishes to several release channels. `stable` and `canary` are the two that most users interact with (no LTS/EOL policy text in repo)"
  - https://nextjs.org/support-policy — official page, UNREACHABLE (direct fetch blocked in sandbox; no text read) — "UNREACHABLE: WebFetch -> {"error_type":"EGRESS_BLOCKED","domain":"nextjs.org"}"

#### V2 — The built-in key denylist does not protect captured request bodies
- **Brief:** §7 "Sentry `beforeSend` scrubbing"; §2 law 4.
- **Verdict:** Extended — high confidence.
- **Finding:** No, the denylist does not protect bodies.
  - **Where the denylist applies:** `SENSITIVE_KEY_SNIPPETS` is applied only to headers, cookies and query params, through `filterKeyValueData`, `filterCookies` and `filterQueryParams`.
  - **How bodies are captured:**
    - `patchRequestToCaptureBody` captures the incoming request body into `normalizedRequest.data`, at size `'medium'` when `httpBodies` includes `'incomingRequest'` (the v11 default).
    - The RequestData integration then copies it unchanged: `requestData.data = normalizedRequest.data`.
    - This happens in the Http integration's server `'request'` hook, independent of incoming-request spans. It therefore applies to `@sentry/nextjs`, which only disables incoming-request spans.
  - **Effect:** a HubSpot webhook body or a lead form post, including any `token` field, is sent verbatim unless `dataCollection.httpBodies: []` is set or `beforeSend` deletes `event.request.data`.
  - Sentry's server-side scrubbing may redact keys like `token`/`secret` after receipt, but by then the data has left the process.
- **Design consequence:** Set `httpBodies: []` in every init, AND have `beforeSend` delete `event.request.data` (belt and braces). The envelope test must post a fixture body containing a lead message and assert that it is absent.
- **Open risk:** None.
- **Sources:**
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/integrations/requestdata.ts — official SDK source — "if (include.data) { requestData.data = normalizedRequest.data; }"
  - https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/integrations/http/server-subscription.ts — official SDK source — "const effectiveBodySize = configuredBodySize ?? (client.getDataCollectionOptions().httpBodies.includes("incomingRequest") ? "medium" : "none"); if (effectiveBodySize !== "none" && !ignoreRequestBody?.(url, request)) { patchRequestToCaptureBody(request, isolationScope, effectiveBodySize, INTEGRATION_NAME); }"
  - https://docs.sentry.io/platforms/javascript/guides/nextjs/data-management/data-collected/ — official docs source repo (renders to the public docs URL) — "By default, incoming and outgoing request bodies are collected. To disable body collection, set `dataCollection: { httpBodies: [] }`."

#### V3 — When `register()` runs: Node at server start, Edge lazily on the first request in each isolate (Next 14)
- **Brief:** not addressed (§3 Monitoring).
- **Verdict:** Extended — high confidence.
- **Finding:**
  - **Node runtime (production):** `register()` runs once in `NextNodeServer.prepareImpl`, before serving, and only when `experimental.instrumentationHook` is true. A missing `.next/server/instrumentation` module is swallowed (`MODULE_NOT_FOUND`).
  - **Node runtime (dev):** `runInstrumentationHookIfAvailable` runs it, but only when the hook file was detected, which also requires the flag.
  - **Edge runtime:** it runs lazily, on the first request handled by each edge isolate.
    - `adapter.ts` awaits `ensureInstrumentationRegistered()`, which memoises a single `registerInstrumentation()` call that reads `_ENTRIES.middleware_instrumentation.register`.
    - On 14, middleware always runs on the edge runtime, so Sentry's edge init happens on the first middleware invocation in each isolate.
    - Errors thrown inside `register()` surface on that request ("An error occurred while loading instrumentation hook: ...").
- **Design consequence:** On 14, any failure in `sentry.edge.config.ts` breaks the first middleware request of each isolate, so keep the edge init trivial and side-effect-free. On 16, proxy runs on Node (NX-RECOMMENDATION), so this matters only for edge route segments.
- **Open risk:** None.
- **Sources:**
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/server/web/globals.ts — official SDK source — "export function ensureInstrumentationRegistered() { if (!registerInstrumentationPromise) { registerInstrumentationPromise = registerInstrumentation() } return registerInstrumentationPromise }"
  - https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/server/next-server.ts — official SDK source — "protected async prepareImpl() { await super.prepareImpl(); if (!this.serverOptions.dev && this.nextConfig.experimental.instrumentationHook) { ... await instrumentationHook.register?.() } catch (err: any) { if (err.code !== 'MODULE_NOT_FOUND') { ... throw err } } }"

---

### 09.y Test vectors

Neither Sentry nor Vercel publishes test vectors for these behaviours. **Every vector below was generated locally:**
- the Sentry vectors ran the official SDK from npm (`@sentry/node` / `@sentry/core` / `@sentry/nextjs` 11.2.0) on Node 22.22.0, with an in-memory transport built from `createTransport`;
- the advisory vector is a live POST to the official npm bulk advisory endpoint.

The `scratchpad/...` paths are research-sandbox scripts, not repo files. M1 must re-create these cases as Vitest tests.

Both blocks below are copied verbatim from the research and verification records.

**Research vectors (generated locally with the official SDK / npm registry):**

```text
1) Sentry v11.2.0 scrubber envelope test (Node 22.22.0, @sentry/node 11.2.0, in-memory transport via createTransport from @sentry/core): inputs: addBreadcrumb({category:'lead', message:'processing lead: Hi, I need a quote for 40 chairs, call me at 555-0100'}); setExtra('debug', { token: 'hsat_SECRET_ACCESS_TOKEN_123', note: 'Authorization: Bearer hsat_SECRET_ACCESS_TOKEN_123' }); captureException(new Error('HubSpot call failed with Bearer hsat_SECRET_ACCESS_TOKEN_123')). Outputs: no scrubber -> envelopes=1 containsToken=true containsLeadMessage=true; restrictive dataCollection + beforeSend/beforeBreadcrumb deep scrub -> envelopes=1 containsToken=false containsLeadMessage=false (scratchpad/sentry-exp/exp.mjs). 2) Span DSC leak: tracesSampleRate 1, startSpan({ name: 'call hubspot hsat_SECRET_ACCESS_TOKEN_123', attributes:{note:SECRET} }), beforeSendSpan renames span + attributes -> {"envelopes":1,"beforeSendCalls":0,"beforeSendSpanCalls":1,"containsSecret":true}; leaked only in envelope header "trace":{...,"transaction":"call hubspot hsat_SECRET_ACCESS_TOKEN_123",...} (exp2.mjs). 3) Error-event transaction scrub: getIsolationScope().setTransactionName('GET /a/actiontok_SECRET_456') + beforeSend rewriting event.transaction/request.url -> containsSecret=false with and without tracing (exp3.mjs). 4) npm advisory bulk query 2026-10-01: next@14.2.35 -> 23 advisories (critical: GHSA-2xp9-vwfh-vxw4, GHSA-p293-qw3h-jr36); next@15.5.27 -> 0; next@16.3.8 -> 0; @sentry/nextjs@10.75.3 -> 0; @sentry/nextjs@11.2.0 -> 0; react@18.3.1 -> 0. 5) @sentry/node 11.2.0 getDefaultIntegrations({tracesSampleRate:1}) includes 'Anthropic_AI'; getDefaultIntegrations({}) does not.
```

**Verifier recheck (reproduced locally; adds a correction to vector 3 and one new vector):**

```text
All 5 original vectors reproduce on Node v22.22.0. (1) sentry-exp/exp.mjs (@sentry/node and @sentry/core 11.2.0): '[no-scrubber] envelopes=1 containsToken=true containsLeadMessage=true' / '[with-scrubber] envelopes=1 containsToken=false containsLeadMessage=false', identical. (2) exp2.mjs: {"envelopes":1,"beforeSendCalls":0,"beforeSendSpanCalls":1,"containsSecret":true}; envelope header trace.transaction = 'call hubspot hsat_SECRET_ACCESS_TOKEN_123' while the span item name is 'call hubspot [Scrubbed]', identical. (3) exp3.mjs: {tracing:false,containsSecret:false} and {tracing:true,containsSecret:false}, identical. The experiment never starts a span, though: my verify-nx/exp/v1.mjs, which wraps captureException in startSpan with tracesSampleRate 1, shows the error envelope header trace.transaction = 'GET /a/actiontok_SECRET_456' despite beforeSend scrubbing, so the 'with tracing' conclusion is corrected. (4) The npm bulk advisory POST re-run at 2026-10-01T17:31Z gives next@14.2.35 = 23 (2 critical: GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4; 8 high; 11 moderate; 2 low), 0 for next@15.5.27 and next@16.3.8, and no entries for @sentry/nextjs 10.75.3/11.2.0 or react 18.3.1, identical. (5) @sentry/node 11.2.0 getDefaultIntegrations({tracesSampleRate:1}) includes 'Anthropic_AI'; getDefaultIntegrations({}) does not (and has no Postgres), identical. New vector: @sentry/nextjs 11.2.0 server init (next@14.2.35 installed) with only env SENTRY_TRACES_SAMPLE_RATE=1 gives tracesSampleRate=1, Anthropic_AI=false; explicit tracesSampleRate:0.1 gives Anthropic_AI=true. Scripts: scratchpad/verify-nx/exp/{v1,v2,v3}.mjs, scratchpad/verify-nx/exp-nx2/t.cjs. Review JSON saved to /tmp/claude-0/-home-user-Autopilot/93edeaab-e8bf-5524-b325-7fb2eb252823/scratchpad/research/nextjs-sentry.verify.json.
```

**How to use them in Vitest:**
- **`tests/observability/sentry-envelope.test.ts`:**
  - Turn vector 1 into the main envelope test, using the exact fixtures (`hsat_SECRET_ACCESS_TOKEN_123` and the lead message `Hi, I need a quote for 40 chairs, call me at 555-0100`).
  - Assert that the unscrubbed baseline leaks, so the test fails loudly if the transport stops capturing, and that the shared options do not leak.
  - Keep fixtures in a separate module, or rely on `frameContextLines: 0`, so `pre_context` cannot cause a false positive.
- **Vector 3 plus the verifier's `v1.mjs` case:** add a regression test that runs the shared options (no `tracesSampleRate`) with a path-token transaction (`GET /a/apt_…/send`). It must find no token in the envelope.
  - Optionally, document the tracing-on leak as a test that asserts the leak happens with `tracesSampleRate: 1`. That shows why tracing must stay off.
- **Vector 5 plus the new vector:** assert that the shared server options yield no `Anthropic_AI` integration, and that `tracesSampleRate`/`tracesSampler` are absent from the options object.
- **Vector 4:** a CI `npm audit` step, not a unit test. Re-run it at WIRE_UP.
