# JassimAI model-routing continuity stabilization

Date: 2026-11-14

## Handoff

- Isolated branch: `replit/jassimai-model-continuity-stabilization`
- Base: `origin/claude/jassimai-ads-connect-closure` at `ddfa15d83f6bfb781ac36e63d7ab7def119f8a3d`
- Scope: local code and evidence only; no push, merge, deployment, live model call, or production/staging data.

## Confirmed routing defect

The catalog router required tool support but did not require the catalog model's structured-output qualification. Every conversational model turn sends DINAR's strict `dinarConversationTurn` tool schema. A scripted ECONOMY candidate marked as not qualified for structured output was nevertheless selected and called.

The regression test was run before and after the fix:

- Before: the new J11 case routed to the incompatible ECONOMY model and returned its scripted answer.
- After: J11 returns the existing no-capacity response and records zero model calls.

The router now requires both tool and structured-output qualification. No catalog entries, provider settings, prices, or paid-call permissions were changed.

## Persisted conversation check

J12 sends four turns through one persisted conversation while changing the preference `AUTO → ECONOMY → CORE → AUTO`. It verifies that the conversation ID stays unchanged and that each captured prompt contains an earlier user fact and the preceding model's answer, including after switching back to FREE. The test uses scripted gateways only.

## Verification

- Disposable loopback PostgreSQL `model-routing.test`: **23 passed, 0 failed**; isolation prelude and suite reported **0 outbound attempts**.
- `pnpm run typecheck:libs`: passed.
- `pnpm --filter @workspace/api-server run typecheck`: passed.
- `git diff --check`: passed.
- Raw pre-fix and post-fix suite logs are retained under `generated-artifacts/dinar-model-continuity/` and excluded from Git and deployment.

## Not claimed

The planner still compares the policy's projected input-token count with catalog context windows before the final prompt is assembled. This local work did not establish provider-specific token counts or prove that every possible prompt fits every candidate model. No model tokenizer or live endpoint was used; context-window fit remains unverified and should not be treated as approved.
