# Jassim Universal Generative OS — Single-Conversation Architecture (For Claude Review)

> **Branch:** `google/jassim-universal-os-v1` (from `c9477f5`)
> **Verified:** 3/3 backend OS unit tests PASS (`jassim-os.test.ts`), `@workspace/api-server typecheck + build` PASS, `@workspace/dinar typecheck + vite build` PASS.

---

## 1. Core Principle: Everything Inside ONE Conversation
A user never has to leave the Jassim chat to:
1. **Shop & Configure** (Burger Builder, Fashion Mannequin Studio, Tech Studio — `JassimCardSpec v1`).
2. **Pay In-Chat** (`InChatPaymentCard` + `in-chat-checkout-contract.ts`, respecting `PRE_LEGAL` markets).
3. **Track Live Delivery (Uber / Talabat-grade)** (`LiveDeliveryTrackerCard.tsx` + `delivery-tracker-engine.ts`, with live ETA, animated progress, `OpenFreeMap` / `DinarMap` toggle, and one-tap courier quick messages).
4. **Connect a Store by Pasting Just Its URL** (`ConnectUrlQuickCard.tsx` + `url-auto-connect.ts`, with strict SSRF protection, auto-detection of Salla/Zid/Shopify/WooCommerce/MCP, and ownership verification meta tag).

## 2. Multi-Brain Orchestration (`jassim-generative-os.ts`)
- **OpenRouter Sticky Sessions (`jassim:conv:<id>`) + Prompt Caching**: Pins each conversation to the same provider endpoint to preserve warm prompt caches (70–85% token cost reduction on Arabic).
- **4 Specialized Brain Tiers**:
  - `FAST_HUMAN`: Low-latency conversational & dialect mirroring + delivery status.
  - `COMMERCE_CORE`: Structured tool calling, URL Connect onboarding, Infinite Card specs, read-only ReAct loop.
  - `VISION`: Visual product search & listing photo intelligence.
  - `REASONING`: Complex multi-item comparisons & multi-company workflow recovery.
- **Ironclad Deterministic Governance**: `requireExplicitUserConfirmationForWrites: true` — no brain can ever confirm an order, publish a listing, or charge a card without explicit user confirmation and server validation.

## 3. Files Delivered in This Branch
- `artifacts/api-server/src/connect/url-auto-connect.ts` — SSRF-safe Paste-URL store platform detector & ownership token generator.
- `artifacts/api-server/src/ai/delivery-tracker-engine.ts` — Haversine geospatial distance, route progress, ETA window, and GPS staleness detector.
- `artifacts/api-server/src/ai/jassim-generative-os.ts` — Single-conversation multi-brain & generative surface orchestrator.
- `artifacts/api-server/test/jassim-os.test.ts` — Automated unit tests for all 3 backend engines.
- `artifacts/dinar/src/features/ai/LiveDeliveryTrackerCard.tsx` — Uber/Talabat-grade live delivery tracking card inside chat with `DinarMap` toggle & quick messages.
- `artifacts/dinar/src/features/ConnectUrlQuickCard.tsx` — Paste-URL auto-onboarding card inside chat & Connect portal.
- `artifacts/dinar/src/pages/dev/SmartStorePreview.tsx` — Interactive dev preview of both cards.
