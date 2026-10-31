# QODER 14 → Claude handoff — W02U-3 canonical card reliability

Read `QODER_14_W02U3_CANONICAL_REPORT.md` and `QODER_14_W02U3_CANONICAL_ACCEPTANCE_MATRIX.md` first.
This file is the operational handoff: what to trust, how to re-run, and where the remaining risk is.

## Branch / commits

- Baseline: `9a0f86f` (`claude/10-ultra-closure`).
- Branch: `qoder/14-w02u3-canonical-reliability`, head `683e1da`.
- Implementation commit: `be1c9dd`. RED tests commit: `eaadf0f`.
- Draft PR is open against `claude/10-ultra-closure`; **not merged**. Do not merge without the
  owner's decision.

## The three behavioural changes (and their boundaries)

1. **Cross-tab invalidation** — `artifacts/dinar/src/features/ai/card-sync.ts`.
   The channel is `dinar:card-sync:v1:<userId>:<marketId>`; the event has exactly
   `{type,userId,marketId,conversationId,issuedAt}` and `parseCardSyncEvent` refuses anything else.
   The receiver only calls `refreshConversationData`; no card content crosses tabs. If you extend the
   event, update `KEYS` and the unit test together.

2. **Lost-turn reconciliation** — `reconcileDeliveredTurn` in `Ai.tsx`, fed by `deliveryUnknown` marks
   in `ai-api.ts`.
   - Answered turn (a later ASSISTANT message exists) → adopt the server transcript.
   - Delivered, unanswered → `verifyingTurn` + Arabic notice + **تحقق من النتيجة** button.
   - Absent → retry with the same `clientMessageId`.
   HTTP 409 from a replay takes the same path. Do not convert this into an optimistic local append;
   the server record is the only authority.

3. **Expiry re-read** — a timer at `expiresAt + 1s` requests a server re-read only. It never extends,
   executes or edits a review; the server returns EXPIRED.

Adoption of server messages is timestamp-guarded and blocked while a turn is streaming, sending,
creating, failed or being verified, so a slow refetch cannot roll back an in-flight turn.

## How to re-run (cloud-only)

```bash
gh workflow run qoder-api-suite.yml \
  --repo qurankream0987-eng/dinar-pro \
  --ref qoder/14-w02u3-canonical-reliability \
  -f suite=w02u3-card-reliability-browser-journey.test \
  -f "flags=BDINAR_W02U3_BROWSER=development"
```

```bash
gh workflow run qoder-api-suite.yml \
  --repo qurankream0987-eng/dinar-pro \
  --ref qoder/14-w02u3-canonical-reliability \
  -f suite=w02u3-card-reliability.test \
  -f "flags=BDINAR_W02U3_TEST_DATABASE=development"
```

Dispatches on the same branch are serialised by the workflow concurrency group; run them one at a
time. Each run typechecks, builds api-server and web, runs `test:surfaces`, and then one isolated
suite on a fresh disposable database with `env -i`, the net-guard and an outbound counter. Expected
tail: `LOCAL_SUITE suite=… exit=0 outbound=0`.

Regressions that are green on this branch: `wave03-card-envelope.test`,
`w02-ultra-cards.test`, `wave03-card-envelope-browser-journey.test` (run IDs in the report).

`w02-ultra-browser.test` cannot run in this workflow: the Chromium install step is gated on suite
names containing `browser-journey`/`security-acceptance`, so it launches a missing
`chromium_headless_shell-1243`. If you need it, either widen that condition or pass an executable
path via `DINAR_CHROMIUM`; do not read its absence as a product failure.

## Known gaps (do not overclaim)

- CR-04/CR-05 (account switch / re-login with a card visible) are implemented via scope reset and
  proven only at the API layer (CR-12). A dedicated browser test is the next useful addition.
- The client expiry re-read has no short-TTL browser test.
- CR-15 has no benchmark.
- No screen-reader (AT) session; only accessible names/focus order are asserted.
- The "verify" button state (`verifyingTurn`) is exercised only by the delivered-unanswered server
  path in unit-level logic; the browser run covers the answered reconciliation branch.

## Invariants you must preserve

- One card runtime: the server envelope. No new registry, ledger, receipt store or optimistic card.
- Pending-action execution stays server-authoritative (UNDERSTAND → REVIEW → CONFIRM → RE-READ →
  EXECUTE); the client never weakens `sameState`, expiry, ownership or market checks.
- Do not add migrations in this branch; the 0041 conflict is for the integration step.
- Keep the sync event metadata-only; the strict parser is part of the security boundary
  (forged broadcast/localStorage is ignored — see CR-12).
- Keep `outbound=0` in the isolation runner; do not reach providers in these tests.
