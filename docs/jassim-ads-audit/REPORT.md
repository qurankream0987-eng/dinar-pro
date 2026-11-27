# Jassim Ads — audit of the existing code (read-only)

Date: 2026-11-27 · Commit audited: `6b62656` (what Production runs) · Auditor: Claude
Nothing was changed, merged or deployed. Production was not touched; data evidence comes from the `qa-lab` clone of the Production database (read-only transaction). Tests ran on disposable loopback databases.

Status legend: **FUNCTIONAL** = real code path, tested end to end (simulated money only) · **PARTIAL** = some pieces exist · **PREPARED** = configured/defined but deliberately blocked · **ABSENT** = no code.

---

## A. Advertising inventory

### A1. Products (server catalogue: `promotion_products.product_type`)

| Product | Placement written | Status | Where defined |
|---|---|---|---|
| `FEATURED_LISTING` (تمييز) | `FEATURED` | FUNCTIONAL (simulated payment) | `lib/promotions.ts:884`, check `lib/db/src/schema/index.ts:493` |
| `VIP_LISTING` | `VIP` | FUNCTIONAL (simulated) — VIP tier label in results | same; `lib/marketplace-listings.ts:465` |
| `REFRESH_LISTING` (تجديد) | `REFRESH` | FUNCTIONAL (simulated); limits `refreshMinIntervalHours=24`, `refreshMaxPerDay=1` | `lib/promotions.ts:367`, `lib/commercial-policy.ts` |
| `SPONSORED_SEARCH` | `SPONSORED_SEARCH` | FUNCTIONAL (simulated) | `lib/promotions.ts:75` (`SEARCH_PLACEMENTS`) |
| `SPONSORED_RECOMMENDATION` (إعلان داخل المحادثة) | `SPONSORED_RECOMMENDATION` | FUNCTIONAL (simulated) | `ai/commerce-turn.ts`, `lib/welcome-ads.ts` |
| `DEMAND_CAPTURE` («جاسم روح بيع لي») | `DEMAND` | FUNCTIONAL (simulated), consent-based | `lib/demand-rescue.ts`, `lib/demand-requests.ts`, `routes/advertising.ts` |
| `STANDARD_PROMOTION` | `SEARCH_AND_CHAT` | FUNCTIONAL (legacy type) | `routes/promotions.ts` |
| `PROMOTION_BUNDLE` | — (grants entitlements) | FUNCTIONAL (simulated) | `commercial_entitlements` |
| `SPONSORED_SURFACE` | — | **PREPARED**: creating it enabled is refused (`PREPARED_NOT_ENABLED`) | `routes/commercial.ts:325,373` |
| `EXTRA_LISTING_QUOTA` | — | **PREPARED**, same refusal | same |
| `DINAR_BUSINESS` (plans Go/Pro/Business) | — | subscriptions via Whop (separate) | `routes/commercial.ts:221,234` |

Note: the market policy field `advertisingProducts` restricts which ad types a market may sell; the acceptance test `AD-01` configures JO with exactly `SPONSORED_RECOMMENDATION`, `DEMAND_CAPTURE`, `SPONSORED_SEARCH`.

### A2. Placements — where an ad can actually appear

The web app runs in **chat-only mode** (`artifacts/dinar/src/App.tsx:76 CHAT_ONLY_MODE = true`): `/`, `/search`, `/discover` redirect into the chat. Placements therefore:

| Surface | Mechanism | Label shown | Status |
|---|---|---|---|
| **Search results inside the chat** | server ranking inserts up to `searchSponsoredSlots` (default 2, max 4) paid slots: `lib/marketplace-listings.ts:412-493`; rendered by `features/ai/ListingGlimpses.tsx:15`, `features/ai/BuyerPanels.tsx:60,87`, `features/OfferCard.tsx:77-83` | «إعلان ممول» / «ممول», VIP tier | FUNCTIONAL |
| **Chat recommendations** | `SPONSORED_RECOMMENDATION`, `recommendationSponsoredSlots` (default 1, max 2): `ai/commerce-turn.ts` | «إعلان ممول» | FUNCTIONAL |
| **Chat welcome screen** | `GET /api/ai/welcome-sponsored`, `features/ai/WelcomeSponsored.tsx`, mounted in `pages/Ai.tsx:2511`; ≤2 cards (`welcomeSponsoredSlots`), ≤3 conversations/day, disappears after the first message, dismissible | «إعلانات ممولة» | FUNCTIONAL — screenshots below |
| **Demand rescue** (low supply) | `demandRescueSlots` (default 2), consented buyer requests only, 10-day window | disclosed | FUNCTIONAL |
| **Smart store card** | `features/ai/smart-store/SmartStoreCardView.tsx:159` shows «ممول» when the card carries a sponsored item | «ممول» | PARTIAL: label only; no paid placement product targets store cards |
| **Store page** (`pages/PublicBusiness.tsx`) | uses `OfferCard` → badge renders if `isSponsored`, but no dedicated store-page slot | badge only | PARTIAL |
| **Product page** (`pages/OfferDetails.tsx`) | no sponsored slot | — | ABSENT |
| **Homepage / standalone search page** | pages exist (`Home.tsx`, `Search.tsx`) but are unreachable in chat-only mode; no homepage slot | — | ABSENT (unreachable) |
| **"Sponsored surface"** (generic placements) | `SPONSORED_SURFACE` product | — | PREPARED, blocked |

