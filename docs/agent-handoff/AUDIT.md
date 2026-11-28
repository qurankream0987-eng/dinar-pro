# Pre-Build Audit (`docs/agent-handoff/AUDIT.md`)

**Branch:** `agent/commerce-build`  
**Base Commit:** `159b0870b72a380ee38ac8bb841c9c1d2f5a8b3e` (`claude/merchant-policies-m1`, parent `dac2315`)  
**Audit Rule (§1 & §7.1):** Written and committed **before any code change** after inspecting `CLAUDE.md`, `docs/merchant-commerce/ARCHITECTURE-AR.md`, `docs/merchant-commerce/M1-DELIVERY-AR.md`, `docs/deal-payments/DESIGN-AR.md`, `docs/jassim-ads-phase2/REPORT-AR.md`, and all §3 modules.

---

## §4A. M2 — Apply Merchant Policies to Orders and Cards (Behind Flag)

### 1. `PAYMENT_OPTIONS` Card Composer (One Card per Order)
- **What Already Exists:**
  - `artifacts/api-server/src/lib/merchant-policies/kinds.ts` defines `PAYMENT_METHODS` (`methods: [{ code, customLabel? }]`, `keepStoreGateway: boolean`) and `PAYMENT_GATEWAY` (`enabled: boolean`, `providerLabel?: string`).
  - `artifacts/api-server/src/lib/merchant-policies/engine.ts` implements `effectivePolicy(businessId, kind, context)` returning `{ id, kind, version, scope, rule, provenance: "MERCHANT_POLICY" }`.
  - `artifacts/api-server/src/lib/deal-payments/service.ts` + `catalog.ts` implement `sellerMethodsView`, `dealCard`, `applyDealAction`, `dealInstructions`, and `seller_payment_methods` / `deal_payment_agreements` / `deal_payment_events`.
  - `artifacts/api-server/src/connect/payment-link.ts` implements `extractStorePaymentLink` and `paymentLinkAfterWrite` for external store payment links.
- **What Will Be Reused:**
  - `effectivePolicy(businessId, "PAYMENT_METHODS")` and `effectivePolicy(businessId, "PAYMENT_GATEWAY")` from `lib/merchant-policies/engine.ts`.
  - `seller_payment_methods`, `dealCard`, and `applyDealAction` from `lib/deal-payments/service.ts` (selecting any direct method or COD delegates directly to existing `deal_payment_*` tables and state machine; no second direct-payment state machine will be created).
  - Country/currency method catalog (`resolveCountry`, `methodStanding`, `methodLabel`, `METHODS`) from `lib/deal-payments/catalog.ts`.
- **What Is Actually Missing (To Be Built in M2):**
  - `artifacts/api-server/src/lib/merchant-policies/payment-options.ts` (behind M2 flag): composes one unified `PAYMENT_OPTIONS` card payload per order combining:
    1. Store's active `PAYMENT_METHODS` policy (if the seller has a `businessProfileId` with an active `PAYMENT_METHODS` policy, with `provenance: "MERCHANT_POLICY"` and policy `version`), intersected/merged with `seller_payment_methods` (`STORE_SYSTEM`),
    2. `COD` availability filtered by `COD_AREAS` policy and delivery area,
    3. Store checkout gateway option **only** when `PAYMENT_GATEWAY` policy is enabled (or `keepStoreGateway !== false`) **and** an enabled `StoreCheckoutAdapter` (§4B) exists and `adapter.supports({ country, currency, amountMinor })` returns `true`. When no adapter is enabled, the gateway option is strictly omitted.
  - Web UI rendering for `PAYMENT_OPTIONS` in `artifacts/dinar/src/features/ai/` so the buyer sees one clear payment card per order and selecting a direct method flows through `deal_payment_*`.

---

