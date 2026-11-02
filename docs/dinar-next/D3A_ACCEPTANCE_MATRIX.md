# D3-A — Acceptance matrix

Branch `replit/dinar-next-complete-development`, preserved from `qoder/15-d3a-native-business`.
Every entry below is an executable assertion, not a design intention. Only tests whose body
executed are counted; the suite prints `D3A_SUMMARY {"passed":43,"total":43,…}` from the same
objects that build this table.

## 1. How it runs

```
workflow: .github/workflows/qoder-api-suite.yml (workflow_dispatch)
runner:   ubuntu-latest, Node 24, pnpm 10, PostgreSQL 16 service
database: disposable dinar_test_local_<random> on 127.0.0.1
network:  env -i + test/isolation/net-guard.mjs  → LOCAL_SUITE … outbound=0
models:   BDINAR_BLOCK_MODEL_CALLS=1, model calls counted and asserted zero
browser:  real Chromium installed only for a suite whose name contains browser-journey
```

- API acceptance: `suite=d3a-native-business.test`,
  `flags="BDINAR_D3A_ACCEPTANCE=development BDINAR_D3A_D2_FIXTURES=development"`.
- Real-UI acceptance: `suite=d3a-browser-journey.test`, same flags.
- Regressions: the flag each existing suite already requires (see §5).

Every dispatch also runs `pnpm run typecheck`, the api-server build, the web build and
`pnpm --filter @workspace/dinar run test:surfaces` before the suite, so a green run is also a
typecheck/build/surface-protocol regression result.

## 2. API acceptance — 43 tests