Measurement: `promotion_attributions` (IMPRESSION / ENGAGEMENT / CONVERSION, dedup windows, self-click skipped, budget skips) — `lib/promotion-attribution.ts`; analytics `GET /api/commercial/campaigns/analytics`.

### A3. Visual evidence
Captured by the repository's browser test `welcome-ads-browser` on a disposable database with simulated payment (not Production):
- `welcome-390x844.png` — sponsored strip «إعلانات ممولة», card labelled «إعلان ممول».
- `welcome-1440x900.png`, `welcome-dark-1440.png` — desktop and dark mode.
- `welcome-after-first-message-390.png` — cards removed after the first message.

**Production today shows no ads**: Production has `BDINAR_PROMOTIONS_ENABLED` unset (feature off → 503 on ad routes) and the Production data clone contains **0** ad products, **0** promotions, **0** wallets, **0** ledger entries (query below).

---

## B. Pricing and administration

### B1. Schema
- `promotion_products` (`lib/db/src/schema/index.ts:428`): `market_id`, `category_id`, `product_type`, `placement`, `charging_mode` (`FIXED` / `PREPAID_BUDGET` / `SUBSCRIPTION`), `price_minor` (>0), `currency_code`, `duration_days` (1–365), `max_budget_minor`, `unit_charge_minor`, `priority_weight`, `refund_policy` (`NON_REFUNDABLE_ON_ACTIVATION` / `RELEASE_UNUSED_BUDGET` / `UNUSED_UNITS_TO_CREDIT` / `NO_REFUND`), `bundle_items`, `entitlement_expiry_days`, `pricing_version`, `effective_from/to`, `enabled`, `plan_code`.
- `listing_promotions` (`:538`): immutable snapshots of price, currency, placement, duration, priority, refund policy; `status` from `PENDING_PAYMENT`; `budget_minor`, `spent_minor`.
- `commercial_policies` (`:944`): versioned JSON policy per market or global (slots, dedup, refresh limits, top-up min/max, welcome caps, `advertisingProducts`, `advertisingTariffs`, `advertisingBillingActivation: "DISABLED"` — a literal, cannot be switched on by data).

### B2. Per-country, per-currency configuration — **yes**
Prices are rows **per market**, in that market's currency at its minor-unit scale, with independent duration, category, priority and validity window; policy can be overridden per market (`getCommercialPolicy`: market row > global row > code defaults).

### B3. Existing values
- **Products in Production data: none configured** (0 rows).
- Code reference tariffs (policy defaults, USD, not charged): `SPONSORED_RECOMMENDATION` $5.00 / 7 days; `DEMAND_CAPTURE` $5.00 / 10 days; `SPONSORED_SEARCH` $2.00 / 7 days; `autoRenew: false`.
- Policy defaults: search slots 2, recommendation slots 1, demand slots 2, welcome slots 2 / 3 conversations/day, impression dedup 30 min, engagement dedup 24 h, conversion window 7 d, refresh ≥24 h and ≤1/day, top-up 1–1000 major units, credit order PROMO_FIRST.
- Targeting available: market, category, search-term match, placement; no demographic/geo-radius/interest targeting in the marketplace ads (the separate smart-ads branch adds interest personalisation, not merged).

