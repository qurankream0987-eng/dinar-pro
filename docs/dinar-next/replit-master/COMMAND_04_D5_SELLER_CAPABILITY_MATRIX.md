# Command 04D — D5 Seller Capability Matrix

D5 remains **PARTIAL**. D6 is not started. **PASS** means the bounded behavior listed is implemented and directly evidenced; **PARTIAL** means a broader seller journey remains unfinished or untested; **BLOCKED** means the behavior is unavailable; **NOT_RUN** means no browser test was run.

## Evidence references

- **[session]** `artifacts/api-server/src/lib/business-delegations.ts`; `artifacts/api-server/src/lib/auth.ts`; `lib/db/src/schema/index.ts`; `lib/db/drizzle/0050_normal_nico_minoru.sql`.
- **[runtime]** `artifacts/api-server/src/ai/smart-turn.ts`; `artifacts/api-server/src/ai/conversation-runtime.ts`; `artifacts/api-server/src/ai/model-turn.ts`.
- **[actions]** `artifacts/api-server/src/ai/action-foundation.ts`; `artifacts/api-server/src/ai/business-turn.ts`; `artifacts/api-server/src/ai/inquiry-turn.ts`; `artifacts/api-server/src/ai/negotiation-turn.ts`.
- **[D5 delegation]** `artifacts/api-server/test/business-delegations.test.ts` — 4/4 passed.
- **[D5 acceptance]** `artifacts/api-server/test/d5-seller-employee-acceptance.test.ts` — 3/3 passed. Injected model only; no live model/provider was used.
- **[G2 inquiry]** `artifacts/api-server/test/next-g2-inquiry.test.ts` — 17/17 passed.
- **[Negotiation]** `artifacts/api-server/test/universal-negotiation-acceptance.test.ts` — 38/38 passed.
- **[G2 smart]** `artifacts/api-server/test/g2-smart-conversation.test.ts` — 91/91 passed with its development payment simulation enabled.
- **[AI boundary]** `artifacts/api-server/test/ai-authority-boundary.test.ts` — 4/4 passed.
- **[F0 actions]** `artifacts/api-server/test/block-f0-foundation.test.ts` — 12/12 passed.
- **[F3 commerce]** `artifacts/api-server/test/block-f3-commerce.test.ts` — 17/17 passed with `BDINAR_WAVE4_ACCEPTANCE=development`.
- All suites ran against fresh loopback PostgreSQL databases with outbound access guarded; each database was dropped afterward. No managed or production database was used.
- Typecheck and API build passed. The three workspace security scanners reported zero SAST and HoundDog findings; dependency findings were in the workspace-root lockfile, while this checkout pins `qs@6.16.1` and `zod@4.6.7`.

