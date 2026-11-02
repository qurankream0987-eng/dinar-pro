# Command 04 — D5 Acceptance Evidence

## Tested implementation

- Starting SHA: `d6889abb8801056268869683cac5fbc590adf0ef`
- Tested source SHA: `17f77af24482f739cb99771208c35bea0e0652d4`
- Branch: `replit/dinar-next-complete-development`
- Database: isolated loopback PostgreSQL databases created by `test/isolation/local-suite.sh`; each suite dropped its database afterward. No managed or production database was used.

## Checks and results

| Check | Result |
|---|---|
| `pnpm --filter @workspace/api-server run typecheck` | PASS |
| `pnpm --filter @workspace/api-server run build` | PASS |
| `local-suite.sh d5-seller-employee-acceptance.test BDINAR_D5_ACCEPTANCE=development` | PASS, 1/1; outbound=0 |
| `local-suite.sh business-delegations.test BDINAR_D4_ACCEPTANCE=development` | PASS, 4/4; outbound=0 |
| `local-suite.sh ai-authority-boundary.test` | PASS, 4/4; outbound=0 |
| `local-suite.sh next-g2-inquiry.test BDINAR_G2_ACCEPTANCE=development` | PASS, 17/17; outbound=0 |
| `local-suite.sh g2-smart-conversation.test BDINAR_G2_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development` | PASS, 91/91; outbound=0; payment simulation stayed in the disposable test database |
| API specification codegen | NOT_RUN; no API contract or generated client changed |
| Readiness, development TLS, and migration 0050 checks | NOT_RUN; no database schema or migration changed |
| Target-checkout SAST / HoundDog and dependency audit | NOT_RUN |
| Chromium/browser D5 acceptance | NOT_RUN |
| Live model/provider acceptance | NOT_RUN |

The new G2/D5 acceptance uses an injected test gateway, not a live model. Its 15 evidence items are:

1. A buyer inquiry is created through G2's canonical service and delivered to the seller's DINAR inbox.
2. The model receives the exact latest unanswered question and the assigned published listing's server inventory.
3. A contact-bearing buyer message is screened before it reaches model context.
4. Limited stock (35 and 0) is distinct from `UNLIMITED`, whose numeric quantity is null.
5. Without `business.inventory.read`, the assigned buyer question is withheld and no reply draft is created.
6. A persisted employee session authorizes a follow-up that omits the explicit invocation wording.
7. The proposed reply is an `INQUIRY_DRAFT` with `DINAR_DRAFT_APPROVED` provenance and remains pending for the owner.
8. Drafting alone creates no seller message and no `INQUIRY_REPLIED` event.
9. Mismatched quantities, false availability/unavailability, and invented restock dates are rejected.
10. Changing stock from 35 to 34 before approval rejects the stale action and writes no seller message or reply event.
11. A refreshed draft receives the current quantity of 34.
12. The owner approves through the existing canonical G2 `SEND_INQUIRY_MESSAGE` action.
13. One in-app seller message and one reply event persist; replaying approval does not duplicate either.
14. Revoking the grant with a pending draft blocks the next approval before another model call and sends no second message.
15. The buyer's authenticated conversation reload contains the approved, persisted reply.

The separate D5 delegation suite continues to verify wrong-actor, wrong-market, expired-grant, ambiguous-grant, market-change, account-switch, logout, owner-stop, and session/capability-audit behavior. G2 suites ran with the test runner's provider keys removed and its outbound guard enabled. The G2 payment simulation was enabled only because that suite exercises the simulated payment review path; its loopback database was dropped afterward. No real payment, external message, live provider call, production check, browser UI change, or deployment was made.

## D5-01 through D5-25

The scenario-by-scenario source paths, direct test evidence, status, and database result are maintained in `COMMAND_04_D5_SELLER_CAPABILITY_MATRIX.md`. D5 remains **PARTIAL**; D6 has not started. Listing publication, refunds, financial commitments, private-contact disclosure, and bulk messaging remain unavailable to the intelligent employee.

## Runtime and browser evidence

The configured API workflow points to the workspace-root artifact rather than this nested target checkout, so it was not used as source validation. The target checkout passed its typecheck, build, and isolated database suites. No browser screenshot, authenticated UI journey, or production check is claimed.