### 2. Policy Enforcement at Checkout (`routes/marketplace.ts`) and in Chat (`ai/buyer-turn.ts` / `ai/action-foundation.ts`)
- **What Already Exists:**
  - `artifacts/api-server/src/routes/marketplace.ts` (`checkout()` / `checkoutForActor()`) validates market, offer status, buyer!=seller, price agreement, and stock under `FOR UPDATE` row locks, and creates immutable `orders` rows.
  - `artifacts/api-server/src/ai/buyer-turn.ts` (`purchaseReview`, `purchaseReviewTurn`, `executeBuyerTurn`, `executePurchaseTurn`) and `artifacts/api-server/src/ai/action-foundation.ts` (`ADD_TO_CART`, `PLACE_ORDER`) build `PURCHASE_REVIEW` (`ORDER_REVIEW`) and execute orders.
  - `artifacts/api-server/src/ai/demand-alert-turn.ts` and `artifacts/api-server/src/lib/demand-requests.ts` (`saveDemandRequest`, `DEMAND_REQUEST_DISCLOSURE`) record buyer interest for out-of-stock/searched items with explicit buyer consent.
  - `offers.businessProfileId` links a listing (`offers`) to `business_profiles.id` (`merchant_policies.businessId`).
- **What Will Be Reused:**
  - `effectivePolicy(businessId, kind, { productId, category, region })` from `lib/merchant-policies/engine.ts` (precedence `PRODUCT` > `CATEGORY` > `REGION` > `STORE`).
  - `checkout()` in `routes/marketplace.ts` as the single order-creation authority.
  - `purchaseReviewTurn()` / `executeBuyerTurn()` / `executePurchaseTurn()` in `ai/buyer-turn.ts` and `readListingForBuyer()` / `ACTION_REGISTRY.PLACE_ORDER` in `ai/action-foundation.ts`.
  - `saveDemandRequest()` / `executeDemandAlertTurn()` for `OUT_OF_STOCK` interest capture.
  - `searchMarketplaceListings()` for `ALTERNATIVES` same-store in-stock suggestions.
- **What Is Actually Missing (To Be Built in M2):**
  - M2 policy evaluator helper (`artifacts/api-server/src/lib/merchant-policies/enforcement.ts`, gated by M2 flag `merchantPoliciesM2Enabled()`):
    - **`ORDERING_PAUSED`**: When `effectivePolicy(businessId, "ORDERING_PAUSED")?.rule.paused === true`, refuse checkout (`409 ORDERING_PAUSED`) and refuse chat purchase review with the merchant's Arabic reason (or default Arabic pause message) and `MERCHANT_POLICY` provenance + version.
    - **`GEO_RESTRICTION`**: When `effectivePolicy(businessId, "GEO_RESTRICTION")` is active and `!rule.allowedCountries.includes(countryCode)` (or buyer region is excluded), refuse checkout (`409 GEO_RESTRICTION`) and chat purchase with clear Arabic reason and `MERCHANT_POLICY` provenance + version.
    - **`MIN_ORDER`**: When `effectivePolicy(businessId, "MIN_ORDER", { productId, category })` is active and quantity < `rule.minQuantity` or subtotalMinor < `rule.minAmountMinor`, refuse checkout (`409 MIN_ORDER_NOT_MET`) and chat purchase with clear Arabic explanation of the minimum required.
    - **`OUT_OF_STOCK` & `ALTERNATIVES`**: When a listing has 0 available stock (or requested quantity exceeds available stock):
      - Read `effectivePolicy(businessId, "OUT_OF_STOCK", { productId, category })` and `effectivePolicy(businessId, "ALTERNATIVES", { productId, category })`.
      - Use merchant's `rule.message` tagged with `MERCHANT_POLICY` (and version); if `rule.promiseDate` is `null`, never promise a date (and mark any unconfirmed restock timing as `UNCONFIRMED`).
      - When `rule.action === "TELL_AND_CAPTURE_INTEREST"`, offer/record interest through the existing `demand-requests` / `demand-alert-turn` mechanism.
      - When `ALTERNATIVES` policy has `rule.suggest === true` (and `OUT_OF_STOCK` action is not `NOT_SOLD`), query up to 5 in-stock published items from the same store (`businessProfileId` / `sellerId` in the same market, optionally prioritized by `rule.sameCategoryOnly`) and attach them as alternatives (`STORE_SYSTEM`).
    - **`SHIPPING`**: Compute shipping fee deterministically in code from `effectivePolicy(businessId, "SHIPPING", { productId, category, region })`:
      - `shippingFeeMinor = (rule.freeAboveMinor !== undefined && subtotalMinor >= rule.freeAboveMinor) ? 0 : rule.feeMinor`.
      - Display shipping fee and provenance (`MERCHANT_POLICY` vN) on `ORDER_REVIEW` (`PURCHASE_REVIEW` stage `ORDER`), and store `shippingFeeMinor` and `totalWithShippingMinor` in the order's immutable snapshot at checkout (`order.data.shippingPolicy`).
    - **`COD_AREAS`**: Enforce `effectivePolicy(businessId, "COD_AREAS")` alongside `seller_payment_methods.codAreas` in `deal-payments/service.ts` (`codAvailability`) and `PAYMENT_OPTIONS` so `COD` is restricted to the merchant's allowed areas.

