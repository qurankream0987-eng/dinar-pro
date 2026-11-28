# Comprehensive Review & Merge Guide for Claude (`qurankream0987-eng/dinar-pro`)

This document guides Claude through reviewing, verifying, and merging all completed Google Agent branches into the canonical integration branch (`claude/merchant-policies-m1`), in the exact dependency order that avoids conflicts and preserves every architectural invariant.

---

## 1. Branch Inventory & Exact Commit SHAs on `origin`

| Priority / Layer | Branch Name | Head Commit SHA | Base Commit | Purpose & Scope |
| :--- | :--- | :--- | :--- | :--- |
| **1. Core Handoff Build (`§4A–§4E`)** | `origin/agent/commerce-build` | `3c8fde54073f19edeb1be851d82b0ccc0752fe5d` | `1b30db5` (`claude/merchant-policies-m1`) | Provider-neutral Jassim Ads (`0080` redefined in place + `PromotionBillingProvider`), Jassim Ads 2 gaps (`§4C`), M2 Merchant Policy enforcement & `PAYMENT_OPTIONS` composer + `MerchantPolicyReviewPanel` (`§4A`), M3 Simulated/Custom-OpenAPI Store Checkout Adapter + Migration `0084` + `StorePaymentPanels` (`§4B`). |
| **2. Performance Remediation & GPU/Cache Hardening** | `origin/google/jassim-apple-performance-remediated` | `b1f9bfcb66966ca27f57161f3720d6b850e046ad` | `daebe5ef` (`google/jassim-apple-master-edition`) | Fixes the 4 performance audit items on top of Apple Master Edition: `InteractiveCircuitBg.tsx` & `AiChat.css` spotlight alignment, lazy `vendor-charts` chunk splitting in `vite.config.ts`, stable callback refs for `React.memo` in `Ai.tsx` & `ChatComposer.tsx`, market/tenant-scoped `BoundedHotCache` invalidation, and safe mid-sentence stream flush in `speed-optimizer.ts`. |
| **3. Apple Master Visual & Speed Edition** | `origin/google/jassim-apple-master-edition` | `daebe5ef8d4dcdf4424b8f7a6623bc7a9a8f2138` | `00fde928` | 120fps GPU compositor spotlight, `LayeredStage`, `React.memo` card isolation, 16ms token coalescer (`speed-optimizer.ts`), sub-0.05ms Arabic intent prefetch (non-authoritative), and idle route preloading. *(Note: `google/jassim-apple-performance-remediated` already includes all of `daebe5ef` plus the 4 audit fixes — merge `google/jassim-apple-performance-remediated` rather than `daebe5ef` alone).* |
| **4. Conversational Commerce & Policy Brain** | `origin/google/jassim-intelligent-commerce-payment-engine` | `0236e5086c4a1c9a770a16b361dc4411e01752f7` | `9a004f0` | `jassim-commerce-policy-brain.ts` & `LiveInteractiveCards.tsx` interactive training/intent helpers. *(Note: Cherry-pick only the non-overlapping AI helper & UI card enhancements; keep `claude/merchant-policies-m1` + `agent/commerce-build` as the authoritative source for migrations `0081–0084`, `deal-payments/`, `merchant-policies/`, and `seller-classification.ts`).* |
| **5. Jassim Ads Go-Sell & Universal OS Cards** | `origin/google/jassim-ads-go-sell-engine` (`840a6b5`) & `origin/google/jassim-universal-os-v1` (`b074a0c`) | `840a6b515278f63aee3b36a942c9651d21a73cfa` / `b074a0c73ba79c61f3f7e60cbff143f5330caf49` | `b16c242e` | Universal generative cards, paste-URL connect helpers, and Go-Sell card motion. *(Included inside `google/jassim-apple-master-edition`).* |

---

## 2. Step-by-Step Review & Merge Procedure for Claude

### Phase 1 — Review & Fast-Forward / Rebase `origin/agent/commerce-build` onto `claude/merchant-policies-m1` (`4e4e206`)

`agent/commerce-build` was branched from `claude/merchant-policies-m1` at `1b30db5`. The only commit added on `claude/merchant-policies-m1` after `1b30db5` is `4e4e206` (which edited `docs/agent-handoff/GOOGLE-AGENT-BRIEF.md` and `docs/payments/PAYMENT-SEPARATION-AR.md`).

1. **Fetch & inspect the diff:**
   ```bash
   git fetch origin
   git log --oneline origin/claude/merchant-policies-m1..origin/agent/commerce-build
   git diff 1b30db5...origin/agent/commerce-build
   ```
