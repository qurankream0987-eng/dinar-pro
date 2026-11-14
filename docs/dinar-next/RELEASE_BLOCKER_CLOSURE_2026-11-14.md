# JassimAI — release blocker closure (2026-11-14)

Branch `claude/jassimai-release-candidate` (local, not pushed). Feature freeze. Disposable
loopback databases only; no Railway, SMS, payments or market activation.

## Final test inventory (290 files, candidate `d7bb060` + search reconciliation `77f7281`)

| Result | Files | Tests |
|---|---|---|
| PASS | 285 | 2,309 |
| FAIL | 3 | 3 |
| BLOCKED | 2 | — |
| Not executed / timed out | 0 | 0 |

The first battery pass hit a PostgreSQL recovery window after a worker restart (174 files exited
in seconds with "the database system is starting up"); all 174 were rerun on the same SHA.

## Root causes found and fixed

| Area | Root cause | User impact | Fix |
|---|---|---|---|
| SC01/03/10, followup-SC01, phase2, pre-switch, market-legal | Run configuration: CI-supplied flags/seeds/databases missing in local reruns | None (product correct) | Correct setup; all pass |
| phase1 | «خليها أقل من 18 ألف» kept the verb in the search text → fell to the model | Buyers could not narrow results with a common phrasing | `20351a1` |
| pre-switch | Leading «جاسم» stripped as an address also turned «جاسم بزنس» into «بزنس» | Plan inquiry reached the model | `dcfb3ff` |
| AI-F07 | Re-reading a compared listing discarded the comparison (search keeps results in the same case) | «أي جوال أفضل؟» could end on one listing instead of the comparison | `320c252` (+ AI-F07b for the outside-read case) |
| command-e-ui | Reduced motion left a 0.01 ms transition on the conversation surface | Accessibility rule not fully applied | `d7bb060` |
| command-e-ui harness | `route.abort` on an already-handled request crashed the run | None | `d7bb060` |
| search-sql-foundation | Pre-C1 golden predates the condition filter | None (used-only requests now exclude new items, proven) | `77f7281` keeps the historical golden and asserts only that documented change |
| contact-browser | Contact and payment became draft defaults (documented) | None; consent assertions unchanged | `8718d4b` |

## Remaining

| File | Status | Reason | Release-critical |
|---|---|---|---|
| hostile-input-performance (HIP-03) | FAIL | One spam input's reading differs from a hash-only golden; cannot prove the new reading correct, so the golden is not changed | No (speed/safety checks pass) |
| storage-s3-wire, storage-portability | FAIL (environment) | The isolation guard refuses the virtual-hosted test hostname before its loopback DNS hook; not bypassed | Yes — must pass in CI against real S3 before production |
| personal-intelligence | BLOCKED | Needs its own PostgreSQL on 55479 and a database URL the runner refuses | Should run in CI |
| g33-docker-acceptance | BLOCKED | Needs the CI compose harness (handshake directory, external API base) | Should run in CI |

Known minor gap (not tested, not fixed under the freeze): «جاسم جو» alone is not recognised as a
plan inquiry.

## Verdicts

- **Staging: GO** for the tested scope, with providers on mocks.
- **Production: NO-GO** until storage passes against real S3, the two blocked suites run in CI,
  and live SMS / payments / AI providers are verified with owner approval.
