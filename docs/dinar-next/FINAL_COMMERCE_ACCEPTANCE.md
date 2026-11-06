# Real commerce acceptance — simulation only

Qualified source `9101672a7370bb8080e598344840d1fde2f88291`. Actual HTTP app, PostgreSQL and Chromium are exercised; this is not a separate demo. Canonical authority remains `routes/marketplace.ts`, `lib/{marketplace-cart,negotiations,order-terminal-accounting}.ts`, `lib/payments/*` and immutable SQL. No duplicate cart, checkout or commission ledger was introduced.

| Journey | Existing/current acceptance |
| --- | --- |
| Seller/business registration, verification, listing media/edit/publish/pause/stock and public storefront | SC01/SC07, D1/D2 API/browser, D3A API/browser, image/publication/storage suites |
| Buyer search/specifications/context, comparisons and negotiation | SC02/SC03/SC06, stock/spec, G2/model-native, 88 C1 goldens and historical numeric edge cases |
| Cart persistence, quantities, cross-tab confirmations and basket animation | V2, card concurrency/reliability/recovery/expiry/session and actual canonical receipt; replayed/failed/external actions do not animate a second success |
| Checkout and stock contention | financial state machine/SC07; persisted totals and locks; last-unit and identical-key retries; original immutable order-line checks |
| Cash/card simulation, cancellation, delivery/dual receipt, refund obligation and dispute | payment/cash/Wave07/Wave08 and order scenarios; claims are not received funds; signed REFUND_SUCCEEDED alone resolves the card refund obligation |
| Lost execution acknowledgement | D12 and D3A44/45 commit real profile/activation/price effects, then inject ACK failure: UNKNOWN, no raw failure/success claim, no replay, historical order prices unchanged |
| Privacy and authority | unchanged six-case AI authority suite; cross-owner/order/market tests; live delegation expiry/revocation and legal gates |

The persisted dinar/market-currency and versioned 10% default commission policies are unchanged. Order price/fee snapshots are consumed rather than recalculated. Existing behavior groups same-seller equal-price lines into one order, differently priced lines into distinct orders; D3A42/43 verify totals, historical snapshots and stable retry order IDs. The old divergent SQL that relaxed the header invariant is not imported.

Full partial physical returns, inspection/IP terms, service quotes/appointments, food/product options and cross-market FX remain owner decisions. They are not inferred from generic CRUD or a partial external-provider refund. Current external Connect cumulative partial-refund accounting is a separate simulation ledger and cannot become internal seller/payment success.

Fresh browser evidence: [internal product](evidence/closure-internal-product-320.png), plus the per-suite evidence in [FINAL_TEST_EVIDENCE](FINAL_TEST_EVIDENCE.md). All accounts, listings, media endpoints and providers used for acceptance are synthetic. No real payment, delivery message or provider billing occurred. Real SMS/card/storage/country/staging acceptance remains BLOCKED.
