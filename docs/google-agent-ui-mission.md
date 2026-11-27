# MISSION ORDER — Jassim AI visual & usability improvement (Google Antigravity)

**Owner decision (2026-11-27):** the QA campaign is paused. Your mission now is the visual design, usability, accessibility and front-end quality of Jassim AI. Claude is finishing integrations and payments in parallel; the comprehensive QA campaign resumes after both are done (`qa/ANTIGRAVITY-MISSION.md` stays valid for that later phase).

Read first: `CLAUDE.md`, `docs/google-agent-tasks.md`, `docs/antigravity-qa-brief.md` (architecture section), and this file. This file wins where they differ.

---

## 1. Product you are improving

Jassim AI (جاسم) is an **Arabic-first conversational marketplace** for 22 Arab markets. Users mostly talk to Jassim in a chat; the chat renders interactive cards (listings, smart store cards, offers, orders, delivery, receipts, Connect action cards). Brand name: **جاسم / JassimAI** — never «دينار». Approved logo only: `artifacts/dinar/public/brand/`.

Plans (prices are set later by the owner — never hard-code them): **Go**, **Pro**, **Business ($49 tier, "Jassim AI Business")**. Business includes the **smart store card**: an interactive card for a merchant's store that changes as the user taps (products, variants, prices, availability, actions).

## 2. Where to work

| Item | Value |
|---|---|
| Repository | `qurankream0987-eng/dinar-pro` |
| Base branch | `claude/jassim-connect-universal-engine` (what production runs) |
| Your branches | one per task: `google/ui-<nn>-<short-name>` from the base branch |
| Front-end code | `artifacts/dinar/src/` — pages `pages/`, admin `pages/admin/`, chat & cards `features/ai/`, smart store `features/ai/smart-store/`, design primitives `ui/` (`Button`, `Feedback`, `Layout`, `Field`, `Sheet`, `Commerce`, `Media`, `PhoneInput`, `CountrySelector`), styles `index.css`, `AiChat.css`, `PremiumMaterials.css`, `ui/Buttons.css` |
| Live reference (read-only) | https://jassimai.com |
| Preview environment | qa-lab — https://jassimai-acceptance-app-qa-lab.up.railway.app (public). Claude deploys your reviewed branches there for preview; you do not deploy |
| Local run | `pnpm install --frozen-lockfile`; `pnpm --filter @workspace/dinar run dev`; API needs a loopback Postgres — see `CLAUDE.md` |

## 3. Absolute rules

1. **Front-end only.** You may change files under `artifacts/dinar/src/`, `artifacts/dinar/public/` (not the logo files) and `artifacts/dinar/test/`. Any server, database, API-contract or generated-client change is requested from Claude in writing — never made by you.
2. Never edit `lib/api-zod`, `lib/api-client-react` (generated) or `lib/api-spec` (contract).
3. **Prices, totals, fees, currency and plan limits always come from the server.** No amount, plan price, quota or currency is written in UI code.
4. **Never show success before the server confirms it** (order, payment, publish, approval). Pending states must look pending.
5. Legal honesty: a market with `legalApprovalStatus !== "APPROVED"` is never shown as legally approved; `operationMode === "PRE_LEGAL"` means cash only.
6. No new runtime dependency without Claude's approval. Prefer what exists (Tailwind, lucide-react, existing `ui/` primitives).
7. Do not delete features, tests, `data-testid` attributes or accessibility labels. If a test must change, explain why in the task report; never weaken an assertion.
8. No secrets, no production access, no Railway changes, no payments, no DNS, no legal approvals, no merges, no deploys.
9. Every user-facing string is Arabic first, natural Modern Standard Arabic, short, specific. No placeholder or lorem text.
10. Stop and ask (through the owner) when a task needs a product decision.

## 4. Design system (apply everywhere)

- **Direction:** RTL everywhere; logical CSS (`ms-`, `me-`, `ps-`, `pe-`, `start`, `end`), never left/right for layout. Numbers, prices and phone inputs stay LTR inside RTL text where needed (`dir="ltr"` on the value only).
- **Typography:** one Arabic UI family with good weights (check what `index.css` loads); body ≥ 16px on mobile, line-height ≥ 1.6 for Arabic; tabular numerals for prices.
- **Color:** define/consolidate tokens (background, surface, text, muted, primary, success, warning, danger, border) for light **and** dark mode; WCAG AA contrast (4.5:1 text, 3:1 large text/icons).
- **Spacing & radius:** a 4/8-based scale; consistent card radius and shadow; no one-off magic numbers.
- **Touch:** targets ≥ 44×44px; no hover-only affordances.
- **States:** every interactive component has default, hover, focus-visible, active, disabled, loading, empty, error.
- **Motion:** short (150–250ms), respects `prefers-reduced-motion`.
- **Breakpoints:** 360, 390, 768, 1024, 1440. No horizontal scroll at 360px.

