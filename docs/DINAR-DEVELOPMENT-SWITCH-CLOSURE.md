# DINAR — DEVELOPMENT DATABASE SWITCH CLOSURE

## RUNTIME
- DEVELOPMENT DB SWITCHED: YES.
- ACTIVE DB: RAILWAY_CANONICAL_DEV.
- /healthz: 200 (mounted at /api/healthz).
- /readyz: 200 (mounted at /api/readyz).
- Readiness response: database=ready, migrations=current.
- MIGRATIONS: READY, 27 entries through 0026_burly_power_pack.
- STARTUP ERRORS: 0 on the final restart.
- HOUSEKEEPING ERRORS: 0 during the final restart/startup observation (the full
  60-second recurring housekeeping interval had not elapsed at report time).
- Initial restart: three housekeeping connection timeouts, resolved by a
  development-only remote connection acquisition budget of 15 seconds.
  Production and loopback retain their original two-second setting.
- No silent fallback exists; failed Railway connections do not select legacy.

## DEVELOPMENT ACCEPTANCE (2026-10-08)
- JO is the only active, priced market: JOD, development-only 1.000 JOD
  reference price; JO retains CASH_DIRECT, PICKUP, DELIVERY, and now COURIER.
- All 248 other market rows retained their pre-bootstrap values.
- The canonical API verified all 249 markets, JO pricing, health, and readiness.
- Standard development phone-verification, account-registration, and password-login
  flows passed for one synthetic buyer, seller, and courier account. Credentials
  and verification codes were generated in-process and not logged or retained.
- One synthetic listing was published and found through My Listings, marketplace
  search, and listing details.
- One buyer checkout and both order lists passed. The order remains CREATED and
  uncompleted; checkout uses the existing TEST_NO_TRANSFER path. Seller dues
  were empty. Tracking and delivery-view requests returned 200.
- Order messages loaded, but no buyer/seller text exchange or AI conversation turn
  was attempted.
- Six read-only commercial endpoints passed: balance, products, entitlements,
  Market Pulse, business plans, and subscription status.
- No live payment, SMS, maps, route planning, or external delivery provider was
  used. No GPS/ETA was fabricated, and no order-completion action was taken.

## AUTHENTICATED BROWSER
- A temporary Playwright browser used the public development verification and
  registration routes to create a synthetic JO account and render the signed-in
  conversation home.
- At 1440, 390, and 320 px, the signed-in page remained RTL with no horizontal
  overflow. The browser observed 0 uncaught page errors, console errors, or HTTP
  500 responses.
- Two synthetic accounts were added during the viewport follow-up. The first
  remained associated with inactive KW; the second was used for the JO screenshots.
- A third synthetic JO account completed the public verification and registration
  flow, then submitted a driver profile through the signed-in conversation UI.
  Profile `3216303b-4d91-4513-b929-ab7e7185eefe` is
  `PENDING_VERIFICATION`, awaiting market-administrator review.
- The courier account has zero orders. No assignment, fare proposal/agreement,
  payment, or other financial record was created in this follow-up.
- Driver approval requires a market administrator. No administrator session or
  approval was available; no auth bypass was used. The live F4/R5 courier-fare
  proposal and two-party confirmation therefore remain unverified.
- No unexpected 409 or HTTP 500 occurred in the earlier authenticated API
  acceptance requests. The unavailable-market 409 was from the pre-bootstrap check.

The earlier browser report below/at `DINAR-SWITCH-BROWSER.md` records the
pre-authorization guest state. Its then-current claim that every market was
unavailable is historical and no longer describes development.

## REGRESSION
These are post-change regressions on fresh disposable latest-schema databases,
NOT substitutes for the live courier journey still unverified above.

- BLOCK E: PASS, 42/42 scenarios, zero model/external calls.
- F4/R5: PASS, 23/23 scenarios.
- ORDERS/TRACKING: PASS, API 63/63 and focused tracking smoke.
- MONETIZATION V3: PASS, focused endpoint/conversation/expiry/ledger smoke.
- SEARCH: PASS, Block E and API suites.
- CONVERSATION: PASS, API and focused persisted commercial surface tests.

## SAFETY
- LEGACY DB MODIFIED: NO.
- LEGACY DB DELETED: NO.
- LEGACY DATA IMPORTED: 0.
- UNKNOWN DATA MIGRATED: 0.
- PRODUCTION ACCESSED: NO.
- Managed DATABASE_URL: unchanged.
- Frontend source/Codex work: unchanged.
- Verified legacy pg_dump archives remain present and untouched; the latest
  archive is readable by pg_restore --list. No dump restoration was performed.
- Existing legacy users, offers, conversations, messages, and
  seller_market_eligibility remain UNKNOWN / PENDING PROVENANCE REVIEW.
- Six new synthetic development accounts now exist: three from the API
  acceptance and three from the browser follow-ups. The API acceptance also
  created one listing and one uncompleted test order. The browser follow-ups
  created one pending driver profile and no listings or orders. No legacy data
  was imported, the order was not completed, and no seller dues were created.

## QUALITY
- API TYPECHECK: PASS.
- WEB TYPECHECK: PASS.
- API BUILD: PASS.
- WEB BUILD: PASS (bundle-size warning only).
- GIT DIFF CHECK: PASS.

## FINAL
- DEVELOPMENT RUNTIME: API acceptance and authenticated browser rendering PASS;
  driver onboarding/submission is verified and awaiting admin review; full
  application acceptance remains incomplete because the live F4/R5 fare
  agreement was not verified.
- DATABASE SWITCH: connection, migrations, single-market configuration, and
  authenticated API acceptance are verified. Full UI/courier closure remains
  open.
- READY FOR LEGACY DATA SALVAGE: NO — provenance review and explicit authorization
  are still required; no automatic transfer is permitted.

STOP. The development API stays connected to the canonical database.
See DINAR-SWITCH-SAFETY.md and DINAR-SWITCH-BROWSER.md for detailed evidence.
