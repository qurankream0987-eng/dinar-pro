# DINAR NEXT G0 — Existing Entitlement and Buyer–Seller Communication Audit

Date: 2026-10-20. Branch `main`, HEAD `d6bf588` (clean tree). Preceding work: A–F + FINAL
(`FINAL_ACCEPTANCE.md`). Evidence is the source at that HEAD; paths are relative to the repo root,
`api/` = `artifacts/api-server/src/`.

Authority: `DINAR_NEXT_G0_G3_COMMANDS.md` (G0–G3) and `DINAR_NEXT_CONVERSATION_FIRST_PRODUCT_AUTHORITY.md`
(cross-cutting). The A–F frozen rule "no new subscription gating / Go-Pro postponed" is superseded for G by
those two documents: tiers may expand **usage allowances only**.

## 1. Membership, subscription and usage — what exists

| Capability | Class | Evidence |
|---|---|---|
| Account model, roles, status (ACTIVE / RESTRICTED / SUSPENDED / DEACTIVATED) | VERIFIED EXISTING | `lib/db/src/schema/index.ts` `users` (role USER/ADMIN, `status`), `api/lib/account-status.ts` |
| Plan catalog (admin-configured, per market, versioned price) | VERIFIED EXISTING | `promotion_products` with `productType = 'DINAR_BUSINESS'`, `businessEntitlements jsonb`; admin create `api/routes/commercial.ts` `POST /admin/markets/:marketId/commercial-products` |
| Subscription record with price/entitlement **snapshot**, one live per user+market, idempotency key, no auto-renew (DB check) | VERIFIED EXISTING | `business_subscriptions`; `api/lib/business.ts` `subscribeBusiness`, `cancelBusinessSubscription`, `getBusinessStatus`, `businessEntitlements` (period end settled on read) |
| Paid activation | SIMULATION ONLY | `subscribeBusiness` refuses unless `isPromotionSimulationEnabled()` (development + explicit flag); charges the commercial balance via `chargeAvailable` (`api/lib/commercial-ledger.ts`), `paymentMode: TEST_NO_TRANSFER`. No real billing provider. |
| Plans seeded in any market | NONE | no `DINAR_BUSINESS` row in migrations, `test/seed.ts` or acceptance fixtures — prices are **unconfigured** everywhere until an admin creates a plan |
| Entitlements granted by Business | VERIFIED EXISTING (capability gating) | `MARKET_PULSE_ADVANCED`, `CAMPAIGN_ANALYTICS_ADVANCED`, `BUSINESS_REPORTING`, `INVENTORY_INSIGHTS`; only `MARKET_PULSE_ADVANCED` is enforced (`api/ai/commerce-turn.ts` Market Pulse windows/limits). Baseline blocker B-4 (keep/hide) still open — left unchanged. |
| Conversation access to plans/status/cancel | VERIFIED EXISTING (Business only) | `api/ai/commerce-turn.ts` patterns `business`, `businessStatus`, `businessCancel`; views `BUSINESS_PLAN_REVIEW`, `BUSINESS_STATUS`; client `features/ai/CommercialSurface.tsx` |
| **AI usage allowances per plan** | **MISSING** | no table, policy or code meters AI usage per account or plan |
| **AI usage ledger / reservation / settlement** | **MISSING** | — |
| Global AI spending guard | **MISSING** | — |
| Provider token / cost recording | MISSING | `api/ai/model-gateway.ts` `OpenAICompatibleChatGateway` ignores `result.usage`; `model-turn.ts` logs provider/model/latency only |
| Rate limits | VERIFIED EXISTING (abuse, not quota) | `api/lib/auth-rate-limiter.ts` `consumeRateLimit` (HMAC buckets, ≤20/window); model turns 20 per 5 min per actor (`api/ai/smart-turn.ts` `executeModelFallback`); guest preview per IP (`AUTH_RATE_LIMIT_SCOPE.guestAiPreview`) |
| Guest usage | PARTIAL | `/ai/preview` rate-limited per IP (`api/routes/ai.ts:708`), `executeGuestModelTurn`; no allowance accounting |
| Actor/market authorization | VERIFIED EXISTING | `requireAuth`, `marketFor(req)`, `ownedConversation`, adapters check `ownerId` on every result set |
| Billing/payment boundary | VERIFIED EXISTING | payments `SIMULATION_ONLY` (DB checks on `payment_intents`, `commercial_topups`); commission `PLATFORM_FEE_BASIS_POINTS = 1_000` |
| Configurable versioned policy store | VERIFIED EXISTING | `commercial_policies` + `api/lib/commercial-policy.ts` `getCommercialPolicy` (market row over global over code v0) |

