# Command 04 — D5 Seller Capability Matrix

D5 remains **PARTIAL**. D6 is not started. **PASS** means the stated D5 behavior is implemented and directly evidenced; **PARTIAL** means a bounded slice exists or the D5 journey is not fully tested; **BLOCKED** means the behavior is unavailable; **NOT_RUN** means no browser/runtime test was run.

## Evidence references

- **[session]** `artifacts/api-server/src/lib/business-delegations.ts`; `artifacts/api-server/src/lib/auth.ts`; `lib/db/src/schema/index.ts`; `lib/db/drizzle/0050_normal_nico_minoru.sql`.
- **[runtime]** `artifacts/api-server/src/ai/smart-turn.ts`; `artifacts/api-server/src/ai/conversation-runtime.ts`; `artifacts/api-server/src/ai/model-turn.ts`.
- **[actions]** `artifacts/api-server/src/ai/action-foundation.ts`; `artifacts/api-server/src/ai/business-turn.ts`; `artifacts/api-server/src/ai/inquiry-turn.ts`; `artifacts/api-server/src/ai/negotiation-turn.ts`.
- **[D5 test]** `artifacts/api-server/test/business-delegations.test.ts` — 4/4 passed. A fake injected model proposed inventory reads; no live model/provider was used.
- **[G2 inquiry]** `artifacts/api-server/test/next-g2-inquiry.test.ts` — 17/17 passed.
- **[G2 smart]** `artifacts/api-server/test/g2-smart-conversation.test.ts` — 91/91 passed with the suite's development payment simulation enabled.
- **[AI boundary]** `artifacts/api-server/test/ai-authority-boundary.test.ts` — 4/4 passed.
- Every suite ran against a fresh loopback PostgreSQL test database with outbound access guarded; each database was dropped afterward. No managed or production database was used.

| ID | Seller capability | D5 status | Source paths | Test evidence and resulting database state |
|---|---|---:|---|---|
| D5-01 | Prepare a used-phone listing draft | PARTIAL | [runtime], [actions] | [D5 test] does not exercise listing drafting. The typed draft route is narrowly bounded; no D5 listing row is asserted. |
| D5-02 | Correct price in the same draft | BLOCKED | [runtime], [actions], [session] | No existing-draft price-edit action or D5 test. Published-price changes remain unavailable; no D5 price write is asserted. |
| D5-03 | Publish only through permitted approval | BLOCKED | [runtime], [actions] | No D5 publication action. No publication state changed in [D5 test]. |
| D5-04 | Answer a known published-product fact | PARTIAL | [session], [runtime] | [D5 test] verifies scoped context, but the fixture has no published listing; no populated fact answer is asserted. |
| D5-05 | Refuse to invent an unknown specification | PARTIAL | [runtime] | The model prompt requires grounding and labels listing content as untrusted; no model-generated D5 answer was evaluated. |
| D5-06 | Report actual stock availability | PARTIAL | [session], [runtime] | [D5 test] exercises the authorized inventory-read route with an empty catalog and asserts its capability audit. No populated quantity fixture or stock mutation is tested. |
| D5-07 | Handle a buyer's bulk quantity inquiry through G2 | PARTIAL | [actions] | [G2 inquiry] and [G2 smart] pass; neither journey invokes the D5 employee. Fixture DBs are dropped. |
| D5-08 | Draft a customer reply for owner approval | PARTIAL | [runtime], [actions] | The D5 route binds a pending reply to its session and listing; [G2 inquiry] covers the canonical path, but no D5 reply draft is asserted. No D5 outbound message is sent. |
| D5-09 | Approve a reply exactly once | PARTIAL | [session], [actions] | Canonical confirmation and duplicate-send coverage passes in [G2 inquiry]; D5 confirmation after session revalidation is not directly exercised. No D5 message write is asserted. |
| D5-10 | Escalate a discount request | PARTIAL | [runtime], [actions] | The D5 proposal can route to negotiation status; [G2 smart] covers the canonical negotiation service, not the D5 route. No D5 negotiation write is asserted. |
| D5-11 | Prevent unauthorized negotiated-price acceptance | PARTIAL | [runtime], [actions] | [AI boundary] and [G2 smart] pass; the D5 employee's prohibited acceptance proposal has no dedicated test. |
| D5-12 | Read an authorized order status | PARTIAL | [session], [runtime], [actions] | `business.orders.read` is rechecked before the canonical business read; no D5 order-status journey or order-row assertion was run. |
| D5-13 | Reject fabricated payment claims | PARTIAL | [runtime], [actions] | [AI boundary] verifies no model financial authority; no D5-generated payment claim was tested. No D5 payment/order record was created. |
| D5-14 | Stop follow-ups after grant revocation | PASS | [session], [runtime] | [D5 test] revokes the active grant; the session row becomes `INVALIDATED` with `GRANT_REVOKED`, and the next turn is denied before another fake-model call. No pending inquiry draft was involved. |
| D5-15 | Deny access to another business | PARTIAL | [session], [runtime] | [D5 test] rejects another actor and ambiguous grants; a same-owner, separate-business D5 journey was not run. |
| D5-16 | Deny access after a market change | PASS | [session], [runtime], [auth] | [D5 test] receives no context for the other market and verifies a JO session becomes `INVALIDATED` with `MARKET_CHANGE` after switching markets. |
| D5-17 | Create truthful marketing text without publishing | PARTIAL | [runtime] | Marketing context is scoped and publication is not an employee action; no generated text or publication attempt was tested. |
| D5-18 | Handle a service listing | BLOCKED | [runtime], [actions] | No D5 service-listing journey is implemented or tested; no service listing was written. |
| D5-19 | Handle a vehicle listing | BLOCKED | [runtime], [actions] | No D5 vehicle-listing journey is implemented or tested; no vehicle listing was written. |
| D5-20 | Handle bulk industrial/business inquiries | BLOCKED | [runtime], [actions] | D5 can draft one reply for owner approval; bulk messaging is not an employee action. No message was sent by the D5 test. |
| D5-21 | Correct and resume a multi-turn task | PARTIAL | [session], [runtime], [actions] | [D5 test] proves a persisted session resolves a follow-up without invocation wording; correction/resumption of a pending D5 draft is not tested. |
| D5-22 | Retry safely after a tool failure | PARTIAL | [session], [runtime], [actions] | Capabilities are rechecked on each action; no D5 tool-failure/retry journey was run and no retry side effect is claimed. |
| D5-23 | Reject malicious customer prompt injection | PARTIAL | [runtime] | The model prompt treats listing/provider content as untrusted; [G2 smart] injection counters are zero, but no D5 listing-content injection fixture was run. |
| D5-24 | Match response, database state, and audit evidence | PASS | [session], [runtime] | [D5 test] matches the inventory response to `business.inventory.read` audit evidence and checks started, invalidated, and ended session audit events. Test database dropped. |
| D5-25 | Preserve authorized state across browser reload | NOT_RUN | [session], [runtime] | Service-level session re-resolution is tested in [D5 test]; no browser journey was run and no UI was changed. |

Publication, refunds, financial commitments, private-contact disclosure, and bulk messaging remain unavailable to the D5 employee. The tested model was an injected test double only; the G2 payment simulation ran solely on a disposable database and did not contact a payment provider.