2. **Verify each section of `GOOGLE-AGENT-BRIEF.md`:**
   - **Pre-build Audit (`96c8e80`):** `docs/agent-handoff/AUDIT.md` committed before any code changes.
   - **§4E (Provider-neutral Jassim Ads):**
     - `lib/db/drizzle/0080_promotion_whop_direct.sql`: Redefined in place with `'PROVIDER_LIVE'`, `'PROVIDER_DIRECT'`, and `listing_promotions_provider_key_required` (`payment_source <> 'PROVIDER_DIRECT' OR payment_provider_key IS NOT NULL`).
     - SHA-256 (`218dbdd8239223262527178c74fec9d9ef7437b412dfb68c484903b00c7d0ef9`) updated in `lib/db/drizzle/release-manifest.json` and `lib/db/src/clone-migration-guard.ts`.
     - `docs/jassim-ads-phase2/rollback-0080.sql`: Restores pre-0080 constraints and cleans up `PROVIDER_DIRECT` / `PROVIDER_LIVE`.
     - `artifacts/api-server/src/lib/promotion-billing.ts`: Defines `PromotionBillingProvider` interface & registry (`registerPromotionBillingProvider`, `getPromotionBillingProvider`), mirroring `SubscriptionBillingProvider`.
     - `artifacts/api-server/src/lib/billing/whop.ts`: Registers Whop (`providerKey: "whop"`) into `promotion-billing.ts`; `lib/promotion-whop.ts` is a thin compatibility re-export shim.
     - `artifacts/api-server/src/lib/commercial-policy.ts`: `advertisingBillingActivation: z.enum(["DISABLED", "PROVIDER_DIRECT"])` + optional `advertisingBillingProvider`.
     - `artifacts/api-server/test/promotion-provider-neutral.test.ts`: Registers a second fake provider (`fake_local_pay`) and verifies end-to-end promotion checkout, signed webhook verification, activation, refund, and zero Whop references in `deal-payments/`, `merchant-policies/`, `seller-classification.ts`, and commission code.
   - **§4C (Jassim Ads 2 Known Gaps):**
     - `artifacts/api-server/src/lib/whop/config.ts`: `DEFAULT_BLOCKED_COUNTRIES` includes `IQ, SY, LY, YE, SD, SO, KM, PS`.
     - `artifacts/api-server/src/lib/promotions.ts` & `welcome-ads.ts`: `isElectronicPaymentApprovedForServing(marketId)` stops serving `PROVIDER_LIVE` campaigns immediately when `ELECTRONIC_PAYMENT` legal approval is withdrawn.
   - **§4A (M2 — Merchant Policy Enforcement & Cards):**
     - `artifacts/api-server/src/ai/fact-provenance.ts`: `COMMERCE_PROVENANCE_SOURCES` (`STORE_SYSTEM`, `MERCHANT_POLICY`, `UNCONFIRMED`, `NEEDS_MERCHANT_APPROVAL`) with Arabic labels including policy version.
     - `artifacts/api-server/src/lib/merchant-policies/enforcement.ts`: Deterministic enforcement of `ORDERING_PAUSED`, `GEO_RESTRICTION`, `MIN_ORDER`, `SHIPPING` (immutable snapshot on `order.data.shippingPolicy` without altering `subtotalMinor` or platform commission), `OUT_OF_STOCK` + `ALTERNATIVES`, and `COD_AREAS`.
     - Wired into `routes/marketplace.ts` (`checkout()`), `lib/deal-payments/service.ts` (`acceptedFor`, `codAvailability`), and `ai/action-foundation.ts` (`readServerSnapshot`, `PLACE_ORDER`).
     - `artifacts/api-server/src/lib/merchant-policies/payment-options.ts`: Composes one unified `PAYMENT_OPTIONS` card per order across all 3 operating modes; never offers store gateway unless `PAYMENT_GATEWAY` is enabled AND an enabled `StoreCheckoutAdapter` supports `{ country, currency, amountMinor }`.
     - `artifacts/dinar/src/features/ai/MerchantPolicyReviewPanel.tsx`: RTL Arabic review card confirming via `POST /api/merchant-policies/:id/confirm` with `expectedVersion`, conflict warnings, and `HIGH_RISK` re-auth prompt.
   - **§4B (M3 — Store Checkout Adapter, Simulated Only + Migration `0084`):**
     - `lib/db/drizzle/0084_store_checkout_sessions.sql` & `lib/db/src/schema/store-checkout.ts`: Additive tables `store_checkout_adapters`, `store_checkout_sessions`, `store_checkout_webhook_events`.
     - Registered in `lib/db/drizzle/meta/_journal.json`, `lib/db/drizzle/release-manifest.json`, `lib/db/src/clone-migration-guard.ts`, `test/development-tls.test.ts`, and `test/readiness.test.ts`.
     - `artifacts/api-server/src/lib/store-checkout/`: `types.ts`, `simulated-adapter.ts` (strictly behind `NODE_ENV !== "production" && DINAR_SIMULATED_STORE_GATEWAY === "true"`), `custom-openapi-adapter.ts` (built on `connect/api-connector.ts` with JSON pointers), and `service.ts` (HMAC-SHA256 verification, `(adapter_id, event_id)` deduplication, provider state re-read via `fetchSessionState`, and exact `{ orderId, amountMinor, currencyCode, providerSessionId }` match before setting `PAID`).
     - `artifacts/dinar/src/features/ai/StorePaymentPanels.tsx`: `PaymentOptionsPanel` & `PaymentStatusPanel` wired into `ConversationContent.tsx`.