### B4. Admin screens and API
- UI: `/admin/promotions` → `pages/admin/AdminPromotions.tsx` (list/create/update plans per market; shows «لا توجد مدفوعات فعلية»). Linked from `AdminMarkets.tsx` and `AdminCategories.tsx`.
- API: `GET/POST /api/admin/markets/:marketId/promotion-products`, `PATCH …/:id`; `GET/POST /api/admin/markets/:marketId/commercial-products`, `PATCH /api/admin/commercial-products/:id`; `GET/POST /api/admin/commercial-policies`; `POST /api/admin/commercial-credits`; `POST /api/admin/commercial-refunds`; `GET /api/admin/markets/:marketId/commercial-summary`; `GET /api/admin/markets/:marketId/promotions`; CLI test `commercial-policy-cli`.
- Gap: no admin UI for commercial policies (slots, caps, tariffs) — API/CLI only.

---

## C. Merchant advertising wallet («رصيد جاسم التجاري»)

| Item | Implementation | Evidence |
|---|---|---|
| Accounts | `commercial_accounts` per user × market × currency; buckets `paid_available`, `promo_available`, `reserved`, `spent`; **SQL CHECK all ≥ 0** | `schema/index.ts:677` |
| Ledger | append-only `commercial_ledger`; 20+ entry types (`CREDIT_TOPUP`, `CREDIT_GRANTED`, `CAMPAIGN_RESERVE/RELEASE/CHARGE`, `FEATURED/VIP/REFRESH/BUNDLE_PURCHASE`, `QUALIFIED_*_CHARGE`, `ENTITLEMENT_CONSUMED`, `REFUND`, `ADJUSTMENT`, `EXPIRE`…); `amount_minor ≥ 0`; `reverses_entry_id` for reversals | `:700`, `lib/commercial-ledger.ts` |
| Duplicate protection | every posting has an `idempotency_key`; top-up credit key `topup:<provider>:<ref>`; same key returns the first entry; reused key with different amount → 409 `IDEMPOTENCY_KEY_REUSED` | `commercial-ledger.ts:400-460` |
| Negative-balance safeguard | buckets mutated only by `post()` under row lock in the same transaction as the ledger row + SQL non-negative checks | `commercial-ledger.ts:1-20` |
| Top-ups | `commercial_topups` with **CHECK `payment_mode = 'SIMULATION_ONLY'`**; intent via `testOnlyPaymentAdapter`; credit only from a verified webhook whose signature, type `CAPTURE_SUCCEEDED`, amount, currency and provider snapshot match | `:747`, `commercial-ledger.ts:426-470` |
| Simulation | `POST /api/commercial/topups/:id/simulate-capture` refused unless `isPromotionSimulationEnabled()` (development/test only) | `commercial-ledger.ts:473` |
| Refunds | admin `POST /api/admin/commercial-refunds`; policies per product (`RELEASE_UNUSED_BUDGET`, `UNUSED_UNITS_TO_CREDIT`…) | `routes/commercial.ts:411` |
| Separation | balance is not buyer money, not withdrawable, never touches orders or settlement | file header |

### C1. To connect real top-ups through Whop safely (not done)
1. A `WhopTopupAdapter` implementing the same interface as `testOnlyPaymentAdapter` (intent = one-time Whop checkout for a fixed USD pack; snapshot = Whop payment status).
2. A migration relaxing `commercial_topups_simulation_only` to allow a `LIVE` mode **only for provider `whop`**, plus a stored FX quote (USD paid → local-currency credit) fixed at intent time.
3. Webhook: reuse the signed Whop billing webhook (`/api/billing/whop/webhook`), route `payment.succeeded` for top-up checkouts to `receiveTopupWebhook` (signature, amount, currency, status re-checked; idempotent).
4. Refund/chargeback events → `REFUND` ledger reversal, never a negative bucket (debt recorded separately if already spent).
5. Gates: `advertisingBillingActivation` is a literal `"DISABLED"`; activation needs a code change plus owner approval, the legal gate per market, and Whop country support (IQ/SY excluded).

---

## D. External campaigns (Facebook, Instagram, Google Ads)

**Implemented: none.** A full-repository search finds no Meta Marketing API, Instagram, Graph API, Google Ads API, OAuth scopes, ad-account linking, campaign creation, reporting or billing code (`grep -i facebook|instagram|googleads|adwords|graph.facebook` → no integration code). The chat chip «أنشئ إعلانًا» (create an ad) in the welcome screen refers to creating a marketplace listing/ad copy, not an external campaign. **No external campaign execution is supported, and none was tested.**