Deliver a short `docs/design-system.md` describing the tokens and component rules you settle on (task 2).

## 5. Tasks, in order

Each task: its own branch, before/after screenshots (360px and 1440px, light and dark), typecheck + build green, report in the PR description (see §7).

### UI-01 — Interface audit (no code)
Walk every page and dialog on https://jassimai.com and in a local run: public pages, sign-in/sign-up (Google + phone typed twice), chat, every card type, cart, checkout, orders, order details, seller pages, account/settings, Connect pages, every admin page. Produce `docs/ui-audit.md`: each issue with page, screenshot, severity (Critical/High/Medium/Low), category (layout, RTL, contrast, copy, consistency, responsiveness, performance, accessibility), proposed fix. Include a list of leftover «دينار» strings and any English copy shown to users.

### UI-02 — Design tokens and primitives
Consolidate colors, typography, spacing, radius, shadows into tokens (light + dark). Refactor `ui/` primitives (`Button`, `Field`, `Feedback`, `Layout`, `Sheet`, `Commerce`, `Media`) to use them, with all states from §4. No page-level redesign yet. Write `docs/design-system.md`.

### UI-03 — Sign-up and sign-in
Clear two-path layout (Google first; explain why the phone is typed twice). Errors next to the field that caused them, using the server's message (`friendlyError` in `lib/errors.ts` already surfaces server text — keep it). Country/phone selector: searchable, flag + Arabic name + dialling code, auto-detected default visible and changeable, per-country digit limit already enforced by `PhoneInput` — keep it. Logout confirmation already exists — keep its look consistent.

### UI-04 — Chat experience (core)
`pages/Ai.tsx`, `AiChat.css`, `features/ai/ChatComposer.tsx`, `ConversationContent.tsx`, `ConversationSidebar.tsx`, `ConversationHistory.tsx`, `RichText.tsx`. Improve message bubbles, spacing, timestamps, "Jassim is typing" state, streaming text, retry after failure (`turn-recovery.ts`), long-message readability, quick-reply chips, composer (multiline, send on Enter / newline on Shift+Enter, attachment and camera entry points, disabled state while sending), conversation list, empty state with useful example prompts per market. Mobile: composer fixed above the keyboard, no layout jump.

### UI-05 — Chat cards (all types)
Unify the visual language of every card rendered in chat: `UniversalCards.tsx`, `AnswerCards.tsx`, `ListingGlimpses.tsx`, `SmartSurfaces.tsx`, `BuyerPanels.tsx`, `OrderSettlementCard.tsx`, `OrderTrackingSurface.tsx`, `DeliverySurface.tsx`, `ActionReceipts.tsx`, `PromotionSurface.tsx`, `InquirySurface.tsx`, `CommercialSurface.tsx`, `BusinessSurface.tsx`, `SellerListingsSurface.tsx`, `WelcomeSponsored.tsx`. One card anatomy (media, title, meta, price block, status badge, actions), consistent badges, price formatting from server values, clear primary vs secondary actions, loading skeletons, error and empty states. Receipts must look different from proposals (a proposal is not a done action).

### UI-06 — Smart store card (Business tier showcase)
`features/ai/smart-store/SmartStoreCardView.tsx`, `MessageSmartStoreCard.tsx`, `useLiveSmartStoreCard.ts`, `ConnectActionCard.tsx`, `WorkflowCard.tsx`. Make the smart store card feel like a live mini-store inside the chat: header with store identity and trust signals, product carousel/grid, variant and quantity selectors, live price/availability updates as the user taps (data from the server/live hook — do not compute prices), clear call-to-action area, "why am I seeing this" and source labels (marketplace vs merchant system), compact and expanded modes, smooth transitions, skeletons while live data loads, graceful "store unavailable" state. Connect action cards: write actions always as a confirmation card with an explicit confirm/cancel, then a receipt — keep that contract. **Payment area inside the chat** is being built by Claude (§6): leave a clearly marked slot and design the visual for it (states: available, unavailable in this country, pending, paid, failed, refunded) using mock data in a Storybook-style dev page only (`pages/dev/`), not wired to real payments.

