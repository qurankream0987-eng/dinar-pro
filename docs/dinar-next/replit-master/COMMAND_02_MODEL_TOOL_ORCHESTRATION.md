# DINAR NEXT Command 02 — Model/Tool Orchestration

**Status:** PASS for the implemented bounded path; PARTIAL for the full Command 02 matrix
**Tested implementation SHA:** `15808607810983dd1bbc277f74c45d6687b56e3f`

## Implemented behavior

The ordinary structured model response may now propose two or three task steps. A server-side validator accepts a proposal only when each item is a 2–400-character, exact, ordered excerpt of the current user message, and the text between excerpts is punctuation/spacing or a narrowly allowlisted neutral connector. It rejects invented or reordered text and rejects plans when the original message contains recognized conditional language.

An accepted proposal is handed to DINAR's existing `executeTaskPlanTurn` path. It is not executed by the model as a tool call: DINAR builds the existing bounded task plan, runs one step at a time through the usual runtime, and retains the pending step through the established task-plan state. Continuing with `التالي` re-enters the runtime without another model call. This avoids an additional paid planning/classification request.

Safety cases added or strengthened:

- `SHADOW` does not persist or execute a model-proposed plan.
- Conditional future purchases do not become a queued purchase or a purchase review merely because the model supplied `canonicalRequest` or `REVIEW_PURCHASE`.
- Accepted plans suppress the single-action fallback paths for that turn; the task steps proceed through existing canonical handlers.
- Invalid plans are discarded; the model does not gain authority from malformed or ungrounded output.

## Capability record

- **Requirements:** Command 02 §§09–11 and §14.
- **Modified files:** `artifacts/api-server/src/ai/model-turn.ts`, `artifacts/api-server/src/ai/smart-turn.ts`, `artifacts/api-server/src/ai/conversation-runtime.ts`, `artifacts/api-server/test/model-native-routing.test.ts`.
- **Functions/contracts:** `ModelTurnOutput`, `groundedTaskPlan`, `executeModelFallback`, `executeTaskPlanTurn`, `executeRuntime`.
- **Tests:** MN-05 verifies SHADOW; MN-07 verifies a seller draft followed by a canonical buyer search; MN-08 rejects invented clauses and a conditional purchase bypass; MN-01–MN-04 and MN-06 protect existing routing/decision behavior. `bounded-multistep.test.ts` also passes.
- **Environment:** Scripted model gateway; API tests against a fresh local disposable PostgreSQL database; no live provider.
- **Tested code SHA:** `15808607810983dd1bbc277f74c45d6687b56e3f`.
- **Status:** PASS for these controlled cases.
- **Provider dependency:** A permitted live provider is required to validate model-produced plans on natural user language.
- **Limitations:** The first supported plan is sequential and bounded to three steps. This does not prove complex dependencies, business delegation, supplier workflows, general-question-plus-commerce orchestration, or all compound-request examples.

## Distinguish proposals from actions

The model output is a proposal. A task step is performed only when DINAR's existing handler returns its actual result. A purchase, publication, contact, payment, or other consequential action remains subject to its existing authorization and confirmation rules; the model cannot report success based solely on its own text.
