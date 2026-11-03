# WAVE 05 — Production GO / NO-GO

**Verdict: NO-GO for integrated commerce release. GO, with named conditions, for the infrastructure, security and assistant-authority portions.**

The blocking issue is not a flaky test. It is a schema-level disagreement about what an order's money means when a cart carries more than one unit price. Wave 05 measured it, reproduced it, and refuses to paper over it.

## Decision table

| Area | Verdict | Why |
| --- | --- | --- |
| Infrastructure (health, readiness, migrations, 404/401/error envelope) | **GO** | `/api/healthz` and `/api/readyz` returned 200 with database and migration readiness; `nosniff`; JSON errors without internals — run `41664520596` |
| Graceful shutdown | **GO** | `SIGTERM` drained in 26 ms, listener closed, pool ended, idempotent — run `41664280013` |
| Database profile and plans | **GO on the runner, conditional in deployment** | Plans and p50/p95 are measured at 20,000 offers; capacity on Railway is unknown until the owner sets pool and `max_connections` and re-runs the profile — `WAVE05_D13_PERFORMANCE.md` |
| Synthetic load baseline | **GO as a baseline, not as a capacity guarantee** | Reported from the CI runner only; no Railway or production load was generated — `WAVE05_D13_PERFORMANCE.md` |
| Buyer journey, single price | **GO** | register → search → order → accept → deliver → confirm, with idempotency and authorization — run `41664520596` |
| Seller journey and dues | **GO** | publish 45.750, accept, deliver, exactly one 9.150 due, dues private — run `41664520596` |
| Seller employee | **GO** | `d5-seller-employee-acceptance.test` — run `41664683083` |
| Assistant grounding and authority | **GO for behaviour, NOT_MEASURED for language quality** | Deterministic inventory read matched the DB; scripted advice touched no cart/order; a model claim was withheld at HTTP and storage — run `41664520596`; Arabic quality and dialect await the blind human rating — `WAVE05_D14_INTELLIGENCE.md` |
| Security boundaries | **GO** | Conversation isolation 404, anonymous turn 401, no payment row, no internals; isolation regression — run `41666288262` |
| **Mixed-price cart / order money model** | **NO-GO** | Strict CHECK rejects seller grouping (`mm11`); the relaxed Wave 02 CHECK accepts a header that contradicts the subtotal (`mm20`); the strict rule cannot be re-imposed (`mm20StrictReimposition`). Present on the newest candidate `qoder/wave06b-d16-d17-closure` — `WAVE05_SECURITY_AND_FINANCIAL_CONSISTENCY.md` |
| **Refunds and disputes** | **NO-GO** | They inherit the same header arithmetic; no policy was invented |
| Browser layout and journeys (Chromium) | **GO with SHA pinning** | Command E (320–1600 px, light/dark, reduced motion) and Command F (320/390/768 authenticated) passed at `c73f7f9`; re-dispatch on the exact release commit before shipping |
| WebKit / Firefox | **NO-GO (unverified)** | Unavailable in this runner; no result claimed |
| Assistive technology | **NO-GO (unverified)** | `AT_MANUAL_BLOCKED`; a manual NVDA/JAWS/VoiceOver/TalkBack pass is required |
| Race conditions in commerce state | **NO-GO** | The money model must be fixed first; concurrent confirmation and refund races cannot be judged on an undefined invariant |

## Conditions that would move commerce to GO

1. Choose Option A or Option B in `WAVE05_INTEGRATION_REQUIREMENTS.md` §1, implement it in SQL, and make every consumer read the same source of truth.
2. Reconcile `0051`/`0052`/`0053` in the migration journal (Wave 06b's numbering is the candidate; verify a fresh database applies cleanly).
3. Add the database rule that header totals equal the sum of line totals (Option B) or change checkout to one order per unit price (Option A).
4. Re-run the money gate, the D15 integrated suite, the isolation suite and the load suite on the new SHA, then re-run refund/dispute coverage — which does not exist yet and must be written.
5. Re-dispatch the browser suites on the release commit; run the manual AT checklist offline.
6. Set `DINAR_DB_POOL_MAX` and the database `max_connections` together on the deployment and re-run the profile suite against it.

## What this verdict is not

- It is not a claim that the API is production-ready. No production database, Railway environment or paid provider was touched.
- It is not a claim about Arabic dialect quality. Scripted turns prove orchestration, not language.
- It is not a licence to merge. The branch `qoder/wave05-d13-d15-closure` is an isolated mission branch; integration is the owner's decision.

## Integration-candidate reconciliation — 2026-11-03

The decision table above records the Wave 05 source branch's earlier candidate, before the Wave 01/02 checkout work was unified. The current integration candidate selects **Option A**: retain the strict per-order header check and create separate orders for each seller/unit-price group. Wave 02's relaxed `0051_order_multi_item_money.sql` remains excluded.

Candidate evidence was rerun against fresh loopback databases on PostgreSQL 16.10; all database acceptance used `test/isolation/local-suite.sh`, and each run reported zero outbound attempts:

- `wave05-d15-money-model.test`: **11/11**. Mixed-price checkout created two orders with strict header arithmetic and matching line subtotals. A disposable relaxed-check probe accepted a deliberately inconsistent inserted header; reapplying the strict check then failed as expected. The probe did not update or weaken the immutable order-snapshot trigger.
- `wave05-d15-acceptance.test`: **5/5**. The actual 9.000/120.000 mixed-price seller cart created separate strict orders. Refunds and disputes remain `BLOCKED`.
- `wave05-d13-db-profile.test`: **9/9** at 20,000 synthetic listings. The 20-message/120-receipt history read used 10 statements versus 80 for per-message reads; doubling history added four statements. The five-worker test refreshed 5,000 documents with zero duplicate writes.
- `wave05-d13-load-baseline.test`: **7/7** at 5,000 listings for pool maxima 10 and 24. Both runs had zero server errors and timeouts; the 24-way search cell measured 61.9 and 62.4 requests/second respectively. These are local-runner observations, not deployment capacity guarantees.
- `wave05-d13-shutdown.test`: **1/1**; SIGTERM closed the listener and pool once, with a 28 ms measured drain.
- `wave05-d14-evaluation.test`: scripted scoring **38/38**. No live model was called; semantic language quality and dialect authenticity remain unmeasured.
- `d4-d5-isolation-security.test`: **8/8**. `wave03-d7-cart-browser-journey.test`: Chromium **1/1**, with no external requests beyond the loopback test stub.
- `command-e-ui.test`: **2/2**. Chromium captured 96 states across 320–1600 px in light and dark; overflow, console errors, unnamed controls, undersized tap targets, hidden composers and journey failures were all empty. The browser made no external requests.
- `command-f-journeys.test`: **3/3**, with **9 authenticated journeys**, no failures or console errors, and zero outbound requests.

These results clear the source branch's mixed-price checkout blocker for this candidate; they do **not** clear integrated-commerce release. The per-price grouping is an application behavior, not a verified cross-table database constraint tying every order header to `SUM(order_items)`. That aggregate rule still requires migration review and PostgreSQL 16/18 testing. Refund/dispute accounting and policy, WebKit/Firefox, and manual assistive-technology checks are not claimed here. Overall commerce release remains **NO-GO**; no production, Railway, payment, SMS, or live AI service was touched.
