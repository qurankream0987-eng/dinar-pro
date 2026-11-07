# Advertising acceptance — final local evidence

The existing standard promotion engine is preserved. The user-visible path remains the unified conversation; no independent ad runtime was introduced. `artifacts/api-server/src/lib/promotions.ts` and `routes/promotions.ts` own eligibility, catalog pricing, preview, confirmation and campaign state. `listing_promotions` and `promotion_products` are authoritative. A simulated campaign receipt is not real payment collection.

| Mechanism | Canonical implementation | Evidence boundary |
| --- | --- | --- |
| Ordinary product/service listing | Existing offers, search and seller services | Not itself a paid campaign |
| Standard paid/sponsored placement | Existing Block E promotion preview/confirm and campaign state | Fresh E34 Chromium plus API/DB lifecycle tests |
| Recommendation/ranking | Existing server result sets and explanation metadata | Listing identity and sponsored labels preserved; no invented product |
| Commercial balance/entitlements/demand capture | Existing V3 commercial ledger and products | Separate next-g3/block-e assertions; do not treat standard campaign UI as proof of every V3 lifecycle |
| Gift/coupon lifecycle | No distinct approved canonical implementation established | Product-scope decision; do not create a new money engine |
| Live ad payment | No approved provider activation in this mission | BLOCKED_PROVIDER / BLOCKED_POLICY |

The strengthened E34 browser follows a seller-owned published offer through plan selection, displayed price/currency/duration, no automatic renewal, explicit confirmation, simulated activation, reload, campaign details, pause and resume. The buyer then sees the exact sponsored item once with visible disclosure, organic alternatives, listing detail and persisted recommendations.

New coupled coverage follows that same disclosed sponsored offer into the existing cart, waits for the server assistant receipt and independently reads the persisted cart, opens the canonical checkout form, confirms that an attempted submission before review consent sends zero checkout requests, checks the actual consent checkbox, and receives one 201 order. The cart subsequently clears. No provider charge occurs for this cash order.

The API wrapper independently verifies exactly one order for the fresh buyer, the original seller, JOD 45.000 subtotal, fee plus seller amount equal subtotal, immutable order-line integrity version, one line for the promoted offer at its stored price, quantity one and reserved stock one. It verifies zero payment intents for the cash order. The campaign itself remains separately ACTIVE/SIMULATION_CAPTURED; its activation is never mistaken for purchase payment.

Focused working-patch qualification: `functional-audit-editor-ads-green`, base 588984129885a9586298d19a42955bb2731c0219, patch SHA256 6f899686f0260107d4537c73770f455c1702c297e0ff67bb01b5bdc86b6f2339. PostgreSQL16 and18 each passed46 Node cases and42 browser checks, with zero unexpected console/page/external request issues, zero horizontal overflow and zero undisclosed sponsored items. Cart and checkout screenshots retained per PostgreSQL version with SHA256 manifests. Final clean-source qualification is recorded below.

Existing negative controls remain: duplicate/concurrent confirmation E09, unsuccessful simulated activation E08, expired read/serving E17, moderation and disabled seller E14/E15, paused listing E16, no silent renewal/recharge E38, catalog-price snapshots E39 and disabled plan E40. This does not establish live provider refunds or commercial/legal approval.


Tested application and canonical acceptance source: `5121c9198ca80fb0cb02be4ef168b396d8aa12c0`. Local branch `codex/dinar-next-functional-audit`; preserved published foundation `ab196c55964ed42947d07a88dcd7f2e5f66ccfa0`. A later documentation/evidence-only delivery SHA must be identified separately; these results are not retroactively assigned to it.

Fresh immutable-source qualification: **350/350 groups PASS** (175 on PostgreSQL16,175 on18), **3548 passing case executions**,0failed cases,2 explicitly skipped development-TLS remote checks,0outbound attempts. All17 program phases and10 additional UI groups passed. These are local deterministic contracts and actual Chromium/API/disposable-database journeys, not live-provider or production approval.
See [fresh evidence](CODEX_FINAL_FRESH_TEST_EVIDENCE.md), [14-field matrix](CODEX_COMPLETE_FEATURE_INVENTORY.md) and [handoff](CODEX_UPDATED_CLAUDE_HANDOFF.md).