**AI model call sites** (all go through `proposeThroughGateway`, `api/ai/model-gateway.ts`):

| Site | Purpose | Metering need |
|---|---|---|
| `api/ai/smart-turn.ts` `executeModelFallback` → `draftWithClaimGuard` → `interpretWithModel` (1–2 calls) | signed-in general chat, marketing copy (with a corrective retry) | TEXT / MARKETING (multi-call) |
| `api/ai/smart-turn.ts` `executeGuestModelTurn` | guest general chat | guest scope |
| `api/ai/personal-context-service.ts` `extractAmbiguousTopics` | background memory topic extraction | optional, skip when exhausted |
| `api/ai/groq-listing-photo-provider.ts` via `api/ai/listing-photo-intelligence.ts` `collectListingPhotoSuggestions` (called from `listing-draft.ts`) | image understanding for seller drafts | IMAGE |
| `api/ai/groq-listing-image-policy-reviewer.ts` | publication image policy review (development-only, schema pending) | not user-initiated; out of scope |

Answer: **no current system supports configurable plan-based AI usage allowances.** The canonical pieces to
extend are the `DINAR_BUSINESS` catalog + `business_subscriptions` (entitlement source), `commercial_policies`
(configuration), and `proposeThroughGateway` callers (metering points). A new usage ledger is required; it is
not a duplicate of `commercial_entitlements` (which counts bundle units of listing promotions).

## 2. Buyer–seller communication — what exists

| Capability | Class | Evidence |
|---|---|---|
| Price negotiation (offer, counter, accept, best-price request) | VERIFIED EXISTING | `negotiations`, `negotiation_events` (append-only); `api/lib/negotiations.ts` `openNegotiation`, `decideNegotiation`; `api/ai/negotiation-turn.ts` `executeNegotiationTurn`, `refreshNegotiationPayload`; surfaces `NEGOTIATION_REVIEW/STATUS/LIST` |
| Order-bound messaging (after purchase) | VERIFIED EXISTING (REST only) | `conversations.kind='ORDER'` + `messages.senderId`; `api/routes/marketplace.ts` `GET/POST /orders/:id/messages` (participants only via `authorizedOrder`) |
| Seller contact release | VERIFIED EXISTING | `api/lib/contact-release.ts` `getAuthorizedSellerContacts` (buyer only, confirmed CASH_DIRECT orders); chat path `executeOrderContactRequest` |
| Notifications | MISSING (provider) | `api/lib/provider-boundaries.ts` declares `NotificationProvider` (EMAIL/SMS/PUSH); `api/lib/market-capability-registry.ts:112` "no outbound notification adapter exists" |
| Abuse reporting | VERIFIED EXISTING (listing/user/order targets) | `marketplace_reports`, `api/routes/trust-safety.ts` `POST /reports` (`TARGET_TYPES = LISTING, USER, ORDER`) |
| Block / mute between users | MISSING | no table or code |
| Pre-purchase listing inquiry (non-price) | **MISSING** | no table, service or adapter; `grep inquir` finds nothing |
| AI-suggested customer replies | PARTIAL | marketing model drafts «اكتب رد لزبون» text for the seller to copy (`seller-management.ts` `MARKETING_REQUEST`); never sent |
| Message persistence | VERIFIED EXISTING | `messages` table (shared by AI and ORDER conversations) |
| Conversation hydration | VERIFIED EXISTING | `api/routes/ai.ts` `GET /ai/conversations/:id` → `freshBlocksForConversation` rebuilds commerce/negotiation/delivery/… payloads from live state |

Specific questions:

| | Question | Answer |
|---|---|---|
| A | Buyer asks DINAR to send a non-price question to a seller | **MISSING** |
| B | Seller replies inside DINAR | **MISSING** for inquiries; PARTIAL for orders (REST `POST /orders/:id/messages`, not from the conversation) |
| C | Reply delivered to the buyer's original conversation | **MISSING** |
| D | Seller initiates an authorized question to a buyer | **MISSING** (negotiation counters are price-only; order messages REST-only) |
| E | Canonical inquiry thread linked to listing/order | **MISSING** (order thread exists, listing thread does not) |
| F | Inquiries separate from binding negotiations | N/A today; negotiations are price-only, so a new inquiry must stay separate |
| G | Permissions before/after purchase | Before: negotiation by buyer on a published NEGOTIABLE listing in the same market (`offerPreconditions`); contact never public. After: order participants message each other (REST) and the buyer gets contact for confirmed cash orders. |
| H | Notifications / delivery receipts | **MISSING**: no outbound transport; no read/delivery receipts on `messages` |