| ID | Executed assertion (abridged) | Requirement |
| --- | --- | --- |
| D3A-01 | «عندي مطعم …» creates one D3 draft linked to its D2 business; D2 remains `DRAFT`, owner/market match, one `BUSINESS_DRAFT_CREATED` audit, and the card resource is `BUSINESS`. If no name is given, the placeholder is hidden and the required name cannot be skipped. | 02, 04 |
| D3A-02 | Repeating the setup sentence resumes the same row; the owner still has exactly one business. | 03-B |
| D3A-03 | Each answer stores one field and the prompt asks for exactly the next missing field (`area` → `fulfilment`); final state is `PROFILE_REVIEW`. | 03 |
| D3A-04 | «ما عندي سجل تجاري» receives the honest registration notice; the refusal text is not written into any profile field. | 03-A |
| D3A-05 | A review exists before activation; the business is still `DRAFT` and nothing is public. | 03 |
| D3A-06 | Only an explicit «أكد» activates once; D2 identity remains unchanged, with one `BUSINESS_ACTIVATED` audit and card lifecycle READY. | 03, 12 |
| D3A-07 | A repeated «أكد» is answered and does not activate twice or duplicate the audit. | 12 |
| D3A-08 | «إلغاء» leaves the business a draft; no activation audit. | 03 |
| D3A-09 | A buyer gets no authority, including a direct `resolveBusinessAccess` call (`NONE`, empty capabilities). | 11 |
| D3A-10 | An unverified owner keeps all three drafts; publishing is refused with the canonical D2 `DRAFT` status; no offer row exists. | 01, 03-A |
| D3A-11 | The fixture hook throws without `BDINAR_D3A_D2_FIXTURES=development`; the live adapter reports `CONNECTED`. | 01, 11 |
| D3A-12 | A D2-verified business runs its onboarding and activates; the verification fixture is confined to the disposable acceptance database. | 03-C |
| D3A-13 | Verified owner access comes from the canonical D2 identity and eligibility; the D3 profile alone grants nothing. | 01, 11 |
| D3A-14 | Staff receive no D3 grant; business access and direct publication are denied (404). | 11 |
| D3A-15 | «جهز لي ثلاث عروض…» yields three typed drafts with titles, `priceMinor` 2500/3250/1000, JOD, category `other`, area عمان; zero offers written. | 05, 10 |
| D3A-16 | Repeating the draft command creates new draft ids and still zero offers. | 10 |
| D3A-17 | «انشر المسودة 1» returns a review with a pending `BUSINESS_ACTION` (`PUBLISH_DRAFT`, idempotency key = draft id); nothing is written before confirmation. | 12 |
| D3A-18 | «أكد» publishes through the canonical authority: `offers` row PUBLISHED at 2500 with `business_profile_id`, `LISTING_PUBLISHED` audit, notice «نُشر». | 04, 08 |
| D3A-19 | Repeating the confirmed publish returns the same listing without duplication. | 12 |
| D3A-20 | The remaining drafts publish at 3250 and 1000; all three offers reference the same D2 business. | 04 |
| D3A-21 | The catalog card is the server summary: 3 total/3 published/0 paused, prices 1000/2500/3250, allowed actions include PAUSE and PRICE. | 04, 13 |
| D3A-22 | «غير سعر البرجر إلى 3.750» shows a review; «إلغاء» changes nothing. | 12 |
| D3A-23 | Confirming a price review updates the canonical listing and writes an audit. | 08, 12 |
| D3A-24 | A listing changed after its review is refused (409) and never overwritten. | 12 |
| D3A-25 | Pause is reviewed then confirmed; the listing leaves buyer search. | 09, 12 |
| D3A-26 | Resume is reviewed then confirmed; the listing returns to search. | 09, 12 |
| D3A-27 | Stock-out uses the canonical PAUSE, keeps the historical snapshot, and the review names نفاد المخزون. | 08, 12 |
| D3A-28 | Buyers discover the listing only through `searchMarketplaceListings`. | 09 |
| D3A-29 | Adding to cart goes through the canonical cart; no order is created. | 09 |
| D3A-30 | The orders card is an honest empty state (`لا توجد`), never an invented order. | 09, 13 |
| D3A-31 | Insights equal the same catalog/order rows the owner can inspect (`completedRevenue` computed, not claimed). | 05, 13 |
| D3A-32 | `GET /businesses/:id` returns only the whitelist fields and live listings; owner/account/contact/audit keys are absent. | 07 |
| D3A-33 | A suspended business is a storefront 404 while search, listing detail, cart and checkout all exclude its listings. | 07, 11 |
| D3A-34 | A request body cannot attach a listing to a business (the body's `businessId` is ignored); the listing is unlinked. | 04, 08 |
| D3A-35 | Another account cannot change a business listing through the business; ownership is re-checked. | 08, 11 |
| D3A-36 | Direct service calls deny a buyer and a staff member without publication grants. | 11 |
| D3A-37 | Audit rows are append-only: UPDATE, DELETE and TRUNCATE all raise `23514`. | 12 |
| D3A-38 | The D3 table has no identity column (PostgreSQL `42703`) and rejects operating modes other than `INTERNAL_DINAR`. | 01, 02, 11 |
| D3A-39 | Editing through the business keeps seller, market and creation snapshot; only allowed fields change. | 08, 12 |
| D3A-40 | All eight surfaces carry a Card Envelope with stable identity, safe resource, no secret-looking keys, and allowed actions only from the server list. | 13 |
| D3A-41 | Multiple owned businesses require an explicit choice before setup or catalog commands; an active business is never silently selected. | 03-B |
| D3A-42 | One seller owning two businesses checks out both listings in one canonical order; each business's orders card counts and sums only its own line, and the two display allocations add back to the stored order amount within one minor unit. | 09, 13 |
| D3A-43 | One seller with differently priced lines checks out into one order per price, each row satisfying `subtotal = quantity × unit_price` and `seller_amount = subtotal − fee`; the grand total is unchanged and a replayed idempotency key returns the same orders without charging again. | 09, 12 |

## 3. Real-browser acceptance — 1 test, 8 families

`d3a-browser-journey.test` (guard `BDINAR_D3A_ACCEPTANCE`) starts the real web app, the real
API and a real Chromium against the disposable database, and the owner performs the business
work by typing Arabic into the conversation:

1. Restores the saved conversation; the setup card is rebuilt from server rows.
2. Answers the remaining setup questions in the UI; the activation review appears; clicks
   «تشغيل النشاط»; the profile shows the ACTIVE state.
3. Prepares three drafts, then for each: review card → clicks «أكد» → published profile notice.
   The test asserts no publish happened without its review.
4. Reads the catalog (3 listings, three widths), the orders card (honest empty state) and the
   insights card (3 listings, completed revenue labelled).
5. Opens the DINAR-hosted public page via the card's own link: verified badge (D2 fixture),
   three live listing cards, the payload names the business, and it contains no owner account
   name, phone, owner id, audit, staff, registration or credential field.
6. A second account (buyer) opens the storefront, sees the business identity (not the owner's
   account name), clicks a listing and the composer is pre-filled with «أبي <title>» (chat-only
   DINAR has no listing page), then finds the listing through the canonical conversation search.

Asserted browser conditions: no page error, no console error, no external request, zero
horizontal overflow at 320/390/1280 in RTL with named ≥32 px buttons, zero model calls.
Database proof after the run: exactly three PUBLISHED offers at 2500/3250/1000, each associated
through `offers.business_profile_id` to the canonical D2 business, one `BUSINESS_ACTIVATED` and
three `LISTING_PUBLISHED` audits, no order, and no D3 verification state.

It found and forced the fix of a real UI defect: the insights metric carried a non-protocol
`ltr` key, so the strict composition schema dropped the whole card. All eight views now have a
composition test in `test:surfaces`.

## 4. Negative coverage (assertions, not prose)

- Model/client/body/display name cannot grant a capability: D3A-09, 13, 14, 34, 36, 40.
- No D3 self-verification: D3A-11, 12, 13, 38; any verified fixture is guarded and limited to the
  disposable acceptance database, while production access reads D2.
- Payment/subscription never consulted: no test path reads any payment or plan state; publish
  gating calls only D2 access + D3 status (D3A-10, 13, 36).
- Moderation/search not bypassed: every publish goes through `createListingForActor`
  (D3A-18), discovery through `searchMarketplaceListings` (D3A-28).
- No invented order or paid state: D3A-29, 30; no order writer exists in D3 code.
- No false success: FAILED actions carry the honest reason (D3A-18 diagnostics, 24);
  timeout/claim races answered without a write (D3A-07, 19, 24).
- Suspension cannot leak listings through a stale card, link, cart or checkout: D3A-33.
- Audit immutability enforced by the database: D3A-37.
- Order money can never blend prices or leak another business's line: D3A-42 (business-scoped
  card) and D3A-43 (one price per order under `order_money_valid`, idempotent replay).

