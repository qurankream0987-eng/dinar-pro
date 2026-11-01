# D3-A — Native business design (INTERNAL_DINAR)

Branch `qoder/15-d3a-native-business`. Base `d94477b`. No new ecommerce platform: a business
is an operating profile over the existing marketplace, and every write goes through the
canonical listing/cart/checkout/card authorities.

## 1. The model

```
users ──owner── business_profiles (D2 identity)
                          │ 1:1, same owner and market
                          ▼
             business_operating_profiles (D3 operating metadata)
                          │
                          └── offers.business_profile_id ──> offers
                        │                                   (one listing, one business)
                        └── business_audit_events (append-only)
D2 identity and membership ──canonical authority──> capabilities, verification, eligibility
```

- `operating_mode` is `INTERNAL_DINAR` and is enforced by a database check. There is no
  `EXTERNAL_*` branch, no domain, no website URL, no API key to store.
- D3 stores no verification state. Every operating profile has a required `d2_business_id`;
  a composite foreign key guarantees the D2 identity has the same owner and market.
- There is one business→listing association: `offers.business_profile_id`, written by the
  canonical listing authority and protected by the database owner/market guard.
- D2 membership, verification and publication eligibility are read from the real D2 business
  profile service. D3 does not grant `STAFF` or reviewer access.

## 2. Identity and onboarding (cases A–D)

All conversation flows start in Arabic in the existing chat; no separate business console.

| Case | Who | What the conversation does | What is blocked |
| --- | --- | --- | --- |
| A. D2 not `VERIFIED` / no commercial registration | An owner whose canonical D2 identity is not verified (or said «ما عندي سجل تجاري») | Honest notice: the business can be prepared and drafts stored inside DINAR, but identity verification and public publishing wait for the commercial-registry review. The refusal text is not stored as a field. | `business.catalog.publish`, `business.listing.update`, `business.inventory.manage`; storefront 404. |
| B. Existing draft | Same owner repeating «عندي مطعم …» | Resumes the same draft (one row per owner per market); nothing is duplicated. | — |
| C. Verified owner (D2) | Owner whose D2 identity is `VERIFIED` + `ELIGIBLE` + `ACTIVE` | Full capability set; publish, edit, inventory, orders, analytics. | Nothing beyond D2's own policy. |
| D. Staff / suspended / stranger | Staff without a supported D2 grant, a suspended business, or a buyer | Staff and strangers receive `NONE`; suspended businesses fail closed; services return no access. | No staff access until an explicit D2 grant path exists; publish always requires verification and eligibility. |

Rules that hold in every case:

1. Capabilities are derived only from trusted rows (D2 port + D3 profile). Messages, request
   bodies, display names and model output cannot grant one.
2. `assertPublishable` is re-evaluated at transaction time, not only when the card was built.
3. A draft that fails verification stays `DRAFT`; payment or subscription state is never read.
4. The live D2 adapter reads canonical identity and membership records. Its fixture registry is
   available only when `BDINAR_D3A_D2_FIXTURES=development`; tests prove the guard rejects it otherwise.

## 3. Conversation surface (the whole product)

The adapter is `executeBusinessTurn`; it runs for authenticated text-only turns before the
general intent adapters and returns `undefined` when the utterance is not resolvable against
the actor's own rows. It never creates a second agent runtime and never calls the model.

| View | Trigger examples | Payload source |
| --- | --- | --- |
| SETUP | «عندي مطعم اسمه …», answers to the current setup question | `business_operating_profiles` draft |
| PROFILE_REVIEW | last setup answer | draft + review lines + pending action |
| PROFILE | «أكد» after review, «نشاطي» | live business + catalog summary |
| CATALOG | «منتجاتي» | `business_catalog` over linked listings |
| CATALOG_DRAFT | «جهز لي ثلاث عروض: شاورما 2.500…» | typed drafts in `ai_result_sets` |
| LISTING_REVIEW | «انشر المسودة 1», «غير سعر البرجر إلى 3.750», «أوقف منتج العصير», «خلص منتج الشاورما» | canonical listing state + diff lines |
| ORDERS | «طلبات النشاط» | `order_items` for this business's listings |
| INSIGHTS | «أداء النشاط» | the same rows as the catalog/orders cards |

Numbering, prices and units: prices are parsed with `parseListingPriceMinor` against the
market's `minorUnitScale` (JOD/KWD 3). «2.500» is 2500 minor units, never 250000.
Draft preparation never writes an offer; publishing is a separate reviewed action.

## 4. Pending actions and exactly-once execution