---

### 3. Fact Provenance on Every Fact Shown
- **What Already Exists:**
  - `artifacts/api-server/src/ai/fact-provenance.ts` defines `FACT_SOURCES = ["SERVER_FACT", "USER_DECLARED", "IMAGE_INFERRED", "DINAR_DERIVED", "UNKNOWN"]` and `resolveFact()`.
  - `artifacts/api-server/src/lib/merchant-policies/engine.ts` returns `provenance: "MERCHANT_POLICY"` and `version: number` on `effectivePolicy()`.
- **What Will Be Reused:**
  - `artifacts/api-server/src/ai/fact-provenance.ts` extended additively (preserving all existing `FACT_SOURCES` and `resolveFact` behavior) with commerce fact provenance helpers for `STORE_SYSTEM` | `MERCHANT_POLICY` (with `version`) | `UNCONFIRMED` | `NEEDS_MERCHANT_APPROVAL`.
- **What Is Actually Missing (To Be Built in M2):**
  - Additive commerce provenance types and formatter in `ai/fact-provenance.ts` and attachment of provenance badges/metadata (`STORE_SYSTEM`, `MERCHANT_POLICY` + `version`, `UNCONFIRMED`, `NEEDS_MERCHANT_APPROVAL`) to M2 order review, out-of-stock/alternatives responses, and payment cards.

---

