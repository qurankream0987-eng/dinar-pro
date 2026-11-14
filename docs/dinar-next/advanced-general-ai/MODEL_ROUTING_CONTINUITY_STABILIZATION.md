# JassimAI model-routing continuity stabilization

Date: 2026-11-14

## Handoff

- Isolated branch: `replit/jassimai-model-continuity-stabilization`
- Starting commit for this acceptance pass: `fe56c4345ef1c4cc50a32f4f4d83c313be2781be`
- Scope: local code and evidence only; no push, merge, deployment, live model call, or production/staging data.

## Confirmed routing defect

The catalog router required tool support but did not require the catalog model's structured-output qualification. Every conversational model turn sends DINAR's strict `dinarConversationTurn` tool schema. A scripted ECONOMY candidate marked as not qualified for structured output was nevertheless selected and called.

The regression test was run before and after the fix:

- Before: the new J11 case routed to the incompatible ECONOMY model and returned its scripted answer.
- After: J11 returns the existing no-capacity response and records zero model calls.

The router now requires both tool and structured-output qualification. No catalog entries, provider settings, prices, or paid-call permissions were changed.

## Persisted conversation check

J12 sends four turns through one persisted conversation while changing the preference `AUTO → ECONOMY → CORE → AUTO`. It verifies that the conversation ID stays unchanged and that each captured prompt contains an earlier user fact and the preceding model's answer, including after switching back to FREE. The test uses scripted gateways only.

## J15 cross-model marketplace continuity

J15 extends the model-routing acceptance through a real persisted marketplace result set. It uses a signed-in Business Pro test account, seven synthetic car listings, and scripted model gateways:

- A deterministic search returns the three synthetic cars under 5,000. Six unrelated turns route `AUTO (FREE) → ECONOMY → CORE → ADVANCED → ECONOMY → AUTO (FREE)`.
- Each turn stays in the same conversation; the test checks the exact selected gateway and that each later model prompt contains the preceding model's reply. The original server-side result-set ID and listing IDs remain unchanged through all six switches.
- `ورني تفاصيل الثاني` opens the second listing from that set. A comparison returns the first two IDs in order, and returning to the car topic restores the same listing IDs.
- A second search returns seven cars under 20,000. After an unrelated ECONOMY answer, `طيب خلها لين 18 ألف` narrows the same budget results to five IDs, keeps all five cars under 18,000, and excludes both higher-priced cars.

The Business Pro subscription and listings exist only in the disposable test database; no payment or ledger history is created. The marketplace search and price correction are deterministic, and the model responses are scripted. The J15 suite passes 26/26 with zero outbound attempts.

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
- J9 verifies the disabled premium-trial path stays on the normal route and consumes no trial message. The G1 usage suite also exercises the enabled, one-time 15-message trial for a signed-in FREE account: a pre-dispatch refusal releases its slot, a dispatched failure consumes one, concurrent final reservations allow only one request, and exhaustion is enforced. A guest is explicitly denied the premium trial; guest free allowance and account behavior remain separate.
- J12 and the multi-turn continuity suite verify that model changes do not change conversation identity or lose earlier facts and replies.
- J15 verifies that an unrelated answer on another model does not replace the active marketplace result set.
- D17.7 rechecks 100, 1,000, and 10,000-message histories, bounded memory summaries, and concurrent reads/writes.

## Chat model-choice assessment

The current UI sends `DEFAULT` or an explicitly selected `PREMIUM_TRIAL`; it does not present a general model/provider picker. The documented routing policy is automatic and owner-controlled, with the premium trial off by default. The missing general picker is therefore a deferred product feature, not a continuity defect in the current UI contract.

## Verification

- Earlier disposable loopback PostgreSQL suites: `advanced-general-ai.test` **14/14**; `model-tiers.test` **25/25**; `free-routing-activation.test` **5/5**; `wave06-conversation-memory-performance.test` **5/5**; `ai-provider.test` **48/48**.
- Final focused reruns after J15: `model-routing.test` **26/26**; `context-sealed.test` **1/1**; `context-understanding.test` **3/3**; `premium-journeys.test` **5/5**; `multiturn-continuity.test` **12/12**; `next-g1-usage.test` **36/36**. `pnpm --filter @workspace/api-server run typecheck` passed.
- `deepseek-chat-compatibility.test`: **15 passed, 6 skipped** (browser-only cases are gated); its replayed compatibility cases use local fixtures.
- All completed isolation preludes and suites, including the focused reruns, reported **0 outbound attempts**. No live provider, paid usage, production/staging data, push, merge, or deployment was used.
- Browser acceptance did not reach Chromium: the isolated checkout lacked Vite, and the offline package cache lacked `maplibre-gl@5.6.0`. No online install was attempted.
- `git diff --check`: passed.
- The new context regression was run red before the fix (**2 failing tests**) and green afterward. Raw evidence logs are retained under `generated-artifacts/dinar-model-continuity/`, excluded from Git and deployment.

## Limits

No provider-specific tokenizer or exact provider-side request serialization is available in this path. The UTF-8 byte method is an estimate, not an exact count or a guarantee of provider-tokenizer accuracy; live-provider fit and Arabic response quality remain unverified. Do not treat this local work as approval to enable a new model, paid route, or deployment.

## Bounded real-provider plan (not executed)

No exact owner-approved chat-routing model IDs are checked into this branch. The checked-in default routing policy is disabled with an empty model catalog; the exact free-model allowlist is owner-configured through `DINAR_APPROVED_FREE_OPENROUTER_MODELS`, and market model catalogs are owner-controlled. I did not inspect secrets or query development, staging, or production for IDs, so no model names are guessed here.

If a real-provider pass is separately approved:

1. Use only exact IDs already approved in the development routing catalog, with approved prices, tool/structured-output support, and the correct account-tier eligibility. Reject dynamic aliases and stop if the provider substitutes a different model.
2. Use one disposable Business Pro account, one conversation, and synthetic listings in a fresh loopback database. Keep search and price correction deterministic; make at most six provider dispatches for `FREE → ECONOMY → CORE → ADVANCED → ECONOMY → FREE`.
3. Disable automatic retries and paid fallbacks for this pass. Enforce the current per-turn reservation ceiling and a separate aggregate budget of at most **$0.36** for the six calls (six times the checked-in default Business Pro cap of $0.06); lower the limit when the approved development policy requires it. Do not run if the provider cannot be constrained to that approved budget.
4. Stop on a model-ID mismatch, budget rejection, schema/tool failure, or context refusal. Record only sanitized request IDs, selected/actual model IDs, token counts, and result-set assertions. Do not use customer data or create orders, payments, promotions, or SMS.

This plan is conditional on explicit approval of the exact model IDs and aggregate spend; it does not authorize execution.

## Claude review focus

Review only this isolated local branch. Check that the conservative estimate and output reservation fail safely without dropping history, that route/HEAVY/guest fallbacks preserve their existing cost and audience gates, and that the UI assessment matches the current product contract. Do not make live model calls or access production/staging data; do not push, merge, or deploy.
