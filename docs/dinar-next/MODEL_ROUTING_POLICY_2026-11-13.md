# JassimAI multi-tier model routing — design, evidence and configuration (2026-11-13)

Owner policy: continuity with controlled cost — not unlimited free usage, and not a chat that
stops at the first free-model quota. Implemented on `claude/jassimai-replit-integration`.

## 1. Architecture (reuses Replit's work; no second gateway or billing engine)

| Piece | Where | Role |
|---|---|---|
| Routing policy | `lib/ai-usage-policy.ts` → `routing` inside the AI usage policy | Catalog, per-audience classes, paid-fallback switch, per-turn ceilings, cost projection. Stored in `commercial_policies` (versioned, per market, admin `POST /admin/commercial-policies`). **Default: disabled.** |
| Planner | `ai/model-routing.ts` `planModelRoute` | Pure, bounded decision: at most one primary and one failover. |
| Gateways | `ai/model-gateway.ts` `catalogModelGateway` | Builds catalog models through the existing `chatGateway` (same keys, base URLs, deployment rules). |
| Identity | `smart-turn.ts` `exactModelIdentityGateway` (Replit) | A reply whose actual model differs from the requested one is rejected. |
| Prices | `ai_model_prices` + `applicableApprovedPrice` (Replit) | Only sourced, non-placeholder rows in the spend currency count. |
| Money | `reserveAiUsage` / `holdAiSpend` / `settleAiUsage` (existing + Replit) | Holds for every model the route can reach; per-account, per-plan, global caps; rollback on failure. |
| Free gate | `free-model-policy.ts` (Replit allowlist + versioned activation) | Used when the catalog is off. |
| Premium trial | `ai-premium-trial.ts` (Replit) | Unchanged; off by default; 15 messages, atomic. |
| Kill switch | `DINAR_PAID_FALLBACK_KILL=1` (env) and `routing.paidFallbackEnabled=false` (policy) | Stops every paid catalog route instantly. |
| Diagnostics | log event `jassim_model_route` | Tier, choice, difficulty, chosen classes/models/projected micros, exclusion reasons. No message, user id or key. |

### Precedence for a turn

1. Routing policy enabled for the market → catalog route (this document).
2. Else free-routing enforcement active (`DINAR_FREE_ROUTING_POLICY=2026-11-13.v1:enforce:<env>` + allowlist) → Replit's strict free route.
3. Else the configured route (`DINAR_AI_*`), exactly as before, under the existing usage/spend checks.

A premium-trial request uses the trial model only when the trial is authorized and available; otherwise
it continues on the account's normal route (1 or 3), never on a hidden paid model.

## 2. Routing decision flow

```
classes by choice and task          audience filter            per model (in order)
AUTO light : FREE → ECONOMY → CORE   GUEST: FREE, ECONOMY        qualified (Arabic, tools)?
AUTO heavy : CORE → ECONOMY → FREE   FREE : FREE, ECONOMY, CORE  context window ≥ need?
ECONOMY    : ECONOMY → FREE          GO   : FREE, ECONOMY, CORE  approved price, same currency?
CORE       : CORE → ECONOMY          PRO  : + ADVANCED           FREE: zero price + allowlisted
ADVANCED   : ADVANCED → CORE                                     paid: policy switch ∧ audience switch ∧ ¬kill
                                                                 projected turn ≤ audience and model ceilings?
                                                                 breaker closed / not disabled?
→ primary = first eligible; failover = first eligible of another class (else the next one)
→ none eligible: truthful capacity message, no model call, nothing charged
→ reservation holds money for both; failure rolls back; settlement records the actual model and cost
```

"Heavy" reuses the existing task classifier (`selectModelTier`: long requests, analysis, explicit
high effort). Every message goes to one model; the failover is used only on a provider failure.

## 3. Test evidence (scripted models — no provider, no key, no money)

`test/model-routing.test.ts` — 21/21. Planner R1–R11 and API journeys J1–J10 (free model available;
first free exhausted; all free exhausted; economy down → CORE only; CORE directly for a heavy task;
user-selected CORE/ADVANCED by audience; kill switch; paid off per audience; price raised above the
ceiling; placeholder/missing/foreign-currency/non-zero-FREE prices; unsupported tools and small context;
quota failover with a recorded cost event; double outage rolls the reservation back (RELEASED, 0
charged); global budget refusal before any call; identity mismatch rejected; guests without paid
fallback; duplicate retry runs once; account isolation; trial request without trial consumes nothing;
routing disabled keeps the legacy route).

Premium trial 15 / 1 / exhausted, atomic reservation, single grant and fallback are Replit's
`next-g1-usage` tests (36/36 on this branch).

## 4. Candidate models (OpenRouter public catalog, read 2026-11-13; prices per 1M tokens)

Turn cost = a realistic JassimAI turn of 6,000 input + 800 output tokens. These are **paper**
assignments: no paid evaluation was run (not authorized), and the free models could not be tested
(no OpenRouter key here). Arabic evidence: DeepSeek is the only family with JassimAI's own lab
evidence (DSLAB, 500-case catalog, recorded R2 replies).