### D1. What an integration would require (proposed — verify against current vendor docs before building)
| | Meta (Facebook + Instagram) | Google Ads |
|---|---|---|
| API | Marketing API (Graph API): campaign → ad set → ad → creative; Insights for reporting | Google Ads API (campaigns, ad groups, ads, reporting via GAQL) |
| App approval | Meta app + Business verification; App Review for advanced access to ads permissions | Developer token (test → basic/standard access approval) |
| OAuth permissions | `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`, `instagram_basic` (+ Instagram account linked to the Page) | OAuth scope `https://www.googleapis.com/auth/adwords`; manager (MCC) account linking |
| Account model (recommended) | merchant connects **their own** ad account; spend billed by Meta to the merchant's payment method | merchant connects **their own** Google Ads account; billed by Google to the merchant |
| What Jassim would do | create campaigns from a listing/store (copy, images, budget, dates, audience), sync status and insights into the merchant dashboard | same, plus conversion tracking |
| Policy/risk | Meta ad policies, special ad categories, regional availability per country | Google Ads policies, country availability |
| Billing through Jassim | possible only as an agency/reseller model (credit lines, invoicing, tax) — **not recommended** initially | same |

Credentials would live in the existing Connect credential vault pattern (`connect/credential-vault.ts`): sealed, never shown to the model.

---

## E. Subscription allowances (Phase A / Phase B)

| Item | Current state |
|---|---|
| Plan policy | `lib/subscription-plans.ts`: Go/Pro/Business are `PROPOSED`, `approved: false`; entitlements are feature keys (`MARKET_PULSE_ADVANCED`, `CAMPAIGN_ANALYTICS_ADVANCED`, `BUSINESS_REPORTING`, `INVENTORY_INSIGHTS`, AI tiers, `BUSINESS_PROFILE_TOOLS`) — **no advertising allowance field exists** |
| Unit entitlements | `commercial_entitlements` already models units of `FEATURED_LISTING` / `VIP_LISTING` / `REFRESH_LISTING` with duration, priority and expiry — but every row must come from a **bundle purchase** (`bundle_product_id NOT NULL`) |
| Gap for Phase A | a monthly grant per active subscription: plan → `{productType, units, durationDays}` (values configurable, **left empty pending pricing approval**), a grant job on activation/renewal (idempotent per subscription period), expiry at period end, consumption through the existing `ENTITLEMENT_CONSUMED` path, and revocation on `membership.deactivated` |
| Phase B | Whop top-up packs → C1 |

No quota or price was invented or activated.

---

## Gap analysis (priority order)

| # | Gap | Area | Size | Notes |
|---|---|---|---|---|
| 1 | Feature off in Production (`BDINAR_PROMOTIONS_ENABLED` unset) and **no products configured** | ops | S | turning on requires configured products + legal per market |
| 2 | Real top-up payment (Whop adapter, LIVE mode, FX quote, refunds) | wallet | L | C1; `advertisingBillingActivation` literal blocks it by design |
| 3 | Subscription ad allowances (Phase A) | plans | M | E; reuse `commercial_entitlements` with a new `source = SUBSCRIPTION` |
| 4 | Product-page and store-page sponsored slots; smart-store-card sponsored product | placements | M | homepage blocked by chat-only mode (product decision) |
| 5 | `SPONSORED_SURFACE` generic placements | placements | M | prepared, refused when enabled |
| 6 | Admin UI for commercial policy (slots, caps, tariffs) | admin | S | API/CLI exist |
| 7 | Merchant ads dashboard (spend, impressions, clicks, conversions per campaign) | merchant UI | M | analytics API exists; UI partial in chat surfaces |
| 8 | External campaigns (Meta, Google) | new | XL | D; none implemented |

## Test evidence (disposable loopback databases, simulated money only)
| Suite | Result |
|---|---|
| `promotions` | 6/6 |
| `advertising-acceptance` (AD-01, AD-02, WS-01..08, DC-01..13) | 5/5 |
| `promotion-intent` | 6/6 |
| `welcome-ads-browser` (WS-B1..B3, all viewports, dark mode, reduced motion) | 3/3 |
| `wave03-d9-campaign-audit` | 1/1 |
TAP lines: `test-results.tap.txt`.

Production data query (qa-lab clone, read-only): `promotion_products 0 · listing_promotions 0 · commercial_accounts 0 · commercial_ledger 0 · commercial_topups 0 · commercial_entitlements 0 · promotion_attributions 0 · welcome_ad_exposures 0 · commercial_policies 1 (global: AI usage policy only)`.
