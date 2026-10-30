# DINAR — Architecture for engineers who will change it

Complements `docs/dinar-next/HANDOFF_FOR_NEXT_AGENT.md` (file map) and
`docs/dinar-next/CLAUDE_DINAR_ARCHITECTURE_MAP.md` (wave-00 map). Read the code; this explains
the shape so you know where a change belongs.

## 1. Monorepo

| Package | Role |
|---|---|
| `artifacts/api-server` | Express 5 API, conversation runtime, domain services, all tests |
| `artifacts/dinar` | React/Vite web app; chat-first (`CHAT_ONLY_MODE = true` in `src/App.tsx`) |
| `lib/db` | Drizzle schema (`src/schema/index.ts`), 41 SQL migrations (`drizzle/`), release manifest, clone guard |
| `lib/api-spec` | `openapi.yaml` — source of the REST contract |
| `lib/api-zod`, `lib/api-client-react` | **generated** from the spec (run codegen, never hand-edit). Exception: `lib/api-zod/src/conversation-runtime.ts` is hand-written (action registry, surfaces) |

## 2. A conversation turn

`POST /api/ai/conversations/:id/turns` (SSE) → `routes/ai.ts` → `executeAiConversationTurn`
in `src/ai/conversation-runtime.ts`.

The runtime is an **ordered chain of deterministic handlers**; the first that claims the
message answers, and the model is consulted only when none does (or for general conversation).
Order matters: a handler early in the chain wins over later ones. Before adding a pattern, find
which handler currently claims the message (add a temporary log, remove it after).

Handlers you will meet, roughly in the order they claim:
control/compound plans → listing-photo suggestions → employment → order contact → buyer–seller
inquiry (`inquiry-turn`) → **order context** (`order-context`: orders list/status/tracking/receipt/
issue) → provider and market gates → best-price requests → driver → **negotiation**
(`negotiation-turn`: reviews, decisions, counters, status) → **purchase** (`buyer-turn`
`executePurchaseTurn`: purchase/payment reviews, «ادفع») → **draft actions** (`draft-actions`:
«انشره», «كمل الإعلان», «اعرض الإعلان قبل النشر») → **listing draft** (`listing-draft`) →
**seller management** (`seller-management`: stock, sales, previews of price/quantity/status) →
commerce (`commerce-turn`: promotions, balance, plans, Pro) → smart turn (`smart-turn`:
consultation, advice, refusals of autonomous negotiation) → **buyer search/refine**
(`buyer-turn`, `marketplace-intent`, `search-query`, `tool-registry.searchListings`) → model.

A turn returns a `ToolResult` (`kind`, `surface`, `listings`, `prompt`, typed payload fields).
`routes/ai.ts` persists it as an `ai_ui_blocks` row and an `ai_result_sets` row and streams it.
**Context for the next turn is read back from those rows** (latest block, latest result set,
pending action). That is why «الأول», «نعم», «ادفع», «كم آخر عرض؟» work: they resolve against
stored state, never against the model's memory.

## 3. Actions: review → confirm → execute

`src/ai/action-foundation.ts` + `CONVERSATION_ACTION_REGISTRY` (`lib/api-zod/src/conversation-runtime.ts`).

1. A handler proposes an action (`proposeAction`) and stores it as a pending result set
   (`createPendingAction`), shown as a review card. **Nothing changes yet.**
2. The user confirms («نعم», a card button) → `confirmPendingAction` re-reads the current server
   state (`read`), re-checks `allowed`, and only then `execute`s through the canonical service.
   If the resource changed since the review → `REVIEW_REQUIRED` (a new review), never the old one.
3. Every action has `requiresConfirmation: true`; the registry lists exactly which exist.
   Adding an action is a reviewed change; adding one with financial or delivery authority is
   forbidden (GUARDRAILS A6–A7).

## 4. Cards (surfaces)

