# D6 Universal Buyer Employee — Acceptance Matrix

## Scope and tested source

- Branch: `replit/dinar-next-complete-development`
- Baseline SHA: `3847ad79fd808775f9a6b403ad9697baa49d6080`
- Tested application/source SHA: `41f112f69b6339735727ed5d8138d32d084cc013`
- The tested source SHA applies to every D6-01–D6-25 row; no application or test source changed between these suite runs.
- Database: disposable PostgreSQL 16 bound to loopback `127.0.0.1:55432`; every integration suite below ran on a fresh database.
- Test accounts and listings were synthetic and created by the suites through DINAR's own registration and listing routes.
- The test harness blocked or replaced live model calls. No real payment, buyer/seller contact, production database, or outbound network request was used.
- Browser evidence came from the checked-out target application with legitimate synthetic-account authentication, not the workspace Preview.
- `PARTIAL` means the named portion passed but one or more listed requirements remain unverified. A passing subsystem suite is not a full D6 end-to-end pass.

## Test command aliases

Run these from `artifacts/api-server` in the checked-out repository. Each `local-suite.sh` invocation creates an isolated disposable database.

| Alias | Command |
| --- | --- |
| C1 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh block-f2-buyer.test BDINAR_BLOCKF_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true` |
| C2 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh block-f3-commerce.test BDINAR_BLOCKF_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true` |
| C3 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh next-g2-inquiry.test BDINAR_G2_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true` |
| C4 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh universal-negotiation-acceptance.test BDINAR_G2_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true` |
| C5 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh g2-smart-conversation.test BDINAR_G2_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true` |
| C6 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh model-native-routing.test BDINAR_G2_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true` |
| C7 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh bounded-multistep.test BDINAR_G2_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true` |
| C8 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh w02-ultra-cards.test BDINAR_TEST_DATABASE=development` |
| C9 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh search-sql-foundation.test BDINAR_TEST_DATABASE=development BDINAR_PROMOTIONS_ENABLED=true` |
| C10 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 DINAR_CHROMIUM=/repl/tools/bin/chromium test/isolation/local-suite.sh w02-ultra-browser.test BDINAR_TEST_DATABASE=development BDINAR_PROMOTIONS_ENABLED=true` |
| C11 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 DINAR_CHROMIUM=/repl/tools/bin/chromium test/isolation/local-suite.sh w02u3-card-recovery-browser-journey.test BDINAR_TEST_DATABASE=development BDINAR_W02U3_BROWSER=development` |
| C12 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh w02u3-card-reliability.test BDINAR_W02U3_TEST_DATABASE=development` |
| C13 | `DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh promotion-intent.test` |

All listed suites passed when run with their required development gates and returned `outbound=0`. C1–C12 used fresh databases; the C13 test is a local intent unit test and makes no database or network calls.

## Scenario results

