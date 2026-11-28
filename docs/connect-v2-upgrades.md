# Jassim Connect v2 — 6 Core Platform Upgrades (For Claude Review)

Base commit: `c9477f5` (`claude/jassim-connect-universal-engine`).
Verified: **5/5 unit tests PASS** (`connect-v2.test.ts`), `@workspace/api-server typecheck + build` PASS, `@workspace/dinar typecheck + vite build` PASS.

1. **One-Click Platform Presets & Auto-Mapper** (`connect/platform-presets.ts`): Zero-config RFC 6901 pointer presets for Salla (سلة), Zid (زد), Shopify, WooCommerce + `autoDetectCardMapping(samplePayload)`.
2. **In-Chat Checkout State Machine Contract** (`connect/in-chat-checkout-contract.ts`): Server-authoritative state machine aligned 1:1 with `InChatPaymentCard.tsx`, enforces `PRE_LEGAL` country block and legal transitions (never jumps to `PAID` without `PENDING`).
3. **Interactive Card Mapping Extension** (`connect/interactive-card-mapping.ts`): Maps merchant modifiers/layers/variants into `JassimCardSpec v1` (`LAYERED_STACK` / `MANNEQUIN` / `PRODUCT_STUDIO`).
4. **Real-Time Signed Inventory Webhook Verifier** (`connect/inventory-webhook.ts`): Constant-time HMAC-SHA256 verification + ±5-minute replay-attack window guard.
5. **Smart Multi-Company Workflow Recovery Planner** (`connect/workflow-recovery.ts`): Preserves committed steps honestly and generates explicit user-confirmed recovery options (retry, swap verified alternative partner in same market, or request compensation).
6. **Live Merchant Card Sandbox Preview** (`features/ConnectCardSandbox.tsx` mounted in `pages/Connect.tsx`): Lets merchants test Salla/Zid/Shopify/WooCommerce presets and preview their Jassim chat card before going live.