| Class | Model (exact OpenRouter ID) | In / Out USD | Turn | Context | Why / caveats |
|---|---|---|---|---|---|
| FREE | google/gemma-4-31b-it:free | 0 / 0 | $0 | 262k | Required tool choice; multilingual card. Account-wide free rate limits; Google AI Studio retention (per Replit's audit: 55 days, no training). |
| FREE | google/gemma-4-26b-a4b-it:free | 0 / 0 | $0 | 262k | Same family, faster; alternative free. |
| ECONOMY | deepseek/deepseek-v4-flash | 0.09 / 0.18 | $0.00068 | 1M | Cheapest model of a family with JassimAI lab evidence; tools + structured output. |
| ECONOMY | google/gemini-2.5-flash-lite | 0.10 / 0.40 | $0.00092 | 1M | Strong multilingual baseline at low cost. |
| ECONOMY | qwen/qwen3.5-flash-02-23 | 0.065 / 0.26 | $0.00060 | 1M | Good Arabic reputation; verify Gulf dialect. |
| CORE | anthropic/claude-haiku-5.5 | 0.10 / 0.50 | $0.00100 | 1M | High quality per dollar; tools + structured output. |
| CORE | deepseek/deepseek-v4-pro | 0.90 / 1.50 | $0.0066 | 1M | Lab-proven family, stronger reasoning. |
| CORE | google/gemini-3.6-flash | 0.75 / 3.75 | $0.0075 | 1M | Fast, multilingual. |
| ADVANCED | anthropic/claude-sonnet-5.5 | 2.00 / 10.00 | $0.020 | 1M | Hard reasoning, agents, coding. |
| ADVANCED | google/gemini-3.1-pro-preview | 2.00 / 12.00 | $0.0216 | 1M | Preview — prefer a GA model in production. |
| ADVANCED | openai/gpt-5.6-terra | 2.00 / 12.00 | $0.0216 | 1M | Alternative provider for diversity. |

Very cheap models such as llama-3.1-8b ($0.00015/turn) were not shortlisted: low price is not value
when Arabic quality and tool validity are unproven; cost per *successful* task is what matters.

**Recommended first configuration (to evaluate before activation):** FREE gemma-4-31b → ECONOMY
deepseek-v4-flash → CORE claude-haiku-5.5, with deepseek-v4-pro as a second CORE, claude-sonnet-5.5
as ADVANCED for BUSINESS_PRO.

### Budget illustration (owner decides the numbers)

At $0.00068 per economy turn, 1,000 free-tier fallback turns a day ≈ $0.68/day; at $0.001 per CORE
turn, ≈ $1.00/day. A guest cap of 20 turns/day per guest key and a global daily cap of e.g. $5 bounds
abuse at $5/day worst case.

## 5. Exact configuration required (nothing below is applied)

1. Credentials (environment credential form, never chat): an OpenRouter key with a credit cap.
2. In staging/production OpenRouter must be reached as `OPENAI_COMPATIBLE` with the pinned base URL
   (the `OPENROUTER` provider is refused there by `resolveAIProviderConfiguration`). Catalog entries
   therefore use `provider: "OPENAI_COMPATIBLE"`.
3. `ai_model_prices`: one approved row per catalog model (`source` PROVIDER_PUBLISHED or CONTRACT,
   `source_reference` set, currency USD; OPENAI_COMPATIBLE rows need both cache-write rates; FREE rows
   all zero).
4. `DINAR_APPROVED_FREE_OPENROUTER_MODELS` = the exact FREE IDs.
5. Commercial policy for the market (admin route), `aiUsage.spend`: `global.limitMicros` (e.g.
   5,000,000 = $5/day), `perPlan.GUEST` / `perPlan.FREE` (daily per-audience budgets),
   `perAccount.FREE` (per user per period), `unpricedModel: "REFUSE"`.
6. `aiUsage.routing`: `enabled: true`, `paidFallbackEnabled: true` only after approval, the catalog
   above with `qualified` set only for models that passed evaluation, audience ceilings
   (defaults: GUEST 2,000 micros/turn, FREE 5,000, GO 20,000, PRO 60,000), `paidFallback` per audience.
7. Staging first; production only after a staging soak. `DINAR_PAID_FALLBACK_KILL=1` stops paid routing
   immediately without a database change.

## 6. Remaining owner decisions

- Approve exact models per class (after a small paid evaluation, which itself needs approval and a budget).
- Approve budgets: global daily cap, per-audience daily caps, per-user caps, per-turn ceilings.
- Whether guests get paid economy fallback at all (default off) and their per-day limit.
- Which tiers may choose CORE / ADVANCED directly.
- Premium-trial activation (model, price, deployment approvals) — still off.
- Privacy: whether Google AI Studio's retention (free tier) is acceptable for user content.
