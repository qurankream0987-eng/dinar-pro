# Command 04D — D5 Acceptance Evidence

## Tested implementation

- Starting SHA: `c8120d46469fd1cc0777db4ed8dc902690dc7dbf`
- Tested source SHA: `61bd7e01e5c2eb765e38ac87f73030a87f5af95d`
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
| `local-suite.sh block-f0-foundation.test BDINAR_BLOCKF_ACCEPTANCE=development` | PASS, 12/12; outbound=0 |
| `local-suite.sh block-f3-commerce.test BDINAR_BLOCKF_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development` | PASS, 17/17; outbound=0; no model or external calls |
| API specification codegen | NOT_RUN; no API contract or generated client changed |
| Readiness, development TLS, and migration 0050 checks | NOT_RUN; no database schema or migration changed |
| Replit workspace SAST / HoundDog / dependency audit | SAST: 0 findings; HoundDog: 0 findings; dependency audit reports one high and one moderate finding in the workspace-root lockfile |
| Target-checkout dependency reconciliation | PASS by lockfile inspection: `qs@6.16.1` and `zod@4.6.7`, both beyond the reported fixed versions; the workspace audit did not scan this nested checkout's lockfile |
| Chromium/browser D5 acceptance | NOT_RUN |
| Live model/provider acceptance | NOT_RUN |

The workspace dependency audit reported `qs@6.16.0` (moderate; fix `6.16.1`) and `zod@3.25.76` (high; fix requires `4.6.6`). Those versions were found in the workspace-root lockfile, not this nested target checkout. No target dependency change was needed or made.

The D5 acceptance uses an injected test gateway, not a live model. Its additional direct evidence covers:

- A published listing's recorded category is returned from the current business catalog; an unrecorded battery specification is refused without inventing the requested value.
- D5 inventory reads report 35 available, zero/unavailable, and `UNLIMITED` without a numeric count; ambiguous and out-of-scope product requests do not expose stock.
- A reservation-only disposable order returns its stored `RESERVED` status and scoped item summary without buyer identifiers.
- Open negotiation details are surfaced for owner review; a model-proposed acceptance is rejected and the negotiation stays `OPEN`.
- A used-phone `SELL` draft contains its title, used condition, and price; a later turn corrects the same draft's price from 12 to 15.
- A publication request is refused with no offer row added, and a drafted reply claiming payment receipt is rejected.
- Revoking the D4 grant invalidates its pending action transactionally; the concurrent confirmation is blocked before a further model call or seller message.

The existing G2 reply evidence remains:

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

The separate D5 delegation suite continues to verify wrong-actor, wrong-market, expired-grant, ambiguous-grant, market-change, account-switch, logout, owner-stop, and session/capability-audit behavior. G2 and F3 suites used only their development payment simulation where required; each loopback database was dropped afterward. No real payment, external message, live provider call, production check, browser UI change, merge, or deployment was made.

## D5-01 through D5-25

The scenario-by-scenario source paths, direct test evidence, status, and database result are maintained in `COMMAND_04_D5_SELLER_CAPABILITY_MATRIX.md`. D5 remains **PARTIAL**; D6 has not started. Listing publication, refunds, financial commitments, private-contact disclosure, and bulk messaging remain unavailable to the intelligent employee.

## Runtime and browser evidence

The configured API workflow points to the workspace-root artifact rather than this nested target checkout, so it was not used as source validation. This checkout passed its typecheck, build, and isolated database suites. No browser screenshot, authenticated UI journey, live-model check, or production check is claimed.