### 4. Web Review Card for Merchant Policies (`MERCHANT_POLICY_REVIEW`)
- **What Already Exists:**
  - Backend `proposePolicy()` in `lib/merchant-policies/engine.ts` and `executeMerchantPolicyTurn()` in `ai/merchant-policy-turn.ts` already emit UI blocks with `surface: "MERCHANT_POLICY_REVIEW"` and `payload.merchantPolicy` containing `{ kind: "MERCHANT_POLICY_REVIEW", policy, before, after, confirmation, canConfirm, conflicts, effects }`.
  - Backend REST routes in `routes/merchant-policies.ts`:
    - `POST /api/merchant-policies/:policyId/confirm` with `{ expectedVersion }` (enforces `channel: "REVIEW_CARD"` and returns `401 FRESH_SIGN_IN_REQUIRED` when a `HIGH_RISK` policy's session is older than 10 minutes).
    - `POST /api/merchant-policies/:policyId/cancel`.
- **What Will Be Reused:**
  - The exact server payload `payload.merchantPolicy` from `engine.ts` / `merchant-policy-turn.ts` and the REST endpoints in `routes/merchant-policies.ts`.
  - `ConversationContent.tsx` block dispatcher.
- **What Is Actually Missing (To Be Built in M2):**
  - `artifacts/dinar/src/features/ai/MerchantPolicyReviewPanel.tsx`:
    - Arabic, RTL (`dir="rtl" lang="ar"`), mobile-first card component.
    - Displays policy title (`labelAr`), scope (`scopeLabel`), version, sensitivity badge (`NORMAL` / `SENSITIVE` / `HIGH_RISK`), `before` vs `after` rule comparison, `effects` list, and any `conflicts` (`title`, `detail`, `resolution`).
    - Confirms via `POST /api/merchant-policies/:id/confirm` with `{ expectedVersion }` (disabled when `canConfirm === false` or conflicts exist) and cancels via `POST /api/merchant-policies/:id/cancel`.
    - Shows clear "سجّل الدخول من جديد للتأكيد" prompt/action when `confirmation === "EXPLICIT_REVIEW_AND_FRESH_SIGN_IN"` or when confirm returns `401 FRESH_SIGN_IN_REQUIRED` (never asking for a password in chat).
  - Wire `MerchantPolicyReviewPanel` into `artifacts/dinar/src/features/ai/ConversationContent.tsx` when `block.type === "SURFACE"` and `isMerchantPolicyReview(block.payload.merchantPolicy)`.

---

## §4B. M3 — Store Checkout Adapter, Simulated Only (Behind Test/Dev Flag)

- **What Already Exists:**
  - `docs/merchant-commerce/ARCHITECTURE-AR.md` §5 specifies the `StoreCheckoutAdapter` contract (`id`, `supports`, `createSession`, `verifyEvent`, `fetchPayment`) and the 4 mandatory verification gates before any payment becomes `PAID`.
  - `artifacts/api-server/src/connect/api-connector.ts` implements `proposeOpenApiTools`, `importApiTools`, `executeConnectOperation`, `callConnectTool`, `confirmToolCall`, and `ConnectNetwork` SSRF-guarded requests.
  - `artifacts/api-server/src/connect/payment-link.ts` implements `extractStorePaymentLink` (HTTPS-only, domain must match `integration.endpointUrl` or `partner.allowedDomains`, strips query/hash, tracks in `connect_payment_links`).
  - `artifacts/api-server/src/connect/credential-vault.ts` seals per-integration credentials.
- **What Will Be Reused:**
  - `connect/api-connector.ts` (`executeConnectOperation`, `ConnectNetwork`), `connect/payment-link.ts` (`validateExternalUrl` / domain matching), and `connect/credential-vault.ts`.
- **What Is Actually Missing (To Be Built in M3):**
  1. **Migration `0084_store_checkout_sessions.sql` + Drizzle schema `lib/db/src/schema/store-checkout.ts`:**
     - Additive table `store_checkout_sessions` (tracks orderId, businessId, marketId, buyerId, adapterId, providerSessionId, providerPaymentId, amountMinor, currency, checkoutUrl, expiresAt, status: `CREATED` | `AWAITING_PROVIDER_CONFIRMATION` | `PAID` | `FAILED` | `EXPIRED` | `CANCELLED`, verifiedAt, metadata) and `store_checkout_webhook_events` (deduplication by `(adapter_id, provider_event_id)` unique index, signatureVerified, payload).
     - Update `lib/db/drizzle/meta/_journal.json`, `release/release-manifest.json`, `artifacts/api-server/src/lib/clone-migration-guard.ts`, `artifacts/api-server/test/development-tls.test.ts`, and `artifacts/api-server/test/readiness.test.ts` to register `0084_store_checkout_sessions`.
  2. **`StoreCheckoutAdapter` Interface & Implementations (`artifacts/api-server/src/lib/store-checkout/`):**
     - `types.ts`: `StoreCheckoutAdapter` interface matching `ARCHITECTURE-AR.md` §5.
     - `simulated-adapter.ts`: `SimulatedStoreGateway` enabled **only** when `DINAR_SIMULATED_STORE_GATEWAY === "true"` (never in production), supporting HMAC-SHA256 signed webhook events, provider payment state store for re-read verification (`fetchPayment`), and hosted checkout URL simulation.
     - `custom-openapi-adapter.ts`: `CustomOpenApiCheckoutAdapter` built on `connect/api-connector.ts` where the store owner authorizes a "create session" operation and a "payment status" read operation and maps response fields via JSON pointers (`sessionId`, `checkoutUrl`, `expiresAt`, `paymentStatus`, `amountMinor`, `currency`, `orderId`).
  3. **Webhook & Session Verification Service + Routes (`artifacts/api-server/src/routes/store-checkout.ts`):**
     - Session creation endpoint (`POST /api/orders/:orderId/store-checkout/sessions`) behind M3 flag: creates a hosted checkout session and returns a `PAYMENT_STATUS` card with `status: "AWAITING_PROVIDER_CONFIRMATION"`.
     - Return URL / buyer chat "دفعت" handling: never marks an order or session `PAID`; keeps status at `AWAITING_PROVIDER_CONFIRMATION` (or `UNVERIFIED_BUYER_CLAIM`) until verified webhook + provider re-read succeed.
     - Signed webhook endpoint (`POST /api/store-checkout/webhooks/:adapterId`):
       1. Verifies cryptographic signature (`adapter.verifyEvent(rawBody, headers)`), refusing forged signatures (`401`).
       2. Deduplicates by `(adapterId, event.eventId)` in `store_checkout_webhook_events` (replay is idempotent no-op).
       3. Re-reads payment directly from provider (`adapter.fetchPayment(event.providerPaymentId)`).
       4. Matches `orderId`, `amountMinor`, `currency`, and `providerPaymentId` against the locked `store_checkout_sessions` and `orders` rows; if mismatched, records mismatch and never marks `PAID`.
       5. Only when all 4 checks pass does session status become `PAID`.
  4. **`PAYMENT_STATUS` & `PAYMENT_OPTIONS` Web Cards (`artifacts/dinar/src/features/ai/StorePaymentPanels.tsx`):**
     - Renders `PAYMENT_OPTIONS` and `PAYMENT_STATUS` in Arabic, RTL, mobile-first.
     - Hosted checkout link opens in an external browser tab (`target="_blank" rel="noopener noreferrer nofollow"`); card numbers, CVV, OTP, or wallet passwords are never collected inside Jassim.

---

## §4C. Jassim Ads — Verify and Close 2 Known Gaps (Still Switched Off)

### 1. Whop Blocked-Country List (`artifacts/api-server/src/lib/whop/config.ts`)
- **What Already Exists:**
  - `artifacts/api-server/src/lib/whop/config.ts` line 80 defines:
    `const DEFAULT_BLOCKED_COUNTRIES = ["IQ", "IR", "KP", "SY", "CU"];`
  - `whopAvailableForMarket(countryCode, currencyCode)` checks `whopConfig().blockedCountries.includes(country)`.
- **What Is Actually Missing:**
  - Add the remaining sanctioned/blocked Arab League markets required by `REPORT-AR.md` §5 and `GOOGLE-AGENT-BRIEF.md` §4C.1 (`LY, YE, SD, SO, KM, PS`) so `DEFAULT_BLOCKED_COUNTRIES` includes the full set `["CU", "IQ", "IR", "KM", "KP", "LY", "PS", "SD", "SO", "SY", "YE"]`.

### 2. Stop Serving Paid Promotions When a Market's Legal Approval Is Withdrawn
- **What Already Exists:**
  - `artifacts/api-server/src/lib/promotions.ts`:
    - `assertPromotionMarketEligible(market)` checks `assertMarketLegalCapability(market.id, "ELECTRONIC_PAYMENT")` at purchase/activation time.
    - `servingCampaignsFor(marketId, listingIds)` (line 205) queries active campaigns (`status = 'ACTIVE'`, `startsAt <= now`, `endsAt > now`) and checks `whopAvailableForMarket(market.countryCode, market.currencyCode)` for `paymentMode === "WHOP_LIVE"`, **but does not check whether the market's legal approval (`ELECTRONIC_PAYMENT` in `market_legal_capability_approvals`) is currently approved/withdrawn**.
  - `artifacts/api-server/src/lib/welcome-ads.ts`:
    - `welcomeSponsoredCards(market)` and `displayPlacementCards(market, placement)` select active `promotionCampaigns` without filtering out paid campaigns (`paymentMode === "WHOP_LIVE"` or paid promotions) when the market's `ELECTRONIC_PAYMENT` legal capability approval is withdrawn.
  - `artifacts/api-server/src/lib/marketplace-listings.ts`:
    - Calls `servingCampaignsFor(market.id, ...)` to mark listings as sponsored.
- **What Is Actually Missing:**
  - Check market legal approval (`ELECTRONIC_PAYMENT`) in `servingCampaignsFor` (`promotions.ts`), `promotionViews` (`promotions.ts`), `welcomeSponsoredCards` (`welcome-ads.ts`), and `displayPlacementCards` (`welcome-ads.ts`) so that when a market's `ELECTRONIC_PAYMENT` legal approval is withdrawn (either via `market_legal_capability_approvals` row with `approved = false` / `status != 'APPROVED'`, or when `d16Enforced()` is on and `assertMarketLegalCapability(marketId, "ELECTRONIC_PAYMENT")` fails), paid promotions (`paymentMode === "WHOP_LIVE"` / paid campaigns) in that market immediately stop being served across search, welcome cards, category banner, and post-search placements.

---

## §4D. Smart Payment Cards — Browser Verification

- **What Already Exists:**
  - `artifacts/api-server/test/welcome-ads-browser.test.ts` uses Playwright Chromium against the built `@workspace/dinar` frontend served locally on `127.0.0.1` across viewports `320`, `360`, `390`, `414`, and `1280` px, checking RTL (`dir === "rtl"`), no horizontal overflow (`overflowX <= 1`), card containment, and keyboard focus.
- **What Will Be Reused:**
  - The local static/API harness pattern from `artifacts/api-server/test/welcome-ads-browser.test.ts`.
- **What Is Actually Missing (To Be Built in §4D):**
  - Playwright browser verification suite `artifacts/api-server/test/smart-payment-cards-browser.test.ts` testing:
    1. `DEAL_CARD` (including protected instructions view on demand and seller's instructions form),
    2. `PAYMENT_OPTIONS`,
    3. `PAYMENT_STATUS`,
    4. `MERCHANT_POLICY_REVIEW`
    across all 5 required viewports (`320`, `360`, `390`, `414`, `1280` px), verifying:
    - RTL direction (`dir="rtl"`),
    - No horizontal scroll (`overflowX <= 1`),
    - Buttons and fields reachable by keyboard (`Tab` focus),
    - Payment instruction values never present in stored chat blocks (`ai_ui_blocks`) or in the DOM before the protected view button is clicked,
    - Screenshots saved to `docs/agent-handoff/screens/`.

---

## §4E. Provider-Neutral Payment Collection for Jassim Ads (Do This FIRST)

- **Decision Reference:** `docs/payments/PAYMENT-SEPARATION-AR.md` (approved 2026-11-28) & `GOOGLE-AGENT-BRIEF.md` §4E.
- **What Already Exists:**
  - `artifacts/api-server/src/lib/subscription-billing.ts` (`SubscriptionBillingProvider` interface + registry + `business_subscriptions.provider_key`) — already provider-neutral; keep as is.
  - `deal-payments/`, `merchant-policies/`, `seller-classification.ts`, and commission logic — already provider-neutral; keep as is.
  - `lib/db/drizzle/0080_promotion_whop_direct.sql` (undeployed anywhere) currently uses `WHOP_LIVE` and `WHOP_DIRECT` in `listing_promotions` constraints.
  - `artifacts/api-server/src/lib/commercial-policy.ts` uses `advertisingBillingActivation: "DISABLED" | "WHOP_DIRECT"`.
  - `artifacts/api-server/src/lib/promotion-whop.ts` calls `activeWhopAdapter()` directly, uses `WHOP_PROMOTION_CURRENCIES`, and `ai/commerce-turn.ts` emits `whopPayment`.
- **What Will Be Reused:**
  - `SubscriptionBillingProvider` registry pattern from `lib/subscription-billing.ts`.
  - `lib/billing/whop.ts` adapter logic (wrapped as a registered `PromotionBillingProvider`).
  - `billing_webhook_events` deduplication table.
- **What Is Missing (To Be Built FIRST):**
  1. Redefine `lib/db/drizzle/0080_promotion_whop_direct.sql` **in place** (keeping filename and tag, updating sha256 in `release-manifest.json` and `_journal.json` if needed):
     - Replace `WHOP_LIVE` with `PROVIDER_LIVE`, `WHOP_DIRECT` with `PROVIDER_DIRECT`.
     - Add nullable `payment_provider_key text` on `listing_promotions` with a CHECK requiring it to be non-null iff `payment_source = 'PROVIDER_DIRECT'`.
  2. Update `lib/db/src/schema/commercial.ts` (or `promotions.ts`) and `lib/commercial-policy.ts` (`advertisingBillingActivation: "DISABLED" | "PROVIDER_DIRECT"`, plus `advertisingBillingProvider?: string` e.g. `"whop"`).
  3. Create `artifacts/api-server/src/lib/promotion-billing.ts` defining `PromotionBillingProvider` (`providerKey`, `displayName`, `supportedCurrencies`, `blockedCountries`, `createPromotionCheckout`, `promotionCheckoutUrl`, `verifyAndParsePromotionWebhook`, `fetchPromotionPayment`) + registry (`registerPromotionBillingProvider`, `getPromotionBillingProvider`, etc.), with Whop registered in `lib/billing/whop.ts`.
  4. Update `lib/promotion-whop.ts` (or refactor into provider-neutral `lib/promotion-billing.ts` / `lib/promotion-checkout.ts` while keeping exports clean), `lib/promotions.ts`, `lib/promotion-policy.ts`, `routes/commercial.ts`, `routes/whop.ts`, and `ai/commerce-turn.ts` (`payload.providerPayment = { providerKey, displayName, note }`), plus OpenAPI spec + codegen.
  5. Tests: `jassim-ads-phase2` (8/8 via Whop), a second fake provider end-to-end test with zero ads-flow changes, 0080 rehearsal on 0000–0079 data, and grep test confirming zero Whop references in `deal-payments/`, `merchant-policies/`, `seller-classification`, and commission code.
