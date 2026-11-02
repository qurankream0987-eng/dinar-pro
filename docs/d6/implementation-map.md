# D6 Universal Buyer Employee — Implementation Map

## Baseline and scope

- Repository: `qurankream0987-eng/dinar-pro`
- Branch: `replit/dinar-next-complete-development`
- Baseline HEAD: `3847ad79fd808775f9a6b403ad9697baa49d6080`
- Baseline working tree: clean
- D5 remains PARTIAL. The buyer path below does not depend on an unverified D5 session or delegated seller authority.
- No production database, live model, payment provider, or real buyer/seller contact is part of this map.

The buyer employee is a capability of the existing authenticated conversation, not a second employee session or commerce runtime. A buyer's authority comes from the authenticated actor, owned conversation, current market, server-side result identities, and existing action reviews. D4/D5 seller delegation remains a separate role and authorization path.

## Request and intelligence path

| Responsibility | Existing implementation | Authority boundary |
| --- | --- | --- |
| Authenticated conversation | `artifacts/api-server/src/routes/ai.ts`: `POST /ai/conversations` and `POST /ai/conversations/:id/turns` | Both routes require authentication. Turn handling verifies conversation ownership before invoking the runtime. |
| Unified turn routing | `artifacts/api-server/src/ai/conversation-runtime.ts`: `executeAiConversationTurn`, `executeWithRoutingMode` | Buyer turns re-enter the common router. Seller employee handling is conditional on an actual persisted D5 session; an ordinary buyer does not receive delegated seller privileges. |
| Flexible language understanding | `artifacts/api-server/src/ai/model-turn.ts`: strict `ModelTurnOutput`, `MODEL_TOOL`, and canonical-request contract; `artifacts/api-server/src/ai/smart-turn.ts`: `executeModelFallback` | The model may interpret or restate intent. The server validates the output and re-enters the same deterministic runtime; model output is not an authority to write data. |
| Canonical search | `artifacts/api-server/src/ai/tool-registry.ts`: `searchListings`; `artifacts/api-server/src/lib/marketplace-listings.ts`: `searchMarketplaceListings` | Results come from published marketplace records in the current market. Search output does not create inventory or seller facts. |
| Buyer discovery and result state | `artifacts/api-server/src/ai/buyer-turn.ts`: `executeBuyerTurn`, `runBuyerSearch`, refinement/ranking/comparison and selection handlers | Search constraints and stable resource identities are persisted in conversation result sets; selection resolves against those server records, not client-provided listing IDs. |
| Comparison and unknown facts | `buyer-turn.ts` comparison handlers and the typed conversation response schemas in `packages/api-zod/src/conversation-runtime.ts` | Comparison values are read from current server records; missing attributes stay missing. |

## Existing action authorities

| Capability | Existing implementation | Canonical authority and persistence |
| --- | --- | --- |
| Buyer-to-seller inquiry | `artifacts/api-server/src/ai/inquiry-turn.ts`: `executeInquiryTurn` | Uses the G2 inquiry/message services, contact and consent checks, review/confirmation, persisted thread messages, and idempotency. |
| Buyer negotiation | `artifacts/api-server/src/ai/negotiation-turn.ts`: `executeNegotiationTurn` | Uses the canonical negotiation engine for review, offer/counter status, lifecycle, stale-state validation, and replay protection. |
| Cart display and edits | `conversation-runtime.ts`: `executeCartConversationTurn`; `artifacts/api-server/src/lib/marketplace-cart.ts` | Reads and updates the authenticated user's server-side cart with market, listing, quantity, and availability checks. |
| Add to cart | `artifacts/api-server/src/ai/tool-registry.ts`: `addToCart` | Validates that the listing belongs to the result set in this conversation and market. Card actions use the server's idempotent add receipt path. |
| Purchase review and order creation | `artifacts/api-server/src/ai/buyer-turn.ts`: `executePurchaseTurn`; action authority in `artifacts/api-server/src/ai/action-foundation.ts` | Review and explicit confirmation precede canonical order creation. Changed price/stock requires a fresh review. Test payment remains `SIMULATION_ONLY`; no real transfer is authorized here. |
| Order history and tracking | `artifacts/api-server/src/ai/order-context.ts` and the existing order/fulfillment services | Reads only participant-owned orders and recorded fulfillment state; it does not invent tracking or delivery status. |
| Recovery and idempotency | persisted `messages`, `ai_result_sets`, `ai_ui_blocks`, pending actions, and action receipts | Reload and retry resolve against persisted actor/conversation/market/resource identities rather than process-local buyer state. |

## Existing UI and typed contracts

- The DINAR conversation UI consumes server-authored blocks and action envelopes; the D6 backend does not ask the model to author application UI.
- Cart state is backed by the marketplace cart API and server records, not a second client ledger.
- D6 does not change the dedicated V2 comparison/cart presentation owned by the parallel frontend work. The current browser suites use the target checkout's own web server, not the workspace's separately configured preview artifact.

## Existing evidence to reconcile in the acceptance matrix

- `block-f2-buyer.test.ts`: natural buyer search, contextual refinements, ranking, comparison, unknown attributes, selection, rejection of invented/out-of-range references, and reload restoration.
- `block-f3-commerce.test.ts`: authenticated cart and purchase/order flows, confirmation, stock/price changes, and false-success checks.
- `next-g2-inquiry.test.ts`: buyer inquiry, consent, persistence, retry/idempotency, participant authorization, and injection boundaries.
- `universal-negotiation-acceptance.test.ts`: negotiation lifecycle and stale/replay/authorization checks.
- `model-native-routing.test.ts` and `bounded-multistep.test.ts`: model interpretation re-enters canonical runtime; compound buyer requests remain bounded and do not execute unconfirmed future actions.
- `w02-ultra-browser.test.ts` and `w02u3-card-recovery-browser-journey.test.ts`: target-checkout browser and recovery coverage. They must be run against the disposable loopback database before being counted as evidence.

## D6 change in this checkout

- `promotionIntent` no longer treats ordinary words for offers, products, or listings as evidence of paid seller promotion. Seller marketing-advice verbs now require whole-word matches, so a buyer asking how to choose between offers stays in the buyer conversation instead of opening seller promotion education.
- Regression coverage is in `artifacts/api-server/test/promotion-intent.test.ts` and the authenticated W02 browser journey. This is a routing-boundary correction; it does not add a new buyer runtime or alter promotion purchase authority.
- The universal-negotiation fixture now uses an alphabetic-only suffix. Random Arabic suffixes could accidentally contain an order-intent word and route a listing search to order history.

## Gaps to prove, not presume

1. Existing suites are separate subsystem journeys; the D6 matrix must distinguish subsystem coverage from a single end-to-end buyer journey.
2. Scripted/injected model tests prove contract and server enforcement only, not live Arabic model quality. No live model call is authorized for this acceptance run.
3. Browser evidence is valid only when the test launches the checked-out target application and authenticates a synthetic account. The workspace preview URL is not evidence for this nested target checkout.
4. PostgreSQL 18 is not installed in this environment; only the available PostgreSQL 16 loopback instance can be validated.
5. Any untested case remains PARTIAL, BLOCKED, or NOT_RUN in `acceptance-matrix.md`; passing neighboring assertions is not a substitute.
