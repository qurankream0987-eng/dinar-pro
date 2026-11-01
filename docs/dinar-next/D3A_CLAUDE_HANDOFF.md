# D3-A → D2 / Claude handoff

> **Integration update (2026-11-02):** Preserved on
> `replit/dinar-next-complete-development`; each D3 operating profile links to the canonical D2
> business, and `offers.business_profile_id` is the only business-listing association. D3 stores
> no verification status and has no `STAFF` grant path. Native acceptance is 41/41; independent
> Claude Code review remains PENDING until after push.
> The sections below preserve the original contribution handoff and are historical; see
> `D3A_EXISTING_SOURCE_MAP.md` and `D3A_ACCEPTANCE_MATRIX.md` for the current design and evidence.

Branch `qoder/15-d3a-native-business`, base `d94477b` (Claude D1/D2 baseline). Never merged to
`main`, never deployed. This document is the integration contract: what D3-A reused, what it
added, what D2 must publish before a business can be verified, and how to undo it.

Companion documents:

- `D3A_EXISTING_SOURCE_MAP.md` — what existed before D3-A and where.
- `D3A_NATIVE_BUSINESS_DESIGN.md` — the model, conversation surface, cards, failure modes.
- `D3A_SECURITY_AND_PERMISSIONS.md` — capabilities, defense in depth, public exposure.
- `D3A_ACCEPTANCE_MATRIX.md` — the 41 executable tests, negatives, runs.

## 1. Branch, commits, scope

| | |
| --- | --- |
| Base | `d94477b` |
| Branch | `qoder/15-d3a-native-business` |
| Commits | `b93573f` native business (INTERNAL_DINAR), `dba214e` source map, `95b43c3` typecheck, `32cc832` market handoff + suspended catalogs, `90e2326` jsonb predicates, `46daf68` draft body/refusal, `364ce22` stock-out review, `9a17407` real-UI journey, `c99f37c` phone prefix, `ea4b1b2` insights metric, `9b45fd9` public contract assertions, `363d9be` storefront seller identity, then docs only |
| Files | 41 changed, +5343 / −27 at `363d9be` |

Nothing in `docs/dinar-next/CLAUDE_*`, no D1 migration, no D2 schema file, and no financial
authority was edited. The shared files that were touched are listed in §2 with the exact change.

## 2. Reused authorities (the contract D3-A depends on)

| Authority | Location | How D3-A uses it | Change D3-A made |
| --- | --- | --- | --- |
| `createListingForActor` | `artifacts/api-server/src/routes/marketplace.ts:339` | every publish of a draft | new optional `trusted?: { businessId, tx }`; server-supplied id only; capability + `assertPublishable` rechecked inside; link row written in the same transaction |
| `updateOwnedListing` | `artifacts/api-server/src/lib/listing-management.ts:207` | price edits from «غير سعر …» | unchanged |
| `changeOwnedListingStatus` | `…/listing-management.ts:339` | pause/resume/stock-out | unchanged |
| `parseListingPriceMinor` | `…/listing-management.ts:56` | «2.500» → 2500 minor units (JOD) | unchanged |
| `searchMarketplaceListings` | `…/marketplace-listings.ts:205` | buyer discovery, storefront listings, catalog read-backs | new eligibility rule `inactiveBusinessListingIds` (below); everything else untouched |
| `inactiveBusinessListingIds` | `…/marketplace-listings.ts:107` | suspend/close must not leak catalogs | new helper; called by search, listing detail, cart validation |
| `buildCardEnvelope` | `…/ai/card-envelope.ts:220` | all eight business cards | new `business` branch: resource kind `BUSINESS`, role `SELLER`, lifecycle from `pendingActionId`/`stale`, server `allowedActions` filtered to `/^[A-Z][A-Z0-9_]{0,39}$/` (max 12) |
| `freshBlocksForConversation` | `…/routes/ai.ts:407` | reload/rehydrate cards from rows | calls `refreshBusinessPayload` for `BUSINESS_*` blocks |
| canonical cart/checkout | `…/lib/marketplace-cart.ts` | buying a business listing | `inactiveBusinessListingIds` added to the three cart validation paths; price/stock/state rules unchanged |
| conversation runtime | `…/ai/conversation-runtime.ts`, `lib/api-zod/src/conversation-runtime.ts` | the eight surface tokens | tokens appended to `CONVERSATION_SURFACE_FAMILIES.business`; no new runtime |

What D3-A did **not** create: a second product/offer/order table, a second search, a second cart,
a second conversation loop, a second agent runtime, or a second card envelope builder.

