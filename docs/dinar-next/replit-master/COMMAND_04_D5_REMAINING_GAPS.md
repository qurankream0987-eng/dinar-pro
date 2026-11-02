# Command 04D — D5 Remaining Gaps

## Release status

D5 is **PARTIAL**, not complete. The feature provides scoped published-catalog, inventory, and order reads; an unpublished listing-draft and correction path; a read-only negotiation escalation summary; and one bounded owner-approved G2 inquiry-reply path grounded in a screened buyer question and current stock. The universal seller employee specified in Command 04 is not complete.

## Functional gaps

- Connect an unpublished seller draft to the owner's existing publication-review route; D5 cannot publish.
- Add a dedicated D5 marketing-copy journey with server-grounded claims.
- Complete service- and vehicle-specific listing drafts, including their category fields and review journeys.
- Add owner notification and decision routing for discount escalations; the current D5 path is a scoped read and audit event only.
- Multi-inquiry routing and bulk business replies remain unavailable.
- Tool-failure safe retry.
- D5 catalog-content prompt-injection coverage.
- Additional D5-specific audit assertions for failed or stale listing, order, and negotiation reads.
- D5-25 authenticated browser reload and stale-action acceptance.
- Live-model response quality and signed-in UI acceptance.

## Current invocation boundary

- D5 starts only when the user explicitly addresses the seller employee; an authorized persisted session permits subsequent turns without repeating the invocation. Ordinary seller requests keep their existing owner-authorized D3 behavior.
- The authenticated owner needs a live intelligent D4 grant for the current market. Each D5 action rechecks its own capability and business/listing scope.
- Catalog facts, stock, and order status are read from server-owned records. G2 reply context additionally requires listing-scoped `business.inquiries.reply`, `business.messages.send`, and `business.inventory.read`.
- The model receives the scoped published catalog and, only for an authorized G2 reply, the screened latest unanswered question and current inventory. A proposed reply uses the existing G2 confirmation and send path; the employee cannot send directly.
- Listing drafts and corrections remain conversation drafts. A D5 price correction requires `business.catalog.draft.price`; no offer row is created or edited.
- Grant revocation invalidates pending D5 actions and blocks concurrent approval before another model call or message write.
- Image/location employee requests are refused. No live-model answer or signed-in browser journey has been verified.

## Constraints and dependencies

- Preserve D4's narrow capability grants and canonical backend authorities. The D5 paths do not add publication, published-price changes, promotion, payment, private-contact, or bulk-send authority.
- Conversation UI ownership remains with Codex; no chat UI or browser acceptance was changed here.
- Live model quality and provider charging remain unverified by design.
- Automated security scans ran at workspace scope: SAST and HoundDog returned zero findings; the dependency audit found vulnerable versions in the workspace-root lockfile. This checkout pins the reported fixed `qs` and `zod` versions, but a target-specific scanner run is still required before release.
- A target-checkout preview/runtime integration was not verified because the configured API workflow points at a different workspace path.

## Known regressions

The target checkout passed API typecheck/build, D5 acceptance, D4 delegation, AI-authority, G2 inquiry, G2 smart-conversation, F0 action-foundation, and F3 commerce suites. This is not a production, browser, live-model, or full D5 acceptance claim.

## D6 readiness

Do not treat D5 as a completed prerequisite for D6 until the blocked seller workflows, browser acceptance, remaining database/audit assertions, real-model review, and dependency finding reconciliation are completed or explicitly descoped by the owner.