## 5. Regressions and runs

| Suite | What it protects | Run |
| --- | --- | --- |
| `d3a-native-business.test` | the 43 D3-A tests | 2026-11-02, CI `qoder-api-suite` at `28f7a3b`: PostgreSQL 16 run 41534215112 and PostgreSQL 18 run 41534221867 — both `D3A_SUMMARY passed=43 total=43`, outbound 0, modelCalls 0 |
| `d3a-browser-journey.test` | the real-UI journey + 8 card families | 2026-11-02, isolated PostgreSQL 18: PASS, 20 checks / 11 steps / 8 surfaces / 1 search hit, outbound 0, no browser or console errors, no external requests, overflow 0 |
| `search-sql-foundation.test` | C1 PostgreSQL search (flags `BDINAR_TEST_DATABASE=development`) | 41253038310 — 6 pass / 0 fail, outbound 0 |
| `wave03-card-envelope.test` | Card Envelope v1 (flags `BDINAR_WAVE03_ACCEPTANCE=development`) | 41253321070 — 9 pass / 0 fail, outbound 0 |
| `commerce-journey.test` | canonical cart/checkout (flags `BDINAR_WAVE4_ACCEPTANCE=development`) | 41253537556 — 8 pass / 0 fail, outbound 0 |
| `pnpm --filter @workspace/dinar run test:surfaces` | composed-surface protocol, card lifecycle/envelope, checkout key | 2026-11-02: 32 pass / 0 fail |

## 6. What this does not prove

- D2's external commercial-registry review is not integrated; production visibility depends on
  a real approved D2 status, never a D3 status or test fixture.
- Restaurant modifiers/reservations/POS are out of scope; drafts use category «أخرى» and offer
  no modifier checkout could ignore.
- The public page is proven as an unauthenticated data contract and a two-account browser
  journey; it is not a formal penetration test.
- Performance is unchanged by construction (no new query path on buyer reads); D3-A adds no
  background job and no new outbound dependency. The browser journey is single-run evidence,
  not a load test.
