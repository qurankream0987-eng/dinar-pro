# Command 04 — D5 Remaining Gaps

## Release status

D5 is **PARTIAL**, not complete. The feature provides a scoped published-catalog context and one bounded owner-approved G2 inquiry-reply path grounded in a screened buyer question and current stock. Ordinary seller questions remain in the owner route. It does not provide the universal seller employee specified in Command 04.

## Functional gaps

- Seller listing draft creation, correction, review, and publication.
- General D5 inventory-answer journeys beyond the scoped G2 reply context.
- Multi-inquiry routing and broader D5 participation in buyer workflows.
- Pending D5 action cancellation when its delegation is revoked.
- Discount escalation and seller-side negotiation decisions.
- Authorized order-status assistance.
- D5-specific payment-claim refusal journey.
- Correction and resumption of pending multi-turn D5 tasks.
- Service, vehicle, and bulk-business listing journeys.
- Tool-failure safe retry.
- D5 catalog-content prompt-injection coverage.
- Additional D5-specific audit assertions for failed or stale reply attempts.
- D5-25 authenticated browser reload and stale-action acceptance.

## Current invocation boundary

- D5 starts only when the user explicitly addresses the seller employee; an authorized persisted session permits subsequent turns without repeating the invocation. Ordinary seller requests keep their existing owner-authorized D3 behavior.
- The authenticated owner needs a live intelligent D4 grant for the current market. G2 reply context additionally requires listing-scoped `business.inquiries.reply`, `business.messages.send`, and `business.inventory.read`.
- The model receives the scoped published catalog and, only for an authorized G2 reply, the screened latest unanswered question and current inventory. A proposed reply uses the existing G2 confirmation and send path; the employee cannot send directly.
- Image/location employee requests are refused. No live-model answer or signed-in browser journey has been verified.

## Constraints and dependencies

- Preserve D4's narrow capability grants and canonical backend authorities. The G2 reply path uses the existing inquiry, message, and inventory capabilities; it does not add general publish, price, promotion, order, or payment authority.
- Conversation UI ownership remains with Codex; no chat UI or browser acceptance was changed here.
- Live model quality and provider charging remain unverified by design.
- The automated security scans ran at workspace scope. Their zero SAST/HoundDog results and dependency findings are not confirmed against the nested target checkout; run target-specific scans before release.
- A target-checkout preview/runtime integration was not verified because the configured API workflow points at a different workspace path.

## Known regressions

The target checkout passed API typecheck/build, the D5 G2 reply acceptance, D4 delegation, AI-authority, G2 inquiry, and G2 smart-conversation suites. This is not a production, browser, or full D5 acceptance claim.

## D6 readiness

Do not treat D5 as a completed prerequisite for D6 until the blocked seller workflows, browser acceptance, remaining database/audit assertions, real-model review, and dependency finding reconciliation are completed or explicitly descoped by the owner.
