# 15 — Security acceptance completion evidence

**Result:** `PASS — 12/12 passed, 0 failed, 0 skipped`

**Tested application-source SHA:** `5a8cfd7693b0b717102c1fdef309e0b19f3df733`

The test ran against the isolated PR branch at the SHA above. The evidence and review notes in this
document are documentation-only additions; no production application source, authorization rule,
financial invariant, or security assertion was changed to obtain the passing result.

## Isolation and fixture prerequisites

The diagnostic and passing run used separate fresh databases on a local PostgreSQL 18.6 container
whose port was exposed only on `127.0.0.1`; both databases were dropped after their run. The passing
suite was launched through the project's disposable-database harness. No run connected to Railway,
shared development data, or an external provider.

The pristine database had no marketplace records. The exact seed prerequisite was:

| Market ID | Country | Currency | Unit-price minor units | Scale | Required status |
|---|---|---|---:|---:|---|
| `KW` | Kuwait | KWD | 1000 | 3 | `ACTIVE`, `is_active=true` |
| `JO` | Jordan | JOD | 1000 | 3 | `ACTIVE`, `is_active=true` |
| `SA` | Saudi Arabia | SAR | 100 | 2 | `ACTIVE`, `is_active=true` |

Each market also needs a matching current `market_price_versions` row with that currency, unit price,
scale, and a valid `effective_from`. The market capability columns use their defined deterministic
defaults: fulfilment `PICKUP`, `DELIVERY`, `DIGITAL`, and `SERVICE`; payment `CASH_DIRECT`.

No users, offers, orders, disputes, payments, or ledger rows were pre-seeded. Once the three market
and price fixtures existed, the suite created its seven actors and test listings through the
ordinary registration and listing API flows. The acceptance fixture module did not create financial
history.

## Pristine-database diagnostic

The initial empty-database run reproduced the previously observed `3 passed / 9 failed / 0 skipped`.
Its first test failed when switching to Saudi Arabia: the API returned `409` with the active-market
price-unavailable response instead of `200`. Because actor setup stopped before it could create its
listings, the remaining eight failures were downstream missing-listing/order fixture failures.

| Failed test | Missing prerequisite exposed by the failure |
|---|---|
| Seven actors receive real sessions and resources span two markets | Active Saudi and Jordan markets with current price versions; the first attempted market switch returned 409. |
| Anonymous users are denied protected order and checkout routes | The setup test did not reach creation of the seller offer/order. |
| Ownership, draft privacy, and market boundaries are enforced by the API | Setup-created offers were absent; listing update returned 404. |
| Listing photos reject invalid uploads, enforce ownership, and are public only when published | The listing required by the photo-ownership checks was absent; API returned 404. |
| Price, commission, quantity, state, and replay attacks use authoritative state | The seller offer/order required by the security assertions was absent; order validation returned 400. |
| Every admin mutation denies anonymous and ordinary users | The expected disputed order could not be created. |
| Cross-origin requests cannot mutate listings, archive, checkout, orders, disputes, or markets | The expected order could not be created. |
| Stored HTML payloads stay inert across buyer, seller, chat, and admin surfaces | The expected order fixture was absent. |
| Only an admin resolves disputes; replay and forged accounting cannot duplicate dues | The expected disputed order could not be created. |

These are fixture/setup failures from an intentionally unseeded baseline, not findings that authorization
or financial behavior was weakened. The three tests independent of marketplace state passed:

- Anonymous phone verification is equivalent and account creation requires one-time proof.
- A successful login remains counted until the 900-second window expires.
- Auth limits share PostgreSQL authority across two API processes.

## Seeded full-suite result

The approved isolated harness seeded the three active markets and their baseline prices in a separate
fresh database, then ran the complete security suite.

A separate fixture audit confirmed the resulting rows exactly: three active markets, one open-ended
baseline price version per market, the expected cash and fulfilment capability arrays, and zero
pre-seeded users, offers, or orders.

| Result | Count |
|---|---:|
| Passed | 12 |
| Failed | 0 |
| Skipped | 0 |

All twelve tests passed, including session and two-market setup, anonymous route denial, ownership
and market boundaries, listing-photo ownership, price/commission/quantity/replay controls, admin
authorization, cross-origin write protection, stored-HTML safety, dispute/accounting controls, phone
proof enforcement, login rate limits, and shared rate limiting across API processes.

## Application-source review map for Claude

The following five application/deployment source files changed in this candidate. This list separates
runtime behavior changes from the test and generated-contract updates.

| File | Change and integration-review boundary |
|---|---|
| `Dockerfile` | Sets the container working directory to `/app/artifacts/api-server` so the readiness route resolves the checked-in migration journal. It does not run migrations during startup. |
| `artifacts/api-server/src/index.ts` | Adds SIGTERM/SIGINT shutdown: stop reservation/search maintenance, close the HTTP server, then close the PostgreSQL pool with a bounded timeout. |
| `artifacts/api-server/src/lib/market-capability-registry.ts` | Clarifies that phone verification is independently reported as `not_configured`; this is documentation in the server capability matrix, not a new phone provider or authorization bypass. |
| `artifacts/api-server/src/routes/health.ts` | Core readiness gates on database, migration state, and required configuration. Phone verification remains separately reported; phone-proof-dependent routes still fail closed without an adapter. |
| `lib/db/src/index.ts` | Handles idle PostgreSQL pool errors by logging only the driver error code, avoiding unhandled pool errors terminating the process or exposing connection details. |

Supporting test updates are in `artifacts/api-server/test/fresh-environment.test.ts` and
`artifacts/api-server/test/readiness.test.ts`. Generated API types/OpenAPI files reflect the readiness
response contract; no financial, authorization, or commerce invariants were changed.

## Scope of this verification

This security-suite result is local acceptance evidence only. It does not establish Railway
connectivity or authorize deployment. No Railway database, setting, network, paid resource, backup,
or PITR configuration was touched. The existing Draft PR remains unmerged and deployment remains
unauthorized.
