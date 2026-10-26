# DINAR NEXT — Implementation Ledger

Baseline `f60e30d` (tag `dinar-next-baseline-20261019`). Phase definitions are the authoritative ones in
[`DINAR_NEXT_FULL_COMMANDS.md`](./DINAR_NEXT_FULL_COMMANDS.md); the earlier proposed split (B-2) is
superseded. Map: [`EXECUTION_CONTEXT.md`](./EXECUTION_CONTEXT.md). Progress: [`EXECUTION_PROGRESS.md`](./EXECUTION_PROGRESS.md).

All DB-backed results below ran on fresh clones of a disposable loopback PostgreSQL 16.10
(127.0.0.1:55432); no managed database was contacted.

---

## Phase A — General-purpose AI and multi-task conversation

**Status: VERIFIED (development).** Checkpoint commit recorded in `EXECUTION_PROGRESS.md`.

Work arrived in two parts: commit `9a4e443` (prior session, auto-committed, untested at the time) and this
session's fixes. Both are verified together below.

| Requirement | Implementation | Evidence |
|---|---|---|
| A1 lifecycle / root causes | General questions failed because (1) model history was 6×300 chars, (2) reply cap 700 chars rejected complete answers, (3) the model filled the reply field with a note about the request (schema had no description), (4) `null` optional fields made complete answers MALFORMED, (5) bare product phrases dead-ended when no model was available | `model-turn.ts`, `smart-turn.ts`, `conversation-runtime.ts` |
| A2 general conversation | Real provider through the one gateway; complete structured answers up to 6000 chars | live smoke 8/8 (`gpt-5-mini` via Replit AI Integrations) |
| A3 understanding | Vocative «دينار …» stripped; corrections «لا قصدي الثانية» re-resolve the result list; draft interruptions keep the draft | cmda A8-03/05/06 |
| A4 multi-task | `task-plan.ts`: ≤3 explicit steps, one per turn, each re-enters the runtime with full gates; confirmations never queued; bound to actor + market | cmda A8-08/08b/13/14 |
| A5 provider reliability | Timeout aborts request; one retry for transient outage only; 401/403/404 → NOT_CONFIGURED; quota never retried; per-actor model rate limit (20/5 min, fails closed); reasoning effort `low` for OpenAI-family (latency 18–24 s → 4–14 s) | cmda A8-10/10b; ai-provider 9/9 |
| A6 context continuity | 10-turn redacted history ≤9000 chars as real chat turns; every call ≤ `MAX_MODEL_INPUT_CHARS` | cmda A8-04/11, A6; g2 G2-51..54 |
| A7 routing | Explicit commerce stays deterministic (no model call); model search suggestions cannot replace the answer to a general question; with no model, a short product phrase that matches real listings is searched, questions never are | cmda A7/A7b/A7c; blockf0 F0-01 (baseline B-1 resolved) |
| A8 acceptance 1–15 | All 15 scenarios | cmda 21/21 |

Session changes: `model-gateway.ts` (REPLIT_OPENAI adapter, reasoning effort), `model-turn.ts` (reply-field
description, writing/cost-question rules, null-field normalization, input ceiling), `smart-turn.ts`
(general-question guard), `conversation-runtime.ts` (model-unavailable product-phrase search),
`listing-draft.ts` (`isGeneralRequest`), tests (`ai-provider`, `command-a-acceptance`, `g2` bound,
live smoke generalised to any configured provider).

**Phase A gate (fresh, this revision):** typecheck PASS; build PASS; ai-provider 9/9, commerce 20/20,
conversation 27/27, promotions 6/6, location-policy 1/1, marketplace-intelligence 20/20, employment 12/12,
r5-delivery-economics 3/3, conversation-router 7/7, promotion-intent 5/5, market-capability-registry PASS,
database-url-selection 5/5, db-guard 8/8, cmda 21/21, blockf0 12/12, g1 39/39, g2 91/91, gfinal 22/22,
api 63/63, security 12/12; live smoke 8/8.

**Open (owner):** the Repl still selects `DINAR_AI_PROVIDER=GROQ` whose key returns 401 (as do the
OpenAI and OpenRouter keys). Either renew the Groq key or set `DINAR_AI_PROVIDER=REPLIT_OPENAI`.
Model availability outside development remains an owner decision (B-3).

