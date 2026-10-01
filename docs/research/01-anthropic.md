## 01. Anthropic models and structured output

Official Anthropic docs and the official TypeScript SDK source (`@anthropic-ai/sdk` 0.131.0, the latest on npm, published 2026-09-30) confirm both default model IDs in §3. `claude-sonnet-5-5` is Active and was released 2026-09-28. `claude-haiku-4-5-20251001` is Active, with retirement not sooner than 2026-10-15. The docs were fetched on 2026-10-01 from platform.claude.com/docs, which is where docs.claude.com now redirects. The sources also confirm that the recommended structured-output approach is GA JSON outputs via `output_config.format = { type: 'json_schema', schema }`, supported on both models with no beta header.

The sources correct the brief in four places:
- **The two env model IDs are not interchangeable.** Sonnet 5.5 returns 400 for `thinking:{type:'disabled'}`, non-default `temperature`/`top_p`/`top_k`, assistant prefill and forced `tool_choice`. Haiku 4.5 rejects adaptive thinking and does not support effort.
- **The fast model must be swappable through env alone,** because Haiku 4.5's retirement floor is close.
- **Some limits cannot be enforced by the schema grammar.** §5.3's "faqs (8 or fewer)" and §5.4's word limits are in this group, because `maxItems`, `maxLength` and `minLength` are unsupported.
- **§5.4's failure path must cover more than validator failures.** It must also handle `stop_reason` `refusal` (HTTP 200, never retried on the same model) and `max_tokens` (always a failed attempt).

The SDK's own documented path, `zodOutputFormat()` with `messages.parse()`, does not suit this product, for two reasons:
- In 0.131.0 it moves `enum` into description text, so category and tone values are not constrained by the grammar.
- `parse()` throws on invalid or truncated JSON, and the throw loses `usage`, `stop_reason` and `_request_id`.

The design therefore uses `messages.create()` with a project schema helper that keeps `enum`, and validates the output itself with Zod v4.

The sources extend the brief with:
- exact per-model prices and usage fields for cost tracking (thinking is billed inside `output_tokens`);
- SDK error classes and retry behaviour, for transient vs fatal handling;
- two content-leak paths (debug logging, and parse-error messages) that the §2 law 4 scrubber must cover;
- request settings per purpose: Haiku for classification; adaptive thinking at effort `high` for the brief; `between_tools` at `medium` for drafts, which is a deliberate deviation from the docs, to be settled by a sweep on the golden cases.

Two things stay open:
- Anthropic's standard 30-day API retention figure for the privacy page rests only on a search summary of privacy.claude.com, which is blocked here.
- Nothing was run against the live API, so the hand-built schemas and the draft thinking/effort choice must be checked during WIRE_UP.

### AI-MODEL-SONNET55 — `claude-sonnet-5-5` is a valid, current model ID
- **Brief:** §3 `ANTHROPIC_MODEL_DRAFT` default `claude-sonnet-5-5`; "[VERIFY] current model IDs ... at docs.claude.com".
- **Resolves:** [VERIFY] §3 current model IDs (and where the docs now live)
- **Verdict:** Confirmed — high confidence
- **Finding:** `claude-sonnet-5-5` is valid and current. It is the Claude API ID of Claude Sonnet 5.5, released 2026-09-28 (3 days before the research date of 2026-10-01).
  - **Status:** Active (latest); deprecated N/A; retirement "Not sooner than September 28, 2027".
  - **Snapshot, not alias:** from the 4.6 generation on, the dateless ID *is* the pinned snapshot, not an evergreen alias. The "alias" row just repeats it. The SDK 0.131.0 `Model` union includes `'claude-sonnet-5-5'`.
  - **Context and output:** context 1M tokens. Max output 128K on the synchronous Messages API, or 300K on Batch with beta `output-300k-2026-03-24`.
  - **Prices:** $2/MTok input, $10/MTok output, 5-minute cache write $2.50, 1-hour cache write $4, cache read $0.20. Batch is 50% off.
  - **Thinking and effort:** adaptive thinking, ON by default; default effort `high`.
  - **Knowledge cutoff:** Jun 2026.
  - **Tokenizer:** Sonnet 5's tokenizer (the post-Opus-4.7 one). The same text produces about 30% more tokens than on Sonnet 4.6, Sonnet 4.5 and Haiku 4.5.
  - **Caching:** minimum cacheable prompt 512 tokens.
  - **Docs location:** `docs.claude.com` now returns 302 to `platform.claude.com/docs`.
- **Design consequence:** Keep `ANTHROPIC_MODEL_DRAFT=claude-sonnet-5-5`. The model is 3 days old, so its breaking changes apply (see AI-SONNET55-REQUEST): thinking is on by default, and each of these returns a 400: `thinking:{type:'disabled'}`, sampling params, prefill, and forced `tool_choice`. Cite platform.claude.com/docs URLs in RESEARCH.md, because docs.claude.com redirects there.
- **Open risk:** None was found in the docs. The model is days old, so re-confirm its status and prices on the models overview and pricing pages during WIRE_UP.
- **Sources:**
  - https://platform.claude.com/docs/en/about-claude/models/overview — official docs — "| Claude API ID | ... | `claude-sonnet-5-5` | `claude-haiku-4-5-20251001` | ... Retirement ... Not sooner than September 28, 2027 | Not sooner than October 15, 2026 ... 'Every Claude model ID is a pinned snapshot, including the dateless IDs used from the 4.6 generation on.'"
  - https://platform.claude.com/docs/en/models/sonnet-5-5/overview — official docs — "**Latest.** Released September 28, 2026. ... Context window: 1M tokens · Max output: 128K tokens · Input pricing: $2 / MTok · Output pricing: $10 / MTok ... | Status | Active (latest) |"
  - https://platform.claude.com/docs/en/about-claude/model-deprecations — official docs — "| claude-sonnet-5-5 | Active | N/A | Not sooner than September 28, 2027 |"
  - https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions — official docs — "For the 4.6 generation and later, the dateless ID is the canonical model ID for that release. It maps to a single, fixed model snapshot."
  - https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide — official docs — "Claude Sonnet 5.5 uses Claude Sonnet 5's tokenizer. Against Claude Sonnet 4.6, Claude Sonnet 4.5, and Claude Haiku 4.5, the same text produces about 30% more tokens, depending on the content."
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts — official SDK source — "export type Model = | 'claude-sonnet-5-5' | ... | 'claude-haiku-4-5' | 'claude-haiku-4-5-20251001' | ... (SDK 0.131.0)"
  - https://docs.claude.com/en/docs/about-claude/models/overview — local experiment — "curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' -> '302 https://platform.claude.com/docs/en/about-claude/models/overview'"

