# WCAG 2.1 AA Accessibility Pass Report (UI-12)

## Summary of Checks & Fixes
1. **Landmarks & Skip Navigation (`AppShell.tsx`)**
   - **Before:** Skip link (`href="#main"`) existed, but `<main id="main">` lacked `tabIndex={-1}`, so keyboard focus did not reliably move into main content across Chromium/WebKit browsers.
   - **After:** Added `tabIndex={-1}` to `<main id="main">` so activating «تخطَّ إلى المحتوى» reliably transfers keyboard focus.
2. **Live Regions (`aria-live`)**
   - Verified `role="status" aria-live="polite"` is present on cart confirmations (`cart-confirmation-status`), subscription return banners (`subscription-checkout-return`), order chat stream (`OrderParts.tsx`), and `SurfaceNotice` danger/warning/pending notices (`primitives.tsx`).
3. **Touch Targets & Interactive Controls**
   - Audited primary interactive buttons across `SmartStoreCardView.tsx`, `OrderSettlementCard.tsx`, `InChatPaymentCard.tsx`, `Auth.tsx`, `Connect.tsx`, and `Home.tsx`: all primary buttons, steppers, and radio pills enforce `>= 44×44px` (`min-h-11` / `size-11`).
4. **Reduced Motion & Decorative Icons**
   - `InteractiveCircuitBg.tsx` respects `prefers-reduced-motion: reduce`.
   - Decorative icons carry `aria-hidden`; icon-only buttons carry explicit Arabic `aria-label` attributes.
5. **RTL Logical Direction & Bidi Isolation**
   - Converted 16 UI primitives (`UI-02`) and `PasswordInput` (`UI-03`) to logical CSS properties (`ps-*`, `pe-*`, `ms-*`, `me-*`, `start-*`, `end-*`, `text-start`).
   - Prices, phone numbers, and reference IDs are isolated with `<bdi dir="ltr">` + `tabular-nums`.

## Verification
- `NODE_OPTIONS=--max-old-space-size=1536 pnpm --filter @workspace/dinar run typecheck`: PASS