---

## Phase B — Universal selling, buying, negotiation and delivery

**Status: VERIFIED (development, deterministic authorities, no model).**

New suite `test/command-b-acceptance.test.ts` drives the owner's own phrasings through real HTTP turns.
It found and this phase fixed six defects:

| Defect (reproduced) | Root cause | Fix |
|---|---|---|
| «دينار بيع لي هاتفي المستعمل» was not a sale | «بيع لي» only meant the paid «روح بِع لي» product | `intent.ts` `surfaceIntent`: «بيع لي <item>» → SELL unless «روح» / deictic / own-ad object |
| Draft title was the whole sentence | `cleanTitle` kept the vocative and «بيع لي» | `listing-draft.ts` `cleanTitle`, `initialDescription` |
| «دينار عندي خدمة تنظيف» was not a service listing | no «عندي خدمة X» pattern | `surfaceIntent` |
| «دينار اطلب آخر سعر» not understood | best-price pattern lacked «اطلب/ابي … آخر/أفضل سعر» | `negotiation-turn.ts` `BEST_PRICE_REQUEST` |
| «اعرض عليه 20» asked "which listing?" after any conversational reply | focus read only the very last block | `focusBlockPayload` skips ADVICE/CLARIFY within 4 blocks |
| «اطلبه» from the buyer's offers list did nothing | order-now read only a single-negotiation block | resolves the one ACCEPTED offer in the list; asks when several |
| Category «منزل» (as offered) chose real estate | tie between Home label and property alias | exact label reply wins (`explicitConfiguredCategory`) |
| Offered pricing options «قدّم عرضك», «سعر ثابت», «سعر قابل للتفاوض» looped forever | price step accepted only amounts / keyword phrases | price step accepts the offered options; a later bare amount keeps the chosen mode |

**B8 scenario disposition (all executed on this revision):**

| Scenario | Evidence |
|---|---|
| Physical / service / generic listing; no-price; negotiable mode; review before publish; no silent publish; repeated «نعم» | command-b B2 (2 tests) |
| Photo-first; draft correction; interrupted/resumed | blockf1 F1-01/03, blockf5 F5-01/04, cmda A8-06/07 |
| Buyer search; comparison/selection; «الثاني»; empty result; market isolation | blockf2 F2-01..12, blockf5 F5-05/06/26, command-b B7/B8 |
| Best-price inquiry; counteroffer sequence; accepted price into order review and order snapshot | command-b B4/B5; g2 G2-21..38 |
| Duplicate confirmation | command-b B5, blockf3 F3-06 |
| Wrong actor / wrong market | command-b B7/B8, blockd D12–D14/D25, blockf4 F4-12/13 |
| Missing delivery provider; pickup; seller delivery; independent courier; buyer receipt | blockd D07/D08/D11/D24, blockf4 W6-05/06, R5-01, F4-15 |
| Privacy (no public contact/location) | command-b B2, blockd D15/D16, blockf5 F5-24, contact 1/1 |
| Commission unchanged (10%) | command-b B5 (`calculatePlatformFeeMinor`), phase2 1/1 |

**Phase B gate (fresh):** typecheck PASS; command-b 7/7, blockb 5/5, blockf0 12/12, blockf1 14/14, blockf2 14/14,
blockf3 17/17, blockf4 48/48, blockf5 29/29 (first parallel run hit a Playwright protocol crash under load;
passed serially), blockd 28/28, blocke 46/46, g1 39/39, g2 91/91, gfinal 22/22, cmda 21/21, conversation 27/27,
conversation-router 7/7, promotion-intent 5/5, commerce 20/20, promotions 6/6, r5 3/3, nl-micro 1/1,
nl-probes 1/1, wave4 1/1, phase2 1/1, api 63/63, security 12/12, contact 1/1.

## Phase C — Ethical advertising and business assistance

**Status: VERIFIED (development).** No new database, engine, subscription or paywall; all answers come
from the seller's own rows through existing authorities (`seller-management.ts`, `promotions.ts`,
`marketplace-listings.ts`, `negotiations`, `orders`).

