# DINAR NEXT — Migration reconciliation

**Canonical baseline:** `11d7fbe3326897924468ee4c6d5467972a92b973`  
**Initial candidate:** same SHA  
**Review date:** 2026-11-03  
**Status:** source identities reconciled; candidate migrations and databases not yet tested.

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

- On a fresh disposable loopback PostgreSQL 18 database, the release runner applied all 57 reviewed migrations, including `0056_order_line_integrity`; the release-migration smoke passed 9/9 checks.
- Migration 0056 preserves pre-existing headers as version 0, defaults ordinary new inserts to version 1, and rejects new version-0 orders. The release manifest hash matched the SQL applied by the runner.
- The fresh-environment smoke passed 9/9 after the administrator activation endpoint gained the same country-intake approval gate as the commerce boundary. The test confirmed activation and listing publication are refused before approvals and inactive-market inventory is not exposed.
- Readiness passed 15/15 and shutdown/pool handling passed 1/1 on PostgreSQL 16 and 18. The D16 readiness suite passed 4/4 on both versions.
- A separately built API process, started from the API package working directory against disposable PG18, returned 503 readiness while the database was unavailable, kept liveness at 200 and the process alive, recovered to 200 readiness after the database reopened, logged idle-pool disconnects without exposing connection details, and exited cleanly on SIGTERM. Outbound attempts: 0.
- W02U3 performance passed on PostgreSQL 16 and 18.

### Not verified or intentionally blocked

- The D15 money-model route suite stopped at account registration with 409 on both database versions because the empty test database had no active market. It did not reach its financial assertions. No market or synthetic approval was added to force the suite through.
- W02U3 accessibility, session, and reliability journeys stopped at the inactive-market gate on PG16. They remain unverified rather than being run against a fabricated approved market.
- A populated legacy-data upgrade/interruption-and-retry rehearsal was not completed on the final candidate. The fresh PG18 release chain is verified; this is not a claim that every upgrade history is safe.
- The candidate Docker image was not built. No Railway, production database, deployment, or live provider was used.

An earlier pre-gate smoke attempt activated JO only inside a disposable loopback database; that database was dropped. The final fresh-environment smoke, after the legal gate was added, confirmed all markets remained inactive. D16 acceptance fixtures exercise legal approval and suspension behavior only inside disposable databases, which are removed by the isolated-suite runner.
