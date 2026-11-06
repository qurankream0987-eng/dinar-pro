# AI gateway, routing and model acceptance

Current source `9101672a7370bb8080e598344840d1fde2f88291`; active Claude source `d0c2f0390b6d06bece8bd2d95c5629d2384c19bc` is inspected, not merged or executed here. The gateway, existing runtime, tool registry and spend/allowance authorities remain the foundation. No second conversation/model/action engine was added.

| Layer | Actual implementation / evidence | Verified limit |
| --- | --- | --- |
| LIGHT/HEAVY selection | `src/ai/model-gateway.ts`, existing tier/provider configuration and `smart-turn` classification; bounded call/tool/deadline and breaker paths | Offline contract, routing and reservation/failure tests; not a current best-model ranking |
| Canonical read/preparation tools | Current capability registry has 15 entries; exact advertised tool/role sets tested, including the unchanged no-financial-writer authority suite | Registry entries, advertised model tools and frontend actions are different counts; no blanket arbitrary tool union accepted |
| Grounding and context | `model-turn`, `smart-turn`, live owned context/read feedback, bounded D17 memory, explicit server receipt | Recorded response replay and actual API/database effects; no model text becomes payment, order completion or authorization |
| General Arabic/routing modes | LEGACY/HYBRID/MODEL_FIRST tests, held-out existing datasets, controlled/recorded transports | Engineering behavior verified. Broad live Gulf Arabic comprehension, ambiguity and multi-step quality remain unverified |
| Historical product wording | Replit 76a7e403 grammar/matchers restored selectively; current query extraction shares the grammar | Real HTTP search → comparison, original MODEL_FIRST/cart receipt/ordinal tests, no cart/order effects from product-shaped words |
| Budgets/cost | Existing reservations, usage ledger, renewal/window and actual-call settlement paths | Synthetic cost arithmetic/guard tests. DINAR allowance is not a provider token/account balance |
| Additional Claude intelligence | Eight bindings: capability discovery, partner/domain search, business/order issue/seller-dues reads, business preparation and usage read/forecast | Absent from this working registry; existing underlying services are present. Joint integration and role/initialization/authority regressions required |

OpenAI/Claude/DeepSeek/Groq/OpenRouter/Gemini/OpenAI-compatible transports/configuration are not proof of currently available models or prices. Historical DeepSeek R1/R2/R3 artifacts are replay evidence, not live retests: exact contracts, truncated/invalid output, credential/quota/timeouts, verified read feedback, restart and browser recovery are exercised locally. The standalone benchmark suite runs offline with live keys stripped; no paid/live benchmark occurred.

Gemini's adapter/schema handling and scripted provider tests exist in `model-gateway.ts`/`ai-provider.test.ts`; there is no verified separate Gemini-agent branch/task artifact. Configured candidate names/free-tier labels are **UNVERIFIED** for current availability, pricing, context limits and reasoning support. The inspected self-hosted slot on Claude uses the existing OPENAI_COMPATIBLE transport and is prepared, not deployed. No model weights, private endpoint, inference spend or billing permission was activated.

The multi-step example “help open a business, choose a name/domain and find a designer” must be evaluated on the joint Claude candidate with held-out paraphrases, real capability discovery and unknown/provider handling. It is not hardcoded here or claimed solved by a single deterministic keyword test. Claude's 17 commits retain their identities; detailed missing bindings, nine textual conflicts and semantic watch items are in [FINAL_CLAUDE_INTEGRATION_HANDOFF](FINAL_CLAUDE_INTEGRATION_HANDOFF.md).

Required external evidence: owner-approved model/provider, credentials, data policy, inference budget and held-out live evaluation. Recorded scores and old provider reports never establish current live quality. The platform is reviewable; full intelligence acceptance remains PARTIAL.