Every mutating command produces a review row in `ai_result_sets` (`BUSINESS_SETUP`,
`BUSINESS_ACTION`, `BUSINESS_CATALOG`, `BUSINESS_CATALOG_DRAFT`):

- owner-bound: `query.ownerId` must equal the authenticated actor;
- 10-minute TTL (`BUSINESS_ACTION_TTL_MS`);
- decision is `PENDING → EXECUTING` via one conditional `UPDATE … WHERE status = 'PENDING'`
  returning the row; a second «أكد» sees `EXECUTING`/`CONFIRMED` and is answered, not run;
- on failure the row becomes `FAILED` with the honest reason; no false success on a timeout;
- a bare «أكد»/«إلغاء» is claimed by the business only while a business card is the last
  message in that conversation, so another surface's review is never hijacked.

Idempotency:

- draft id = the canonical listing idempotency key, so relinking a published draft returns the
  same listing and relinks instead of creating a second one;
- price/status actions carry `expectedUpdatedAt`; a listing changed after the review is
  refused with the canonical 409 «تغيّر العرض منذ المعاينة» and nothing is overwritten;
- inventory: stock-out is the canonical PAUSE, so reserved/available quantities and the
  historical snapshot are preserved.

## 5. Public storefront

`GET /businesses/:id` returns only: `id, name, description, businessType,
businessTypeLabel, operatingMode, marketId, currency, verified, verificationStatus,
profile{area,fulfilment,hours,serviceAreas}, listings, listingCount`.

- `publicBusiness` requires `status = ACTIVE`; suspended or closed is 404.
- `listings` are this business's linked, published listings resolved through
  `searchMarketplaceListings` (policy, seller status, stock, restrictions). Each record keeps the
  canonical public listing shape, except that the seller identity shown on the page is the
  business (`sellerName = business.displayName`, no personal avatar); the owner's account name
  and avatar are never republished by the storefront.
- `verified` is true only when D2 reports `VERIFIED`; there is no other path.
- Never exposed: registration documents, private phone numbers, owner identity documents,
  private analytics, payment credentials, API keys, internal notes, audit rows, staff
  permissions, or the raw profile JSON.
- The web page is a DINAR route (`/business/:id`), rendered from that payload; it never
  fetches extra private data and does not render HTML from a model.

## 6. Cards (Card Envelope v1)

Eight tokens are added: `BUSINESS_SETUP`, `BUSINESS_PROFILE`, `BUSINESS_PROFILE_REVIEW`,
`BUSINESS_CATALOG`, `BUSINESS_CATALOG_DRAFT`, `BUSINESS_LISTING_REVIEW`, `BUSINESS_ORDERS`,
`BUSINESS_INSIGHTS`. The envelope is still minted by `buildCardEnvelope`:

- resource `{kind:"BUSINESS", id}`, role `SELLER`, `surfaceId = ${resultSetId}:${surfaceType}`;
- lifecycle derived from live state: `PENDING_REVIEW` while a pending action exists, `EXPIRED`
  when stale, `READY` otherwise;
- `allowedActions` filtered against `/^[A-Z][A-Z0-9_]{0,39}$/`, max 12, and used only as
  utterances — pressing one re-enters the conversation and is authorized again;
- refresh `REFETCH`; reloading a conversation rebuilds the card from rows and drops a business
  that no longer belongs to the actor or no longer exists in the market;
- no secrets, no model HTML; the client renders the server payload through typed adapters.

## 7. Failure modes and honest states

| Situation | Behavior |
| --- | --- |
| D2 not verified/eligible | Current D2 status is shown, publish is refused, drafts are kept (case A). |
| D2 says not verified / not eligible / not active | publish refused with a specific Arabic reason. |
| Business suspended | only `business.read`; storefront 404; search, listing detail and cart/checkout exclude its listings. |
| Listing changed after review | 409, action `FAILED`, no overwrite; a fresh review is required. |
| Duplicate confirmation / duplicate publish | answered once; no second write. |
| No orders yet | honest empty orders card; nothing invented. |
| Unknown charge or timeout | error state, never a success card. |

## 8. Deliberate limitations

- Restaurants have no seeded modifier schema: drafts use category «أخرى» and offer no
  modifiers, so checkout never silently ignores a selectable paid option.
- `BOTH` fulfilment is stored as `PICKUP` because the canonical listing type has no combined
  value; this is recorded, not hidden.
- The verified badge requires the D2 business reference; until D2 ships, every storefront is
  honestly unverified.
- No delivery-zone pricing, no reservations, no POS: out of D3-A scope by the mission.
