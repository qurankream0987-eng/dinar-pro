# D3-A — Security and permissions

Scope: the business operating profile, its catalog, its storefront and its conversation cards.
Nothing here weakens an existing authentication, financial or migration guard.

## 1. Capabilities (nine)

```
business.read            business.profile.manage   business.catalog.read
business.catalog.draft   business.catalog.publish  business.listing.update
business.inventory.manage business.orders.read     business.analytics.read
```

Derivation (`resolveBusinessAccess`):

| Actor class | Capabilities |
| --- | --- |
| `NONE` (buyer, stranger, mismatched D2/D3) | none |
| `APPLICANT` (D3 owner, D2 not verified or not eligible) | read, profile.manage, catalog.read/draft, orders.read, analytics.read |
| `STAFF` (no D3 grant path) | none |
| `VERIFIED_OWNER` | approved owner capabilities only while D2 is verified/eligible and D3 is `ACTIVE` |
| Suspended business | owner: `business.read` only; staff: `business.catalog.read` only if granted; closed: owner read only |

`PUBLICATION_CAPABILITIES` = publish, listing.update, inventory.manage. They require
`verificationStatus = VERIFIED`, `publicationEligibility = ELIGIBLE`, `businessStatus = ACTIVE`
and D3 `status = ACTIVE`. `assertPublishable(access)` throws a specific Arabic 409 otherwise.

An actor is only an owner when `business.ownerUserId === actorId` **and** the D2 identity
agrees on market/owner; any disagreement collapses to `NONE` (fail closed).

What cannot grant a capability: the model, the request body, the business display name, a
staff-supplied string, a payment receipt, a subscription, or a D3 row claiming verification.
`businessCapabilities()` drops unknown D2 scopes instead of guessing them.

## 2. Defense in depth

1. **Route/actor**: every HTTP route resolves the market and the authenticated actor first.
2. **Conversation adapter**: only resolves businesses owned by the actor in the current
   market; ambiguous ownership is offered as a choice, never guessed; another account's
   business id is not accepted.
3. **Service re-check**: `publishBusinessDraft`, `updateBusinessListing`,
   `changeBusinessListingStatus`, `archiveBusinessListing` re-resolve access inside their
   transaction, lock the business row (`FOR SHARE`), re-check capabilities and
   `assertPublishable` before delegating to the canonical listing functions.
4. **Listing authority**: `createListingForActor` re-checks business capability and
   publishability inside the same transaction, and writes `offers.business_profile_id`; a
   mismatch aborts the whole publish.
5. **Database**: D3 has no verification column. Its required `d2_business_id` has a composite
   same-owner/same-market FK to D2; `offers.business_profile_id` is the only listing association.
   Mode/status/type checks and append-only audit triggers remain enforced in SQL.
6. **Card envelope**: server-built only; allowed actions are filtered by regex and length;
   actions are utterances re-authorized on the next turn; rehydration re-checks ownership.

## 3. Public exposure

`GET /businesses/:id` is the only public business endpoint. It returns a fixed whitelist
(see the design doc). The following are **never** serialized: commercial-registration or
identity documents, owner identity data, private phone numbers, payment credentials, API
secrets, private analytics, audit rows, staff permissions, internal compliance notes and the
raw `profile` JSON. A suspended/closed/non-ACTIVE business is a 404.

The storefront's listing cards are canonical public listing records, but the seller identity
shown there is the business: `sellerName` is replaced with the business display name and the
owner's personal avatar is never republished. A visitor of the page therefore never learns the
owner's account name; the marketplace listing pages keep their own public contract unchanged.

Suspension is enforced in four places so a stale card or a saved cart cannot leak a listing:

- search eligibility (`inactiveBusinessListingIds` in the shared rule **and** the C1 SQL
  candidate query);
- listing detail (404 for non-owners);
- cart add/replace and single-line update (409);
- checkout (409) — the transaction re-reads the business status.

## 4. Financial and payment boundaries

- No payment, subscription or commission path is added. `checkoutForActor` remains the only
  order producer, with its own idempotency and price authority.
- Subscription/payment state is never consulted for business capability or verification.
- Prices are never taken from the model or the browser; drafts and edits use
  `parseListingPriceMinor`/`updateOwnedListing` with market minor units.
- Historical price snapshots and ownership columns of existing marketplace rows are not
  rewritten; D3-A only updates the fields the canonical update authority allows.

## 5. Verification (explicitly not faked)

- Production: the adapter reads canonical D2 business and membership records; verification-
  dependent capabilities require D2 `VERIFIED` and publication `ELIGIBLE`.
- Tests: a fixture registry exists only if `BDINAR_D3A_D2_FIXTURES=development`. The registry
  throws otherwise (test D3A-11). Fixtures live in the test process only; no endpoint can
  register one.
- D3 has no identity status to set (test D3A-38 receives PostgreSQL `42703`). Verification remains
  in D2's `business_profiles`; D3 cannot change it through the operating-profile schema.

## 6. Moderation, search and isolation

- No business write bypasses policy acceptance (`assertPoliciesAccepted`), contact-text
  refusal, image validation or moderation checks: D3-A calls the same canonical functions.
- No separate search: buyers only see business listings through `searchMarketplaceListings`
  (C1 PostgreSQL), so restrictions, stock, seller status and suspension apply unchanged.
- No order is invented: the orders card and insights read real `orders`/`order_items` rows.
- No new outbound calls: the suite runs under the isolation net-guard; model calls are
  blocked (`BDINAR_BLOCK_MODEL_CALLS=1`) and counted as zero.

## 7. Residual risks / notes for Claude

- `access.publishable` is business-level; staff publication also requires D2 to grant
  `business.catalog.publish` through `permissions`. Both are checked; a D2 integration must
  keep permissions per member.
- `lockedBusiness` uses `FOR SHARE` on the profile; listing writes additionally lock the
  listing row through the canonical authorities. If D2 introduces concurrent membership
  changes, the port should expose a version to include in the access decision.
- The storefront requires the existing D2 identity linked by `d2_business_id`; it returns 404
  unless D2 verification/publication and D3 operating status are all currently eligible.