---

### Phase 2 — Run Test Suites on Loopback PostgreSQL (Linux / CI Runner)

Because local test execution on the Windows machine was paused at the owner's request, run the isolation suite on your Linux/PostgreSQL environment after checking out `origin/agent/commerce-build`:

```bash
pnpm run typecheck
artifacts/api-server/test/isolation/local-suite.sh \
  promotion-provider-neutral.test \
  jassim-ads-phase2.test \
  jassim-ads-phase1.test \
  promotions.test \
  promotion-intent.test \
  advertising-acceptance.test \
  merchant-policies.test \
  deal-payment-agreement.test \
  deal-payment-open-methods.test \
  seller-classification.test \
  development-tls.test \
  readiness.test
```

> **Important Note for `advertising-acceptance.test` and `jassim-ads-phase2.test`:**
> - Run `advertising-acceptance.test` in its own `local-suite.sh` invocation (or reset `commercial_policies` for market `JO` after `jassim-ads-phase2.test`), because `local-suite.sh` chains multiple suites on one shared disposable DB and `jassim-ads-phase2.test` sets `JO` `advertisingBillingActivation` to `"PROVIDER_DIRECT"`, whereas `advertising-acceptance.test` (`AD-01`) asserts the fresh default `"DISABLED"`.
> - In `jassim-ads-phase2.test`, note that `POST /api/commercial/whop-promotions/checkouts` is aliased to `/api/commercial/provider-promotions/checkouts` in `routes/commercial.ts`; check `AP-03..AP-07` if any Whop webhook payload expects `providerKey: "whop"`.

---

### Phase 3 — Merge Performance & Visual Remediation (`origin/google/jassim-apple-performance-remediated`)

After `agent/commerce-build` is reviewed and merged into `claude/merchant-policies-m1`:

1. Inspect `origin/google/jassim-apple-performance-remediated` (`b1f9bfcb66966ca27f57161f3720d6b850e046ad`), which sits on top of `origin/google/jassim-apple-master-edition` (`daebe5ef8d4dcdf4424b8f7a6623bc7a9a8f2138`):
   ```bash
   git show b1f9bfcb66966ca27f57161f3720d6b850e046ad
   ```
2. Merge or cherry-pick the performance & visual files:
   - `artifacts/api-server/src/ai/speed-optimizer.ts` & `artifacts/api-server/test/speed-optimizer.test.ts` (16ms token coalescer, mid-sentence stream flush, market/tenant-scoped `BoundedHotCache`, non-authoritative Arabic intent prefetch)
   - `artifacts/dinar/vite.config.ts` (restores lazy `vendor-charts` splitting so Recharts is never bundled into the initial chat chunk)
   - `artifacts/dinar/src/components/InteractiveCircuitBg.tsx` & `artifacts/dinar/src/pages/AiChat.css` (GPU `translate3d` spotlight alignment)
   - `artifacts/dinar/src/pages/Ai.tsx`, `ChatComposer.tsx`, `RichText.tsx` (stable callback references for `React.memo`)
   - When merging `artifacts/dinar/src/features/ai/ConversationContent.tsx`, keep BOTH the `React.memo` / `LiveInteractiveCards` optimizations from `b1f9bfcb` AND the new `MerchantPolicyReviewPanel` / `PaymentOptionsPanel` / `PaymentStatusPanel` branches from `agent/commerce-build`.
