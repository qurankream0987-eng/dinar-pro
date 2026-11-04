# DINAR NEXT — Migration reconciliation

**Canonical baseline:** `11d7fbe3326897924468ee4c6d5467972a92b973`  
**Initial candidate:** same SHA  
**Review date:** 2026-11-04
**Status:** source identities reconciled; fresh and populated PostgreSQL 18 migration tests passed; G33 database-connected CI acceptance passed at frozen implementation SHA `f4981d8ddaf11284641ef6b43edb3603e1cf9110`; local Docker replay remains blocked.

## Source facts

The canonical journal ends at `0050_normal_nico_minoru` (idx 50; `when=1793606821612`). The canonical release manifest SHA-256 for that SQL is `50cc9e7ca9ec351d26df4ca0e8e0fc5d7c19d1c9e724b0735b91d0908bb121ac`. No database was queried.

The Wave 02 and Wave 06/06b branches carry byte-identical `0051_order_multi_item_money.sql`:

`e99dce44bbb6cc81d0686c8193859e102b3a22076c4812af28ebdfde04adad24`

That migration removes `subtotal_minor = quantity * unit_price_minor` from `orders`. Wave 05's recorded probes found that seller-grouping different prices makes the header price-times-quantity inconsistent with the subtotal; refund/dispute consumers were consequently marked blocked. The Wave 01 branch later adds grouping by seller and unit price, which keeps every individual order header arithmetically meaningful.

The Replit D16 source uses migrations `0051–0053`. The Wave 06b branch renumbers the same SQL blobs to `0052–0054` after the relaxed-money migration. The independently calculated hashes match:

| Replit D16 source | Wave 06b path | SHA-256 |
|---|---|---|
| `0051_d16_legal_readiness_incidents.sql` | `0052_d16_legal_readiness_incidents.sql` | `d0e8f19788d18b531a82dcb929bd747d1fb978f54cd25d029e7fd388ddac12f2` |
| `0052_d16_readiness_constraints.sql` | `0053_d16_readiness_constraints.sql` | `e059800b4aa2f6f88171cc705cd0d955bebb8cc1b2d84274c71b9fbc34c265ff` |
| `0053_d16_country_legal_intake.sql` | `0054_d16_country_legal_intake.sql` | `1c74587d36ec1d2f255321023b1441bb0b2113fcde1960b045432a09d2b9ede3` |

Wave 06b's `0055_conversation_memory.sql` hash is `7112f4a23aba466fabb9dcf43ac4da6207b649c597f53cf70c168c0976e1d700`. Its SQL does not depend on the Wave 02 money migration.

The older `qoder/17-unified-integration-candidate` has a separate sequence: C1/D1/D2 occupy `0041–0042`, W07–W10 occupy `0043–0046`. The canonical baseline already has W07–W10 at `0041–0044` and C1/D1/D2 at `0045–0046`; importing that branch's journal or migration names wholesale would collide with established identities.

## Candidate design decision

Use normalized `order_items` as the source for order quantity and subtotal; require the stored order header to equal the sum of its lines at transaction commit. Keep the existing strict per-order arithmetic check and group mixed-price checkout lines by seller and unit price. This allows a mixed-price cart to produce multiple correct orders without weakening the established order constraint or changing the historical `0051` identity.

Do **not** include the Wave 02/Wave 06b relaxed `0051_order_multi_item_money.sql` in the selected chain. Preserve it unchanged on its source branches and classify it as superseded-but-preserved in the final manifest. Add a new migration for the line-to-header aggregate invariant after the selected D16/D17 migrations, with a fail-closed preflight for historical rows. The selected D16 migrations retain their byte-identical SQL; D17 memory SQL may receive a new sequence number because it is not applied to the canonical baseline.

This design uses line items as the accounting authority and keeps the header as a checked aggregate. It does not introduce payment-provider behavior or a new fee/refund policy. Any existing environment that has applied the unselected `0051_order_multi_item_money` remains an unknown migration-history case; no remote database will be accessed, and no rollout may be described as safe until an owner-authorized history check is completed.

## Reconciliation and test gates

Before acceptance:

1. Keep every already-applied canonical migration byte-identical.
2. Update the journal, release manifest, Drizzle schema/snapshot, migration guard, and readiness/TLS tests together for every selected new migration.
3. Verify all current and new migration hashes directly from Git blobs.
4. Test fresh PostgreSQL 16 and 18 databases, an upgrade fixture populated with orders/businesses/audit records, interruption halfway through migration, and a retry.
5. Assert the new invariant rejects missing lines, wrong quantities, wrong subtotals, line edits that desynchronize the order, and order inserts without items; assert valid multi-price carts create correct separate orders.
6. Do not use `drizzle-kit push`, Railway, production, or any non-loopback database.

The final candidate validation snapshot below supplements this design and source audit. It does not turn unrun migration or financial scenarios into acceptance evidence.

## Final candidate validation snapshot — 2026-11-04

### Verified

- On fresh disposable loopback PostgreSQL 18, the release runner applied all 57 reviewed migrations, including `0056_order_line_integrity`; the fresh release smoke passed 9/9.
- The release-migration suite passed 12/12. Its populated pre-0056 fixture covered synthetic businesses, listings, an order and line items, payment history, a dispute, financial-ledger rows, and audit history. A controlled interruption left the ledger and records unchanged; retry completed migration 0056, preserved the history, and was idempotent. Divergent/ahead ledgers and a changed migration checksum were refused.
- Migration 0056 preserves pre-existing orders as version 0, requires version 1 for new orders, and protects the financial snapshot and line items from later mutation. No market was activated by the migration rehearsal.
- The fresh-environment legal guard smoke passed 9/9. It refused activation and listing publication before approvals and did not expose inactive-market inventory.
- Readiness passed 15/15 and shutdown/pool handling 1/1 on PostgreSQL 16 and 18. D16 readiness passed 4/4 on both versions.
- The API outage/recovery rehearsal on disposable PG18 returned 503 readiness while PostgreSQL was unavailable, kept liveness at 200 and the process alive, recovered to 200 readiness, logged idle-pool disconnects without connection details, and exited cleanly on SIGTERM. Outbound attempts: 0.
- W02U3 performance and reliability checks passed. With a synthetic JO approval in a disposable database, D15 acceptance passed 5/5 and the money-model suite passed 11/11.
- Financial-state-machine, payment-order-state, W07 journal, W08 cash/refunds, and cash-lock-order suites passed on disposable JO. Wave 4 passed 10/10 on a fresh JO/JOD database. The strict reconciliation assertion was retained; a contaminated combined run was replaced with an isolated fresh-database run.
- `pnpm run build` passed workspace typechecking and all builds. The Dinar bundle-size advisory remains non-blocking.
- The candidate Docker image built successfully. An offline container smoke of the built API runtime returned `healthz=200`, kept readiness at 503 with the database unavailable, returned 503 for the unconfigured phone-verification path and 404 for the disabled payment-simulation route, and shut down cleanly.

### Not verified or intentionally blocked

- Docker database-connected migration, checkout/payment, and restart-persistence acceptance is incomplete. Docker could start PostgreSQL but the environment could not start a client in the shared network namespace or execute into that container; host-port publishing was unavailable on the internal network. The migration runner refused a Unix-socket host override, so no migration was applied in Docker.
- The offline Docker smoke is not database readiness or checkout evidence: its readiness response reported `database=unavailable`, `migrations=unchecked`, `configuration=invalid`, and `phoneVerification=not_configured`.
- Automated accessibility assertions are not a manual screen-reader pass.
- No external launch, jurisdictional counsel, payment provider, or production readiness was assessed. No Railway, production database, deployment, or live provider was used.

An earlier pre-gate smoke attempt activated JO only inside a disposable loopback database; that database was dropped. The final fresh-environment smoke, after the legal gate was added, confirmed all markets remained inactive. D16 acceptance fixtures exercise legal approval and suspension behavior only inside disposable databases, which are removed by the isolated-suite runner.

## G33 CI reconciliation — 2026-11-04

The local Docker limitation above is specific to reproducing a client/PostgreSQL container connection in this workspace. GitHub Actions G33 run `41821045947` passed database-connected Docker acceptance on PostgreSQL 16 and 18 at frozen implementation SHA `f4981d8ddaf11284641ef6b43edb3603e1cf9110`; the earlier baseline run `41814480105` is historical. Current feature completeness and final candidate evidence are tracked only in `13_CAPABILITY_COMPLETENESS_MATRIX.md`. No application-code changes followed the frozen SHA.