The server picks a `surface` (e.g. `LISTING_RESULTS`, `SELL`, `MY_LISTINGS`, `NEGOTIATION_REVIEW`,
`PURCHASE_REVIEW`, `ORDERS_LIST`, `ORDER_STATUS`) and typed data; the web renders it with fixed
components in `artifacts/dinar/src/features/ai/` (`ConversationContent.tsx` routes surfaces).
Order cards embed the real order page (`pages/OrderDetails.tsx` → `OrderInlineSurface`) inside
the chat, through an in-card memory router: that is where accept / hand-off / receipt / dispute
buttons live. Cards that read data must not show cached values after a server-side change
(see `SellerListingsSurface` `refetchOnMount: "always"`).

## 5. Listing lifecycle

Draft (`ai_ui_blocks.payload.draft`, step machine in `listing-draft.ts`: title → description →
category → attributes → price → quantity → area → contact → payment methods → review) →
«انشره» → `PUBLISH_LISTING` review → «نعم» → same create body as `POST /api/listings` →
`offers` row (`status PUBLISHED`; price in `unit_price_minor`; text fields in `data`).
Seller edits/pause/archive: preview (`managementPreview`) → «نعم» → offers update with ownership check.

## 6. Negotiation

`lib/negotiations.ts`: OPEN (buyer's offer) → COUNTERED (seller) ↔ … → ACCEPTED (agreed amount,
one buyer, consumed once by an order) | REJECTED | WITHDRAWN | EXPIRED. Price only; non-price
terms are not stored (owner decision P-SC03). A NEGOTIABLE listing cannot be bought at the asking
price without an agreement.

## 7. Orders, delivery, disputes

State machine and invariants: `docs/dinar-next/CLAUDE_01_STATE_TRANSITION_MATRIX.md`.
CREATED (stock reserved: `offers.reserved_quantity += q`) → ACCEPTED (seller) → delivery
arrangement (`order_fulfillments`: PICKUP needs READY_FOR_PICKUP; SELLER_DELIVERY needs
OUT_FOR_DELIVERY; COURIER is recorded by the assigned driver) → SELLER_MARKED_DELIVERED (proof)
→ COMPLETED (buyer confirms) or DISPUTED (buyer, with reason) → admin resolves BUYER (CANCELLED,
stock released) or SELLER (COMPLETED, fee recorded once). Expiry and cancellation release the
reservation (`order-terminal-accounting.ts`).

## 8. Payments (simulation only)

`POST /api/payments/intents` (buyer, owned order) → provider simulation → signed webhook
`/api/payments/webhooks/test` → `payment_events` (dedup by provider event id; amount/currency
checked) → intent states. Capture on a cancelled/lapsed order → `payment_refund_obligations`
(D3). Cash (`CASH_DIRECT`) is off-platform: DINAR never shows it as money collected. Real billing
for subscriptions is not connected (`BILLING_PROVIDER_NOT_CONNECTED`).

## 9. Arabic understanding

- Normalisation: `arabic-normalization.ts` (`foldArabicLetters`, digits, number words),
  `search-context.ts` (`normalizeSearch`, category aliases), `context-intent.ts` (status
  questions, corrections, price edits).
- Search matching: `lib/arabic-search-terms.ts` (request words, variants, lexicon, generic and
  purpose words) used by `lib/marketplace-listings.ts` conversational matching; relaxations in
  `tool-registry.ts` with `broadenedFrom` / `widenedFromCategory`.
- Intent: `intent.ts` (`surfaceIntent`: SELL, ORDERS, …), `marketplace-intent.ts`
  (explicit search intent, search questions).
- Measurement: `test/arabic-generality.test.ts` + `test/fixtures/arabic-generality-phrases.json`.

## 10. Where a change belongs

| You want to… | Change |
|---|---|
| understand a new phrasing of an existing request | the handler that should claim it (find it first), plus a test with other phrasings |
| match more listing wordings | `arabic-search-terms.ts` (+ precision test) |
| a new card field | the `ToolResult` type, the producing handler, the web component; never let the card compute money |
| a new state change | a registry action with review/confirm, ownership in `allowed`, the canonical service in `execute` — and a reviewer's approval |
| a new table/column | a new SQL migration + manifest + clone guard + reviewed-journal test + readiness head tag |