## 3. New server modules

| Module | Purpose |
| --- | --- |
| `lib/business-access.ts:65` | `resolveBusinessAccess` — capabilities from D2 port + D3 profile + status; fail-closed on disagreement; `PENDING_D2` → applicant set |
| `lib/business-access.ts:176` | `requireBusinessCapability` — 403; used by every mutating service |
| `lib/business-access.ts:190` | `assertPublishable` — 409 «الهوية التجارية قيد الاعتماد…»; re-evaluated at transaction time |
| `lib/business-capabilities.ts` | the nine capabilities and `PUBLICATION_CAPABILITIES`; unknown D2 scopes are dropped |
| `lib/d2-business-identity.ts:135` | the D2 port: production `PENDING_D2`, fixture registry only under `BDINAR_D3A_D2_FIXTURES=development` |
| `lib/business-catalog.ts` | `businessCatalogSummary`, `publishBusinessDraft` (line 172), `businessOrders` (358), `businessAnalytics` (386), `publicBusiness` (422), audit writer |
| `ai/business-turn.ts:1514` | `executeBusinessTurn` — resolves the utterance against the actor's own rows, before the general adapters, never calls the model |
| `ai/business-turn.ts:1637` | `refreshBusinessPayload` — rebuilds/drops business cards on reload |
| `routes/businesses.ts` | `GET /businesses/:id` — the public storefront payload |
| `routes/ai.ts` | adapter call site + rehydration hook |

Frontend: `features/ai/BusinessSurface.tsx`, `surface/business-adapters.ts`,
`business-types.ts` (typed payload validation), `pages/PublicBusiness.tsx`,
`App.tsx` route `/business/:id`, `ConversationContent.tsx` block dispatch.

Migration: `lib/db/drizzle/0042_d3a_native_business.sql` (see §6).

## 4. The D2 contract D3-A expects

The port is typed; these are the values production must provide. Until then
`d2BusinessIdentity.forBusiness()` / `.forActor()` return `null` and access is the applicant set.

```ts
type D2BusinessIdentity = {
  businessId: string;
  ownerUserId: string;
  marketId: string;
  businessType: "RESTAURANT" | "SHOP" | "SERVICE_PROVIDER" | "OTHER";
  verificationStatus: "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED" | "SUSPENDED";
  publicationEligibility: "ELIGIBLE" | "BLOCKED";
  membershipPermissions: BusinessCapability[];   // the nine D3 capability strings
  businessStatus: "DRAFT" | "ACTIVE" | "SUSPENDED" | "CLOSED";
  policyVersion: string;
  memberships?: { userId: string; role: "OWNER" | "STAFF"; permissions: BusinessCapability[] }[];
};
```

`publishable = verificationStatus === "VERIFIED" && publicationEligibility === "ELIGIBLE" &&
d2.businessStatus === "ACTIVE" && d3.status === "ACTIVE"`.

### 4.1 What D2 must publish

1. The identity lookup by `(businessId, marketId)` and the actor membership lookup — the two
   functions behind `d2BusinessIdentity.forBusiness` / `.forActor`.
2. A stable `businessId` that D3 stores in `business_operating_profiles.d2_business_id`
   (unique per market). D3 never invents one; the fixture helper is test-only.
3. Real verification from the commercial-registry review. D3 never writes a verification result;
   `identity_status` is database-constrained to `PENDING_D2` until a D2-backed value exists.
4. Membership permissions expressed in the nine D3 capability strings; unknown strings are
   dropped, never guessed.
5. Status transitions: `SUSPENDED` → only `business.read` and a 404 storefront; `CLOSED` → owner
   read only; `ACTIVE` → full set.

### 4.2 Deliberate D2 gaps (recorded, not hidden)

- Payment or subscription state is never read by any D3 path. If D2 later wants commercial
  gating, it belongs in D2's eligibility answer, not in D3.
- There is no `EXTERNAL_*` operating mode, no website/domain/API-key field anywhere; the DB check
  refuses anything except `INTERNAL_DINAR`. If the product ever needs it, it is a new migration,
  not a toggle.
- The verified badge on the storefront is true only when the D2 port answers `VERIFIED`; with the
  production port every storefront is honestly unverified.

## 5. Conversation and card contracts

Eight surface tokens (added to `CONVERSATION_SURFACE_FAMILIES.business`):
`BUSINESS_SETUP`, `BUSINESS_PROFILE_REVIEW`, `BUSINESS_PROFILE`, `BUSINESS_CATALOG`,
`BUSINESS_CATALOG_DRAFT`, `BUSINESS_LISTING_REVIEW`, `BUSINESS_ORDERS`, `BUSINESS_INSIGHTS`.

