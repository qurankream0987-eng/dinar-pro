# Command 04 — D5 Seller Capability Matrix

Status key: **PASS** means implemented and evidenced for D5; **PARTIAL** means only the stated slice exists; **BLOCKED** means the D5 employee behavior is not implemented; **NOT_RUN** means a test was not run.

| Seller capability | Existing platform authority | D5 employee status | Evidence or boundary |
|---|---|---:|---|
| Prepare a seller listing draft | D3 seller draft services | BLOCKED | D5 does not create drafts. |
| Correct price in the same draft | D3 draft edit/review | BLOCKED | No employee draft state or price edit was added. |
| Publish after permitted approval | D3 publication authority | BLOCKED | D5 cannot publish or request approval. |
| Answer a known published-product fact | D4 catalog read | PARTIAL | A context path exists; no populated listing answer was tested. |
| Refuse to invent an unknown specification | Model prompt instruction | PARTIAL | Instruction is supplied; no live-model output was accepted. |
| Report actual stock | D3 inventory services | BLOCKED | D4 catalog context contains no stock quantities. |
| Handle bulk buyer quantity inquiry through G2 | G2 inquiry runtime | PARTIAL | G2 regressions pass; no D5 employee participation was added. |
| Draft a customer reply for owner approval | Existing conversation/approval authorities | BLOCKED | No reply draft or owner-approval action exists in this change. |
| Approve a reply exactly once | Canonical confirmation/idempotency services | BLOCKED | No D5 reply approval or outbound message path exists. |
| Escalate a discount request | Existing negotiation conversation | PARTIAL | Existing negotiation tests pass; D5 does not classify or route a seller employee discount request. |
| Prevent unauthorized negotiated-price acceptance | Universal negotiation and AI authority guards | PARTIAL | General guards regress; no D5-specific employee test exists. |
| Read an authorized order status | Existing order authority | BLOCKED | D4 intelligent catalog grants do not include order access. |
| Reject fabricated payment claims | Existing model-authority boundary | PARTIAL | Financial/order tools remain unavailable to the model; no D5 employee response test exists. |
| Stop a pending task after grant revocation | D4 grant lookup on each qualifying turn | PARTIAL | Access is re-resolved per request; dedicated pending-task revocation coverage is absent. |
| Deny another business | D4 owner and business scope checks | PARTIAL | Actor isolation is tested; a separate-business D5 journey is not. |
| Deny another market | D4 market-scoped lookup | PASS | D5 integration test confirms the wrong market returns no context. |
| Create truthful marketing text without publishing | Existing seller advice and model path | PARTIAL | Model context can be included for seller help; generation and publication separation were not exercised with a model. |
| Handle a service listing | D3 listing/catalog services | BLOCKED | No D5 employee workflow was added. |
| Handle a vehicle listing | D3 listing/catalog services | BLOCKED | No D5 employee workflow was added. |
| Handle bulk industrial/business inquiries | G2 and business inquiry services | PARTIAL | Existing G2/business regressions pass; no D5 employee route exists. |
| Multi-turn correction and resumption | G2 conversation state | BLOCKED | No D5 employee draft/task state was introduced. |
| Safe retry after a tool failure | Existing G2 action protections | PARTIAL | Existing G2/authority regressions pass; no D5-specific retry path exists. |
| Reject malicious customer prompt injection | Existing G2 safety controls | PARTIAL | G2 injection counters remain zero; D5 catalog-content injection was not tested. |
| Match response to database and audit evidence | D4 audit events and catalog records | PARTIAL | D4 catalog reads use the audit authority; the new D5 audit row is not asserted in the new test. |
| Preserve authorized state across browser reload without stale actions | Existing browser/auth conversation flows | NOT_RUN | No D5 browser journey was run; conversation UI remains owned by Codex. |

No capability beyond the read-only catalog context should be described as delegated to the intelligent employee.
