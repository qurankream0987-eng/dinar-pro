# DINAR NEXT — financial integrity evidence

**Date:** 2026-11-04
**Scope:** Candidate branch only; disposable PostgreSQL test data; simulation-only payments.

## Integrity rules preserved

- Migration 0056 adds an order-to-line integrity version without rewriting historical order amounts. Existing orders remain version 0; new orders must use version 1.
- Version-1 order headers must reconcile exactly to their `order_items` quantity and subtotal. The committed financial snapshot and order lines are protected from later mutation.
- Mixed-price carts remain split into separate orders by seller and unit price. The legacy relaxed 0051 migration was not selected.
- Payment, dispute, journal, cash, and refund acceptance uses the test adapter/simulation boundary. No real transfer, settlement, payment provider, or live refund was exercised.

## Acceptance evidence

- The financial-state-machine, payment-order-state, W07 journal, W08 cash/refunds, and cash-lock-order suites passed in disposable JO data.
- Wave 4 passed 10/10 on a fresh JO/JOD disposable database. The isolated rerun retained the strict reconciliation expectation; no assertion was loosened to accommodate earlier test records.
- The populated 0055→0056 rehearsal passed within the 12/12 release-migration suite. Its synthetic historical order, items, payment, payment event, dispute, ledger entries, and audit row matched their pre-migration snapshot after interruption, retry, and completion.
- The migration retry was idempotent, the historical order remained version 0, and markets remained inactive during the migration rehearsal.

## Limits

These results establish internal data-integrity behavior only. They do not establish provider settlement, legal authority to process payments, customer-funds handling, production migration safety for unknown histories, or launch readiness. See `09_DOCKER_LOCAL_ACCEPTANCE.md` for the remaining containerized persistence gap.