Every mutating utterance creates a review row in `ai_result_sets`:
kind `BUSINESS_SETUP` | `BUSINESS_ACTION` | `BUSINESS_CATALOG` | `BUSINESS_CATALOG_DRAFT`,
owner-bound, 10-minute TTL (`BUSINESS_ACTION_TTL_MS`), claimed with one conditional
`UPDATE … WHERE status='PENDING'`; a second «أكد» is answered, never executed. Failure is stored
as `FAILED` with the honest reason. Draft ids are the canonical listing idempotency keys, so a
re-publish relinks the same offer instead of creating a second one. Price/status actions carry
`expectedUpdatedAt`; a stale review is refused with 409 «تغيّر العرض منذ المعاينة».

`refreshBusinessPayload` (`ai/business-turn.ts:1637`):

- `SETUP` is dropped once the business is no longer `DRAFT`; `PROFILE_REVIEW` is dropped when its
  pending review is no longer `PENDING`;
- `LISTING_REVIEW` survives with the notice «تمت معالجة هذا الإجراء.» once resolved;
- `CATALOG`, `CATALOG_DRAFT`, `ORDERS`, `INSIGHTS` are rebuilt from live rows;
- a business that no longer belongs to the actor or the market is dropped, never re-served.

## 6. Migration impact

`0042_d3a_native_business.sql` is additive: three new tables, no `ALTER` of an existing table,
no rewrite of any listing, order, price snapshot or ownership row.

| Table | Key rules |
| --- | --- |
| `business_operating_profiles` | unique `(d2_business_id, market_id)` where not null; indexes `(owner_user_id, market_id)`, `(market_id, status)`; FKs to `users`, `markets`; checks: mode `INTERNAL_DINAR` only, four business types, four statuses, `identity_status = 'PENDING_D2'` |
| `business_listing_links` | `listing_id` is the primary key (one listing, one business); FKs to `offers` (cascade) and profiles (cascade); indexes `(business_id, created_at)`, `(market_id)` |
| `business_audit_events` | FKs to profile, user; append-only trigger `business_audit_events_append_only_row` / `_truncate` raising SQLSTATE `23514` |

Journal: `lib/db/drizzle/meta/_journal.json` tag `0042_d3a_native_business`;
`lib/db/drizzle/release-manifest.json` includes the tag; `lib/db/src/clone-migration-guard.ts`
carries the file's sha256 `e4e0c0c1a66269887c308db707b892ea7889e566fb2d1e8539ba4a79616a70bb`.
Schema definitions live in `lib/db/src/schema/index.ts`.

## 7. Tests and evidence

All execution is in GitHub Actions (`qoder-api-suite.yml`): PostgreSQL 16, Node 24, pnpm 10,
`env -i` isolation, outbound-blocking net guard. Every dispatch also runs `pnpm run typecheck`,
the api-server build, the web build and `pnpm --filter @workspace/dinar run test:surfaces` before
the suite.

| Suite | Evidence |
| --- | --- |
| `d3a-native-business.test` | 2026-11-02 isolated PostgreSQL 18 run: `D3A_SUMMARY {"passed":41,"total":41,…,"modelCalls":0}`, `outbound=0`; earlier CI run 41252858333 at `363d9be` passed 40/40 |
| `d3a-browser-journey.test` | 2026-11-02 isolated PostgreSQL 18 run: `D3A_UI_SUMMARY {"result":"PASS","surfaces":8,"checks":20,"steps":11,"searchHits":1}`, `outbound=0`, zero page/console errors, zero external requests, overflow 0; earlier CI run 41252571040 at `363d9be` also passed |
| `test:surfaces` | 2026-11-02: 32/32, incl. all eight business views through `ComposedSurfaceSchema` |
| `search-sql-foundation.test` | C1 PostgreSQL search regression (`BDINAR_TEST_DATABASE=development`): run 41253038310, 6 pass / 0 fail, outbound 0 |
| `wave03-card-envelope.test` | Card Envelope v1 regression (`BDINAR_WAVE03_ACCEPTANCE=development`): run 41253321070, 9 pass / 0 fail, outbound 0 |
| `commerce-journey.test` | canonical cart/checkout regression (`BDINAR_WAVE4_ACCEPTANCE=development`): run 41253537556, 8 pass / 0 fail, outbound 0 |

Reproduction commands (workflow_dispatch inputs):

