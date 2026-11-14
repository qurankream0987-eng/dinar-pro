# JassimAI — Advertising UX update and Jassim Connect closure (2026-11-14)

Branch `claude/jassimai-ads-connect-closure` (local only; not pushed, merged or deployed).
Base: `claude/jassimai-premium-product-evolution` `5b121e6` (published with owner approval).
Commits: `95c6b27` (advertising), `1a8b10f` (Connect Mode A + commands), this report.

## 1. Advertising

### Products (policy-gated, versioned)

| Product | Type | Placement(s) | Duration | Proposed price | Test configuration |
|---|---|---|---|---|---|
| «إعلان داخل المحادثة» | SPONSORED_RECOMMENDATION | WELCOME + contextual in chat | 7 days | USD 5 | 3.550 JOD |
| «جاسم روح بيع لي» | DEMAND_CAPTURE | saved buyer demand | **10 days**, no renewal | USD 5 | 3.550 JOD |
| «تمييز في نتائج البحث» | SPONSORED_SEARCH | search results | 7 days | USD 2 | 1.420 JOD |

- New commercial-policy fields: `advertisingProducts` (allow-list; unset = legacy behaviour, so
  historical campaigns are untouched), `welcomeSponsoredSlots` (≤ 2), `welcomeSponsoredDailyConversations`,
  `demandRequestRetentionDays`. Creating a product outside the allow-list returns 409
  `AD_PRODUCT_NOT_IN_POLICY` (VIP refused in AD-01).
- Prices are admin-configured per market in the market currency. USD prices need an owner
  decision on currency/conversion (blocker B1). No real billing: purchases use the simulated
  commercial balance.

### Welcome-screen sponsored cards

`lib/welcome-ads.ts`, `GET /ai/welcome-sponsored`, `POST /ai/welcome-sponsored/dismiss`,
`WelcomeSponsored.tsx` rendered as a footer inside the welcome scroll area (after the six
starters, never above the composer). Server rules: owner + empty conversation only; chosen once
per welcome key and returned unchanged (typing/refresh never rotate); never after the first
message; daily cap; dismissal; viewer's own listings excluded; market eligibility only; one
NOT_BILLABLE `WELCOME` impression per card. Signed-in users only (caps need an identity).
Short screens (≤ 620 px high) hide the section, as they already hide the starters.

Defect found and fixed during this work: on phones the first layout squeezed the welcome area
and clipped the second row of starters; the test only counted starter elements. The row moved
into the welcome content and the browser test now asserts that every displayed starter is fully
visible above the composer and that the sponsored row comes after the starters.

Evidence: `ads-connect-evidence/` (before/after first message at 390, 1366×768, 768×1024,
320×568, dark 1440, metrics JSON).

### «جاسم روح بيع لي» (10 days)

Buyer-authorised saved requests (`buyer_demand_requests`, migration `0064`), explicit consent
text and version, retention by policy, opt-out and deletion; deterministic matching (category,
city, max price, every number in the need must appear in the listing, coverage ≥ policy);
notices carry no buyer identity; the seller sees only a count. Conversation flow
«نبّهني إذا توفر» → disclosure → «أوافق على حفظ طلب التنبيه».

## 2. Jassim Connect

### Inventory

| Capability | Existing code | Tests | Runtime evidence | Status |
|---|---|---|---|---|
| Free onboarding on canonical D2 identity | connect/partners.ts | connect-partners 24 | API + browser | VERIFIED END-TO-END (simulation) |
| Site ownership (DNS proof, not URL) | connect/sites.ts, domains.ts | connect-domain, connect-partners | offline DNS resolver | TESTED |
| Catalog sources: feed/API, website page, MCP, OAuth/PKCE | catalog-pull, website-catalog, mcp-catalog, oauth | catalog-pull, website-catalog, mcp-catalog, sync-observations | synthetic transports | TESTED; live providers BLOCKED BY EXTERNAL PROVIDER |
| Mode B external checkout (click ≠ sale) | partners.ts cards, network.ts | connect-modes/cards browser journeys | browser | VERIFIED END-TO-END (simulation) |
| **Mode A catalog → internal listing** | **connect/catalog-import.ts (new)** | **connect-catalog-import 8** | API | TESTED (was NOT IMPLEMENTED) |
| Mode C hybrid | mode + both paths | connect-modes, CI-07 | browser + API | TESTED |
| Agreements, referrals, finance ledger | agreements.ts, finance.ts | agreement-draft, commission-math, finance browser | browser | VERIFIED END-TO-END (simulation) |
| Conversation commands | provider-turn, business-turn, **connect-merchant-turn (new)** | **connect-commands 2** | runtime, blocked model | TESTED |
| Connect + demand capture | demand-requests.ts + import | CI-08 | API | TESTED |

### Mode A import rules

Owner only (404 otherwise); internal-sale capability enabled (approved partner + verified
business — choosing the mode is not enough); offer PUBLISHED and checked within 24 h; market
currency and scale (no conversion); the previewed source version and price are confirmed
(a sync in between → 409 `OFFER_CHANGED`); stock, location and fulfilment are the owner's
statement; derived listing id (retries and parallel clicks return one listing, one audit row);
free; the merchant website's checkout never runs inside DINAR.

### Ten commands (blocked model)

| Command | Handling |
|---|---|
| «جاسم اربط متجري» | provider connection review (no key before confirmation, no password) |
| «جاسم استورد منتجات موقعي» | catalog with import readiness (new; was a generic settings reply) |
| «جاسم رتب المنتجات» | model, grounded on the seller's listings |
| «جاسم حسّن وصف المنتج» | model, grounded on the seller's listings |
| «جاسم أبي أبيع منتجات متجري عندك» | catalog with import readiness (new; was a new one-item sale draft) |
| «جاسم خل الشراء من موقعي» | mode and missing requirements (new; was a generic settings reply) |
| «جاسم قارن منتجاتي» | own listings performance |
| «جاسم ورني الطلبات» | orders list |
| «جاسم حلل مبيعاتي» | monthly sales from records (no invented numbers) |
| «جاسم أبي سائق يوصل الطلب» | orders list (a driver is requested on an order) — PARTIAL |

### Commission

- Internal commerce: published policy wins, fallback 10 % (1,000 bps) of gross item subtotal,
  half-up; immutable snapshot per order (`commission-policy.ts`).
- External: no default referral percentage; commission only from an owner-accepted agreement
  version and an authenticated conversion event (connect-commission-math, finance journey).
- **Delivery: the code accrues a 10 % courier commission receivable on every completed courier
  trip (`courier-economics.ts:35`, present since the source export). The historical initial-phase
  policy is 0 %. Not changed here (financial behaviour needs owner approval) — blocker B2.**

## 3. Release blockers / owner decisions

B1 currency of the USD ad prices; B2 courier commission 10 % in code vs 0 % policy; B3 outbound
notification channel for demand matches (in-app only today); B4 live Connect providers/credentials
and DNS pinning egress; B5 legal texts for demand consent and advertising; B6 publication and
deployment approval.
