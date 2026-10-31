# D3-A — Existing source map (Phase 00)

Branch: `qoder/15-d3a-native-business`
Base: `d94477b` (C1 PostgreSQL search report on top of `92227d1`)
Status: drafted after a read of the current tree; updated only with verified paths/lines.

D3-A adds one thing: a DINAR-native business. It does not add a second marketplace.
The map below is the inventory of what already existed and what D3-A calls, so that every
write still passes through the authority that owns that rule.

## 1. Authorities D3-A reuses (never duplicates)

| Authority | Location | What D3-A relies on |
| --- | --- | --- |
| Publish a listing | `createListingForActor(actor, rawBody, idempotencyKey?, trusted?)` — `artifacts/api-server/src/routes/marketplace.ts:339` | Validation, contact-text refusal, policy acceptance, image validation, fingerprint idempotency, DRAFT→PUBLISHED completion. D3-A only adds an optional server-supplied `trusted.businessId`. |
| Update a published listing | `updateOwnedListing` — `artifacts/api-server/src/lib/listing-management.ts:207` | Ownership, immutable snapshots, stale `expectedUpdatedAt` → 409, price parsing and representation. |
| Status transitions | `changeOwnedListingStatus` — `listing-management.ts:339` | PAUSE / RESUME / SOLD semantics; inventory release. STOCK_OUT maps to canonical PAUSE (D3-A adds no new status). |
| Archive | `archiveOwnedListing` — `listing-management.ts:414` | Terminal delete-by-owner semantics. |
| Price parsing | `parseListingPriceMinor` — `listing-management.ts:56` | Market minor units (JOD/KWD 3): «٢٥٠٠» → 2500000. |
| Listing body assembly | `buildListingUpdateBody` — `listing-management.ts:475` | One shape for chat edits and REST edits. |
| Buyer search | `searchMarketplaceListings(market, options)` — `artifacts/api-server/src/lib/marketplace-listings.ts:202` | Eligibility (seller ACTIVE, restricted categories, policy, stock), C1 SQL candidates, keyset paging, pricing projection. D3-A adds one eligibility predicate: a listing whose business is not ACTIVE is not a candidate (`inactiveBusinessListingIds`, same file:104; SQL prefilter at the candidate query). |
| Listing rows by id | `offerRowsByIds` — `marketplace-listings.ts:62` | Bounded reads for cart/checkout; storefront listings go through search, not a new query. |
| Cart read/write | `getMarketplaceCart` / `replaceMarketplaceCart` — `artifacts/api-server/src/lib/marketplace-cart.ts:121` / `:178` | The only cart. Buyers of business listings use it unchanged. |
| Checkout | `checkoutForActor` — `artifacts/api-server/src/routes/marketplace.ts` (POST `/checkout`) | The only path to a paid/ordered state. D3-A never writes an order or a paid flag. |
| Card Envelope v1 | `buildCardEnvelope` — `artifacts/api-server/src/ai/card-envelope.ts` | Eight new surface tokens are declarative; identity, role, lifecycle, allowed actions and refresh policy are still minted by the server. |
| Surface rehydration | `freshBlocksForConversation` — `artifacts/api-server/src/routes/ai.ts:455` | Business cards are rebuilt from live rows (`refreshBusinessPayload`), dropped when the row is gone or not the actor's. |
| Pending owner actions | `ai_result_sets` + `ai_ui_blocks` (BUSINESS_SETUP / BUSINESS_ACTION / BUSINESS_CATALOG / BUSINESS_CATALOG_DRAFT) | Owner-bound, 10-minute TTL (`BUSINESS_ACTION_TTL_MS`, `business-turn.ts:49`), conditional PENDING→EXECUTING claim, FAILED on error. |
| Conversation routing | `executeRuntime` — `artifacts/api-server/src/ai/conversation-runtime.ts:645` | Business text adapter runs after product-control and before the remaining intent adapters; it returns `undefined` when the utterance is not resolvable against this actor's rows. |
| Account / market | `marketFor`, `assertMarketActive` — `lib/markets.ts`; phone-challenge registration in `routes/auth.ts` | No new identity system; JO market fixtures as before. |
| Payments | SIMULATION_ONLY; `checkoutForActor` | D3-A adds no payment path and no subscription check. |
| Public pages | SPA routes — `artifacts/dinar/src/App.tsx:82,136,158` | `/business/:id` is a DINAR-hosted page, not an external website. |

## 2. New D3-A modules (thin, each calls an authority above)

