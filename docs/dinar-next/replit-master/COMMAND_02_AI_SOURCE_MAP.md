# DINAR NEXT Command 02 — AI Source Map

**Overall status:** PARTIAL
**Repository branch:** `replit/dinar-next-complete-development`
**Starting SHA:** `5fd1f41bbfeb54fd704c838be32b0dbd7665d098`
**Tested implementation SHA:** `15808607810983dd1bbc277f74c45d6687b56e3f`

This is the verified source trace for the existing DINAR conversation path, with the Command 02 change called out separately from previously existing behavior.

| Stage | Existing source and responsibility | Command 02 result |
|---|---|---|
| INPUT | `artifacts/api-server/src/routes/ai.ts` accepts authenticated conversation turns; the established conversation APIs own identity and session boundaries. | Reused unchanged. |
| Context and routing | `artifacts/api-server/src/ai/conversation-runtime.ts` builds the turn context and selects the existing deterministic/runtime/model routes. | Reused. The runtime now also receives an accepted model task proposal. |
| MODEL | `artifacts/api-server/src/ai/model-turn.ts` defines the structured `ModelTurnOutput`, model tool schema, and system guidance. `artifacts/api-server/src/ai/smart-turn.ts` calls the configured gateway and validates the response. | Added optional `plannedSteps` to the existing response contract and prompt. No second classifier/planner call was added. |
| TOOL | `conversation-runtime.ts` re-enters the ordinary conversation runtime for each task-plan step. | Reused the bounded task-plan execution path; model proposals do not become arbitrary tool names or commands. |
| AUTHORITY | Existing runtime routes each step through the same actor/market checks, deterministic handlers, and confirmation/review flows. | Reused; a proposed plan does not bypass canonical authorization. |
| RESPONSE | Existing `TurnExecution` and typed conversation surfaces produce the user-visible result. | The first supported step produces the normal DINAR response and indicates a remaining step when the existing task-plan runtime does so. |
| PERSISTENCE | Existing `artifacts/api-server/src/ai/task-plan.ts` and conversation persistence retain bounded task progress. | Reused; no new table or migration was introduced. |

## Implemented capability record

- **Requirement:** Command 02 §09, bounded compound-task planning; §10, trusted tool execution; §14, model output must not acquire server authority.
- **Exact modified files:** `artifacts/api-server/src/ai/conversation-runtime.ts`, `artifacts/api-server/src/ai/model-turn.ts`, `artifacts/api-server/src/ai/smart-turn.ts`.
- **Functions/contracts modified:** `ModelTurnOutput`, `MODEL_TOOL`, `SYSTEM_PROMPT`, `executeModelFallback`, `executeTaskPlanTurn`, and the runtime model-fallback path.
- **Tests:** `model-native-routing.test.ts` (MN-01–MN-08); `bounded-multistep.test.ts`.
- **Environment:** Local isolated PostgreSQL via `test/isolation/local-suite.sh`; model gateway injected with scripted responses; no external provider call; outbound attempts reported as zero.
- **Tested code SHA:** `15808607810983dd1bbc277f74c45d6687b56e3f`.
- **Status:** PASS for the controlled, bounded seller-draft-then-buyer-search path and its negative cases; overall mission remains PARTIAL.
- **Provider dependency:** A live, owner-authorized external model is required to evaluate actual language understanding. None was called for this work.
- **Limitations:** This does not establish broad general-answer quality, multi-dialect performance, all 35 acceptance categories, or live provider behavior. See `COMMAND_02_REMAINING_GAPS.md`.

No database migration, API OpenAPI contract, client-generated contract, or Codex-owned UI file changed.

## Command 02B source update

**Starting SHA:** `6c54e8013fd409a03dab45e0a10f1612d3729cb4`
**Implementation/test commit:** `792d0f4da3500d00915e178d73f713d2a822a8be`

| Stage | Verified source path | 02B behavior |
|---|---|---|
| Input/stream | `artifacts/api-server/src/routes/ai.ts`; `artifacts/dinar/src/features/ai/ai-api.ts` | Existing authenticated conversation endpoint and SSE response remain in place. |
| Model | `artifacts/api-server/src/ai/model-turn.ts`; `smart-turn.ts` | Existing structured turn now carries optional, bounded `plannedSteps`; provider output remains untrusted. |
| General vs. DINAR routing | `artifacts/api-server/src/ai/commerce-turn.ts` | Current-demand questions without DINAR market scope can reach the general model; explicit DINAR market scope remains data-backed. The model prompt forbids claiming live data. |
| Plan/runtime | `artifacts/api-server/src/ai/conversation-runtime.ts`; `task-plan.ts` | Conditional future steps persist as blocked; a failed step halts later work; only a failed read-only search may be retried. |
| Authority/result | Existing `executeAiConversationTurn` handlers and canonical services | Each executed step re-enters the ordinary server runtime. A plan does not create a second tool authority. |
| Persistence | Existing conversation message metadata and result surfaces | No table or migration added. Cancellation and failed-step state remain attached to the saved plan. |

The 02B source changes are limited to the paths above plus acceptance tests and removal of the duplicate `test:w07` script key. Verification and remaining blockers are recorded in `COMMAND_02_ACCEPTANCE_EVIDENCE.md` and `COMMAND_02B_SOURCE_AND_SC_TRACEABILITY.md`.