## 3. Safe reuse (decision)

| Need | Canonical service to extend |
|---|---|
| Plan tiers | `DINAR_BUSINESS` products; tier carried as a business entitlement key (`AI_USAGE_BUSINESS_GO` / `AI_USAGE_BUSINESS_PRO`) in the plan and the subscription snapshot — no new plan or entitlement table |
| Tier resolution | `api/lib/business.ts` `businessEntitlements` (server-side, period-settled) |
| Allowance configuration | `commercial_policies` (`aiUsage` object) with code v0 placeholders marked unapproved |
| Metering | new `api/lib/ai-usage.ts` (reserve → settle/release) invoked at the model call sites above; tokens from provider `usage` |
| Usage / plans in conversation | the commerce adapter (`commerce-turn.ts`) views + `CommercialSurface.tsx` (rebuilt on reload by `refreshCommercePayload`) |
| Seller statistics | `seller-management.ts` `executeSellerAdviceTurn` + `SellerBusinessInsight` + `BusinessSummaryPanel.tsx` |
| Inquiry thread + messages | `conversations` (new kind `INQUIRY`) + `messages` (same persistence as ORDER threads) + a thin `marketplace_inquiries` header and append-only events |
| Inquiry delivery | append a system-attributed message + typed surface into the recipient's DINAR conversation (durable DB write); no process-local timers; notification transport reported as not configured |
| Abuse report | `marketplace_reports` (`USER` target) |
| Price questions | routed to `executeNegotiationTurn` / negotiation authority, never stored as inquiries |

No separate chat server, agent or runtime is introduced.

## 4. Database impact (planned)

- `ai_usage_counters` (owner scope × period × resource → reserved/consumed requests and tokens) and
  `ai_usage_reservations` (idempotent ledger rows: RESERVED → SETTLED / RELEASED / EXPIRED).
- `marketplace_inquiries` (listing, market, buyer, seller, initiator, status, per-party DINAR conversations,
  thread conversation) and `marketplace_inquiry_events` (append-only typed lifecycle).
- `conversations_shape_check` widened for `kind = 'INQUIRY'` (no owner; the header row holds both parties).
- One migration `0035`. No change to orders, payments, commissions or negotiation tables.

## 5. Privacy

- Usage ledger stores no prompt or reply text; only resource, counts, tokens, provider/model ids, status.
- Provider cost is internal; users see requests and tokens, never other accounts' data.
- Inquiries never carry phone numbers or addresses; contact release stays order-bound. Message bodies are
  checked for phone numbers / links and refused, so the inquiry cannot be used to bypass the contact policy.
- Every inquiry read is party-scoped (buyer or seller of that inquiry) and market-scoped.

## 6. Sequence and tests

G1 (ledger, policy, tier, metering, conversation usage/plans) → G2 (inquiry authority, adapter, delivery,
surfaces) → G3 (combined acceptance, regression, browser). Tests: a new DB-backed `g-usage` suite (allowances
per tier, forged tier, concurrency, duplicate, timeout, release, renewal, upgrade/downgrade, isolation, guest,
exhaustion keeps marketplace), a `g-inquiry` suite (20 scenarios of G2 §12), a combined conversation suite
for the conversation-first acceptance list, and a browser journey.

## 7. Integration blockers (known now)

| ID | Blocker | Effect |
|---|---|---|
| GB-1 | No real billing provider | Go/Pro paid activation shows "billing not connected"; development simulation stays labelled TEST_NO_TRANSFER |
| GB-2 | No notification transport | Inquiry delivery is in-app (recipient's DINAR conversation); push/SMS/email reported as not configured |
| GB-3 | Prices and quotas unapproved | Code allowances are placeholders; no plan exists until an admin creates one |
| GB-4 | Default provider key (GROQ) rejected (from F) | Live AI needs owner provider switch; tests use scripted gateways |
| B-4 | Business capability gating of advanced Market Pulse (baseline) | unchanged; owner decision |
