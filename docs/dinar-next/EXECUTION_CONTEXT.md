# DINAR NEXT — Execution Context

Engineering map for the coordinated 00→A→…→FINAL run. Source of truth is the code; this file only says
where to look. Architecture detail and baseline evidence: [`00-baseline.md`](./00-baseline.md).
Authoritative requirements: [`DINAR_NEXT_FULL_COMMANDS.md`](./DINAR_NEXT_FULL_COMMANDS.md).

## Canonical paths

| Area | Path / symbol |
|---|---|
| Turn endpoint (SSE, idempotent by `clientMessageId`) | `artifacts/api-server/src/routes/ai.ts` `POST /ai/conversations/:id/turns` |
| Single orchestrator | `src/ai/conversation-runtime.ts` `executeAiConversationTurn` |
| Route gates (auth/market/provider) | `src/ai/conversation-router.ts` `resolveConversationRoute` |
| Action / capability / surface registries | `lib/api-zod/src/conversation-runtime.ts` |
| Compound requests (bounded, ≤3 steps, «التالي») | `src/ai/task-plan.ts` |
| Model gateway (GROQ / OPENROUTER / OPENAI / REPLIT_OPENAI) | `src/ai/model-gateway.ts` `resolveAIProviderConfiguration`, `createConversationModelGateway` |
| Model turn contract, prompt, history, redaction | `src/ai/model-turn.ts` `interpretWithModel`, `ModelTurnOutput`, `MAX_MODEL_INPUT_CHARS` |
| Model fallback + per-actor model rate limit | `src/ai/smart-turn.ts` `executeModelFallback` |
| Seller drafts / publish | `src/ai/listing-draft.ts` `listingDraft`; `src/ai/draft-actions.ts` `publishDraft` |
| Buyer search / purchase review | `src/ai/buyer-turn.ts`; `src/lib/marketplace-listings.ts` `searchMarketplaceListings` |
| Negotiation | `src/ai/negotiation-turn.ts`; `src/lib/negotiations.ts` |
| Orders / checkout | `src/lib/commerce.ts` `planCheckout`, `createOrdersFromPlan` |
| Delivery / courier | `src/ai/delivery-turn.ts`, `src/ai/driver-turn.ts`, `src/lib/delivery.ts`, `src/lib/courier-economics.ts` |
| Contact release | `src/lib/contact-release.ts` |
| Promotions / ads | `src/ai/promotion-turn.ts`, `src/lib/promotions.ts`, `src/lib/promotion-policy.ts` |
| Market Pulse / business | `src/lib/market-pulse.ts`, `src/ai/commerce-turn.ts`, `src/lib/business.ts` |
| AI usage allowances (G1) | `src/lib/ai-usage.ts` (reserve/settle/reconcile/summary), `src/lib/ai-usage-policy.ts` (policy, periods), tier `src/lib/business.ts` `aiPlanFor`; cards `src/ai/usage-turn.ts` via `commerce-turn.ts` (`AI_USAGE`, `AI_PLANS`) |
| Buyer–seller inquiries (G2) | `src/lib/inquiries.ts` (authority, delivery), `src/ai/inquiry-turn.ts` (adapter), action `SEND_INQUIRY_MESSAGE` in `src/ai/action-foundation.ts` |
| Seller sales statistics | `src/ai/seller-sales.ts` (`SALES` insight) via `seller-management.ts` `executeSellerAdviceTurn` |
| Frontend chat | `artifacts/dinar/src/pages/Ai.tsx`, `src/features/ai/*` (G: `InquirySurface.tsx`, AI cards in `CommercialSurface.tsx`, sales in `BusinessSummaryPanel.tsx`) |
| OpenAPI | `lib/api-spec/openapi.yaml` → Orval → `lib/api-zod`, `lib/api-client-react` |

## Provider configuration (development)

`.replit` sets `DINAR_AI_MODEL_FALLBACK=true`, `DINAR_AI_PROVIDER=GROQ`, `DINAR_AI_MODEL=qwen/qwen3.8-27b`.
Model registration is development-only (`model-turn.ts` `modelGatewayRegistration.environments`).
Live status (2026-10-19): GROQ, OPENAI and OPENROUTER keys all return HTTP 401. The Replit AI
Integrations OpenAI proxy (`AI_INTEGRATIONS_OPENAI_*`, model `gpt-5-mini`) answers; it is selectable with
`DINAR_AI_PROVIDER=REPLIT_OPENAI`. Switching the Repl's default provider is an owner action.

## Test commands

All suites run through `artifacts/api-server/test/run.mjs`, which refuses any DB that is not a loopback
`dinar_(test|acceptance|…)_*` database and strips provider keys. Session harness (scratchpad, not committed):

- `pg.sh init` — loopback PostgreSQL 16 on 127.0.0.1:55432, templates `dinar_test_template00`
  (migrations + acceptance fixtures) and `dinar_test_templatedev` (migrations + dev seed).
- `pg.sh run <label> <cmd>` — fresh clone per run, managed `PG*`/`DATABASE_URL` stripped, dropped after.
- Suite flags are the ones in `artifacts/api-server/package.json` scripts.
- Timing-sensitive suites (`marketplace-intelligence`, `employment`) must not run alongside a build.

Live provider smoke (read-only, no DB): bundle `test/groq-live-general-smoke.ts` with esbuild and run with
`DINAR_RUN_LIVE_GROQ_SMOKE=1 NODE_ENV=development DINAR_AI_PROVIDER=<provider>`.

## Restrictions (frozen)

No bubble architecture, no new cryptocurrency/wallet, no capability gating by plan (G: Go/Pro expand AI usage
allowances only; prices/quotas unapproved), commission stays 10% (`PLATFORM_FEE_BASIS_POINTS = 1_000`), payments simulation-only, no
invented GPS/ETA, no courier tips, no duplicate commerce engines, no deployment, no push.
