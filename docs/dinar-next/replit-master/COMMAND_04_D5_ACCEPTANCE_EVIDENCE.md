# Command 04 — D5 Acceptance Evidence

## Tested implementation

- Starting SHA: `f939595922171974626ef2cfd2c516aec8b86428`
- Tested source SHA: `d0b63b36b9d4b4982ed192126682c51fa3882e0f`
- Branch: `replit/dinar-next-complete-development`
- Database: isolated loopback PostgreSQL created by `test/isolation/local-suite.sh`; not a permanent or production database.

## Commands and results

| Check | Result |
|---|---|
| `pnpm -w run typecheck` | PASS |
| `pnpm --filter @workspace/api-server run build` | PASS |
| `pnpm --filter @workspace/dinar run build` | PASS; existing vendor-annotation and large-chunk warnings remain |
| `pnpm --filter @workspace/db run check` | PASS; no schema changes |
| `pnpm run test:secrets` in `artifacts/api-server` | PASS, 1 test |
| `test/isolation/local-suite.sh business-delegations.test BDINAR_D4_ACCEPTANCE=development` | PASS, 4 tests; `outbound=0` |
| D1/D2, D3-A native business, D4, G2 inquiry, G2 smart conversation, universal negotiation, AI authority chain | PASS, 221 Node tests across 7 suites; `outbound=0` |
| SAST / HoundDog | PASS, zero findings from each |
| Dependency audit | PARTIAL/OPEN: workspace-root scan found 1 high and 1 moderate; target-checkout scan not established, see security document |
| Chromium/browser D5 acceptance | NOT_RUN |
| Live-provider/model acceptance | NOT_RUN |

The D5 integration test proves: no grant gives no context; one active intelligent read grant gives context; expired grants, another actor, and another market give no context; two active grants are ambiguous and give no context; seller-help wording receives the bounded server context; unrelated wording does not; and the context includes no grant/configuration identifier.

The broader chain recorded: D1/D2 24/24, D3-A native business 43/43 (including 41 D3A cases), D4 4/4, G2 inquiry 17/17, G2 smart conversation 91/91 (including 83 G2 cases), universal negotiation 38/38 (36 acceptance cases), and model-authority boundary 4/4. Every isolated suite reported `outbound=0`.

## D5-01 through D5-25

| ID | Scenario | Result | Evidence |
|---|---|---:|---|
| D5-01 | Prepare a used phone listing | BLOCKED | No D5 employee draft workflow. |
| D5-02 | Correct price in the same draft | BLOCKED | No D5 employee draft workflow. |
| D5-03 | Publish only through permitted approval | BLOCKED | No D5 employee publication workflow. |
| D5-04 | Answer a known product fact | PARTIAL | Bounded catalog context is implemented; no populated-listing/model answer was tested. |
| D5-05 | Refuse an unknown specification | PARTIAL | No-invention instruction is present; no actual model answer was tested. |
| D5-06 | Answer actual stock availability | BLOCKED | The D4 grant returns no inventory quantity to D5. |
| D5-07 | Buyer requests 50 units through G2 | PARTIAL | G2 regressions pass; no D5 employee participates. |
| D5-08 | Draft a reply requiring owner approval | BLOCKED | No employee reply-draft path. |
| D5-09 | Approve once; duplicate approval sends no duplicate | BLOCKED | No D5 reply approval or sender. |
| D5-10 | Escalate a discount request | PARTIAL | Existing negotiation tests pass; no D5 employee escalation. |
| D5-11 | Do not accept a negotiated price without authority | PARTIAL | General negotiation/model-authority regressions pass; no D5-specific journey. |
| D5-12 | Read an authorized order status | BLOCKED | D4 intelligent grant is catalog-read only. |
| D5-13 | Reject a fabricated payment claim | PARTIAL | Financial/order model tools remain blocked; no D5 employee response test. |
| D5-14 | Revoke during a pending task | PARTIAL | Each request re-resolves the grant; pending-task cancellation test absent. |
| D5-15 | Deny another business | PARTIAL | Wrong-actor denial is tested; separate-business D5 journey absent. |
| D5-16 | Deny another market | PASS | D5 integration test returns no context for the other market. |
| D5-17 | Create truthful marketing text without publishing | PARTIAL | Prompt context is gated; no model generation/publication journey. |
| D5-18 | Handle a service listing | BLOCKED | No D5 employee workflow. |
| D5-19 | Handle a vehicle listing | BLOCKED | No D5 employee workflow. |
| D5-20 | Handle bulk industrial/business inquiry | PARTIAL | Existing G2/business tests pass; no D5 employee path. |
| D5-21 | Multi-turn correction and resumption | BLOCKED | No D5 task/draft state. |
| D5-22 | Tool failure followed by safe retry | PARTIAL | Existing G2 regressions pass; no D5 employee retry journey. |
| D5-23 | Reject malicious customer prompt injection | PARTIAL | Existing G2 injection tests pass; D5 catalog-content injection not tested. |
| D5-24 | Match response to database and audit evidence | PARTIAL | Existing D4 service audits reads; new D5 audit evidence is not asserted. |
| D5-25 | Browser reload preserves authorized state and blocks stale actions | NOT_RUN | No D5 browser run; no UI change was made. |

## Runtime and browser evidence

The API server workflow was restarted, but the configured workflow runs from `/home/runner/workspace/artifacts/api-server`, separate from this nested target checkout. Its successful startup is not D5 runtime evidence for the tested source SHA. No target-checkout Chromium/browser acceptance was run. No screenshots or production checks are claimed.
