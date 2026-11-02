# DINAR NEXT Command 02 — External Brain Contract

**Status:** PARTIAL; `LIVE_MODEL_NOT_VERIFIED` and `REAL_LLM_ACCEPTANCE_BLOCKED`
**Tested implementation SHA:** `15808607810983dd1bbc277f74c45d6687b56e3f`

## Existing contract reused

DINAR continues to use the server-side provider-neutral model gateway and the existing structured conversation-turn contract. Provider selection, timeouts/retries, model readiness, and model usage/cost accounting remain server concerns. No provider credential or model configuration is exposed to the browser.

`artifacts/api-server/src/ai/model-turn.ts` defines the structured output schema and tool description consumed by `artifacts/api-server/src/ai/smart-turn.ts`. The Command 02 extension is optional `plannedSteps`, a bounded list of two or three strings with a maximum of 400 characters per step. The prompt asks the model to use only ordered excerpts from the current user message, retain conditions, avoid confirmations, and omit a plan when intent or order is ambiguous.

The model still proposes interpretation; DINAR's server remains the authority for market availability, actor identity, route selection, confirmation, and business mutations. The change does not add raw SQL, arbitrary tools, or a parallel chatbot.

## Verification record

- **Requirement:** Command 02 §§04, 10, 14, and 15.
- **Exact modified files:** `artifacts/api-server/src/ai/model-turn.ts`, `artifacts/api-server/src/ai/smart-turn.ts`, `artifacts/api-server/src/ai/conversation-runtime.ts`.
- **Tests:** `ai-provider.test.ts` 47/47; `model-tiers.test.ts` 24/24; `model-native-routing.test.ts` 8/8; `closure-ai-cost.test.ts` 19/19.
- **Environment:** Controlled scripted/injected gateways and disposable loopback PostgreSQL. The closure cost suite used a fresh development-seeded disposable database with its documented acceptance flags. Network-guard output was zero outbound attempts.
- **Tested code SHA:** `15808607810983dd1bbc277f74c45d6687b56e3f`.
- **Status:** PASS for the tested gateway contracts, deterministic orchestration, and bounded usage/cost controls. PARTIAL for external-brain acceptance.
- **Provider dependency:** Actual provider/model availability and owner permission for live acceptance.
- **Remaining limitation:** No real provider request was sent, so the exact live provider/model and its Arabic, dialect, reasoning, and planning quality are unverified. Do not interpret scripted responses as real-model evidence.

No paid provider was activated, no live provider call was made, and no real customer communication or payment was attempted.

## Command 02B revalidation

**Implementation/test commit:** `792d0f4da3500d00915e178d73f713d2a822a8be`

The server-side gateway in `artifacts/api-server/src/ai/model-gateway.ts` retains provider-neutral adapters for Groq, OpenRouter, OpenAI, Replit AI Integrations, OpenAI-compatible endpoints, Gemini, and DeepSeek. At source level, primary-provider resolution falls back to Groq if `DINAR_AI_PROVIDER` is absent; an environment override can change the effective selection. Active provider values and credentials were not inspected, so the effective runtime provider remains unverified.

`plannedSteps` is still part of the existing structured response; the server accepts only bounded, ordered excerpts from the current message. The commerce-route regression also now lets an unscoped real-world current-demand question reach the general model. The system prompt explicitly says the model has no live internet or real-time data, so this does not authorize a current-market claim.

Controlled verification: provider 47/47, model tiers 24/24, operation contracts 7/7, model-native routing 9/9, command-A acceptance 22/22. These establish contracts and routing only. XP-19 passed after the routing correction; the XP suite remains 21/22 because its browser report recorded one failed resource load. No model answer quality was independently judged.

**Status remains:** `LIVE_MODEL_NOT_VERIFIED`; `REAL_LLM_ACCEPTANCE_BLOCKED`. Owner-approved provider selection and explicit live-test authorization are still required.
