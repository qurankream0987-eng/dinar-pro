# Business and finance — final local evidence

The canonical business profiles/catalog, memberships/delegations, order snapshot, financial journal, seller dues, payment and refund services remain the foundation. No new ledger, onboarding engine, migration chain or payment policy is introduced by this audit.

Business acceptance traces owner setup and verification, authorized storefront/catalog reads, native business changes and reporting. Existing D1/D2 and D3-A suites exercise real browser/API paths; business-delegations and Connect finance suites verify permitted employee reads, absent scopes, former employees, owner-only management and revocation/expiry. Synthetic reviewer fixtures do not establish real-world business or legal verification.

Financial acceptance must preserve these distinct outcomes:

- Checkout derives price, quantity policy, fee, seller amount and currency from persisted state and snapshots them once. Order items and snapshots remain immutable.
- Stock reservation, dual-party delivery/receipt, cancellation eligibility, disputes and terminal accounting use existing server-owned transitions, concurrency guards and receipts.
- A successful simulated provider event is not real money. Cash/external handover is not card capture. A cancelled/lapsed order's later capture creates one refund obligation, never a completed sale.
- Only provider-signed REFUND_SUCCEEDED resolves an electronic provider refund. Cash repayment remains a separate two-party attestation: a seller repayment claim stays unverified until the buyer confirms actual receipt. Administrative case decisions and local UI cannot fabricate provider settlement.
- Internal marketplace seller commissions, advertising activation and external Connect agreement commissions are distinct ledgers/events.
- Duplicate/signed-event checks, amount/currency matches, integer rounding, reversals and unauthorized reads remain enforced.

The >20-global-policy-history defect was reproduced against the canonical getCommercialPolicy function. Scope selection now orders effective market overrides before global versions in SQL, then limits1. Future rows, other markets, schema validation and safe defaults remain. This does not recalculate existing order prices.

Actual admin browser coverage changes a market unit-price version and independently verifies the existing order snapshot is unchanged; explicit listing prices in the cart also remain unchanged. Category create/update has audit rows; plan create/disable retains server price/currency. The new sponsored cash checkout independently verifies one order, its exact seller/item/quantity/JOD amount, fee-plus-seller reconciliation, reserved stock and zero provider payment intents.

Fresh financial-state-machine, journal, cash/refund, lock-order, payment-state and permission suites run independently on PostgreSQL16/18. The final program then creates fresh synthetic financial source databases, takes custom dumps, restores into separate disposable targets, compares every public/drizzle table digest, and attempts prohibited snapshot/item/journal mutations. Exact restored SQLSTATE/function/message checks must pass and the failed writes must leave all digests unchanged. Source/target databases and dumps are removed afterward. The exact-source restore stages passed on bothPGs, including all133 table digests and all three immutable guard errors; source/target databases and dumps were removed.

No production database, Railway, live payment, paid AI, billing activation or external-provider credential from another service is accessed. Subscription prices/renewal and unsupported financial policies remain owner/legal gates; locally passing fixtures do not approve them.


Tested application and canonical acceptance source: `5121c9198ca80fb0cb02be4ef168b396d8aa12c0`. Local branch `codex/dinar-next-functional-audit`; preserved published foundation `ab196c55964ed42947d07a88dcd7f2e5f66ccfa0`. A later documentation/evidence-only delivery SHA must be identified separately; these results are not retroactively assigned to it.

Fresh immutable-source qualification: **350/350 groups PASS** (175 on PostgreSQL16,175 on18), **3548 passing case executions**,0failed cases,2 explicitly skipped development-TLS remote checks,0outbound attempts. All17 program phases and10 additional UI groups passed. These are local deterministic contracts and actual Chromium/API/disposable-database journeys, not live-provider or production approval.
See [fresh evidence](CODEX_FINAL_FRESH_TEST_EVIDENCE.md), [14-field matrix](CODEX_COMPLETE_FEATURE_INVENTORY.md) and [handoff](CODEX_UPDATED_CLAUDE_HANDOFF.md).