```
suite = d3a-native-business.test
flags = BDINAR_D3A_ACCEPTANCE=development BDINAR_D3A_D2_FIXTURES=development

suite = d3a-browser-journey.test
flags = BDINAR_D3A_ACCEPTANCE=development BDINAR_D3A_D2_FIXTURES=development
```

The API suite's browser test spawns the real Vite dev server, registers two phone-verified
accounts, opens the storefront as both, and prints `D3A_UI_SUMMARY`; the test then re-reads the
database to prove: business `ACTIVE` with `identity_status = PENDING_D2`, three published offers
at 2500/3250/1000 minor units, three links, one `BUSINESS_ACTIVATED` and three `LISTING_PUBLISHED`
audit events, zero orders, zero model calls.

## 8. Performance and dependencies

- Buyer reads: one extra indexed lookup (`business_listing_links` joined to profiles) per search
  plus `NOT EXISTS` in the SQL candidate query; unlinked listings are unaffected.
- Storefront: business row + links + canonical search capped at 48 + in-process D2 port.
- Conversation: the adapter runs only for authenticated text-only turns and returns `undefined`
  when the utterance is not a business command, so other adapters see the same message.
- No background job, no new outbound call, no new provider. The model gateway is not called by
  any business path (proved by `modelCalls: 0`).
- The browser journey is single-run evidence, not a load test.

## 9. Known gaps and deliberate limitations

- D2 is not published: verification exists only through the guarded fixture port.
- Restaurant modifiers, reservations, delivery-zone pricing and POS are out of scope; drafts use
  category «أخرى» and offer no modifier that checkout could ignore.
- `BOTH` fulfilment is stored as `PICKUP` because the canonical listing type has no combined
  value; the stored profile keeps the owner's words, the listing uses the canonical value.
- Storefront listings reuse the canonical public listing record, but present the business as the
  seller (`sellerName = business.displayName`, no personal avatar): a buyer never sees the
  owner's account name on the business page.
- Analytics count only this business's linked listings on completed orders; no other seller's
  rows are read or shown.
- The business page is not a formal penetration test result.

## 10. Overlap with D1/D2

| Area | Overlap | Status |
| --- | --- | --- |
| Financial closure / D1 | none | D3-A reads no payment, plan, fee or payout row |
| D2 identity | the port is the only bridge | D2 files unchanged; D3 expects the contract in §4 |
| Canonical marketplace | `createListingForActor`, search, cart, listing detail | additive parameters/rules only; existing callers behave identically (regressions above) |
| Card envelope | one new `business` branch | all existing branches untouched; existing envelope/lifecycle tests still run |
| Conversation runtime | one new surface family + one adapter | no change to routing for non-business utterances |

## 11. Rollback

1. Revert the branch (never merge it to `main`). No production schema has been touched.
2. If 0042 has already been applied in an environment, the rollback is
   `DROP TABLE business_audit_events, business_listing_links, business_operating_profiles;`
   after exporting the audit rows; `DROP FUNCTION business_audit_events_append_only();`.
   The tables are additive and reference nothing outside themselves.
3. Listings published by a business remain ordinary canonical listings owned by the seller. Their
   `offers.data.businessId` field is inert without the link table; optionally clear it with
   `UPDATE offers SET data = data - 'businessId' WHERE data ? 'businessId';` (historical prices,
   ownership and order snapshots are never rewritten by D3-A and must not be rewritten here).
4. Remove the `/business/:id` route and the eight tokens from the surface families only after the
   tables are gone; the client treats an unknown `business` block as absent.

## 12. Integration status

- D3-A product code and migrations remain unchanged from base
  `d60fd749317d0df8357224e6e7f7bdaf8a2ec33f`. The runner-only integration was tested at
  `907f43cb8a49a9aa0949eb0f66b8c9174360d36e`; the final PostgreSQL 18.6 native and real-UI
  results, migration status, N7 assessment, and Actions limitation are in
  [the W12.2 integration report](./D3A_QODER_W12_2_INTEGRATION_REPORT.md). Earlier D3-A API
  acceptance evidence remains as recorded above; it is not represented as a new 41-test rerun.
- D2 remains the product blocker to production business verification. Until §4 ships, every
  production business is an applicant (drafts and profile only, publish 409) and every storefront
  is honestly unverified.
- Independent Claude Code review: PENDING on tested implementation commit
  `907f43cb8a49a9aa0949eb0f66b8c9174360d36e`; no review findings or approval are claimed here.
- Nothing is merged, nothing is deployed, and no production data was read or written.
