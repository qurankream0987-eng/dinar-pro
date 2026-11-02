# Command 04 — D5 Remaining Gaps

## Release status

D5 is **PARTIAL**, not complete. The committed feature provides an explicit-invocation, read-only catalog context for the existing AI model path. Ordinary seller questions remain in the owner route. It does not provide the universal seller employee specified in Command 04.

## Functional gaps

- Seller listing draft creation, correction, review, and publication.
- Stock/inventory facts and truthful stock responses.
- D5 participation in G2 buyer inquiries.
- Reply drafts, owner approval, exactly-once approval, and a message sender.
- Discount escalation and seller-side negotiation decisions.
- Authorized order-status assistance.
- D5-specific payment-claim refusal journey.
- Pending-task cancellation on revoke and multi-turn task resumption.
- Service, vehicle, and bulk-business listing journeys.
- Tool-failure safe retry.
- D5 catalog-content prompt-injection coverage.
- D5-specific persisted-state and audit-event assertions.
- D5-25 authenticated browser reload and stale-action acceptance.

## Current invocation boundary

- D5 starts only when the user explicitly addresses the seller employee; ordinary seller requests keep their existing owner-authorized D3 behavior.
- One active intelligent `business.catalog.read` grant is required for the authenticated owner and current market.
- The model receives only the scoped published-catalog summary. Proposed writes, searches, planning, and canonical actions are rejected; no D5 mutation permission has been added.
- Image/location employee requests are refused. No live-model answer or signed-in browser journey has been verified.

## Constraints and dependencies

- The repository’s current D4 intelligent capability is `business.catalog.read`; it does not include draft, publish, inventory, order, message, price, promotion, or payment authority. Expanding those powers requires an explicit owner-approval/security design and canonical backend authority, not a model prompt change.
- Conversation UI ownership remains with Codex; no chat UI or browser acceptance was changed here.
- Live model quality and provider charging remain unverified by design.
- The automated security scans ran at workspace scope. Their zero SAST/HoundDog results and dependency findings are not confirmed against the nested target checkout; run target-specific scans before release.
- A target-checkout preview/runtime integration was not verified because the configured API workflow points at a different workspace path.

## Known regressions

No regression was observed in the executed typecheck, builds, database schema check, D1/D2, D3-A, D4, G2, universal negotiation, or model-authority suites. This is not a production or full D5 acceptance claim.

## D6 readiness

Do not treat D5 as a completed prerequisite for D6 until the blocked seller workflows, browser acceptance, database/audit assertions, real-model review, and dependency finding reconciliation are completed or explicitly descoped by the owner.
