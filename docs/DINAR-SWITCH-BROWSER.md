# DINAR database switch — browser verification report

## Scope and safety

Verification was performed in the actual Dinar Marketplace development preview at `/`:

`https://6b907220-d9b2-4ec4-a996-0ba045126594-00-3h1g63rs4mqit.pike.replit.dev/`

No workflow was restarted. No secrets, database contents, or production systems were touched. No records were seeded, no accounts were created, no frontend/application source was changed, and no market was activated or repriced. The only file change is this requested report.

## Preview UI

- **Home:** `/` rendered the Arabic DINAR AI conversation landing screen with purchase, sale, car, and service prompt cards and an empty composer.
- **Conversation history/search:** The sidebar conversation search control opened its search field. The history showed its empty state; no saved conversations were available. The separate `/search` URL did not open marketplace search and returned to `/`.
- **Discovery and listing:** `/discover` and `/listings/1` returned to `/`; no discovery, listing, or listing-detail surface was rendered.
- **My Listings:** `/seller` and `/seller/offers` returned to `/`; no seller dashboard or offers/listings surface was rendered.
- **Orders:** `/orders` redirected to `/ai?openOrders=1`. The page displayed a chat request, «طلباتي», rather than an Orders panel. Its visible response was «هذا السوق غير متاح حاليًا» with a retry action; a 409 resource failure was also logged. No order data was available to inspect.
- **Tracking:** `/tracking` returned to `/`; no tracking surface was rendered. There was no existing order ID to use, and none was fabricated.
- **Commercial surfaces, Market Pulse, DINAR Business:** `/market-pulse` and `/business` both returned to `/` with only the chat home. No commercial, Market Pulse, or DINAR Business content was present in the preview.
- **Guest/auth state:** `/api/auth/me` reported `{"user":null}`. The account control exposed an inline phone/password sign-in and verification prompt, but no credentials were entered, no verification was requested, and no registration or account creation was attempted. Protected flows therefore remain unverified as an authenticated user.

The tested non-chat URLs consistently returned to the chat home. Empty states are acceptable, but the requested marketplace, seller, orders, tracking, and business surfaces could not be evaluated because they were not exposed in this preview. The Orders attempt was additionally gated by the user-facing unavailable-market response.

## Read-only API checks

| Request | Result |
| --- | --- |
| `GET /api/healthz` | `200`, `{"status":"ok"}` |
| `GET /api/readyz` | `200`, ready; database `ready`, migrations `current` |
| `GET /api/markets` | `200`, 249 market records |
| `GET /api/listings` | `200`, empty array `[]` |
| `GET /api/auth/me` | `200`, `{"user":null}` |
| `GET /api/auth/bootstrap` | `404`, `{"error":"Not found"}` |
| `GET /api/auth/session` | `404`, `{"error":"Not found"}` |

All 249 returned markets had status `COMING_SOON`; zero were active and zero had `priceConfigured: true`. The API includes numeric `unitPriceMinor` fields, but these are not configured prices (for example, Kuwait has `unitPriceMinor: 0`, `priceConfigured: false`, `isActive: false`, status `COMING_SOON`). No activation or pricing change was made.

The two 404 auth requests were read-only probes of the bootstrap/session paths; this check did not establish that these are the application's canonical auth bootstrap contract. They are nevertheless missing at those paths. Authenticated/protected behavior could not be verified: the current account is a guest and the available API reports `user: null`.

## Viewport and runtime diagnostics

`document.documentElement.scrollWidth`, `document.body.scrollWidth`, and `clientWidth` matched the viewport at all requested widths:

| Viewport | Document/body/client width | Horizontal overflow |
| --- | ---: | --- |
| 1440 px | 1440 px | None observed |
| 390 px | 390 px | None observed |
| 320 px | 320 px | None observed |

Across observed page loads and read-only API checks:

- **HTTP 500 responses:** 0 observed.
- **Uncaught page errors (`pageerror`):** 0 observed.
- **Browser console errors:** 1 observed: a resource request returned HTTP 409 during the `/orders` → `طلباتي` unavailable-market flow. No other console errors were captured.

## Outcome / blockers

The preview and read-only health/readiness/listing/market API checks were reachable, and no horizontal overflow was measured at 1440/390/320. This was the pre-authorization state: the Orders request was rejected because no market was active, and no test accounts existed. The missing `/api/auth/bootstrap` probe was not evidence of a broken documented authentication flow.

## Follow-up: Minimal JO development acceptance (2026-10-08)

The owner subsequently authorized Jordan as the sole active development market. A guarded bootstrap enabled JO/JOD, preserved every other market, and added JO's COURIER capability. It did not change payment methods or enable a live provider.

The actual development API was then exercised through public routes, without direct user/order database seeding or auth bypass:

- Health, readiness, and the 249-market catalog passed; JO was the only active and priced market.
- Three synthetic JO accounts completed development OTP verification, registration, and password login: buyer, seller, and courier.
- A seller published one synthetic offer. Authenticated My Listings, buyer search, and offer detail all returned it.
- The buyer created one uncompleted order. Buyer/seller order lists, tracking, fulfillment view, and order-message retrieval passed. The order remained `CREATED`; the existing checkout implementation records `TEST_NO_TRANSFER`, and the seller's dues response was empty.
- Six commercial surfaces returned successfully as reads only. No purchase, subscription change, payment, completion, SMS, map, or external-delivery action was made.
- At 1440, 390, and 320 px, the screenshot-only browser showed the signed-out home without a visible layout overflow or page error. It cannot interact with the sign-in form; authenticated UI screenshots were not obtained.
- No courier profile/assignment was created, so the live F4/R5 fare proposal and mutual confirmation remain unverified. No coordinates or ETA were invented.
- Test passwords and phone verification codes were generated in the run and were not printed or saved.

## Follow-up: Authenticated viewport check (2026-10-08)

- A temporary Playwright browser used the public development phone-verification
  and registration routes to establish a synthetic JO account session. No
  password, verification code, or session cookie was saved or printed.
- The signed-in DINAR conversation home was captured at 1440, 390, and 320 px.
  All three views remained RTL with no horizontal overflow; there were no
  uncaught page errors, console errors, or HTTP 500 responses.
- Two synthetic accounts were created during this follow-up. The first remained
  associated with inactive KW; the JO account was used for the screenshots.
  Neither account was used to create a listing, order, courier profile, fare
  agreement, payment, or other financial record.
- F4/R5 remained unverified at the time because driver approval requires a
  market administrator; no admin session or authentication bypass was used.

## Follow-up: Courier application awaiting review (2026-10-08)

- A third synthetic JO account used the public development verification and
  registration routes. The signed-in conversation UI collected vehicle and
  service city, then submitted the driver profile for administrator review.
- The profile is `PENDING_VERIFICATION`, not approved or available for work:
  `3216303b-4d91-4513-b929-ab7e7185eefe`.
- The account has zero orders. No courier assignment, fare proposal/agreement,
  payment, or other financial record was created. No production or live
  payment/SMS/maps/delivery provider was used.
- The application remains pending an authorized market-administrator decision.
  Live F4/R5 fare proposal and mutual confirmation have not been attempted.

The pre-authorization observations above remain useful as historical evidence, not as the current market state. The current status and remaining acceptance gaps are summarized in `DINAR-DEVELOPMENT-SWITCH-CLOSURE.md`.