Probe through the runtime found: marketing requests reached the model with **no product facts**;
«أرني بضاعتي» searched the market for the word «بضاعتي»; «كم بقي…», «كم طلبًا عندي» went to the model;
«كيف أداء عروضي» returned a generic line; «اقترح كيف أحسن الإعلان» / «كيف أعرض مميزات المنتج» were
captured by the promotion tutorial; no "why is this sponsored" explanation existed; and the canonical
«غيّر الوصف إلى …» edit stored the **letter-folded** text («كنبه انيقه»). Live runs showed the model
inserting an unsupported warranty and an invented discount/deadline into copy despite instructions.

| Area | Implementation |
|---|---|
| C2 grounded copy | `sellerListingFacts` gives the model `SELLER_LISTING` = `dinarRecord` (price, availability, status) vs `sellerProvided` (title, description, attributes) for the listing or draft in focus; none when ambiguous |
| C3 ethics | `claimCheck` of requested claims (scarcity, urgency, warranty, certification, discount, social proof) against those facts; prompt rules; **server guard** `draftWithClaimGuard`: unsupported assertive claim wording → one read-only corrective retry → otherwise an honest refusal (draft never shown) |
| C4 sponsored | `explainSponsoredPlacement`: «ليش هذا ممول؟» explains from the stored result set and the actual placement rules; reports when nothing is sponsored |
| C5 business | `executeSellerAdviceTurn` + inventory / stock-of-focus / order counts by state / per-listing orders, price offers and campaign analytics; states that organic views are not recorded; promotions-unavailable stated |
| C6 review | copy is text only; applying uses the canonical listing preview + confirmation; wording now stored as written (`originalWording`) |
| C7 | no Business Go/Pro, quota or upgrade text added (asserted) |

**C8 disposition:** command-c 11/11 covers all 14 scenarios (truthful drafting; fake scarcity; misleading
warranty; facts unavailable; seller claim vs DINAR record; sponsored label; organic alternative;
authorized inventory; unauthorized seller; market isolation; empty analytics; unavailable advertising;
continuity; edit with approval). Live `command-c-live-smoke` 4/4 (gpt-5-mini via Replit AI Integrations)
through the same guard. Limitation: the guard is pattern-based Arabic claim detection; it is a backstop to
the instructions, not a proof that no misleading phrasing can ever pass.

**Phase C gate (fresh):** typecheck PASS; cmdc 11/11, cmda 21/21, cmdb 7/7, g1 39/39, g2 91/91, gfinal 22/22,
blockf0 12/12, blockf1 14/14, blockf2 14/14, blockf3 17/17, blockf4 48/48, blockf5 29/29, blockc 50/50,
blocke 46/46, blockd 28/28, promotion-intent 5/5, conversation 27/27, conversation-router 7/7, ai-provider 9/9,
commerce 20/20, promotions 6/6, marketplace-intelligence 20/20, employment 12/12, api 63/63, security 12/12,
nl-micro 1/1, nl-probes 1/1; live C 4/4.

## Phase D — Typed interactive conversation surfaces

**Status: VERIFIED (server, contract, reload); browser rendering of the two new renderers is verified in
the Phase E browser suite.**

Audit: the server emits only surfaces declared in the OpenAPI enum (now a test); the client dispatches
by payload key (delivery, promotion, driver, provider, negotiation, commerce, memory, employment) or
surface (ADVICE, COMPARISON, PURCHASE/PAYMENT_REVIEW), and its generic fallback embeds the real
workflow components in-chat (memory router), so those buttons are real. Gaps found and closed:

| Gap | Change |
|---|---|
| Phase C business answers (inventory, orders, performance) had no card | `SellerBusinessInsight` Zod contract in `lib/api-zod/src/conversation-runtime.ts`; server `parse`s before emitting; `BusinessSummaryPanel.tsx` renders only what parses; text keeps lead + notes, drops duplicated rows |
| General answers rendered as raw markdown (fences, lists, tables, bold) | `rich-text.ts` (pure parser → data) + `RichText.tsx` (React elements only, never HTML); code blocks LTR with a real clipboard copy; tables and code scroll in their own container |
| New advice/insight fields undocumented | OpenAPI descriptions; Orval regenerated (description-only diff) |

No new commercial buttons were added; existing commercial buttons keep their canonical actions.
Not added: a typed card for compound-request step plans (plan state is persisted on the user message and
shown as text) — not in the D2 list.