| ID | Actual implementation and authoritative API | Test data and database assertion | Command and evidence | Result and remaining limitation |
| --- | --- | --- | --- | --- |
| D6-01 | `routes/ai.ts` conversation create/turn routes; `executeAiConversationTurn`; authenticated actor and conversation ownership | Synthetic buyers; foreign actor receives no private conversation or buyer state, and cannot execute another buyer's card action | C3, C5, C8, C12; G2 authorization cases and W02U-05/CR-12 | **PASS** — ordinary buyer authority is separate from D4/D5 seller authority. |
| D6-02 | `model-turn.ts`, `smart-turn.ts`, and the existing model gateway; model output is validated and routed back through server authorities | Arabic scripted/injected requests; assertions cover validated surfaces, action counts, and zero unauthorized effects | C5 and C6; G2 smart summary: 83/83, 57 model turns, zero outbound calls | **PARTIAL** — contract and fallback behavior passed, but no live provider call was authorized; live Arabic quality is unverified. |
| D6-03 | `tool-registry.ts: searchListings`; `searchMarketplaceListings`; buyer result-set persistence | Published synthetic marketplace records; returned resource IDs match actual listings and current market | C1, C8, C9, C10; F2 and search foundation SF-01–SF-06 | **PASS** — real DINAR inventory is used; no external marketplace or fabricated records. |
| D6-04 | Canonical search plus `executeBuyerTurn`; service pricing remains governed by the listing's recorded price mode | Published service listing with `QUOTE_REQUIRED`; buyer resolves the real listing and requests a seller quote without an invented amount | C4; U-06 and U-22, 36/36 negotiation cases passed | **PASS** — covers the tested quote-required service path; not every service category or remote-service filter. |
| D6-05 | Canonical marketplace search and persisted result identities | Real synthetic car listings and a toy-vehicle listing appear in the cross-category browser result set; comparison reads current listing records | C10; captured W02 browser trace and W02U-01 | **PARTIAL** — vehicle records were discovered and compared, but a vehicle-specific natural-language filter journey was not separately asserted. |
| D6-06 | Buyer search refinement in `buyer-turn.ts`; canonical search applies supplied filters | F2 buyer used a price ceiling and server-returned prices were checked against published records | C1; F2 contextual refinement and ranking cases | **PARTIAL** — budget filtering was exercised; a separate user-specified geographic constraint assertion was not run. |
| D6-07 | `executeBuyerTurn` clarification surface; no action is authorized until requirements are sufficient | Two plausible drafts; the assistant returned `CLARIFY`; the test checked that no target or write was guessed | C5; G2-14 | **PASS** — the specific ambiguity case passed without a database mutation. |
| D6-08 | Stored result-set identities and contextual selection in `buyer-turn.ts` | Buyer searches actual listings, then selects first/second by ordinal; selected IDs are compared to stored results | C1, C4, C5, C10; F2 and U-31/U-32 | **PASS** — selection is tied to persisted results rather than a client-supplied ID. |
| D6-09 | Result resolution rejects missing, expired, or ambiguous targets instead of substituting another listing | Synthetic multi-result search; invalid/out-of-range references and two plausible drafts | C1, C5, C8; F2 invalid-reference cases and G2-14 | **PASS** — tested invalid references do not create a different target. |
| D6-10 | Typed comparison in `buyer-turn.ts` and conversation response schemas | Actual listings from unrelated categories; recorded price and seller facts are compared | C8, C10; W02U-01/W02U-02 and six-width browser trace | **PASS** — no unsupported preference ranking was introduced. |
| D6-11 | Comparison renderer preserves missing and inapplicable values | Cross-category synthetic listings with deliberately absent attributes | C8, C10; assertions cover `لا ينطبق`, `لم يذكر البائع`, and computed labels | **PASS** — absent seller facts remain absent in the card. |
| D6-12 | `inquiry-turn.ts` through canonical G2 messaging and inquiry services | Synthetic buyer, seller, listing, and thread; message is persisted to the correct participants after review | C3; G2-01/04/05/07 | **PASS** — seller replies remain attributed to the seller and use the existing conversation thread. |
| D6-13 | G2 consent, contact, participant, market, and suspension checks | Wrong seller, own listing, cross-market, suspended participant, and contact/spam inputs | C3 and C5; G2-12/13/15/16 | **PASS** — refused cases have no unauthorized message or contact release. |
| D6-14 | Persisted G2 messages and idempotency keys; existing thread rehydration | Duplicate confirmation, duplicate message, and reload of the buyer conversation | C3; G2-07 and G2-10 database/message-count assertions | **PASS** — retries do not create a second persisted message. |
| D6-15 | `negotiation-turn.ts` and canonical negotiation engine; review precedes mutation | Synthetic negotiable listing; proposal is first a review, then explicit buyer confirmation creates the offer | C4; U-22 and U-27 | **PASS** — database state remains unchanged before confirmation. |
| D6-16 | Canonical negotiation lifecycle, version checks, and idempotency | Expired offer, changed price, conflicting decisions, and repeated request/confirmation | C4; U-12/U-13/U-16/U-19/U-29, 36/36 cases | **PASS** — stale and replayed actions do not execute twice or bind above the current price. |
| D6-17 | `tool-registry.ts:addToCart` and `marketplace-cart.ts`; server checks selected result identity and market | Synthetic buyer adds an actual search result; cart is read back from the server | C1, C2; F3 B2/B4/B5 and F3-01 | **PASS** — cart is the canonical server cart, not a model-authored receipt. |
| D6-18 | Canonical cart and checkout routes validate quantity, listing semantics, stock, and price | Quantity updates, single-quantity listings, stock reductions, and stale price reviews | C2; B7/F3-02/F3-03/F3-04/F3-05 | **PASS** — invalid quantities or stale reviews do not create an order. |
| D6-19 | Cart and card reads are scoped to authenticated buyer and market | Two synthetic accounts, a stranger, and a market switch; database-backed cart quantity is checked for both actors | C12; CR-12 and cart ownership assertions | **PASS** — another buyer's account and another market cannot read or drive the pending card/cart action. |
| D6-20 | `executePurchaseTurn` and canonical checkout/order services; explicit review and confirmation | Synthetic listing and buyer; order count remains unchanged before confirmation; final order values are read from PostgreSQL | C2; F3-01–F3-06 and F3-12 | **PASS** — duplicate/concurrent confirmation creates one canonical order. |
| D6-21 | Payment and purchase actions remain gated by supported policy; test payment is simulation-only | Payment intent counts and payment mode are asserted; external network guard records no calls | C2 and C5; F3-09/F3-10 and G2-36B | **PASS** — no real payment or transfer occurred; unsupported payment claims are rejected. |
| D6-22 | `order-context.ts` and existing order/fulfillment authorities | Buyer asks about own offer/order status; the returned resource is checked against the buyer's stored order, while foreign access is refused | C4; U-31 and owner-scoped order assertions | **PASS** — only recorded order state is returned; this is not a delivery-provider integration test. |
| D6-23 | Persisted conversation messages, result sets, pending actions, and action receipts; recovery uses server identities | Search/selection reload and interrupted turn scenarios; one server user row and one resulting cart action are asserted after retry | C1, C6, C7, C11; W02U3 recovery trace and model-native/bounded suites | **PARTIAL** — persistence and recovery passed in subsystem journeys; a single complete browse→inquiry→negotiation→checkout conversation was not run. |
| D6-24 | Actor/market checks, G2 message validation, negotiation idempotency, and cart/order concurrency authorities | Harmless injection, foreign actors, duplicate actions, concurrent decisions, stale inventory/price; summaries assert zero injection successes and zero unauthorized effects | C2–C7, C12; G2 summary counters, U-12/U-16, F3-04/F3-06, CR-12 | **PARTIAL** — buyer-side checks passed. D4/D5 delegation revocation regressions remain with the parallel auditor and are not claimed here. |
| D6-25 | Existing DINAR browser conversation, typed comparison card, persisted chat recovery | Synthetic authenticated buyer; real browser search, rank, compare, advice question, responsive card checks, then an interrupted confirmation/retry journey with backend row counts | C10 and C11; W02 JSON trace shows six viewport widths, no console/page errors, no external requests; W02U3 trace shows one user row after retry | **PARTIAL** — real signed-in traces and reload/retry persistence passed. No screenshots were saved, and the browser suite does not yet cover the whole D6 purchase journey in one run. |