| Module | Purpose | Depends on |
| --- | --- | --- |
| `artifacts/api-server/src/lib/business-capabilities.ts` | The nine capability names, Arabic labels, publication subset. | nothing |
| `artifacts/api-server/src/lib/d2-business-identity.ts` | Typed `PENDING_D2` port with a development-only fixture registry; production always reports `PENDING_D2`. | `BDINAR_D3A_D2_FIXTURES` |
| `artifacts/api-server/src/lib/business-access.ts` | `resolveBusinessAccess` (APPLICANT / VERIFIED_OWNER / STAFF / NONE, CLOSED/SUSPENDED fail-closed) and `requireBusinessCapability` / `assertPublishable` / `assertVerifiedOwner` / `assertStaffCapability`. | D2 port, operating profile |
| `artifacts/api-server/src/lib/business-catalog.ts` | Catalog summaries, draft publish, price/status/archive wrappers, orders, analytics, `publicBusiness`. | `createListingForActor`, `updateOwnedListing`, `changeOwnedListingStatus`, `archiveOwnedListing`, `searchMarketplaceListings` |
| `artifacts/api-server/src/ai/business-turn.ts` | Arabic intent adapter: setup, profile review, catalog, drafts, price review, pause/resume/stock, orders, insights, refresh. | business-access, business-catalog, pending actions |
| `artifacts/api-server/src/routes/businesses.ts` | `GET /businesses/:id` public storefront projection. | `publicBusiness`, `businessPublicListingIds`, `searchMarketplaceListings`, D2 port |
| `artifacts/dinar/src/pages/PublicBusiness.tsx` | Renders the whitelist the server sent; no client-side expansion. | `GET /businesses/:id` |
| `artifacts/dinar/src/features/ai/BusinessSurface.tsx`, `business-types.ts`, `surface/business-adapters.ts` | Renders the eight card families from the server payload only. | `ConversationContent.tsx` |

## 3. Data model (migration `0042_d3a_native_business.sql`)

- `business_operating_profiles` — one row per business: owner user, market, display name,
  type, description, published profile JSON, `operating_mode` (DB check `INTERNAL_DINAR`),
  `identity_status` (DB check `PENDING_D2` until D2 ships), nullable `d2_business_id`,
  `status` (DRAFT/ACTIVE/SUSPENDED/CLOSED), `version` for optimistic updates,
  `pending_action_id`, timestamps.
- `business_listing_links` — `listingId` PK/FK, `businessId` FK, `marketId`; written only in
  the same transaction that publishes the listing.
- `business_audit_events` — append-only (`BEFORE UPDATE/DELETE/TRUNCATE` trigger raising
  `ERRCODE 23514`), business/market/actor/action/listing/price/version columns.

No existing table was altered; no historical price snapshot or ownership column is touched.
Journal entry idx 42; release manifest and clone guard carry sha256
`e4e0c0c1a66269887c308db707b892ea7889e566fb2d1e8539ba4a79616a70bb`.

## 4. Contracts touched (additive only)

- `GET /businesses/:id` (new, public).
- `POST /ai/conversations/:id/turns` — `SURFACE` payload gains an optional `business`
  object; `resultSetId` is propagated. Existing payload fields unchanged.
- `createListingForActor` — optional 4th argument; the REST route does not pass it and the
  request body's `businessId` is ignored by `CreateListingBody`.
- Surface enum gains exactly eight tokens: `BUSINESS_SETUP`, `BUSINESS_PROFILE`,
  `BUSINESS_PROFILE_REVIEW`, `BUSINESS_CATALOG`, `BUSINESS_CATALOG_DRAFT`,
  `BUSINESS_LISTING_REVIEW`, `BUSINESS_ORDERS`, `BUSINESS_INSIGHTS`
  (`lib/api-spec/openapi.yaml`, `lib/api-zod/src/generated/api.ts`,
  `lib/api-zod/src/conversation-runtime.ts`, `lib/api-client-react/src/generated/api.schemas.ts`).

## 5. What D2 must provide when it lands

1. `forActor(actorId, marketId)` returning membership role (`OWNER`/`STAFF`), permissions,
   and the identity (`businessId`, `marketId`, `ownerUserId`, `businessStatus`,
   `verificationStatus`, `publicationEligibility`, `policyVersion`).
2. `forBusiness(d2BusinessId, marketId)` for the storefront verified badge.
3. A reviewed mapping between `business_operating_profiles.d2_business_id` and the D2
   business id; until then the DB check keeps every D3 row `PENDING_D2`.
4. Suspension propagation: D2 `businessStatus !== ACTIVE` or `verificationStatus ===
   SUSPENDED` is already fail-closed in `resolveBusinessAccess`.

D3-A does not attempt verification, does not accept documents, and cannot flip
`identity_status`. A D3 draft is never VERIFIED; payment/subscription state is never read.

## 6. Deliberate non-goals (unchanged behavior)

- No separate storefront backend, domain, POS, or API; the storefront is a DINAR page.
- No new order, payment, inventory or moderation tables.
- Restaurant modifiers: category seed has no restaurant schema, so drafts fall back to
  «أخرى» and no modifier is offered (nothing selectable that checkout ignores).
- `BOTH` fulfilment without typed support is stored as `PICKUP` (documented limitation).
- STOCK_OUT is PAUSE; there is no distinct stock-out state in the canonical listing.
