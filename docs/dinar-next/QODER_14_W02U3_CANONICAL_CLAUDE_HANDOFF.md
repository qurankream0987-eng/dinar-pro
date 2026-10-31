# QODER 14 → Claude handoff — W02U-3 canonical card reliability

Read `QODER_14_W02U3_CANONICAL_REPORT.md` and `QODER_14_W02U3_CANONICAL_ACCEPTANCE_MATRIX.md` first.
This file is the operational handoff: what to trust, how to re-run, and where the remaining risk is.

## Branch / commits

- Baseline: `9a0f86f` (`claude/10-ultra-closure`).
- Branch: `qoder/14-w02u3-canonical-reliability`, final tested head `b5a3772`.
- Implementation commit: `be1c9dd`. RED tests commit: `eaadf0f`.
- Acceptance closure (`683e1da..b5a3772`): test-only plus one Chromium install line
  (`e869a1e`); six new browser journeys (sessions, expiry, recovery, concurrency, performance,
  accessibility) and their wrappers. The documentation commit on top of `b5a3772` changes no code.
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

The acceptance journeys use the same entry point: `w02u3-card-sessions-browser-journey.test`,
`w02u3-card-expiry-browser-journey.test`, `w02u3-card-recovery-browser-journey.test`,
`w02u3-card-concurrency-browser-journey.test`, `w02u3-card-performance-browser-journey.test` and
`w02u3-card-accessibility-browser-journey.test`, each with
`-f "flags=BDINAR_W02U3_BROWSER=development"`.

Dispatches on the same branch are serialised by the workflow concurrency group; run them one at a
time. Each run typechecks, builds api-server and web, runs `test:surfaces`, and then one isolated
suite on a fresh disposable database with `env -i`, the net-guard and an outbound counter. Expected
tail: `LOCAL_SUITE suite=… exit=0 outbound=0`.

Regressions green on `b5a3772`: `wave03-card-envelope.test` `41246654084`,
`wave03-card-envelope-browser-journey.test` `41246826500`, `w02-ultra-cards.test` `41247096828`,
`w02-ultra-browser.test` `41247269702`, `api.test` `41247620760`, `conversation.test` `41249383853`,
`commerce.test` `41249618801`, `security-acceptance.test` `41249857637`.

`w02-ultra-browser.test` now runs in this workflow: `e869a1e` widened the Chromium install condition
for that suite, and `41247269702` is green. The earlier run `41223814591` failed only because the
browser was not installed; that is environmental, not a product failure.

## Known gaps (do not overclaim)

- CR-04/CR-05 are browser-proven: `w02u3-card-sessions-browser-journey.test` (run `41245502937`)
  holds A's re-read while the account switches, proves B inherits nothing and the backend 404s B's
  read/turn, then proves A's re-login restores the server's CONFIRMED card and history.
- The client expiry re-read is browser-proven with a short-TTL fixture (run `41245718734`), including
  the "no turn POST during the automatic refresh" assertion. The production expiry rule was not
  changed.
- The "verify" button (`verifyingTurn`) is now browser-clicked: `w02u3-card-recovery-browser-journey`
  (run `41245889451`) covers delivered-but-unanswered verify/adopt and the absent-turn retry with the
  original `clientMessageId`.
- CR-15 is benchmarked (run `41246348213`): medians ≤ 477 ms, p95 ≤ 485 ms, 40-bubble window,
  ~522 DOM nodes from 40 to 500 messages.
- Screen reader: `AT_MANUAL_BLOCKED` (run `41244786883`); keyboard/focus/names/announcement regions
  are asserted, spoken output is not. Remaining manual checklist: NVDA + Firefox (Windows),
  VoiceOver + Safari (iOS), TalkBack + Chrome (Android), and an announcement review of the busy state
  and the settled card.
- Two-tab confirmation is browser-proven with both POSTs held before either answer (run
  `41246114023`); one effect, convergence and clean reloads are asserted.

## Invariants you must preserve

- One card runtime: the server envelope. No new registry, ledger, receipt store or optimistic card.
- Pending-action execution stays server-authoritative (UNDERSTAND → REVIEW → CONFIRM → RE-READ →
  EXECUTE); the client never weakens `sameState`, expiry, ownership or market checks.
- Do not add migrations in this branch; the 0041 conflict is for the integration step.
- Keep the sync event metadata-only; the strict parser is part of the security boundary
  (forged broadcast/localStorage is ignored — see CR-12).
- Keep `outbound=0` in the isolation runner; do not reach providers in these tests.
