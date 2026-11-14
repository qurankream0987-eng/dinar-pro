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

## Context-window dispatch safety

The earlier route planner compared a projected input count with a catalog model's context window before the final messages and tool schemas were assembled. The shared gateway boundary now checks each assembled request immediately before dispatch:

- It estimates input from the serialized UTF-8 bytes of the actual messages and tool schemas, plus a per-message/tool framing allowance.
- It reserves the gateway's configured maximum output tokens (8,192 by default); it refuses with `CONTEXT_TOO_LARGE` when input estimate plus output reserve exceeds the catalog window.
- Catalog window metadata follows each route candidate into its gateway. A refusal is local: no provider request or provider-call charge is recorded.
- A too-small primary or HEAVY model is skipped; a configured fallback is tested against its own window, and an over-context separate HEAVY model can fall back to LIGHT.
- No history is silently trimmed. Existing recent-turn selection and D17 retrieval/summaries remain unchanged. The user receives Arabic copy that this over-context attempt was not sent and the current history was preserved.

AG13/J13 reproduce the over-context dispatch and then verify the request is refused before the scripted gateway is called; J13 also confirms the request reservation is released with zero charged requests. J14 verifies the same safe refusal for guests without paid fallback. AG14 verifies an undersized primary is skipped for a fitting fallback. DT-14b verifies the same behavior across separate HEAVY and LIGHT tiers and checks that only the sent LIGHT request is billed.

## Guest/free and continuity checks

- J7 and the free-routing activation tests verify that guests stay on eligible free routes and do not silently use paid capacity.
- J9 verifies the disabled premium-trial path stays on the normal route and consumes no trial message; the enabled 15-message lifecycle was not exercised in this local pass.
- J12 and the multi-turn continuity suite verify that model changes do not change conversation identity or lose earlier facts and replies.
- D17.7 rechecks 100, 1,000, and 10,000-message histories, bounded memory summaries, and concurrent reads/writes.

## Chat model-choice assessment

The current UI sends `DEFAULT` or an explicitly selected `PREMIUM_TRIAL`; it does not present a general model/provider picker. The documented routing policy is automatic and owner-controlled, with the premium trial off by default. The missing general picker is therefore a deferred product feature, not a continuity defect in the current UI contract.

## Verification

- Disposable loopback PostgreSQL suites: `advanced-general-ai.test` **14/14**; `model-routing.test` **25/25**; `model-tiers.test` **25/25**; `free-routing-activation.test` **5/5**; `multiturn-continuity.test` **12/12**; `wave06-conversation-memory-performance.test` **5/5**; `ai-provider.test` **48/48**.
- `deepseek-chat-compatibility.test`: **15 passed, 6 skipped** (browser-only cases are gated); its replayed compatibility cases use local fixtures.
- All completed isolation preludes and suites reported **0 outbound attempts**. No live provider, paid usage, production/staging data, push, merge, or deployment was used.
- `pnpm --filter @workspace/api-server run typecheck`: passed; `git diff --check`: passed.
- The new context regression was run red before the fix (**2 failing tests**) and green afterward. Raw evidence logs are retained under `generated-artifacts/dinar-model-continuity/`, excluded from Git and deployment.

## Limits

No provider-specific tokenizer or exact provider-side request serialization is available in this path. The UTF-8 byte method is an estimate, not an exact count or a guarantee of provider-tokenizer accuracy; live-provider fit and Arabic response quality remain unverified. Do not treat this local work as approval to enable a new model, paid route, or deployment.

## Claude review focus

Review only this isolated local branch. Check that the conservative estimate and output reservation fail safely without dropping history, that route/HEAVY/guest fallbacks preserve their existing cost and audience gates, and that the UI assessment matches the current product contract. Do not make live model calls or access production/staging data; do not push, merge, or deploy.
