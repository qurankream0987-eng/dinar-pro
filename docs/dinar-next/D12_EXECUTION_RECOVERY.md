# D12 — execution-lease recovery for abandoned actions

Status: **implemented, pending integrated verification** (isolated branch `qoder/closure-12-executing-recovery`).
Baseline: Replit `da3170e38fa1b4d5de4499185907b70709e80f25`.

## 1. Gap

`confirmPendingAction` (and the two business confirmation paths in `business-turn.ts`) commit
`status: "EXECUTING"` before the domain authority runs. Execution happens after that commit, and
the final status write happens after execution. A process that dies in that window leaves a
ledger row that:

- is never settled by the executor (it no longer exists);
- answers every later confirmation with `IN_PROGRESS` / «الإجراء قيد التنفيذ» forever;
- shows the receipt «قيد التحقق من نتيجة التنفيذ» with «لا تكرر الطلب» forever.

Nothing is re-executed today, which is correct. The defect is that the state never resolves, so
the user is stuck and cannot safely retry.

## 2. Invariant

An execution that was claimed but whose result was never recorded is **UNKNOWN**: it is neither
reported as success nor as failure (the authority may have committed before the crash), and it is
**never re-executed** under the same ledger row. The user opens a new review instead.

## 3. Design

- The `EXECUTING` claim now stamps `executingAt` (ISO timestamp) in the ledger query.
- `ACTION_EXECUTION_LEASE_MS` = 2 minutes: longer than any single action authority runs, short
  enough that a crash is not permanent.
- `executionLeaseExpired(row)` is true only for `EXECUTING` rows whose claim is older than the
  lease. A pre-lease claim (no `executingAt`) is stale once its own confirmation window plus one
  lease has passed — an execution cannot still be running that long after its review expired.
- Confirmation of a stale `EXECUTING` row settles it as `UNKNOWN` with an explicit Arabic notice.
  A live claim is still answered `IN_PROGRESS`.
- `settleAbandonedExecutions()` sweeps bounded batches at startup and every 60 s through the
  existing housekeeping interval. Each row is written only while it is still `EXECUTING` **and**
  still carries the claim that was read, so a concurrent completion wins (its `CONFIRMED` is not
  overwritten) and a live execution is never taken over.
- The sweep touches only the action ledgers (`ACTION`, `BUSINESS_ACTION`, `BUSINESS_SETUP`);
  other `ai_result_sets` kinds are never modified.
- Receipts map `UNKNOWN` explicitly: «تعذر التحقق من نتيجة التنفيذ» with a next step that says to
  review the ledger before retrying, and no confirmation button.

## 4. Files

| File | Change |
| --- | --- |
| `artifacts/api-server/src/ai/action-recovery.ts` | new: lease constant, expiry predicate, sweep |
| `artifacts/api-server/src/ai/action-foundation.ts` | stamp `executingAt`; stale claim → `UNKNOWN`; repeat confirm reports `UNKNOWN` |
| `artifacts/api-server/src/ai/action-receipts.ts` | explicit `UNKNOWN` lifecycle and honest receipt text |
| `artifacts/api-server/src/ai/business-turn.ts` | stamp `executingAt`; `UNKNOWN` in settled-decision set and message |
| `artifacts/api-server/src/index.ts` | run the sweep with the existing housekeeping interval |
| `artifacts/api-server/test/d12-execution-recovery.test.ts` | D12-01…D12-06 |
| `.github/workflows/qoder-api-suite.yml` | allowlist the suite |

## 5. What this does not do

- No re-execution, no automatic retry, no fabricated success or failure.
- No new table, migration, queue, worker or infrastructure.
- No change to the authorities (`checkoutForActor`, listing update, negotiation, payments).
- The deal/control cards that predate the receipt keep their existing fallback: an `UNKNOWN`
  control row maps to `EXPIRED` in `refreshControlPayload`. That is a display fallback, never an
  execution claim; the action receipt is the authoritative surface.

## 6. Verification

```
DINAR_LOCAL_PG=postgres://<user>@127.0.0.1:<port> \
  sh test/isolation/local-suite.sh d12-execution-recovery.test BDINAR_TEST_DATABASE=development
```

CI: `.github/workflows/qoder-api-suite.yml`, suite `d12-execution-recovery.test`, flags
`BDINAR_TEST_DATABASE=development`, PostgreSQL 16 and 18, loopback only, `outbound=0`.

Expected evidence: D12-01 stale claim → `UNKNOWN` with no result; D12-02 live claim → `IN_PROGRESS`;
D12-03 sweep settles exactly the abandoned action rows and is idempotent; D12-04 lease boundaries;
D12-05 receipt text; D12-06 repeat confirmation. The suite also asserts zero model calls and zero
outbound requests.

## 7. Integration notes

- The change is additive and self-contained in the action foundation; it does not alter any route
  contract except adding the `UNKNOWN` value to the confirmation outcome, which callers already
  treat through their generic `outcome.message` path.
- A concurrent completion after a takeover writes `CONFIRMED` over `UNKNOWN` (the final write is
  unconditional on the row id), so a late success still appears as success.
- Re-run `d12-execution-recovery.test`, `universal-negotiation-acceptance.test`,
  `ai-provider.test`, `block-f3-commerce.test`, `d4-d5-isolation-security.test` and
  `business-delegations.test` on the integrated SHA.