### UI-07 — Home, welcome and onboarding
`pages/Home.tsx`, `features/Onboarding.tsx`, `WelcomeSponsored.tsx`, `TutorialVideoCard.tsx`. What Jassim is in one sentence, three example tasks (buy, sell, ask), market selector, sign-up call to action. Fast first paint.

### UI-08 — Commerce pages
`Search.tsx`, `OfferDetails.tsx`, `Cart.tsx`, `Checkout.tsx`, `Orders.tsx`, `OrderDetails.tsx`, `features/OfferCard.tsx`, `OrderCard.tsx`, `OrderParts.tsx`, `OfferForm.tsx`, `DealClosurePanel.tsx`. Clear order status timeline, negotiation history, cash-on-delivery explanation, seller and buyer next steps, cancellation/refund-due states worded honestly.

### UI-09 — Market status and plan surfaces
Small, honest market badge: «تشغيل تقني — الدفع نقدًا فقط» for `PRE_LEGAL`; nothing for fully approved markets. Subscription/plan page and upgrade prompts (Go/Pro/Business): read plans, prices and limits from the server; show "payment not available in your country" when the server refuses (IQ, SY, pre-legal markets); `features/WhopPayment.tsx` look and states. No prices in code.

### UI-10 — Account, settings and Connect pages
`pages/Account.tsx`, `pages/Connect.tsx`, `features/Connect*.tsx`. Clean grouping, consistent list rows, destructive actions separated and confirmed, Connect onboarding steps clear (connect → verify → authorize tools → live), secrets never displayed.

### UI-11 — Admin panel
All `pages/admin/*`. Consistent table/list layout, filters and search (Arab markets page: filter by technical/legal status, search by country), technical vs legal status always visually separate, bulk actions guarded with confirmation.

### UI-12 — Accessibility pass
WCAG 2.1 AA across all pages: landmarks, headings order, labels, focus order and visible focus, keyboard-only operation of chat and cards, screen-reader text for icons, `aria-live` for streamed replies and toasts, contrast. Report with before/after findings.

### UI-13 — Performance pass
Entry bundle size, lazy routes, image sizes and `loading="lazy"`, font loading, avoid layout shift. Report before/after: bundle KB, LCP, CLS, INP (Lighthouse mobile on the preview).

### UI-14 — Copy pass
All user-facing Arabic copy: consistent terms (طلب، عرض، بائع، مشتري، تاجر، متجر), no «دينار» brand, no English leaking, short error messages that say what to do next. Produce `docs/ui-glossary.md`.

## 6. What Claude is building in parallel (do not build these; design only where stated)

- Whop payments for subscriptions and paid ads (methods, checkout, webhooks).
- Card (Visa/Mastercard) payment between buyers and sellers — model under study.
- **In-chat payment area for stores connected through Jassim Connect Universal** (Jassim generates the payment place inside the conversation). You design its visual states (UI-06); Claude builds the server and wiring.
- Integration completion: email, monitoring, free AI provider and open-source maps for testing.
- Plan pricing, capacity and limits per plan are decided by the owner after the QA campaign.

If a task needs any of these, use mock data on a dev page and note the dependency.

## 7. Delivery format (every task)

Push the branch, then add to `docs/ui-progress.md` on your branch:
- Task id and branch, commit hash.
- What changed and why (bullet list), files touched.
- Screenshots: before/after, 360px and 1440px, light and dark (store under `docs/ui-screens/<task>/`).
- `pnpm run typecheck` and `pnpm --filter @workspace/dinar run build` output (pass).
- Browser tests you ran from `artifacts/dinar/test/` (with `CHROMIUM_PATH`), and results.
- Known gaps and any request for Claude.

The owner sends each branch to Claude; Claude reviews, deploys to qa-lab for preview, and merges only with the owner's approval. Work on the next task while the previous one is in review; keep branches small and independent.

## 8. Definition of done (whole mission)

All 14 tasks delivered and reviewed; no Critical/High items left from the UI-01 audit; AA accessibility; no horizontal scroll at 360px; light and dark mode complete; Lighthouse mobile performance ≥ 85 on the preview; zero «دينار» strings in the UI; no regressions in existing browser tests.

---

## UI-15 — Jassim Ads surfaces (added 2026-11-27, owner decision)