| ID | Seller capability | D5 status | Source paths | Test evidence and resulting database state |
|---|---|---:|---|---|
| D5-01 | Prepare a used-phone listing draft | PASS | [runtime], [actions] | [D5 acceptance] verifies the phone title, used condition, and price in a `SELL` draft; seller offer rows remain unchanged. |
| D5-02 | Correct price in the same draft | PASS | [runtime], [actions], [session] | A later D5 turn changes the same unpublished draft from 12 to 15; no offer row is created. |
| D5-03 | Publish only through permitted approval | PASS | [runtime], [actions] | Phone, service, and vehicle drafts create pending `PUBLISH_LISTING` reviews; only owner confirmation publishes, and replay does not create a duplicate. Editing a reviewed draft expires the stale approval. |
| D5-04 | Answer a known published-product fact | PASS | [session], [runtime] | The owner-scoped published catalog returns the fixture listing’s recorded category; answers are server-grounded. |
| D5-05 | Refuse to invent an unknown specification | PASS | [runtime] | A battery-capacity question returns “not recorded” and omits the requested unrecorded value. |
| D5-06 | Report actual stock availability | PASS | [session], [runtime] | The D5 route returns 35, distinguishes zero from unavailable, and reports `UNLIMITED` without a numeric count. G2 independently rejects a stale 35→34 snapshot at send time. |
| D5-07 | Handle a buyer's bulk quantity inquiry through G2 | PARTIAL | [actions] | [D5 acceptance] sends a 50-piece buyer question through canonical G2, gives the model the recorded 35, rejects stale stock, and sends one owner-approved reply. Bulk fulfillment and negotiation remain unavailable. |
| D5-08 | Draft a customer reply for owner approval | PASS | [runtime], [actions] | [D5 acceptance] verifies an `INQUIRY_DRAFT` with `DINAR_DRAFT_APPROVED` provenance, no pre-approval message/event, and screened buyer context. |
| D5-09 | Approve a reply exactly once | PASS | [session], [actions] | The canonical G2 action revalidates session, inquiry, question, listing, and stock; one in-app reply/event persists and approval replay does not duplicate it. |
| D5-10 | Escalate a discount request | PASS | [runtime], [actions] | D5 shows only in-scope negotiations and cannot accept or counter. The owner’s counter and confirmation use the canonical negotiation surface and engine; the test verifies the negotiation changes only after owner confirmation. |
| D5-11 | Prevent unauthorized negotiated-price acceptance | PASS | [runtime], [actions] | A model-proposed price-review action is rejected; the fixture negotiation remains `OPEN`. |
| D5-12 | Read an authorized order status | PASS | [session], [runtime], [actions] | A disposable reservation fixture returns its stored `RESERVED` status and scoped item summary without buyer identifiers. No payment or settlement is created. |
| D5-13 | Reject fabricated payment claims | PASS | [runtime], [actions] | A drafted buyer reply claiming receipt of payment is refused; no reply draft or payment record is created. |
| D5-14 | Stop follow-ups after grant revocation | PASS | [session], [runtime] | Revocation invalidates a pending action in the same transaction; the race test confirms a blocked approval performs no later model call or message write. |
| D5-15 | Deny access to another business | PASS | [session], [runtime] | A different owner’s listing and stock are not returned by the current business-scoped D5 session. |
| D5-16 | Deny access after a market change | PASS | [session], [runtime], [auth] | [D5 delegation] receives no context for the other market and verifies a JO session becomes `INVALIDATED` with `MARKET_CHANGE` after switching markets. |
| D5-17 | Create truthful marketing text without publishing | PASS | [runtime] | D5 marketing copy uses authorized listing facts, corrects an unsupported warranty/scarcity claim, and leaves the published listing unchanged. |
| D5-18 | Handle a service listing | PASS | [runtime], [actions] | The test drafts and completes a service listing using seller-provided details, requests owner review, and verifies publication occurs only after confirmation. |
| D5-19 | Handle a vehicle listing | PASS | [runtime], [actions] | The test resolves a vehicle draft to `cars`, supplies required vehicle attributes through the category schema, and verifies owner-confirmed publication. No attributes outside the category schema are written. |
| D5-20 | Handle bulk industrial/business inquiries | BLOCKED | [runtime], [actions] | D5 can draft one reply for owner approval; bulk messaging is not an employee action. No message was sent by the D5 test. |
| D5-21 | Correct and resume a multi-turn task | PASS | [session], [runtime], [actions] | The persisted D5 session corrects a pending listing draft on a later turn without repeating invocation wording. |
| D5-22 | Retry safely after a tool failure | PASS | [session], [runtime], [actions] | A simulated local tool failure creates no draft or offer; retry and replay resume the same conversation draft. A pending publication review is also invalidated by grant revocation before owner confirmation. |
| D5-23 | Reject malicious customer prompt injection | PARTIAL | [runtime] | The model prompt treats listing/provider content as untrusted; [G2 smart] injection counters are zero, but no D5 listing-content injection fixture was run. |
| D5-24 | Match response, database state, and audit evidence | PASS | [session], [runtime] | [D5 delegation] matches inventory access to capability audit evidence and checks session audit events; [D5 acceptance] matches reviews, publication, final reply, `INQUIRY_REPLIED`, tool-failure no-op, and revocation state. Test databases dropped. |
| D5-25 | Preserve authorized state across browser reload | NOT_RUN | [session], [runtime] | Service-level session re-resolution is tested in [D5 delegation]. The preview showed only the logged-out home screen; no authenticated D5 browser reload journey was run. |

Publication, refunds, financial commitments, private-contact disclosure, and bulk messaging remain unavailable to the D5 employee. The tested model was an injected test double only; the G2 payment simulation ran solely on a disposable database and did not contact a payment provider.