## Browser trace evidence

- W02 comparison trace: actual signed-in synthetic buyer searched three published listings, sorted them, compared the first/second/third, asked which was cheapest, and asked how to choose between offers. The promotion-routing assertion passed. The card remained readable at 320, 375, 390, 428, 768, and 1280 px, with zero horizontal overflow, page errors, console errors, or external requests.
- W02U3 recovery trace: one deliberately unanswered delivered turn was verified without resending; one absent turn was retried with the original `clientMessageId`. The server retained one buyer-message row and the confirmation produced one cart action. The browser reported zero page errors, console errors, or external requests.
- These are signed-in browser traces from the target checkout's test harness. They are not evidence of live model quality or a complete search-to-checkout browser journey.

## Build, security, database, and performance evidence

- `pnpm run typecheck`: passed.
- `pnpm --filter @workspace/api-server run build`: passed.
- `pnpm --filter @workspace/dinar run build`: passed. Vite emitted existing dependency annotation and large-chunk warnings; build completed.
- Dependency audit: one high Zod finding (`zod` 3.25.76; suggested fix requires a major upgrade) and one moderate `qs` finding (6.16.0; fix available in 6.16.1). No dependency change was made because the Zod remediation is a potentially breaking major upgrade and is outside this D6 change.
- SAST and HoundDog scans: no findings reported.
- PostgreSQL 16 loopback disposable suites passed; PostgreSQL 18 was unavailable in this environment.
- Search SF-02 asserts a bounded candidate set rather than scanning the whole market. No end-user latency benchmark or p95 measurement was run.

## Overall status

**D6 remains PARTIAL, not ready for full acceptance.** The existing authenticated buyer runtime and canonical inquiry, negotiation, cart, checkout, and order services passed the listed scoped tests. Remaining evidence includes live Arabic model quality under explicit provider approval, focused vehicle/location discovery, a single full signed-in journey through inquiry/negotiation/cart/checkout, and the independent D4/D5 revocation audit.