Context: `docs/jassim-ads-audit/DESIGN-SCOPE-AR.md` and the owner's design `docs/jassim-ads-audit/owner-design-ad-placements.webp` (branch `claude/jassim-ads-audit`). Jassim Ads is a **conversational** marketing manager: merchants create, preview, buy, launch, monitor and optimise promotion inside the chat. Your job is the **visual and interaction layer** of those cards and placements — not server logic, not payments.

Vocabulary on screen: «إعلان» = the merchant's listing; «ترويج» = paid reach (internal or external). Every paid item shows a visible label («إعلان ممول» / «ممول») — never remove or shrink it below readable size.

### A. Buyer-facing placements (design + front-end, with server data only)
1. **Welcome hero carousel** (top of the chat welcome): 16:9-ish banner, image left / text right in RTL, crown «عرض مميز» tag only for VIP, «إعلان ممول» chip, product name, 3 trust facts (condition, warranty, delivery), price pill from server value, primary «عرض التفاصيل والشراء», favourite, prev/next arrows, dots. Autoplay ≥ 6 s, pause on hover/focus/touch, swipe on mobile, keyboard arrows, `prefers-reduced-motion` = no autoplay. Height ≤ 38% of viewport on desktop, ≤ 32% on mobile; never pushes the composer off-screen. Hidden on screens ≤ 620 px high.
2. **«إعلانات مميزة لك» row**: exactly the number of cards the server returns (target 3). Desktop: 3 equal cards in one row; tablet: 2 + scroll; mobile: horizontal scroll-snap, 1.15 cards visible, no layout jump when it loads (reserve height with a skeleton). Card anatomy: image, «إعلان» chip, title (1 line, ellipsis), one-line subtitle, price, add-to-cart icon button (44 px). Dismiss «×» for the whole row.
3. **Sidebar sponsored card** (desktop ≥ 1280 px only): one card, rotating with dots, same anatomy, never taller than 220 px, never above «المحادثات الأخيرة».
4. **Sponsored items inside chat search results and recommendations**: keep current server rules; restyle the badge consistently with UI-05; sponsored items must look visually distinct from organic results (badge + subtle border), never styled as Jassim's own answer.

### B. Merchant conversational ad cards (render server-provided objects; design them now on a dev page with mock data)
Build components under `features/ai/ads/` and a dev page `pages/dev/AdsCards.tsx`:
1. **Opportunity card** — "this product gets views but few sales", suggested actions as chips.
2. **Creative preview card** — the ad as it will appear, switchable by placement/platform (search result, featured card, hero, Instagram post 1:1, story 9:16, Facebook feed, Google search text); multiple copy variants with «اختر هذه النسخة».
3. **Campaign plan card** — channels with budget per channel (bar), audience, regions, duration, assumptions, and three clearly separated money blocks: «حصتك/رصيد جاسم» · «ميزانية المنصة (من حسابك لدى Meta/Google)» · «رسوم خدمة جاسم» (hidden when zero).
4. **Confirmation card** — exact item, price in local currency from server, duration, what is charged where; «تأكيد ودفع» / «تعديل» / «إلغاء». Pending state until the server returns a receipt; never a success look before the receipt.
5. **Receipt card** — visibly different from the proposal (check icon, reference, start/end dates).
6. **Performance report card** — KPI tiles (impressions, clicks, attributed orders, conversion), per-channel table, Jassim's analysis text, suggested next actions as chips; every number from server; "example/illustrative" watermark when data is mock.
7. **Account connection card** — Meta / Google connect status (not connected / connecting / connected / needs re-auth), what permissions mean in plain Arabic, never show tokens.
8. **Budget alert / expiry card** — compact, actionable.

### C. Quality bar
- Smoothness: no layout shift (CLS < 0.05 on the welcome screen), skeletons for every async card, 60 fps scroll on mid-range Android, images `loading="lazy"` with fixed aspect ratios, transitions 150–250 ms.
- Sizes: card widths fluid with min 260 px / max 360 px in rows; chat cards max 560 px; typography and spacing from the UI-02 tokens.
- Accessibility: carousel and chips fully keyboard-operable, `aria-roledescription="carousel"`, live region for slide changes off by default, labels on all icon buttons, AA contrast on gold-on-dark (the design's gold must pass AA — adjust shade if needed).
- Light and dark mode; RTL; 360 px with no horizontal page scroll.
- Screenshots per §7 for every card state (loading, empty, error, pending, receipt) at 360 and 1440 px.
- Do not hard-code any price, quota, slot count or plan limit; read them from props supplied by the server.