### AI-MODEL-HAIKU45 — `claude-haiku-4-5-20251001` is valid, but can retire from 2026-10-15
- **Brief:** §3 `ANTHROPIC_MODEL_FAST` default `claude-haiku-4-5-20251001`; used for §5.2 classification.
- **Resolves:** [VERIFY] §3 current model IDs
- **Verdict:** Extended — high confidence
- **Finding:** `claude-haiku-4-5-20251001` is valid and current.
  - **ID and alias:** it is a dated snapshot. The Claude API also accepts the alias `claude-haiku-4-5`, a convenience pointer that resolves to that snapshot. The stability guarantee covers IDs, not aliases.
  - **Status:** "Active (latest)"; there is no newer Haiku. Released 2025-10-15. Deprecated: N/A.
  - **Retirement:** tentative retirement is "Not sooner than October 15, 2026", 14 days after 2026-10-01. The deprecations page fetched on 2026-10-01 shows **no** deprecation notice. Anthropic gives "at least 60 days' notice before model retirement for publicly released models".
  - **Retirement timing (verifier correction):** 2026-10-15 is a floor on *retirement*, not on *notice*. A notice can be issued any day, including before 2026-10-15. Retirement then falls on or after max(2026-10-15, notice date + 60 days), which is about 2026-11-30 at the earliest if notice came today.
  - **Precedent:** `claude-sonnet-4-5-20250929` was deprecated on 2026-09-30 with retirement on 2026-11-30 (61 days' notice), and `claude-sonnet-5-5` is its replacement. The SDK 0.131.0 `DEPRECATED_MODELS` map lists only the Sonnet 4.5 IDs, not Haiku 4.5.
  - **Limits:** context 200K; max output 64K.
  - **Prices:** $1/MTok input, $5/MTok output, 5-minute cache write $1.25, 1-hour cache write $2, cache read $0.10. Batch is 50% off.
  - **Thinking and effort:** manual extended thinking only (`thinking.type:'enabled'` + `budget_tokens`), OFF by default. Effort: "Not supported".
  - **Caching:** minimum cacheable prompt 4,096 tokens.
  - **Knowledge cutoff:** Feb 2025.
- **Design consequence:** Keep the dated ID as the default: it is pinned, and the alias adds no stability. Build the request layer so `ANTHROPIC_MODEL_FAST` can be switched to `claude-sonnet-5-5` with no code change (the per-model parameter builder in AI-MODEL-CAPABILITY-MAP). Record this in WIRE_UP.md and DECISIONS.md: "if Anthropic deprecates Haiku 4.5, set ANTHROPIC_MODEL_FAST=claude-sonnet-5-5 (thinking between_tools, effort low)". Key the cost rate table by `response.model`: prices differ 2x, and Sonnet 5.5's tokenizer yields more tokens for the same text.
- **Open risk:** A deprecation notice can arrive on any day. Retirement then follows at least 60 days later, and no earlier than 2026-10-15. So the classification path must be swappable through env alone. During WIRE_UP, re-check https://platform.claude.com/docs/en/about-claude/model-deprecations for a Haiku 4.5 notice.
- **Sources:**
  - https://platform.claude.com/docs/en/models/haiku-4-5/overview — official docs — "Model ID: `claude-haiku-4-5-20251001` ... | Claude API alias | `claude-haiku-4-5` | ... | Status | Active (latest) | Released | October 15, 2025 | Retirement | Not sooner than October 15, 2026 ... `claude-haiku-4-5` is a convenience alias that resolves to the pinned snapshot `claude-haiku-4-5-20251001`."
  - https://platform.claude.com/docs/en/about-claude/model-deprecations — official docs — "| claude-haiku-4-5-20251001 | Active | N/A | Not sooner than October 15, 2026 | ... 'providing at least 60 days' notice before model retirement for publicly released models.'"
  - https://platform.claude.com/docs/en/about-claude/model-deprecations — official docs — "| claude-sonnet-4-5-20250929 | Deprecated    | September 30, 2026 | November 30, 2026 | ... ### 2026-09-30: Claude Sonnet 4.5 model ... | November 30, 2026 | `claude-sonnet-4-5-20250929` | `claude-sonnet-5-5` |"
  - https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions — official docs — "This guarantee covers model IDs, not the convenience aliases that the Claude API accepts for some earlier models"
  - https://platform.claude.com/docs/en/about-claude/pricing — official docs — "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts — official SDK source — "const DEPRECATED_MODELS = { 'claude-sonnet-4-5': 'November 30th, 2026', 'claude-sonnet-4-5-20250929': 'November 30th, 2026' } (Haiku 4.5 not listed in SDK 0.131.0)"

### AI-MODEL-CAPABILITY-MAP — the two env model IDs need different request parameters
- **Brief:** §3 "Model IDs from env" (this implies the two IDs are interchangeable).
- **Resolves:** [VERIFY] §3 current model IDs (consequence for swapping them)
- **Verdict:** Extended — high confidence
- **Finding:** They are not interchangeable with one request shape. Each model accepts different `thinking`, `effort`, sampling and prefill values, and a mismatch returns HTTP 400.
  - **Haiku 4.5:** "Extended only", thinking default Off, rejects `"adaptive"`. Effort is "Not supported", and Haiku 4.5 is absent from the effort feature's `supportedModels`.
  - **Sonnet 5.5:** "Adaptive, `between_tools`", thinking default On, rejects `"enabled"` and `"disabled"`. "Only Claude Sonnet 5.5 accepts `"between_tools"`". Effort is supported, default `high`.
  - **Other models in the per-model table:** Sonnet 5 accepts `"disabled"`. Opus 5 accepts `"disabled"` only at effort high or below. Opus 5.5 and Fable are "Always on".
  - **Sampling params:** a non-default `temperature`/`top_p`/`top_k` returns 400 on Claude 4.7-and-later models, including Sonnet 5.5. Haiku 4.5 still accepts them.
  - **Prefill:** an assistant prefill returns 400 on Sonnet 5.5. Haiku accepts one, but prefill is incompatible with structured outputs anyway.
  - **Runtime capability lookup:** `GET /v1/models/{id}` (SDK `client.models.retrieve(id)`) returns `capabilities.effort.supported`, `capabilities.structured_outputs.supported` and `capabilities.thinking.types.adaptive.supported`.
  - **Verifier correction to the lookup:** in SDK 0.131.0, `ThinkingTypes` has only `adaptive` and `enabled`, and `EffortCapability` is `{supported, low, medium, high, xhigh|null, max}`. So the Models API cannot tell you whether `between_tools` or `disabled` is accepted, and a static per-model map is mandatory, not an optional alternative.
  - **Covered Models:** Fable models are Covered Models. They require 30-day data retention, and orgs whose retention config doesn't allow it get a 400.
- **Design consequence:** Implement `buildModelParams(modelId, purpose)` over a static map:
  - `claude-sonnet-5-5`: `thinking` chosen per purpose (`{type:'between_tools'}` for drafts; adaptive for the brief, per AI-REQUEST-RECOMMENDATIONS), plus `output_config.effort`.
  - `claude-haiku-4-5*`: omit `thinking` and `effort`.
  - `claude-sonnet-5` / `claude-opus-5`: `{thinking:{type:'disabled'}}`, with effort at high or below.
  - `claude-opus-5-5` / Fable: omit `thinking` (it cannot be disabled), effort `'low'`, larger `max_tokens`.
  - Unknown model: omit `thinking`, `effort` and sampling params; larger `max_tokens`.

  Never send `temperature`/`top_p`/`top_k` or a prefill on any path. Keep Covered Models (Fable/Mythos) out of the env allow-list. Unit-test the map. In `APP_MODE=fake`, FakeLLM should assert that the params it receives are valid for the model.
- **Sources:**
  - https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting — official docs — "| Claude Sonnet 5.5 | Adaptive, `between_tools`3 | On | `"enabled"`, `"disabled"` | ... | Claude Haiku 4.5 | Extended only | Off | `"adaptive"` | ... Only Claude Sonnet 5.5 accepts `"between_tools"`"
  - https://platform.claude.com/docs/en/build-with-claude/effort — official docs — "supportedModels: ... claude-opus-4-5-20251101, claude-sonnet-5-5, claude-sonnet-5, claude-sonnet-4-6 (no claude-haiku-4-5-20251001)"
  - https://platform.claude.com/docs/en/about-claude/model-deprecations — official docs — "`temperature`, `top_p`, `top_k` | Deprecated (Claude Opus 4.7 and later) | Returns a 400 error when set to a non-default value on Claude 4.7 and later models"
  - https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide — official docs — "Prefill returns an error. Claude Sonnet 5.5 rejects a prefilled last assistant turn with a 400 error ... Claude Sonnet 4.5, Claude Haiku 4.5, and older models accept one."
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/models.ts — official SDK source — "export interface ModelCapabilities { batch; citations; code_execution; context_management; effort: EffortCapability; image_input; pdf_input; structured_outputs: CapabilitySupport; thinking: ThinkingCapability }"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/models.ts — official SDK source — "export interface ThinkingTypes { adaptive: CapabilitySupport; enabled: CapabilitySupport; } ... export interface EffortCapability { high; low; max; medium; supported: boolean; xhigh: CapabilitySupport | null }"
  - https://platform.claude.com/docs/en/manage-claude/api-and-data-retention — official docs — "Claude Fable 5.1, Claude Mythos 5.1, Claude Fable 5, and Claude Mythos 5 are designated Covered Models ... and require 30-day data retention"

### AI-PRICING-COST — exact prices and how to turn usage into cost
- **Brief:** §5.4 "Record token counts per draft for cost tracking"; prices are not addressed.
- **Verdict:** Extended — high confidence
- **Finding:** Rates in USD per million tokens, with micro-USD per token in brackets:

  | Model | Input | Output | 5m cache write | 1h cache write | Cache read |
  |---|---|---|---|---|---|
  | Sonnet 5.5 | $2 [2] | $10 [10] | $2.50 [2.5] | $4 [4] | $0.20 [0.2] |
  | Haiku 4.5 | $1 [1] | $5 [5] | $1.25 [1.25] | $2 [2] | $0.10 [0.1] |

  - **Batch:** 50% off (not used here).
  - **Thinking:** thinking tokens are billed as output and are already included in `usage.output_tokens`, which is "the inclusive, authoritative total used for billing".
  - **Cached input:** `input_tokens` excludes cached tokens. `total_input = cache_read_input_tokens + cache_creation_input_tokens + input_tokens`.
  - **`inference_geo`:** US-only `inference_geo` adds a 1.1x multiplier on 4.6+ models and returns 400 on earlier models such as Haiku 4.5, so do not set it.
  - **Long context:** billed at the standard price on 4.6+ models.
- **Design consequence:** For each AI call, store (no content) purpose, `response.model`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `thinking_tokens`, `stop_reason`, attempt number, and cost in integer micro-USD from a rate table keyed by model ID. Keep the table in code with a "prices as of 2026-10-01" comment. A draft's cost is the sum of all its attempts, including the validator retry.
- **Open risk:** Prices are as of 2026-10-01; re-check the pricing page during WIRE_UP.
- **Sources:**
  - https://platform.claude.com/docs/en/about-claude/pricing — official docs — "| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok | ... | Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok | ... 'specifying US-only inference through the `inference_geo` parameter incurs a 1.1x multiplier' ... 'requests that include the parameter on these models return a 400 error.'"
  - https://platform.claude.com/docs/en/build-with-claude/prompt-caching — official docs — "total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens"
  - https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide — official docs — "Revisit `max_tokens`. It covers thinking plus text, and thinking tokens are billed as output tokens."
  - https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking — official docs — "`output_tokens` remains the inclusive, authoritative total used for billing. `output_tokens_details` is a read-only breakdown for observability."

### AI-SO-API — the recommended structured-output approach
- **Brief:** §3 "[VERIFY] ... the recommended structured-output approach at docs.claude.com"; §5.3 and §5.4 only say the model "returns JSON".
- **Resolves:** [VERIFY] §3 recommended structured-output approach
- **Verdict:** Confirmed — high confidence
- **Finding:** Structured outputs are GA on the Claude API; no beta header is needed.
  - **Wire format:** the request body carries `output_config: { format: { type: 'json_schema', schema: <JSON Schema> } }`. The response's text content block holds JSON that conforms to the schema.
  - **Documented TS SDK path (0.131.0):** `import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'`, then `client.messages.parse({ model, max_tokens, messages, output_config: { format: zodOutputFormat(Schema) } })`. The result has `parsed_output`, typed from the schema.
  - **Non-zod alternative:** `import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'`. Types are inferred from an `as const` schema, and `{ transform: false }` sends the schema unchanged. It does **not** validate the response.
  - **Verifier extension:** `jsonSchemaOutputFormat(rawSchema, { transform: false })` keeps `enum` (local run: `{"type":"string","enum":["lead","spam"]}`). This only works if the raw schema already avoids unsupported keywords (`maxItems`, `maxLength`, `$schema`), and it does no validation. For schemas built from Zod, the project helper in AI-SO-TS-ENUM is still the right choice.
  - **Deprecated parameter:** the old top-level `output_format` param is deprecated. It needs beta header `structured-outputs-2025-11-13`; without it the request returns 400.
  - **Incompatibilities:** structured outputs cannot be combined with assistant prefill or with Citations (400).
  - **Grammar compilation:** the first request for a schema is slower while the grammar compiles. Compiled grammars are cached 24h from last use.
  - **Prompt overhead:** structured outputs inject an extra system prompt (slightly more input tokens), and changing `output_config.format` invalidates the prompt cache.
  - **Forced `tool_choice`:** the old JSON trick returns 400 on Sonnet 5.5, so do not use tools to get JSON.
- **Design consequence:** Use `output_config.format` JSON outputs for classification, the brief and drafts. Pin `@anthropic-ai/sdk` to exactly `0.131.0` in package.json. Make the call with `client.messages.create()` and a project schema helper, not `messages.parse()` + `zodOutputFormat()`; AI-SO-TS-ENUM and AI-SO-PARSE-SEMANTICS give the reasons.
- **Sources:**
  - https://platform.claude.com/docs/en/build-with-claude/structured-outputs — official docs — "Wrap a Zod schema in `zodOutputFormat()` and pass it to `client.messages.parse()` as `output_config.format`. ... 'The `output_format` parameter has moved to `output_config.format`, and beta headers are no longer required.' ... '**Message Prefilling:** Incompatible with JSON outputs'"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/helpers/zod.ts — official SDK source — "export function zodOutputFormat<ZodInput extends z.ZodType>(zodObject: ZodInput): AutoParseableOutputFormat<z.infer<ZodInput>> { const jsonSchema = transformJSONSchema(z.toJSONSchema(zodObject, { reused: 'ref' })); return { type: 'json_schema', schema: {...jsonSchema}, parse: ... } }"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts — official SDK source — "export interface OutputConfig { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null; format?: JSONOutputFormat | null; }"
  - https://registry.npmjs.org/@anthropic-ai/sdk — official SDK source — "npm view @anthropic-ai/sdk: version = '0.131.0', dist-tags latest: '0.131.0', '0.131.0': '2026-09-30T23:03:22.385Z', peerDependencies = { zod: '^3.25.0 || ^4.0.0' } (optional)"
  - https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5 — official docs — "`tool_choice` set to `{"type": "any"}` or `{"type": "tool", "name": "..."}` returns a 400 `invalid_request_error` ... or move the schema to structured outputs."
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/helpers/json-schema.ts — local experiment — "jsonSchemaOutputFormat(raw).schema -> {"category":{"type":"string","description":"{enum: [\"lead\",\"spam\"]}"}}; jsonSchemaOutputFormat(raw,{transform:false}).schema -> {"category":{"type":"string","enum":["lead","spam"]}}"

### AI-SO-ZOD-VERSION — the SDK's Zod helper needs Zod v4 schemas
- **Brief:** §3 "Zod for every external payload"; no version given.
- **Verdict:** Extended — high confidence
- **Finding:** SDK 0.131.0 declares an optional peer `zod: '^3.25.0 || ^4.0.0'`. However, the helper imports `* as z from 'zod/v4'` and calls `z.toJSONSchema`, so it accepts only Zod v4 schemas.
  - **zod 4.x** (latest 4.6.5): `import { z } from 'zod'` works.
  - **zod 3.25.x:** schemas must be built from `import { z } from 'zod/v4'`. A classic v3 schema from `import { z } from 'zod'` crashes with `TypeError: Cannot read properties of undefined (reading 'def')` (local experiment, reproduced independently by the verifier).
  - **Runtime requirements:** the SDK needs TypeScript 5.0 or later and Node.js 20 LTS or later.
- **Design consequence:** Install `zod@^4` (4.6.5) and use `import { z } from 'zod'` everywhere, so the same schemas serve webhook/form validation and AI output validation.
- **Sources:**
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/helpers/zod.ts — official SDK source — "import * as z from 'zod/v4';"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md — official SDK source — "**zod:** use v4 import path for Zod ^3.25 compatibility ... **zod:** ensure only zod/v4 types are used"
  - https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript — official docs — "TypeScript >= 5.0 is supported. The following runtimes are supported: Node.js 20 LTS or later ..."
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/helpers/zod.ts — local experiment — "SDK 0.131.0 + zod 3.25.76: zodOutputFormat(z3.object({a: z3.enum(['x','y'])})) -> 'TypeError Cannot read properties of undefined (reading 'def')'; same schema built from 'zod/v4' -> OK"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/helpers/zod.ts — local experiment — "verify-ai/v3/t.mjs (SDK 0.131.0, zod 3.25.76): 'v3 classic -> TypeError Cannot read properties of undefined (reading 'def')'; 'zod/v4 OK ...'"

### AI-SO-MODELS — both default models support structured outputs
- **Brief:** Implicit: both models return JSON (§5.2 classification, §5.3 brief, §5.4 drafts).
- **Resolves:** [VERIFY] §3 recommended structured-output approach (model coverage)
- **Verdict:** Confirmed — high confidence
- **Finding:** Both models are listed explicitly. The structured-outputs feature metadata names `claude-sonnet-5-5` and `claude-haiku-4-5-20251001` among its `supportedModels`. The full list is: claude-fable-5-1, claude-mythos-5-1, claude-fable-5, claude-mythos-5, claude-mythos-preview, claude-opus-5-5, claude-opus-5, claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-sonnet-5-5, claude-sonnet-5, claude-sonnet-4-6, claude-sonnet-4-5-20250929, claude-opus-4-5-20251101, claude-haiku-4-5-20251001. Status: GA on the Claude API. Data retention: ZDR-eligible (excluding Covered Models). The JSON schema itself is cached for up to 24h.
- **Design consequence:** Neither default model needs a tool-use fallback to produce JSON.
- **Sources:**
  - https://platform.claude.com/docs/en/build-with-claude/structured-outputs — official docs — "featureMetadata: status: ga ... supportedModels: ... - claude-sonnet-5-5 ... - claude-haiku-4-5-20251001 ... supportedPlatforms: Claude API: ga"

### AI-SO-SCHEMA-LIMITS — supported JSON Schema features, and what the grammar cannot enforce
- **Brief:** §5.3's brief schema needs `faqs[]` (8 or fewer), a `tone` enum, booleans and arrays, and assumes the model enforces them. §5.4's draft JSON and §5.2's classification enum make the same assumption.
- **Verdict:** Corrected — high confidence
- **Finding:**
  - **Supported:**
    - object, array, string, integer, number, boolean, null;
    - `enum` (strings, numbers, bools or nulls only) and `const`;
    - `anyOf` / `allOf` (no `allOf` with `$ref`);
    - `$ref` / `$defs` / `definitions` (no external refs);
    - `default`, `required`, and `additionalProperties` (must be `false`);
    - string formats `date-time`, `time`, `date`, `duration`, `email`, `hostname`, `uri`, `ipv4`, `ipv6`, `uuid`;
    - array `minItems` of 0 or 1 only;
    - simple regex `pattern`.
  - **Not supported (400 if sent raw):**
    - recursive schemas;
    - `minimum` / `maximum` / `multipleOf`;
    - `minLength` / `maxLength`;
    - any array constraint beyond `minItems` 0/1.

    So `maxItems: 8` for faqs **cannot** be enforced by the grammar.
  - **Limits per request:**
    - At most 24 optional (non-required) properties. Required properties are emitted first, then optional ones, and each optional property roughly doubles the grammar state.
    - At most 16 union types (`anyOf`, or type arrays such as `['string','null']`).
    - At most 20 strict tools.
    - An over-complex schema returns 400 `Schema is too complex for compilation`. Compilation times out at 180s.
  - **Enum casing:** the API does not guarantee the capitalization of string `enum`/`const` values (typically the first letter after a space). Compare case-insensitively.
  - **Verifier notes:**
    - The docs literally list "`$ref`, `$def`, and `definitions`", while the SDKs and Zod emit `$defs`. This is probably a docs typo; `$defs` is what the SDK transform keeps.
    - Regex `pattern` support is limited: no backreferences, no lookaround, no `\b`, and only simple `{n,m}`. The SDK transform does not forward `pattern` (it lands in the description), so a project helper must keep it explicitly if it is needed.
    - `.nullable()` becomes the type array `["string","null"]`, which counts toward the 16-union limit.
- **Design consequence:** Make every field required and use `.nullable()` instead of `.optional()` (for example `booking_link: string|null`, `sign_off_name: string|null`). This stays far under the 24-optional limit and keeps property order stable. The brief schema uses 2 nullable unions, well within the limit of 16.
  - Enforce faqs ≤ 8, the 120/70-word limits and subject length in the deterministic validator or in post-processing. For the brief, use `faqs.slice(0,8)` rather than failing the whole brief.
  - Use lowercase snake_case enum values with no spaces, and lowercase the returned value before validating.
- **Sources:**
  - https://platform.claude.com/docs/en/build-with-claude/structured-outputs — official docs — "Supported features: ... `enum` (strings, numbers, bools, or nulls only - no complex types) ... Array `minItems` (only values 0 and 1 supported) ... Not supported: ... Numerical constraints (such as `minimum`, `maximum`, `multipleOf`) * String constraints (`minLength`, `maxLength`) * Array constraints beyond `minItems` of 0 or 1 ... | Optional parameters | 24 | ... | Parameters with union types | 16 | ... 'Structured outputs don't guarantee the capitalization of string `enum` and `const` values'"

### AI-SO-TS-ENUM — the TS SDK's Zod helper does not send `enum` to the API
- **Brief:** Not addressed; the brief assumes the classification and tone enums are enforced.
- **Resolves:** [VERIFY] §3 recommended structured-output approach (SDK caveat)
- **Verdict:** Extended — high confidence
- **Finding:** The helper does not send `enum`. In `@anthropic-ai/sdk` 0.131.0 (identical to upstream main as of 2026-09-30), `transformJSONSchema` is used by `zodOutputFormat`, by default by `jsonSchemaOutputFormat`, and by the beta `betaStandardSchemaOutputFormat`.
  - **What it keeps:** `type`, `anyOf`, `oneOf` (as `anyOf`), `allOf`, `description`, `title`, `properties`, `required`, `additionalProperties`, supported `format` values, `items`, `minItems` 0|1, `$defs` and `$ref`.
  - **What it demotes:** every other key, including `enum`, `const`, `default`, `pattern`, `maxItems` and `maxLength`, is moved into the field's `description` as text. `z.literal('x')` becomes the description `{const: "x"}`.
  - **Nested objects:** for a single-use nested object, `zodOutputFormat` emits `$defs.__schema0` + `$ref` (`reused:'ref'`).
  - **Local experiment:** `z.enum(['lead','spam','vendor_pitch','job_seeker','support_request','unclear'])` is sent as `{"type":"string","description":"{enum: [\"lead\",...]}"}`. The category and tone values are therefore only hinted in the prompt, not constrained by the grammar. Zod then rejects an off-list value locally, and `parse()` throws `AnthropicError`.
  - **Contradictions:** this contradicts the docs, which list `enum` as a supported API feature and say the SDK only removes "unsupported constraints". It also differs from the official Python SDK, whose `transform_schema` keeps `enum` (`strict_schema["enum"] = enum`). The docs do not call this a bug.
- **Design consequence:** Add a small project helper, `toClaudeJsonSchema(zodSchema)`. It calls `z.toJSONSchema(schema, { reused: 'inline' })` and then walks the result:
  - drop `$schema`;
  - keep `type`, `properties`, `required`, `items`, `enum`, `const`, `anyOf`, `allOf`, `$ref`, `$defs`, `description`, `title`, `default`, supported `format` values, and `minItems` 0|1;
  - force `additionalProperties:false` on objects;
  - move everything else (`maxItems`, `maxLength`, `minLength`, min/max, unsupported formats, `minItems`>1) into description text.

  Verified locally, and reproduced by the verifier with an independently written walker: the output keeps `"enum":["lead",...]` and `tone.style` `{"enum":["friendly","formal","direct"]}`, and turns faqs `maxItems` into the description `{maxItems: 8}`. Send the result as `output_config.format = { type: 'json_schema', schema }`, validate the response yourself with the original Zod schema, and snapshot-test the generated schemas.
- **Open risk:** The sandbox has no live API, so whether the API accepts the hand-transformed schema is untested. The schema uses only documented-supported keywords. If Anthropic changes the SDK transform, the helper keeps working because it does not depend on it. During WIRE_UP, send one live request per schema (classification, brief, draft) and confirm a 200 with no `Schema is too complex for compilation` error.
- **Sources:**
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/transform-json-schema.ts — official SDK source — "if (Object.keys(jsonSchema).length > 0) { ... strictSchema['description'] = (existingDescription ? existingDescription + '\n\n' : '') + '{' + Object.entries(jsonSchema).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ') + '}'; } (no branch keeps 'enum')"
  - https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/lib/_parse/_transform.py — official SDK source — "enum = json_schema.pop("enum", None) ... if is_list(enum): strict_schema["enum"] = enum"
  - https://platform.claude.com/docs/en/build-with-claude/structured-outputs — official docs — "How SDK transformation works ... 1. **Remove unsupported constraints** (for example, `minimum`, `maximum`, `minLength`, `maxLength`) ... Supported features ... `enum` (strings, numbers, bools, or nulls only - no complex types) ... `const`"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/helpers/zod.ts — local experiment — "node scratchpad/exp/schemas.mjs (SDK 0.131.0, zod 4.6.5): Classification -> {"type":"object","properties":{"category":{"type":"string","description":"{enum: [\"lead\",\"spam\",\"vendor_pitch\",\"job_seeker\",\"support_request\",\"unclear\"]}"}, ...}; Brief.faqs -> {"type":"array",...,"description":"{maxItems: 8}"}"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/transform-json-schema.ts — local experiment — "verify-ai/v4/tv.mjs: TV1 -> {"type":"object","properties":{"category":{"type":"string","description":"{enum: [\"lead\",\"spam\",\"vendor_pitch\",\"job_seeker\",\"support_request\",\"unclear\"]}"},...}; z.literal('x') -> {"type":"string","description":"{const: \"x\"}"}"

### AI-SO-PARSE-SEMANTICS — `messages.parse()` throws on bad output and loses usage
- **Brief:** Not addressed. This finding corrects the bundled claude-api skill reference, which says "parsed_output is null if parsing failed - assert or guard" (`typescript/claude-api/tool-use.md:593`).
- **Verdict:** Corrected — high confidence
- **Finding:** From the SDK source and a mock-fetch experiment: `client.messages.parse(p)` is `this.create(p).then(message => parseMessage(...))`. There are three outcomes:
  1. **Valid JSON that passes Zod:** `parsed_output` is the typed object. It is also attached non-enumerably to each text block.
  2. **No text block** (for example a refusal before any output, `content: []`): `parsed_output` is `null` and nothing is thrown.
  3. **Invalid or truncated JSON, or a Zod failure:** the promise **rejects** with `AnthropicError` ("Failed to parse structured output: ..."). The Message object is lost, along with its `usage` and `stop_reason`.

  So the bundled reference's "null if parsing failed" is wrong: a failure throws.
  - **Request ID:** the parsed result has no `_request_id`; the `create()` result does.
  - **Return type:** despite its `APIPromise` typing, `parse(...)` returns a plain `Promise` at runtime, so `.withResponse` and `.asResponse` are undefined.
  - **Content leak:** the `AnthropicError` message embeds a snippet of the model output, for example `Unexpected token 'S', "Sorry, I c"... is not valid JSON`.
  - **Text blocks:** `parseMessage` parses *every* text block (each gets its own `parsed_output`), so any non-JSON text block throws. The first block's value becomes the top-level `parsed_output`.
- **Design consequence:** Recommended pattern:
  1. `const msg = await client.messages.create({ ..., output_config: { format: { type: 'json_schema', schema: toClaudeJsonSchema(Schema) } } })`.
  2. Always record `msg.usage`, `msg.model` and `msg._request_id` first.
  3. Branch on `msg.stop_reason`:
     - `'refusal'`: no retry, and a needs-your-touch email.
     - `'max_tokens'` or `'model_context_window_exceeded'`: a failed attempt.
     - anything other than `'end_turn'`: a failure.

     Include a default branch, since new `stop_reason` values may be added.
  4. Concatenate the `content.filter(b => b.type==='text')` blocks.
  5. Run `JSON.parse` + `Schema.safeParse` inside try/catch, then the deterministic validator.

  Never log the raw error message from `JSON.parse` or `AnthropicError`, and never send it to Sentry, because it contains output text. Log only the error class, `stop_reason` and Zod issue paths.
- **Sources:**
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts — official SDK source — "parse<Params ...>(params, options?) { return this.create(params, options).then((message) => parseMessage(message, params, { logger: this._client.logger ?? console })) as APIPromise<...>; }"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/parser.ts — official SDK source — "try { if ('parse' in outputFormat) { return outputFormat.parse(content); } return JSON.parse(content); } catch (error) { throw new AnthropicError(`Failed to parse structured output: ${error}`); }"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/tests/lib/parser.test.ts — official SDK source — "it('handles invalid JSON', ...) expect(() => parseBetaMessage(invalidMessage, params, opts)).toThrow(AnthropicError);" (beta block, line 177)
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/tests/lib/parser.test.ts — official SDK source — "line 581: expect(() => parseMessage(invalidMessage, params, opts)).toThrow(AnthropicError);"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/parser.ts — local experiment — "mock fetch, SDK 0.131.0: '2 REFUSAL parsed_output= null stop= refusal category= general_harms usage.in= 900'; '3 MAX_TOKENS parse() REJECTS -> AnthropicError | message: Failed to parse structured output: Error: Failed to parse structured output as JSON: Unterminated string in JSON at position 32'; 'create()._request_id = req_abc' vs 'parse()._request_id = undefined'; 'TypeError: client.messages.parse(...).withResponse is not a function'"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/parser.ts — local experiment — "verify-ai/v4/e2e.mjs: 'OK parsed_output= {"subject":"Hi","body":"Hello"} stop= end_turn rid= undefined'; 'REFUSAL parsed_output= null stop= refusal'; 'MAXTOK REJECT AnthropicError | ...'; 'create rid= req_v1'; 'parse() withResponse type = undefined asResponse type= undefined ctor= Promise'"

### AI-SO-REFUSAL-MAXTOKENS — refusals and `max_tokens` also break the schema guarantee
- **Brief:** §5.4 "On validation failure: retry once"; only validator failures are considered.
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Refusals:** the response is HTTP 200 with `stop_reason: "refusal"`, and "the output may not match your schema because the refusal message takes precedence over schema constraints". A refusal can arrive before any output (empty content) or mid-stream after partial output; the docs say to "treat any partial output as incomplete and discard it". Re-sending a refused request to the same model "usually earns another refusal".
  - **Truncation:** with `stop_reason: "max_tokens"`, "the output may be incomplete and not match your schema". Retry with a higher `max_tokens`.
  - **Sonnet 5.5 specifically:** "With structured outputs at `low` and `medium` effort, the model occasionally keeps thinking until it reaches `max_tokens`. At `high` effort and above, this almost never happens. Treat any response whose `stop_reason` is `"max_tokens"` as failed, even if its text holds valid JSON, and retry." This warning applies to adaptive thinking.
  - **Docs inconsistency (verifier):** the structured-outputs page says a refusal is "billed for the tokens generated". The more specific refusals page, dated "as of September 2026", says a refusal before any output is billed only for `bio`, `frontier_llm` and `reasoning_extraction`. Use the refusals page for cost logic (see AI-REFUSAL-HANDLING).
- **Design consequence:** Draft pipeline outcomes:
  - `end_turn` and valid: run the validator.
  - `end_turn` with a schema or validator failure: one retry with the errors fed back (per the brief).
  - `max_tokens`: one retry with the same prompt and a larger `max_tokens`. This counts as the single retry.
  - `refusal`: no retry. Go straight to the "needs your touch" email with the minimal safe template, and record `refusal_category` (no content).

  Using `thinking: between_tools` (AI-REQUEST-RECOMMENDATIONS option A) avoids the runaway-thinking `max_tokens` failure. This is an inference the verifier judged well-founded: per the docs, "In a request without tools, `between_tools` means the model answers without thinking first".
- **Sources:**
  - https://platform.claude.com/docs/en/build-with-claude/structured-outputs — official docs — "**Refusals** (`stop_reason: "refusal"`) ... The output may not match your schema because the refusal message takes precedence over schema constraints ... **Token limit reached** (`stop_reason: "max_tokens"`) ... The output may be incomplete and not match your schema * Retry with a higher `max_tokens` value"
  - https://platform.claude.com/docs/en/build-with-claude/structured-outputs — official docs — "If Claude refuses a request for safety reasons: * The response has `stop_reason: "refusal"` * You'll receive a 200 status code * You'll be billed for the tokens generated"
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5 — official docs — "With structured outputs at `low` and `medium` effort, the model occasionally keeps thinking until it reaches `max_tokens`. At `high` effort and above, this almost never happens. Treat any response whose `stop_reason` is `"max_tokens"` as failed, even if its text holds valid JSON, and retry."
  - https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback — official docs — "A refusal can arrive before any output, or mid-stream after partial output. In either case, treat any partial output as incomplete and discard it. ... **Retry on a different model.** Re-sending a refused request to the same model usually earns another refusal."

### AI-SONNET55-REQUEST — request constraints on `claude-sonnet-5-5`
- **Brief:** Not addressed (§5.3 and §5.4 draft-model requests).
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Thinking:**
    - A request with no `thinking` field runs adaptive thinking (On). The default `display` is `"omitted"`: thinking blocks come back with empty text plus a signature.
    - `thinking: {type: 'disabled'}` returns a 400 `invalid_request_error` that points to `between_tools`. `{type:'enabled', budget_tokens}` also returns 400.
    - The lowest setting is `thinking: {"type": "between_tools"}`. It needs no beta header and is available on every platform. "If your requests don't use tools, the response contains only text."
    - `between_tools` is accepted only at effort `low`, `medium` or `high`; it returns 400 at `xhigh`/`max`. It takes no other field (`display`, `budget_tokens` or `block_binding` returns 400) and allows no per-message effort changes.
  - **Effort:**
    - `output_config.effort` takes `low`, `medium`, `high`, `xhigh` or `max`. It is GA, with no beta header.
    - The default on Sonnet 5.5 is `high`, and the levels are recalibrated relative to Sonnet 5.
    - "For chat and other latency-sensitive work, start with `medium` or `low`." At `low` the model "skips thinking on most simple requests".
    - Effort affects all output tokens, not just thinking.
  - **Other constraints:**
    - A non-default `temperature`, `top_p` or `top_k` returns 400.
    - Prefilling the last assistant turn returns 400: "This model does not support assistant message prefill. The conversation must end with a user message."
    - Forced `tool_choice` (`any`/`tool`) returns 400.
    - `max_tokens` covers thinking plus text. Read content by block type, since a response can start with a `thinking` block when thinking is on.
    - Safety classifiers can return `stop_reason: 'refusal'`.
- **Design consequence:** Every Sonnet 5.5 call in v1 is single-turn, tool-free and non-streaming.
  - Send an explicit `output_config.effort`.
  - Send `thinking:{type:'between_tools'}` on the draft path. Per AI-REQUEST-RECOMMENDATIONS as corrected by the verifier, the brief call uses adaptive thinking instead.
  - Send no `temperature`/`top_p`/`top_k`, no prefill, and no tools or `tool_choice`.
  - Read text via `block.type==='text'` for robustness.

  SDK 0.131.0 types already include `between_tools`, so no raw override is needed.
- **Sources:**
  - https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5 — official docs — "To turn off up-front thinking on Claude Sonnet 5.5, send `thinking: {"type": "between_tools"}` instead of `"disabled"`. ... It needs no beta header. ... If your requests don't use tools, the response contains only text ... `between_tools` is accepted at `low`, `medium`, and `high` effort. At `xhigh` or `max` effort, a request with `between_tools` returns a 400 error."
  - https://platform.claude.com/docs/en/models/sonnet-5-5/overview — official docs — "Setting `temperature`, `top_p`, or `top_k` to a non-default value returns a 400 error. ... The minimum cacheable prompt length is 512 tokens."
  - https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide — official docs — "| Claude Sonnet 5.5 | On | `"adaptive"`, `"between_tools"` | `"omitted"` | ... This model does not support assistant message prefill. The conversation must end with a user message."
  - https://platform.claude.com/docs/en/build-with-claude/effort — official docs — "Claude Sonnet 5.5 supports all five effort levels, and `high` is the default on the Claude API. Its levels are recalibrated ... For chat and other latency-sensitive work, start with `medium` or `low`. ... The effort parameter affects **all tokens** in the response"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts — official SDK source — "export interface ThinkingConfigBetweenTools { type: 'between_tools'; } export type ThinkingConfigParam = ThinkingConfigEnabled | ThinkingConfigDisabled | ThinkingConfigBetweenTools | ThinkingConfigAdaptive;"

### AI-HAIKU45-REQUEST — request constraints on `claude-haiku-4-5-20251001`
- **Brief:** Not addressed (§5.2 classification on the fast model).
- **Verdict:** Confirmed — high confidence
- **Finding:**
  - **Thinking:** OFF by default; a request without `thinking` runs without it. Haiku 4.5 accepts `"disabled"` and `"enabled"` (manual extended thinking, with `budget_tokens` at least 1,024 and below `max_tokens`). It rejects `"adaptive"` with a 400. `between_tools` is Sonnet 5.5 only.
  - **Effort:** "Not supported" (models overview, Haiku page, and absent from the effort `supportedModels`). Don't send `output_config.effort`. The exact error for sending it is not documented.
  - **Sampling params:** accepted (the 400 rule covers 4.7+ models) but unnecessary.
  - **Prefill:** accepted by the model but incompatible with structured outputs.
  - **Structured outputs:** supported.
  - **Caching:** the prompt cache minimum is 4,096 tokens, so classification prompts will fall below it and won't be cached.
  - **Limits:** max output 64K; context 200K.
  - **Refusals:** Haiku 4.5 is not among the models documented as running the classifier-refusal safeguards (Fable 5.1, Fable 5, Opus 5.5, Opus 5, Sonnet 5.5). Refusal handling (`stop_reason: 'refusal'`) should still be generic.
- **Design consequence:** The classification request on Haiku omits `thinking`, `output_config.effort` and sampling params, sends no prefill, uses a structured-output enum schema, and uses a small `max_tokens`.
- **Open risk:** The exact error returned when `output_config.effort` is sent to Haiku 4.5 is not documented. The design never sends it, so this needs no live check unless the parameter builder changes.
- **Sources:**
  - https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting — official docs — "| Claude Haiku 4.5 | Extended only | Off | `"adaptive"` |"
  - https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide — official docs — "| Claude Sonnet 4.5 and Claude Haiku 4.5 | Off | `"disabled"`, `"enabled"` | `"summarized"` |"
  - https://platform.claude.com/docs/en/models/haiku-4-5/overview — official docs — "| [Default effort] | Not supported | ... Claude Haiku 4.5 uses manual extended thinking (`thinking.type: "enabled"`), not adaptive thinking."
  - https://platform.claude.com/docs/en/build-with-claude/prompt-caching — official docs — "* 4,096 tokens for Claude Haiku 4.5"
  - https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback — official docs — "Claude Fable 5.1, Claude Fable 5, Claude Opus 5.5, Claude Opus 5, and Claude Sonnet 5.5 include safety classifiers that can decline a request."
  - https://platform.claude.com/docs/en/build-with-claude/extended-thinking — official docs — "`budget_tokens` must satisfy these constraints: * **Minimum of 1,024 tokens.** ... * **Less than `max_tokens`.**"

### AI-REQUEST-RECOMMENDATIONS — request settings for classification, the brief and drafts
- **Brief:** Not addressed (§5.2 classification, §5.3 brief generation, §5.4 draft engine).
- **Verdict:** Corrected — medium confidence. The verifier corrected the research's original recommendation for brief generation (`between_tools`) to the docs-aligned setting (adaptive at `high`), and marked the draft setting as a deliberate deviation from the docs.
- **Finding:**
  - **(a) Classification on `claude-haiku-4-5-20251001`:**
    - `max_tokens: 256`. Omit `thinking` (off by default), `output_config.effort` (not supported) and `temperature`/`top_p`/`top_k`. No prefill.
    - `output_config.format = { type:'json_schema', schema:{ type:'object', properties:{ category:{ type:'string', enum:['lead','spam','vendor_pitch','job_seeker','support_request','unclear'] } }, required:['category'], additionalProperties:false } }`, built with the enum-preserving helper.
    - Lowercase the value before Zod. Treat refusal, `max_tokens` or invalid output as `unclear`.
  - **(b) Brief on `claude-sonnet-5-5`:**
    - Omit `thinking` (adaptive, the default) or send `{type:'adaptive'}`.
    - `output_config: { effort:'high', format: <brief schema> }`. In the brief schema all fields are required, `booking_link`/`sign_off_name` are nullable, `tone.style` is an enum, and the faqs `maxItems` appears in the description only.
    - `max_tokens: 16000`. This leaves room for thinking plus JSON, and is below the SDK's non-streaming guard of about 21,333 when no explicit `timeout` is set.
    - End the system prompt with "Think the problem through before you answer."
    - Treat `stop_reason` `max_tokens` as a failure, and retry once with a higher limit.
    - Worst-case cost is about 30k in × $2 + 16k out × $10, roughly $0.22, once per portal.
    - Give the job enough function duration. If the duration cap binds, fall back to `thinking:{type:'between_tools'}` + effort `'high'` + `max_tokens: 4096`.
  - **(c) Drafts and follow-ups on `claude-sonnet-5-5`:** env-switchable, decided by the golden-case sweep.
    - **Option A** (the cost- and latency-bounded default, and a deliberate deviation from the docs' "start with `high`"): `thinking:{type:'between_tools'}`, `output_config:{effort:'medium', format:<draft schema>}`, `max_tokens: 1024`. It produces one text block, no thinking tokens and no runaway-thinking risk. Do **not** add the "think first" line; it has no effect here.
    - **Option B** (docs-aligned for JSON tasks that apply rules): omit `thinking`, `effort:'high'`, `max_tokens: 8000`, plus "Think the problem through before you answer."
    - **Both options:** never send sampling params, prefill or tools/`tool_choice`. Read text by block type. `stop_reason` `max_tokens` counts as a failure.
    - **Validator retry:** either append-only (`[user, assistant (exact content as received, including any thinking blocks), user (errors)]`), or a fresh single-turn request embedding the prior draft and the errors. Never edit system/tools between attempts: the thinking-block prefix check is enforced for accounts created on or after 2026-08-31.
  - **Why the verifier corrected (b):** the docs say "Start with `high` unless your workload is agentic or latency-sensitive". They also say "Use adaptive thinking for reasoning tasks without tools", and "Use adaptive thinking rather than `between_tools` ... The line has no effect there, and accuracy on these tasks is lower." Brief generation is a one-off background job whose output feeds every future draft. For drafts, applying rules such as "no currency unless allowed" is the docs' "applying a rule" example, so Option A must be marked as a deviation from the docs and settled by the sweep.
- **Design consequence:** Env defaults: `ANTHROPIC_DRAFT_EFFORT=medium`, `ANTHROPIC_BRIEF_EFFORT=high`, `ANTHROPIC_DRAFT_THINKING=between_tools`. Log the choice in DECISIONS.md, and require an effort sweep on real golden cases during WIRE_UP; the docs say the levels are recalibrated and to sweep on your own evals. Wrap the lead message and website text in delimiters as untrusted input (prompt-injection hygiene); structured outputs bound the shape of the output.
- **Open risk:**
  - The quality and latency of `between_tools` vs adaptive thinking for these tasks are unmeasured, because the sandbox has no live API. The recommendation is a documented starting point, not a measured optimum.
  - During WIRE_UP, run the golden-case sweep (Option A vs Option B) and time the brief call (adaptive, `high`, `max_tokens: 16000`) against the Vercel function duration.
  - The 60 s client `timeout` suggested in AI-SDK-ERRORS-RETRIES may need a per-request override for the brief call. The SDK docs allow `timeout` "at the client or request level".
- **Sources:**
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5 — official docs — "To run Claude Sonnet 5.5 without up-front thinking, send `thinking: {"type": "between_tools"}`. ... **Use adaptive thinking for reasoning tasks without tools.** In a request without tools, `between_tools` means the model answers without thinking first. ... 'Think the problem through before you answer.'"
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5 — official docs — "This section applies when you ask Claude Sonnet 5.5 for a JSON answer to a task that needs a few steps of working out. Examples include totaling figures from a document, applying a rule, or ranking items. ... **Use adaptive thinking rather than `between_tools`.** In a request without tools, the model doesn't think before it answers under `between_tools`. The line has no effect there, and accuracy on these tasks is lower."
  - https://platform.claude.com/docs/en/build-with-claude/effort — official docs — "Start with `high` unless your workload is agentic or latency-sensitive. ... For chat and other latency-sensitive work, start with `medium` or `low`. ... Set `max_tokens` with room for thinking and the reply."
  - https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide — official docs — "Without tools, the response contains only text."
  - https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript — official docs — "This SDK also throws an error if a non-streaming request is expected to be above roughly 10 minutes long. Passing `stream: true` or overriding the `timeout` option at the client or request level disables this error."

### AI-REFUSAL-HANDLING — what a refusal looks like, and how it is billed
- **Brief:** Not addressed (§5.4 draft failure path).
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Shape:** HTTP 200, `stop_reason: "refusal"`, `content: []` (or partial output if the refusal came mid-stream), and `stop_details: { type: 'refusal', category: 'cyber'|'bio'|'frontier_llm'|'reasoning_extraction'|'general_harms'|null, explanation: string|null }`.
    - The explanation text is not stable: display it, don't parse it.
    - `stop_details` is `null` for every other stop reason.
    - Sonnet 5.5 declines in all five categories.
    - The non-beta `RefusalStopDetails` has no `recommended_model`; that field exists only in beta, with `fallbacks`.
  - **Billing (as of September 2026):**
    - A refusal before any output is billed only for `bio`, `frontier_llm` and `reasoning_extraction`.
    - A refusal before output in `cyber` or `general_harms`, or with a `null` category, is not billed. Usage token counts still appear, and it counts against rate limits.
    - A mid-stream refusal bills the input plus the streamed output.
  - **Guidance:**
    - Branch on `stop_reason` (or `stop_details.type`), not on content or the inner fields.
    - Instrument refusals as their own metric; they never show up as HTTP errors.
    - Prompts that ask the model to write out its reasoning invite `reasoning_extraction` declines.
  - **SDK types:** `RefusalStopDetails`; `StopReason = 'end_turn'|'max_tokens'|'stop_sequence'|'tool_use'|'pause_turn'|'refusal'|'model_context_window_exceeded'`.
- **Design consequence:**
  - **On refusal:** never retry the same model.
    - Draft: send the "needs your touch" email with the minimal safe template.
    - Brief: show an empty brief form for manual entry.
  - **What to record:** persist `stop_reason` and `refusal_category` (an enum, no content) on the `ai_calls` row, and show the refusal count on the admin page.
  - **Cost rule:** if `stop_reason=='refusal'`, `output_tokens==0`, and the category is not `bio`, `frontier_llm` or `reasoning_extraction`, the billed cost is 0.
  - **Prompts:** don't instruct the model to "explain your reasoning" in the output. `flags[]` should hold short codes, not reasoning.
- **Open risk:** The verifier notes that the cost rule is a heuristic. The docs define billing by "before any output", not by `output_tokens`, and say token counts still appear in `usage` when nothing is billed, so the stored usage numbers are not the billed numbers. Label refusal costs as estimates. The refusal billing rules are dated "as of September 2026", so re-check them during WIRE_UP.
- **Sources:**
  - https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback — official docs — ""content": [], "stop_reason": "refusal", "stop_details": { "type": "refusal", "category": "cyber", "explanation": "..." } ... a refusal that arrives before any output is billed when its `stop_details.category` is `"bio"`, `"frontier_llm"`, or `"reasoning_extraction"` ... A refusal before any output in any other category, or with a `null` category, is not billed. Either way, `content` is empty and token counts appear in `usage`. ... **Branch on `stop_reason` or `stop_details.type`, not on `content` or the inner `stop_details` fields.**"
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5 — official docs — "If your prompts ask the model to include its reasoning in the response, remove those instructions, because they invite `reasoning_extraction` declines."
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts — official SDK source — "category: 'cyber' | 'bio' | 'frontier_llm' | 'reasoning_extraction' | 'general_harms' | null; explanation: string | null; type: 'refusal'; ... export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' | 'model_context_window_exceeded';"

### AI-SERVER-FALLBACK — server-side `fallbacks` (beta): documented, but not enabled in v1
- **Brief:** Not addressed (§5.4 Sonnet 5.5 calls).
- **Verdict:** Extended — high confidence
- **Finding:**
  - **Availability:** beta, Claude API only. Not available on Message Batches, Bedrock, Google Cloud or Foundry.
  - **Header:** `anthropic-beta: server-side-fallback-2026-07-01`. Only this date supports `"default"`. `2026-06-01` accepts only the explicit list, and any other `server-side-fallback-*` value returns 400.
  - **Body:** `"fallbacks": "default"`, or `"fallbacks": [{"model": "claude-sonnet-5", "max_tokens"?: n, "thinking"?: {...}, "output_config"?: {...}, "speed"?: ...}]`.
    - The list holds at most 3 distinct entries.
    - Each entry must be in the model's `allowed_fallback_models`.
    - The request must be valid for every named model.
  - **TypeScript call:** `client.beta.messages.create({ ..., fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] })`.
  - **Behaviour for Sonnet 5.5:**
    - Default routing retries only `cyber` and `frontier_llm` declines, on Claude Sonnet 5. It does **not** retry `bio`, `reasoning_extraction` or `general_harms`.
    - Under the 2026-07-01 header, a `between_tools` request that falls back to Sonnet 5 runs there with `thinking:{type:'disabled'}`.
    - Only a classifier decline triggers it; 429 and 5xx are returned as-is.
  - **Response:**
    - The top-level `model` is the model that served the request.
    - A `{type:'fallback', from:{model}, to:{model}}` content block comes first.
    - `usage.iterations[]` has `type:'message'` entries for declined attempts and `'fallback_message'` for the serving attempt. Top-level `usage` covers only the returned attempt.
    - `stop_details.recommended_model` is set when the fallback was skipped (for example, because the fallback model was rate-limited).
  - **Sticky routing:** stores a content hash of the conversation prefix for about 1h. Don't combine it with the SDK refusal middleware: "Configure one or the other, never both".
- **Design consequence:** Decision for v1: do **not** enable it, and record the deliberate opt-out in DECISIONS.md. The reasons:
  - The decline categories most likely for odd lead text (`general_harms`, and `reasoning_extraction` via injected text) are not retried by default routing.
  - `cyber` and `frontier_llm` declines on SMB lead replies are rare.
  - Enabling it moves calls onto the beta namespace and requires summing `usage.iterations` for cost.

  Handle refusals deterministically instead (AI-REFUSAL-HANDLING), and keep an env flag `ANTHROPIC_SERVER_FALLBACK=off`. If it is turned on later, use `client.beta.messages.create`, compute cost from `usage.iterations` (each entry at that entry's model rate), and record `response.model` as the serving model.
- **Open risk:** This is a beta feature, so its shape may change, though the header date pins it. Re-read the refusals-and-fallback page before enabling the flag.
- **Sources:**
  - https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback — official docs — "Set the `fallbacks` parameter to the string `"default"` and send the `server-side-fallback-2026-07-01` beta header. ... The beta header must carry exactly the date `2026-07-01`, which supports both `"default"` and the explicit-list form, or `2026-06-01`, which accepts only the explicit-list form. Under any other `server-side-fallback-*` value, the `fallbacks` parameter is rejected with a 400 error. ... The top-level `usage` counts describe only the attempt that produced the returned message."
  - https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5 — official docs — "[Server-side fallback] (`fallbacks: "default"`, in beta, on the Claude API) retries `"cyber"` and `"frontier_llm"` declines on Claude Sonnet 5. It doesn't retry `"bio"`, `"reasoning_extraction"`, or `"general_harms"` declines."
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/beta/messages/messages.ts — official SDK source — "export type BetaFallbacksParam = Array<BetaFallbackParam> | 'default'; ... fallbacks?: BetaFallbacksParam | null; ... export interface BetaFallbackMessageIterationUsage { ... type: 'fallback_message'; }"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/beta/beta.ts — official SDK source — "| 'server-side-fallback-2026-06-01' | 'server-side-fallback-2026-07-01'"

### AI-USAGE-FIELDS — usage fields available for per-draft cost tracking
- **Brief:** §5.4 "Record token counts per draft for cost tracking, with no content".
- **Verdict:** Extended — high confidence
- **Finding:** `message.usage` (SDK type `Usage`) contains:
  - `input_tokens: number`: uncached input after the last cache breakpoint.
  - `output_tokens: number`: includes thinking; authoritative for billing.
  - `cache_creation_input_tokens: number|null` and `cache_read_input_tokens: number|null`.
  - `cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } | null`.
  - `output_tokens_details: { thinking_tokens } | null` (`thinking_tokens` is at most `output_tokens`).
  - `server_tool_use: {web_search_requests, web_fetch_requests} | null`.
  - `service_tier: 'standard'|'priority'|'batch'|null` and `inference_geo: string|null`.

  Also available on the message:
  - `message.model` (the model that actually served the request), `message.id`, `message.stop_reason` and `message.stop_details`.
  - `_request_id`, from the `request-id` header. It is present on `create()` results and absent on `parse()` results.
  - `usage.iterations[]`, under server-side fallback only, with per-attempt `{type, model, input_tokens, output_tokens, cache_*}`.
  - An optional top-level `diagnostics.cache_miss_reason` (`{type: model_changed|system_changed|tools_changed|messages_changed|previous_message_not_found, cache_missed_input_tokens}`), added by the verifier. It is not needed in v1.
- **Design consequence:** An `ai_calls` table, with no content:
  - **Columns:** `id`, `portal_id`, `lead_id` (nullable), `purpose` (`classify|brief|draft|followup`), `attempt`, `model`, `request_id`, `stop_reason`, `refusal_category`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `thinking_tokens`, `cost_micro_usd`, `latency_ms`, `outcome` (`ok|schema_fail|validator_fail|refusal|max_tokens|api_error`), `created_at`.
  - **Nulls:** treat null cache fields as 0.
  - **No prompt caching in v1:** per-portal lead volume is low, so the 5-minute TTL rarely hits and 1h writes cost 2x. Haiku's 4,096-token minimum is also larger than classification prompts.
- **Sources:**
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts — official SDK source — "export interface Usage { cache_creation: CacheCreation | null; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null; inference_geo: string | null; input_tokens: number; output_tokens: number; output_tokens_details: OutputTokensDetails | null; server_tool_use: ServerToolUsage | null; service_tier: 'standard' | 'priority' | 'batch' | null; }"
  - https://platform.claude.com/docs/en/api/messages — official docs — ""usage": { "cache_creation": { "ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 0 }, "cache_creation_input_tokens": 2051, "cache_read_input_tokens": 2051, "inference_geo": "global", "input_tokens": 2095, "output_tokens": 503, "output_tokens_details": { "thinking_tokens": 0 }, ... "service_tier": "standard" }"
  - https://platform.claude.com/docs/en/api/messages — official docs — ""diagnostics": { "cache_miss_reason": { "cache_missed_input_tokens": 0, "type": "model_changed" } }"
  - https://platform.claude.com/docs/en/api/errors — official docs — "The Python and TypeScript SDKs expose the request ID as a `_request_id` property on top-level response objects."

### AI-SDK-ERRORS-RETRIES — SDK error classes, default retries, and transient vs fatal handling
- **Brief:** Not addressed for Anthropic; the brief covers transient vs revoked only for HubSpot (§5.1).
- **Verdict:** Extended — high confidence. The verifier corrected the error classification to add `APIUserAbortError`, the duration guard and exact spend-cap detection.
- **Finding:**
  - **Error classes** exported from `'@anthropic-ai/sdk'` (0.131.0, `src/core/error.ts`):
    - `AnthropicError` (base).
    - `APIError` `{status, headers, error, requestID, workspaceID, type}`:
      - `error` holds the full JSON body, for example `{type:'error', error:{type, message, details?}, request_id}`;
      - `requestID` comes from the `request-id` header;
      - `type` equals `body.error.type`.
    - Status subclasses: `BadRequestError` 400, `AuthenticationError` 401, `PermissionDeniedError` 403, `NotFoundError` 404, `ConflictError` 409, `UnprocessableEntityError` 422, `RateLimitError` 429, and `InternalServerError` for >=500 (500 `api_error`, 504 `timeout_error`, 529 `overloaded_error`). Any other status (402 `billing_error`, 413 `request_too_large`) is a plain `APIError`.
    - `APIConnectionError` (status undefined) and its subclass `APIConnectionTimeoutError`.
    - `APIUserAbortError` (status undefined). Thrown when the caller's `AbortSignal` fires, including during the SDK's retry sleep.
    - `RetryableError` (for middleware).
    - A plain `AnthropicError` is also thrown client-side in two cases: by the non-streaming duration guard (`max_tokens` > about 21,333 with no explicit `timeout`), and by `parse()` on invalid structured output.
  - **Default retries:**
    - `maxRetries` is 2 (set per client or per request).
    - Retried: connection errors and timeouts, 408, 409, 429 and >=500. An `x-should-retry: true|false` header overrides this.
    - Delay: `retry-after-ms`, else `retry-after` (seconds or an HTTP date), honoured if >0 and <=2^31-1 ms, with no upper cap. Otherwise min(0.5s × 2^n, 8s) × (1 − up to 25% jitter).
    - The default timeout is 600000 ms. The SDK throws if a non-streaming request's `max_tokens` implies more than 10 minutes, unless `timeout` is set or the call streams.
  - **Special cases:**
    - A spend limit you set yourself returns 400 `invalid_request_error`.
    - The tier monthly spend cap returns 429 `rate_limit_error` with `body.error.details.error_code` `'enforced_spend_limit_reached'` and no `retry-after`. The SDK still retries twice (local test: 3 calls before the throw).
    - Detect the spend cap with `err instanceof RateLimitError && err.error?.error?.details?.error_code === 'enforced_spend_limit_reached'`.
    - Sonnet 5.5 parameter mistakes and schema complexity errors return 400.
  - **Classification after the SDK's own retries:**
    - **TRANSIENT:** `APIConnectionError`, `APIConnectionTimeoutError`, `APIUserAbortError` (our own budget signal), `RateLimitError` with a `retry-after` header, `InternalServerError`, `ConflictError`.
    - **FATAL-CONFIG:** `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `BadRequestError`, `APIError` 402/413, the spend-cap `RateLimitError`, and a plain `AnthropicError` from the duration guard.
    - **OUTPUT-LEVEL:** refusal, `max_tokens`, schema or validator failure.
- **Design consequence:** Create the client as `new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 })`, and pass `{ signal: AbortSignal.timeout(<remaining function budget>) }` per call so that retry sleeps (which honour the signal) can't exceed the Vercel function limit.
  - **TRANSIENT:** job-level backoff; the lead stays pending; re-enqueue on `APIUserAbortError`.
  - **FATAL-CONFIG:** a Sentry alert once, mark the draft "needs your touch", and don't loop.
    - `NotFoundError` covers a bad model ID, for example a retired model.
    - For `BadRequestError`, log `error.type`, and the message only if it contains no content.
    - `RateLimitError` without `retry-after`, or with the spend-cap `error_code`, also lands here.
  - **OUTPUT-LEVEL:** handled per AI-SO-REFUSAL-MAXTOKENS.

  Map a "retired model" error (404/400 on the model) to an admin-visible alert, since Haiku 4.5's retirement floor is near.
- **Open risk:** Spend-cap and error shapes were exercised only against a mock fetch. Confirm `error.type`/`request_id` logging on a real 400 during WIRE_UP.
- **Sources:**
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/core/error.ts — official SDK source — "if (status === 400) { return new BadRequestError(...) } ... if (status === 429) { return new RateLimitError(...) } if (status >= 500) { return new InternalServerError(...) } return new APIError(status, error, message, headers, type);"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/core/error.ts — official SDK source — "export class APIUserAbortError extends APIError<undefined, undefined, undefined> { constructor({ message }: { message?: string } = {}) { super(undefined, undefined, message || 'Request was aborted.', undefined); } }"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts — official SDK source — "this.maxRetries = validatePositiveInteger('maxRetries', options.maxRetries ?? 2); ... const shouldRetryHeader = response.headers.get('x-should-retry'); ... if (response.status === 408) return true; if (response.status === 409) return true; if (response.status === 429) return true; if (response.status >= 500) return true; ... const initialRetryDelay = 0.5; const maxRetryDelay = 8.0; ... static DEFAULT_TIMEOUT = 600000; // 10 minutes"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts — official SDK source — "calculateNonstreamingTimeout(maxTokens, maxNonstreamingTokens) { const maxTime = 60 * 60 * 1000; const defaultTime = 60 * 10 * 1000; const expectedTime = (maxTime * maxTokens) / 128000; if (expectedTime > defaultTime || ...) { throw new Errors.AnthropicError('Streaming is required for operations that may take longer than 10 minutes. ..."
  - https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript — official docs — "Certain errors are automatically retried 2 times by default, with a short exponential backoff. Connection errors ..., 408 Request Timeout, 409 Conflict, 429 Rate Limit, and >=500 Internal errors are all retried by default. ... By default requests time out after 10 minutes. ... On timeout, an `APIConnectionTimeoutError` is thrown."
  - https://platform.claude.com/docs/en/api/errors — official docs — "402 - `billing_error` ... 413 - `request_too_large` ... 429 - `rate_limit_error`: ... A tier spend-cap 429 has no `retry-after` header and keeps failing until access resumes ... 529 - `overloaded_error` ... The API also returns a 400 when usage reaches an organization or workspace spend limit you set"
  - https://platform.claude.com/docs/en/api/rate-limits — official docs — ""details": { "error_code": "enforced_spend_limit_reached" } ... The error type is `rate_limit_error`, the same as for a rate limit, but the response has no `retry-after` header. Retrying, including the SDK's automatic retries, fails until access resumes."
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts — local experiment — "verify-ai/v4/abort.mjs (SDK 0.131.0, mock fetch): 529+retry-after:30 with {signal: AbortSignal.timeout(700)} -> 'APIUserAbortError | Request was aborted. | calls= 1 | ms= 708'; spend-cap 429 (no retry-after) -> 'RateLimitError 429 rate_limit_error | error_code= enforced_spend_limit_reached | calls= 3 | requestID= req_y'; default client max_tokens 32000 non-streaming -> 'AnthropicError | Streaming is required for operations that may take longer than 10 minutes.'; client {timeout:60000} same request -> reaches network (RateLimitError 429)"

### AI-SDK-LOGGING-PRIVACY — the SDK can leak prompt and draft content into logs
- **Brief:** §2 law 4 "Never log tokens, message text or drafts; scrub them from logs and Sentry"; §7 Sentry `beforeSend` scrubbing; §12 "a test proves the scrubber".
- **Verdict:** Extended — high confidence
- **Finding:** Yes, the SDK can leak content, through two paths.
  1. **Debug logging:** SDK log level `debug` logs all HTTP requests and responses, including bodies, and "sensitive data in request and response bodies may still be visible". The level is set via the `ANTHROPIC_LOG` env var or the `logLevel` client option, and the option overrides the env var. The default is `'warn'`.
  2. **Parse errors:** structured-output parse errors (`AnthropicError`) embed a snippet of the model output, for example `Unexpected token 'S', "Sorry, I c"... is not valid JSON`. The project's own `JSON.parse` leaks the same way, because V8 `SyntaxError` messages embed a snippet.

  `APIError` messages for 400s echo the API's error message, which can quote request fields; for example, the thinking-signature 400 names message indices and what changed. The exact content is not documented, so treat every `APIError.message` as untrusted for logging. The API key is sent in the `x-api-key` header. Per the docs, "Some authentication-related headers are redacted" in SDK logs; `src/internal/utils/log.ts` redacts `authorization` and `x-api-key`. The SDK also emits `console.warn` for deprecated models (model ID only, no content).
- **Design consequence:** Construct the client with `logLevel: 'warn'` (or `'error'`) explicitly, so a stray `ANTHROPIC_LOG=debug` can't turn on body logging. Never forward an SDK error's `.message` to Sentry. Log a sanitized record `{class, status, error.type, request_id, stop_reason}` instead. Add these message shapes, including `JSON.parse` `SyntaxError` messages, to the Sentry `beforeSend` scrubber test.
- **Sources:**
  - https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript — official docs — "You can configure the log level in two ways: 1. Through the `ANTHROPIC_LOG` environment variable 2. Using the `logLevel` client option ... `'warn'` - Show warnings and errors (default) ... At the `'debug'` level, all HTTP requests and responses are logged, including headers and bodies. Some authentication-related headers are redacted, but sensitive data in request and response bodies may still be visible."
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/helpers/zod.ts — local experiment — "zodOutputFormat(Draft).parse('Sorry, I cannot help with Jane Doe at 555-0100') -> AnthropicError: 'Failed to parse structured output as JSON: Unexpected token 'S', "Sorry, I c"... is not valid JSON'"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/helpers/zod.ts — local experiment — "verify-ai/v4/tv.mjs: 'sorry AnthropicError | "Failed to parse structured output as JSON: Unexpected token 'S', \"Sorry, I c\"... is not valid JSON"'"

### AI-DATA-RETENTION — Anthropic retention statements for the privacy page
- **Brief:** §5.13: list Anthropic as a sub-processor on `/privacy` (a placeholder marked `TODO: legal review`).
- **Verdict:** Not officially documented — medium confidence. The fetched official docs support every statement below except the standard "30 days" figure, which rests only on a search summary. Note: the merged input file carried the pre-verification answer and privacy text for this finding; this entry uses the verifier's corrected answer from the raw research JSON.
- **Finding:** Supported by fetched official docs (platform.claude.com/docs/en/manage-claude/api-and-data-retention, and structured-outputs):
  - On the Claude API (`api.anthropic.com`), Anthropic is the data processor.
  - "Retained data is never used for model training without your express permission."
  - "Conversation content (your prompts and Claude's outputs) is not retained by default; the exception is Covered Models, which require 30-day retention." The Covered Models are Fable 5.1, Mythos 5.1, Fable 5 and Mythos 5, none of which are used here. The verifier notes this statement sits under "How Anthropic approaches data retention" (general commitments for features that require storage), not in a ZDR-specific section.
  - "Even with ZDR or HIPAA arrangements in place, Anthropic may retain data where required by law or where it has been flagged by Anthropic's automated trust and safety systems ... may retain inputs and outputs for up to 2 years."
  - Structured outputs: the JSON schema is cached for up to 24 hours since last use, and "No prompt or response data is retained beyond the API response."
  - For standard (non-ZDR) retention, the page defers to the commercial data retention policy at https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data. That page was unreachable here. A WebSearch summary of it says Anthropic "automatically deletes inputs and outputs on its backend within 30 days of receipt or generation". The exceptions it lists are longer-retention services (for example the Files API), ZDR agreements, Usage Policy enforcement (flagged inputs/outputs kept up to 2 years, classification scores up to 7 years) and applicable law. The 30-day and 7-year figures are **unverified**, and the reachable sources cannot reconcile "not retained by default" with "deleted within 30 days".
- **Design consequence:**
  - **Privacy placeholder text** (`TODO: legal review`): "Anthropic (Claude API) processes the lead's form message, first name, company and your business brief to classify leads and generate briefs and reply drafts. It acts as our processor and does not use API data for model training without permission. Retention follows Anthropic's commercial data retention policy [link]; content flagged by its trust and safety systems may be kept up to 2 years, or longer where required by law."
  - Add a specific day count only after legal has read the linked policy.
  - Keep JSON schemas free of personal data, since they are cached separately for 24h.
  - Never allow a Covered Model (Fable/Mythos) via env.
- **Open risk:** The 30-day figure comes only from a search summary, because privacy.claude.com is egress-blocked here (CONNECT 403; WebFetch EGRESS_BLOCKED). Legal must read the live commercial retention policy before any day count appears on `/privacy`.
- **Sources:**
  - https://platform.claude.com/docs/en/manage-claude/api-and-data-retention — official docs — "This page covers the Claude API (`api.anthropic.com`) ... where Anthropic is the data processor. ... * Retained data is never used for model training without your express permission. * Only what is technically necessary for the feature to work is retained. Conversation content (your prompts and Claude's outputs) is not retained by default; the exception is Covered Models, which require 30-day retention. ... if a chat or session is flagged, Anthropic may retain inputs and outputs for up to 2 years."
  - https://platform.claude.com/docs/en/manage-claude/api-and-data-retention — official docs — "For Anthropic's standard retention policies outside these arrangements, see the [commercial data retention policy](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) ... ## How Anthropic approaches data retention ... Where a feature necessarily requires storage, Anthropic designs for the smallest possible retention footprint under the following commitments:"
  - https://platform.claude.com/docs/en/build-with-claude/structured-outputs — official docs — "Prompts and responses are processed with ZDR when using structured outputs. However, the JSON schema itself is temporarily cached for up to 24 hours since last use for optimization purposes. No prompt or response data is retained beyond the API response."
  - https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data — official page via search summary — direct fetch blocked in sandbox — "'For Anthropic API users, Anthropic automatically deletes inputs and outputs on its backend within 30 days of receipt or generation', exceptions: longer-retention services (e.g. Files API), ZDR agreements, Usage Policy enforcement (flagged: inputs/outputs up to 2 years, classification scores up to 7 years), applicable law."
  - https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data — local experiment — "curl via proxy: 'curl: (56) CONNECT tunnel failed, response 403'; WebFetch: EGRESS_BLOCKED for privacy.claude.com; WebSearch: session search budget exhausted (200/200). Content not retrievable."

### AI-SDK-STRUCTURED-CALL-PATTERN — one call pattern for classification, the brief and drafts
- **Brief:** Not addressed (§5.2, §5.3, §5.4 implementation).
- **Resolves:** [VERIFY] §3 recommended structured-output approach (the concrete call)
- **Verdict:** Extended — high confidence
- **Finding:** The call:

  ```ts
  const res = await anthropic.messages.create({ model, max_tokens, system, messages, ...buildModelParams(model, purpose), output_config: { ...(effort && { effort }), format: { type: 'json_schema', schema: toClaudeJsonSchema(Schema) } } }, { signal })
  ```

  Then:
  1. `recordUsage(res)`.
  2. `switch (res.stop_reason)`:
     - On `'end_turn'`: `text = res.content.filter(b => b.type === 'text').map(b => b.text).join('')`, then `parsed = Schema.safeParse(safeJsonParse(text))`.
     - Handle `'refusal'` and `'max_tokens'` separately.
     - Treat the default branch as a failure.

  Verified locally with a mock fetch, and reproduced by the verifier:
  - the SDK serialises exactly `{model, max_tokens, thinking:{type:'between_tools'}, output_config:{effort:'medium', format:{type:'json_schema', schema}}, messages}`;
  - it sends that to `POST https://api.anthropic.com/v1/messages` with `anthropic-version: 2023-06-01` and no `anthropic-beta` header;
  - the `parse` function on a helper format is not serialised (format keys are `type,schema`).

  The versioning page says Anthropic may "Add new variants to enum-like output values", which is why the `stop_reason` switch needs a default branch. Because the pattern passes a per-call `{ signal }`, it must also catch `APIUserAbortError` (see AI-SDK-ERRORS-RETRIES).
- **Design consequence:** Put this in `src/lib/ai/` behind an `LlmClient` interface. The FakeLlm used in `APP_MODE=fake` should return canned Messages, including refusal, `max_tokens` and invalid-JSON fixtures, so the failure paths are unit-tested. Always include a default branch for unknown `stop_reason` values.
- **Sources:**
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts — local experiment — "scratchpad/exp/e2e.mjs: 'wire url= https://api.anthropic.com/v1/messages  anthropic-version= 2023-06-01  anthropic-beta= (none)'; 'wire body keys= model,max_tokens,thinking,output_config,messages  thinking= {"type":"between_tools"}  output_config.effort= medium  format.parse serialized?  false'"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts — local experiment — "verify-ai/v4/e2e.mjs: 'wire https://api.anthropic.com/v1/messages anthropic-version= 2023-06-01 anthropic-beta= (none) keys= model,max_tokens,thinking,output_config,messages thinking= {"type":"between_tools"} effort= medium format keys= type,schema'"
  - https://platform.claude.com/docs/en/api/versioning — official docs — "When making API requests, you must send an `anthropic-version` request header. For example, `anthropic-version: 2023-06-01`. ... Anthropic may ... Add new variants to enum-like output values"

### 01.1 Verifier-added items

#### V1 — Sonnet 5.5's thinking-block prefix check and the validator retry
- **Brief:** §5.4 "On validation failure: retry once with the validator errors fed back"; the brief does not say how to build the retry.
- **Verdict:** Extended — high confidence
- **Finding:** The check matters only if a Sonnet 5.5 call runs with adaptive thinking *and* its retry replays the earlier assistant turn.
  - **The rule:** the API checks that nothing before a Claude Sonnet 5.5 thinking block (`system`, `tools`, earlier messages) has changed since the block was produced. It enforces this by default for accounts created on or after 2026-08-31 00:00 UTC on the Claude API, Amazon Bedrock and Google Cloud. A new Hublytix account will be in this group.
  - **The error:** a replay after such a change returns 400 "messages.{i}.content.{j}: Invalid `signature` in `thinking` block. The block is bound to a different conversation...". Retrying the same request body doesn't clear it.
  - **Safe retry shapes:**
    1. Append-only: `[user, assistant (content exactly as received, thinking blocks included), user (validator errors)]`, with `system` unchanged.
    2. Strip every `thinking`/`redacted_thinking` block from the replayed assistant turn (documented as allowed).
    3. Simplest: a fresh single-turn request whose user message embeds the previous draft text and the errors.
  - **When it cannot trigger:** with `thinking:{type:'between_tools'}` and no tools, responses carry no thinking blocks.
  - **Ending the retry:** it must always end with a user message, because a final assistant turn is prefill and returns 400 on Sonnet 5.5.
- **Design consequence:** Use shape (3) or (1) for the validator retry on both draft options, and never edit `system` between attempts. This is required for Option B and the brief call (adaptive thinking).
- **Open risk:** Confirm the Anthropic account's creation date during WIRE_UP. Any account created after 2026-08-31 has the check on by default.
- **Sources:**
  - https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5 — official docs — "It enforces that check by default for accounts created on or after August 31, 2026, 00:00 UTC, on the Claude API, Amazon Bedrock, and Google Cloud. On those accounts, a request that replays a block after such a change returns a 400 error. ... With `between_tools`, keep the history append-only, or strip the thinking blocks from the edited turn on."
  - https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5 — official docs — "The API also checks whether anything before a Claude Sonnet 5.5 thinking block has changed since the block was produced: the `system` prompt, the `tools`, or an earlier message."
  - https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting — official docs — "messages.{i}.content.{j}: Invalid `signature` in `thinking` block. The block is bound to a different conversation. ... Retrying the same request body doesn't clear the error. ... Alternatively, strip every `thinking` and `redacted_thinking` block from the history"

#### V2 — a per-call AbortSignal throws `APIUserAbortError`, which is not retried
- **Brief:** Not addressed. This relates to the jobs that must fit a Vercel function budget.
- **Verdict:** Extended — high confidence
- **Finding:** The SDK throws `APIUserAbortError`, an `APIError` subclass with status `undefined` and message `'Request was aborted.'`.
  - It is not retried.
  - It fires even during the SDK's retry sleep, because `sleep(timeoutMillis, options.signal)` honours the signal.
  - It is **not** an `APIConnectionTimeoutError`, so code that only catches timeouts will misclassify it.
  - Verified locally: a mock 529 with `retry-after: 30` and `AbortSignal.timeout(700)` gave `APIUserAbortError` after 708 ms, with a single fetch.
- **Design consequence:** Classify it as TRANSIENT and re-enqueue the job (included in AI-SDK-ERRORS-RETRIES).
- **Sources:**
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts — official SDK source — "if (options.signal?.aborted) { throw new Errors.APIUserAbortError(); } ... await sleep(timeoutMillis, options.signal ?? undefined);"
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts — local experiment — "verify-ai/v4/abort.mjs: 'abort-during-retry-sleep -> APIUserAbortError | Request was aborted. | calls= 1 | ms= 708'"

#### V3 — the SDK's non-streaming `max_tokens` guard
- **Brief:** Not addressed. This constrains the `max_tokens` values in AI-REQUEST-RECOMMENDATIONS.
- **Verdict:** Extended — high confidence
- **Finding:** When neither the client nor the request sets `timeout`, `messages.create()` computes `expectedTime = 3,600,000 ms × max_tokens / 128,000`.
  - If that exceeds 600,000 ms (`max_tokens` > about 21,333), it throws `AnthropicError` "Streaming is required for operations that may take longer than 10 minutes..." before sending.
  - All the recommended values (256 / 1024 / 4096 / 8000 / 16000) are under the limit.
  - Setting a client `timeout` (for example `60_000`) or streaming disables the guard.
  - Verified locally: `max_tokens` 32000 throws on a default client and reaches the network on a `{timeout:60000}` client.
- **Design consequence:** Keep `max_tokens` ≤ 16000 on every path. If the client `timeout` is ever removed, a larger `max_tokens` becomes a FATAL-CONFIG `AnthropicError` before any network call.
- **Sources:**
  - https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript — official docs — "This SDK also throws an error if a non-streaming request is expected to be above roughly 10 minutes long. Passing `stream: true` or overriding the `timeout` option at the client or request level disables this error."
  - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts — official SDK source — "let timeout = options?.timeout ?? ((this._client as any)._options.timeout as number | null); if (!body.stream && timeout == null) { const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? undefined; timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens); }"

### 01.2 Test vectors

None of these vectors are published by Anthropic. TV1–TV5 were generated locally with the official `@anthropic-ai/sdk` 0.131.0 (with zod 4.6.5, and zod 3.25.76 for the v3 crash), using a mock `fetch` where a network call was involved. TV6 is arithmetic on the vendor-published prices; its token counts are illustrative inputs, not measurements. The verifier re-ran all of them on a fresh install with independent scripts and added three new vectors. Both blocks below are copied verbatim from the research and verification records.

**Research vectors (generated locally with the official SDK):**

```text
TV1. SDK zodOutputFormat (@anthropic-ai/sdk 0.131.0 + zod 4.6.5).
Input: z.object({category: z.enum(['lead','spam','vendor_pitch','job_seeker','support_request','unclear']), confidence: z.enum(['high','medium','low'])})
Schema sent: {"type":"object","properties":{"category":{"type":"string","description":"{enum: [\"lead\",\"spam\",\"vendor_pitch\",\"job_seeker\",\"support_request\",\"unclear\"]}"},"confidence":{"type":"string","description":"{enum: [\"high\",\"medium\",\"low\"]}"}},"additionalProperties":false,"required":["category","confidence"],"description":"{$schema: \"https://json-schema.org/draft/2020-12/schema\"}"}
The enum is NOT constrained.

TV2. Enum-preserving helper, same input.
Output: {"type":"object","properties":{"category":{"type":"string","enum":["lead","spam","vendor_pitch","job_seeker","support_request","unclear"]},"confidence":{"type":"string","enum":["high","medium","low"]}},"required":["category","confidence"],"additionalProperties":false}

TV3. Enum-preserving helper, brief schema (faqs .max(8); booking_link and sign_off_name .nullable(); tone {style enum, note}).
Output: faqs becomes {"type":"array","items":{"type":"object","properties":{"question":{"type":"string"},"answer":{"type":"string"}},"required":["question","answer"],"additionalProperties":false},"description":"{maxItems: 8}"}; booking_link becomes {"type":["string","null"]}; tone.style becomes {"type":"string","enum":["friendly","formal","direct"]}; all 10 top-level fields are required; additionalProperties is false.

TV4. zodOutputFormat parse failures.
- 9 faqs: throws AnthropicError '... faqs: Too big: expected array to have <=8 items'.
- '{"category":"Lead",...}': throws '- category: Invalid option: expected one of "lead"|"spam"|...'.
- 'Sorry, I cannot help with Jane Doe at 555-0100': throws AnthropicError 'Failed to parse structured output as JSON: Unexpected token 'S', "Sorry, I c"... is not valid JSON'. This is a content-snippet leak.

TV5. messages.parse() with a mock fetch.
- content [] with stop_reason 'refusal': parsed_output is null, no throw.
- text '{"subject":"Hi","body":"Hello Sa' with stop_reason 'max_tokens': the promise rejects with AnthropicError 'Failed to parse structured output: Error: Failed to parse structured output as JSON: Unterminated string in JSON at position 32 (line 1 column 33)'.
- create()._request_id is 'req_abc'; parse()._request_id is undefined.

TV6. Cost, in micro-USD per token.
Rates: sonnet-5-5 in 2 / out 10 / cache5m 2.5 / cache1h 4 / read 0.2; haiku-4-5 in 1 / out 5 / 1.25 / 2 / 0.1.
- Sonnet draft, 1500 in / 250 out, no cache: 1500*2 + 250*10 = 5500 micro-USD ($0.0055).
- Haiku classification, 600 in / 20 out: 600 + 100 = 700 micro-USD ($0.0007).
- Sonnet brief, 30000 in / 1500 out: 60000 + 15000 = 75000 micro-USD ($0.075).
- Sonnet general_harms refusal before output, 412 in / 0 out: billed 0.
- The same refusal with category bio: 412*2 = 824 micro-USD.
Token counts are illustrative inputs, not measurements.
```

**Verifier recheck (re-executed locally on a fresh install; includes three new vectors):**

```text
Re-executed on fresh installs in scratchpad/verify-ai (npm pack @anthropic-ai/sdk@0.131.0, sha1 81a8b4db6d19d0cbe3e74170f6c201a0b4d2c65e, identical to the agent's tarball; zod 4.6.5 and 3.25.76). Independent scripts, not the agent's.

TV1 REPRODUCED byte-identically (zodOutputFormat moves enum into description; root description '{$schema: ...}').

TV2 REPRODUCED byte-identically with an independently written enum-preserving walker (verify-ai/v4/helper.mjs).

TV3 REPRODUCED: faqs keeps items plus description '{maxItems: 8}'; booking_link becomes {"type":["string","null"]}; tone.style keeps its enum; 10 required fields; additionalProperties false.

TV4 REPRODUCED:
- 'Sorry, I cannot help with Jane Doe at 555-0100' gives AnthropicError "Failed to parse structured output as JSON: Unexpected token 'S', \"Sorry, I c\"... is not valid JSON".
- The cased enum 'Lead' gives AnthropicError '... category: Invalid option: expected one of "lead"|...'.
- The truncated JSON throws 'Unterminated string'.

TV5 REPRODUCED (verify-ai/v4/e2e.mjs):
- Refusal with content []: parsed_output null, no throw.
- max_tokens with truncated JSON: rejects with 'Failed to parse structured output: Error: Failed to parse structured output as JSON: Unterminated string in JSON at position 32 (line 1 column 33)'.
- create()._request_id is 'req_v1'; parse()._request_id is undefined; the parse() return is a plain Promise (withResponse undefined).

TV6 arithmetic RE-CHECKED: 5500, 700, 75000, 0 and 824 micro-USD are correct at the documented rates.

Zod 3.25 classic-schema crash REPRODUCED.

NEW vectors (verify-ai/v4/abort.mjs):
- Abort during the retry sleep: APIUserAbortError at 708 ms.
- Spend-cap 429: 3 fetches, then RateLimitError, err.error.error.details.error_code='enforced_spend_limit_reached'.
- max_tokens 32000 on a default client: AnthropicError duration guard.
```
