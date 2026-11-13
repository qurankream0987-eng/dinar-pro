# Free-model qualification — 2026-11-13 (integration of Replit e04b1aa, owner Option A)

## Verdict

**Do not activate free-model enforcement yet.** No model is qualified for JassimAI user traffic on
the evidence available today. Activation stays off (`DINAR_FREE_ROUTING_POLICY` unset), so free
accounts and guests keep the existing route under the existing usage reservation, price check and
spend hold.

Two blockers are independent of model quality:

1. **Account-wide rate limits.** OpenRouter's limits page and FAQ (read 2026-11-13) say free variants
   (`…:free`) have their own requests-per-minute and requests-per-day limits that depend on credits
   ever purchased, and that free models "have low rate limits … and are usually not suitable for
   production use". The limit is per OpenRouter account, i.e. shared by every JassimAI user. The
   exact numbers are rendered client-side and could not be read from the fetched page — they must be
   read from `GET /api/v1/key` (`free_model_daily_requests`) once a key exists.
2. **No real-model evaluation was possible.** This environment holds no OpenRouter key (only DeepSeek
   and Railway credentials). Arabic/Gulf-dialect quality, tool-call validity against JassimAI's
   function schema, identity reporting and failover were therefore **not tested against a real
   model** (status: BLOCKED). No inference request was made; spend $0.

## Method (all public, no key, no inference)

- `GET https://openrouter.ai/api/v1/models` → 472 models, **17 with prompt and completion price "0"**.
- `GET /api/v1/models/{id}/endpoints` for every tool-capable candidate → serving provider, status,
  uptime, quantization, `tool_choice` modes.
- `GET /api/v1/providers` → provider headquarters, datacenters, privacy/terms URLs.
- OpenRouter docs: limits page and FAQ.
- The API does **not** publish retention or training flags per endpoint; privacy below is from the
  provider's terms URL and Replit's audit, and is marked unverified where I could not read it.

## Zero-price catalog (2026-11-13)

| Exact ID | Context / max out | tools | tool_choice | structured_outputs | Serving provider | Notes |
|---|---|---|---|---|---|---|
| google/gemma-4-31b-it:free | 262,144 / 32,768 | ✓ | ✓ (incl. required) | – (response_format ✓) | Google AI Studio (US) | uptime 30m/1d 100% |
| google/gemma-4-26b-a4b-it:free | 262,144 / 32,768 | ✓ | ✓ | – (response_format ✓) | Google AI Studio (US) | MoE, faster |
| nvidia/nemotron-3-ultra-550b-a55b:free | 1,000,000 / 65,536 | ✓ | ✓ | – | Nvidia (US) | NVIDIA **API Trial** terms |
| nvidia/nemotron-3.5-super-vl:free | 1,000,000 / 131,072 | ✓ | ✓ | ✓ | Nvidia (US) | vision; trial terms |
| nvidia/nemotron-3.5-lightning:free | 1,000,000 / 65,536 | ✓ | ✓ | – | Nvidia (US) | nvfp4 quantized |
| nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free | 256,000 / 65,536 | ✓ | ✓ | – | Nvidia (US) | small reasoning |
| baidu/ernie-5.5-flash-preview:free | 1,024,000 / 921,600 | ✓ | ✓ | ✓ | Baidu (CN) | preview; CN jurisdiction |
| dots-studio/dots-3-note-preview:free | 512,000 / 460,800 | ✓ | ✓ | ✓ | AtlasCloud (US) | preview, fp8 reseller |
| particle-ai/particle-1:free | 1,048,576 / 131,072 | ✓ | ✓ | ✓ | Particle AI (US) | no public model card read |
| liquid/lfm-3-1.7b:free | 262,144 / 8,192 | ✓ | ✓ | ✓ | Liquid | 1.7B; not for multi-step reasoning |
| liquid/lfm-2.5-2.6b:free | 65,536 / 8,192 | ✓ | ✓ | ✓ | Liquid | small |
| cohere/north-mini-code:free | 256,000 / 64,000 | ✓ | ✓ | – | Cohere (US) | code model |
| recursive/flint-v1.0:free | 262,144 / 235,929 | ✓ | **–** | – | – | no tool_choice → unusable |
| thinkingmachines/inkling-2-small:free | 1,048,576 / 131,072 | ✓ | **–** | – | – | no tool_choice → unusable |
| openrouter/free | 200,000 / – | ✓ | ✓ | ✓ | dynamic | **rejected**: not an exact model |
| google/lyria-3-clip-preview, google/lyria-3-pro-preview | – | – | – | – | – | music models, not text |

JassimAI's turn contract is a forced function call (`tool_choice` = required) with a JSON-Schema
argument, so a candidate needs `tools` + `tool_choice`; `structured_outputs` is not required.

## Ranked shortlist (paper ranking — must be confirmed by a real evaluation)

1. **google/gemma-4-31b-it:free** — exact ID, required tool choice, long context, the strongest
   multilingual pedigree of the list (Gemma 4 card: 35+ languages supported, 140+ pretrained), stable
   endpoint. Privacy: Google AI Studio; Replit's audit reports 55-day prompt retention, no training
   (not re-verified here). Not zero-retention.
2. **google/gemma-4-26b-a4b-it:free** — same contract and provider, lower latency; fallback to #1.
   Same model family means a failover keeps similar behaviour.
3. **nvidia/nemotron-3-ultra-550b-a55b:free** — largest model; served under NVIDIA *API Trial* terms,
   whose data-use clauses must be read before any user content is sent. Arabic quality unknown.
4. **nvidia/nemotron-3.5-super-vl:free** — adds vision and structured outputs; same trial-terms caveat.
5. **baidu/ernie-5.5-flash-preview:free** — capable on paper but a *preview*, CN jurisdiction, and no
   Arabic-specific evidence; lowest privacy fit for Gulf users.

Not recommended: small Liquid models (quality, Replit's audit flags possible training use), Cohere
North Mini Code (code-specialised), previews from resellers, models without `tool_choice`, and the
dynamic `openrouter/free` alias.

## What activation requires (in order)

1. A dedicated OpenRouter key with a $0 credit cap for free models (saved through the environment's
   credential form, never in chat); read its real `free_model_daily_requests`.
2. A controlled real evaluation of #1 and #2 on JassimAI's own Arabic/Gulf conversation set and
   tool-call contract (identity reporting, schema-valid calls, refusal on mismatch, failover #1→#2).
3. A zero-price `ai_model_prices` row with a source reference for each approved ID, and
   `DINAR_APPROVED_FREE_OPENROUTER_MODELS` listing them.
4. Only then `DINAR_FREE_ROUTING_POLICY=2026-11-13.v1:enforce:<environment>` on staging first.
   The value names its environment, so it cannot activate production by being copied.

Given blocker 1, the likely production design is not "free models for every free user" but free
models for guests and light traffic with a strict cap, and an owner-approved low-cost model for
registered free accounts under the existing spend controls. That is an owner pricing decision and is
not made here.