**Phase D gate (fresh):** typecheck PASS; full build PASS; command-d 6/6 (spec consistency, contract
valid/invalid, reload hydration equality, actor isolation 404, empty states, parser safety incl. literal
`<img onerror>`), cmda 21/21, cmdb 7/7, cmdc 11/11, g2 91/91, gfinal 22/22, blockf1 14/14; browser: g3 6/6,
blockf5 29/29 (incl. UI journeys 320–414), contact 1/1; security 12/12.

## Phase E — Premium Arabic RTL UI, mobile and performance

**Status: VERIFIED (development, headless Chromium).** Reuse: `pages/Ai.tsx`, `features/ai/*`, `AiChat.css`,
the app theme (`lib/theme.ts`, `.dark`). No new screens or authorities.

Evidence harness: `api-server/test/command-e-ui.test.ts` seeds real conversations (general answer with
table/code, search cards, negotiation, delivery, seller draft, business, 30-message thread) through the one
runtime with a scripted model, serves the production build, and `dinar/test/command-e-ui.mjs` measures and
screenshots 8 widths (320, 375, 390, 430, 768, 1024, 1440, 1600) in light, and 4 of them in dark (96 runs).

| Finding (measured) | Fix |
|---|---|
| Direct purchase of a NEGOTIABLE listing passed the chat order review, then checkout refused it with the misleading «تغير المخزون» | The approved rule (checkout since `3f6ba72`, asserted by g-final J05/J06/J07/GEN-OTHER/SEC-INJECTION) is kept: only FIXED listings are bought directly; NEGOTIABLE/OPEN_TO_OFFERS need an accepted agreement. Made the other layers agree: `PLACE_ORDER` refuses up front with the next step, `OfferDetails` shows «اتفق مع البائع» instead of buy, the negotiation guard no longer promises a direct purchase, and a checkout 409 names the real issue (`checkoutIssueMessage`). commerce + command-b B5 tests. (An interim commit `30ec99a` loosened checkout instead; F's full regression caught the conflict with g-final and it was reversed.) |
| Chat ignored the light theme: `AiChat.css` hard-coded ~300 dark colours and two unconditional dark token blocks | One chat palette (`--chat-*`, light by default, dark under `.dark`); raw colours mapped onto it; dark token overrides scoped to `.dark`; shared button variants follow the palette inside the chat and the history drawer portal |
| Business answers embedded the whole «عروضي» workflow under the new card | only `BusinessSummaryPanel` when a business insight is present |
| «معلومة عامة…» provenance label rendered as an empty card | compact `.ai-scope-chip` |
| Tap targets: context button 38px wide, map link 18px tall, order/cart title link 22px | 44px / 40px / padded hit area (layout unchanged) |
| Harness: drawer journey clicked the desktop-only rail button; return-to-latest used a programmatic scroll (which by design does not unpin the thread) | mobile menu button; real wheel gesture. Both journeys now pass at 390 and 1440 |
| Bundle: the chat chunk carried the whole Orval Zod contract (~100 kB) and rarely used surfaces | build-only `/*#__PURE__*/` annotation of the generated schemas (`vite.config.ts`); Employment/Delivery/OrderTracking/Promotion surfaces lazy |

**Performance (production build):** main JS 924.26 kB / gzip 247.11 kB → 776.56 kB / gzip 225.52 kB;
transferred JS on chat load 242 KB → 221 KB; CSS ~225 kB (gzip ~38 kB) unchanged in size class.
**Browser result (final run):** 96/96 runs, overflow none, unnamed controls none, tap targets < 40px on touch
widths none, composer always visible, console errors none, RTL everywhere, dark applied in all dark runs,
drawer opens/closes (Escape) at 390, return-to-latest visible and working at 390 and 1440.
**Accessibility:** focus ring follows theme (blue on light), reduced-motion rules kept, all controls named.
**Not done:** no new visual features (by E2's "do not add decorative features"); `countries.ts` (35 kB) and
`react-dom` remain in the main chunk.

**Phase E gate (fresh):** typecheck PASS; build PASS; command-e 2/2 (96 browser runs); commerce 23/23;
command-b 8/8; g2 91/91; blockf3 17/17; blockf5 29/29; command-d 6/6; g3 6/6; contact 1/1.

## Phase F — Integration, regression, security and acceptance

**Status: VERIFIED (development) with one stale test.** Full report: [`FINAL_ACCEPTANCE.md`](./FINAL_ACCEPTANCE.md).

Full regression on loopback clones: 48 suites, **713 pass / 1 fail (phase1 UI script, stale) / 1 skip** (+ guard
8/8, personal-intelligence 1/1, image-publication 1/1 — first run ever). Live: REPLIT_OPENAI smoke 8/8, GROQ 0/8
(401). Dev runtime (API + web dev commands) verified with a live model through the web origin and a real browser.

| Defect found in F | Fix | Test |
|---|---|---|
| E's interim negotiable fix (`30ec99a`) contradicted the approved checkout rule asserted by g-final | reversed; review / OfferDetails / guard text aligned with the rule | g-final 22/22, command-b, commerce |
| «كم … أحتاج لـ…؟» routed to product search | `NEED_QUESTION` in `marketplace-intent.ts`, `smart-turn.ts` | command-a A7d |
| Grounded marketing copy labelled general knowledge | `DINAR_INTERNAL` + `MARKETING_COPY` | command-c, command-f |
| «اضغط زر نشر العرض» but button «نشر» | label | g3, contact |

New suite `command-f-journeys` (8 typed journeys: general + follow-up, inventory, honest copy + refusal,
purchase + pickup, unauthorized receipt, buyer receipt click, reload, mobile).

## Stale tests from baseline (B-5)

wave3 ×2 (public `contactPhone`, 15% fee), readiness (migration head `0027`), phase1 (`payment_methods`):
expected pre-approval behaviour. **Phase F:** wave3 and readiness updated to the approved behaviour and pass;
phase1's API half updated and passes, its UI script still targets the pre-conversation publish path
(browser POST `/api/listings`) and fails — left stale, coverage provided by g3 J-A / UI-SG-*, contact, command-f.

---

# DINAR NEXT G0–G3 (subscriptions by usage, mediated buyer–seller communication, conversation-first)

Authority: [`DINAR_NEXT_G0_G3_COMMANDS.md`](./DINAR_NEXT_G0_G3_COMMANDS.md) and
[`DINAR_NEXT_CONVERSATION_FIRST_PRODUCT_AUTHORITY.md`](./DINAR_NEXT_CONVERSATION_FIRST_PRODUCT_AUTHORITY.md).
The A–F frozen rule "no new subscription gating / Go-Pro postponed" is superseded for G only in the sense these
documents allow: tiers expand **usage allowances**, never capabilities. Final evidence:
[`G3_FINAL_ACCEPTANCE.md`](./G3_FINAL_ACCEPTANCE.md).

## G0 — Existing capability audit

**Status: DONE.** [`G0_EXISTING_CAPABILITY_AUDIT.md`](./G0_EXISTING_CAPABILITY_AUDIT.md). Found: DINAR Business
catalog + subscription snapshot (simulation-only activation), versioned `commercial_policies`, per-actor model rate
limit, negotiation authority, order-bound messages (REST only), no AI usage accounting, no listing inquiry, no
notification transport.

## G1 — Universal AI access with tiered usage allowances

**Status: VERIFIED (development).** Commit "DINAR NEXT G0+G1".

| Requirement | Implementation | Evidence |
|---|---|---|
| Plan architecture FREE / BUSINESS_GO / BUSINESS_PRO, tier separate from business ownership | Tier = AI key (`AI_USAGE_BUSINESS_GO/PRO`) on a `DINAR_BUSINESS` catalog plan, resolved from the live subscription snapshot (`business.ts` `aiPlanFor`); no new plan table | next-g1 G1-02/06/08 |
| Quotas configurable, unapproved | `commercial_policies.aiUsage` (`ai-usage-policy.ts`), v0 placeholders `approved:false`; schema enforces PRO ≥ GO ≥ FREE per resource; invalid rows fall back | G1-19 |
| Universal capability | Same paths for every tier; only allowances differ; deterministic commerce never metered | G1-05, G3-01 |
| Metered resources | TEXT_REQUEST, MARKETING_GENERATION, BUSINESS_ANALYTICS, IMAGE_UNDERSTANDING, AGENT_MULTI_STEP (configured; no multi-step agent exists, see G3 report) + per-period token budget; provider-reported tokens recorded (`model-gateway.ts` `usage`) | G1-03, G1-18 |
| Secure ledger | `ai_usage_reservations` (owner, tier, entitlement source, period, idempotency key, reserved/charged, tokens, provider/model, outcome; no prompt text) + `ai_usage_counters` (migration 0035) | G1-03 |
| Race safety | One conditional `UPDATE … WHERE reserved+consumed+n <= limit` per counter row, fixed lock order | G1-09 (12 parallel → exactly 3) |
| Retries / callbacks / failures | Idempotent key; duplicate settle no-op; failures and timeouts released for the user, counted in the global guard; abandoned reservations reconciled | G1-10/11/12 |
| Periods | Calendar month/day in an IANA time zone; renewal at next boundary | G1-13 |
| Upgrade / downgrade / expiry | Tier read at reservation; same-period counters; expiry → FREE; tier change during a live subscription refused (no invented proration) | G1-14 |
| Guest transition | Guest HMAC-keyed GUEST allowance; account starts its own FREE allowance | G1-16 |
| Global guard | Platform counter checked on every reservation | G1-17 |
| Conversation UX | `AI_USAGE` / `AI_PLANS` cards in the commerce adapter (rebuilt on reload); exhaustion message names the allowance, renewal, what still works, plan hint once per conversation; near-limit note | G1-01/04, G3-02 |
| Billing boundary | Upgrade only opens the existing Business review; simulation-only in development; otherwise "billing not connected" | G1-07, CF-16 |

## G2 — DINAR-mediated buyer–seller inquiries

**Status: VERIFIED (development).** Commit "DINAR NEXT G2".

| Requirement | Implementation | Evidence |
|---|---|---|
| Canonical thread, no second messaging app | `conversations.kind='INQUIRY'` + `messages` (same persistence as ORDER threads) + `marketplace_inquiries` header + append-only `marketplace_inquiry_events` (migration 0036) | next-g2 G2-04/14 |
| Review before send | F0 action `SEND_INQUIRY_MESSAGE` (`action-foundation.ts`): review → confirm → re-read → execute | G2-04/06/08 |
| Stock answered from the record first | Inventory fact labelled `DINAR_RECORD`; no promise beyond stock; explicit confirmation still possible | G2-02/04 |
| Asynchronous delivery | Durable insert into the recipient's DINAR conversation (or inbox); no timers; SUBMITTED / DELIVERED / READ / REPLIED separate; notifications NOT_CONFIGURED | G2-05/09/20 |
| Bidirectional, relationship-scoped | Seller writes only within an inquiry, negotiation or order; no unsolicited contact | G2-08/16, G3-03b |
| Provenance | BUYER_AUTHORED / SELLER_AUTHORED / DINAR_DRAFT_APPROVED per message; verbatim; facts and system status labelled separately | G2-07 |
| Negotiation separation | Price/offer wording refused as inquiry; best-price requests go to negotiation | G2-17, G3-05 |
| Privacy / abuse | Phone, e-mail and links refused; ACTIVE parties only; market scope; duplicate, 3-unanswered and 12/h limits; block and close | G2-10/12/13/15/16/22 |
| Prompt-injection guard | Delivered words and inquiry answers excluded from model history | G2-21 |
| Surfaces | `INQUIRY_DRAFT/STATUS/INCOMING/LIST/NOTICE`, rebuilt per party on reload; client `InquirySurface.tsx` | G2-07/19, browser |

## G3 — Combined acceptance and conversation-first capabilities

**Status: VERIFIED (development)** — see `G3_FINAL_ACCEPTANCE.md` for counts.

Added for conversation-first C: `SALES` seller insight (`ai/seller-sales.ts`, `SellerSalesInsight`): explicit
period (UTC calendar), orders / completed / cancelled / gross / simulated-paid / refunded / net-after-commission,
period comparison, top products; client card in `BusinessSummaryPanel.tsx`. Suite `next-g3-acceptance` (12 API
tests + 1 real-browser test: usage/plans at 320/390/1280 light+dark, two-party inquiry by clicks, sales card).
