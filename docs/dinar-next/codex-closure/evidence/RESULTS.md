# Recorded verification results

Counts describe each recorded run. Repeated runs overlap and must not be summed as unique tests.

| Run | Suites | PASS | FAIL | SKIP | Outbound | Nonzero/missing suites | Complete |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| closure-regression | 55 | 498 | 4 | 1 | 0 | 7 | False |
| closure-regression-authority-final | 7 | 120 | 2 | 0 | 0 | 1 | True |
| closure-regression-browser-retry | 2 | 1 | 1 | 0 | 0 | 1 | True |
| closure-regression-commission-seeded | 1 | 1 | 0 | 0 | 0 | 0 | True |
| closure-regression-deepseek-browser | 1 | 19 | 2 | 0 | 0 | 1 | True |
| closure-regression-delivery | 99 | 734 | 11 | 7 | 0 | 9 | True |
| closure-regression-final | 26 | 237 | 4 | 0 | 0 | 3 | False |
| closure-regression-negotiation-final | 2 | 50 | 0 | 0 | 0 | 0 | True |
| closure-regression-numeric | 15 | 47 | 4 | 0 | 0 | 5 | True |
| closure-regression-supplement | 6 | 10 | 1 | 0 | 0 | 4 | True |
| closure-regression-verified | 29 | 263 | 5 | 0 | 0 | 3 | False |

## Deterministic laboratories

| Run | Cases | PASS | FAIL | NOT_EXECUTABLE_DET | Complete |
| --- | ---: | ---: | ---: | ---: | --- |
| A | 500 | 368 | 30 | 102 | True |
| A-delivery | 500 | 370 | 27 | 103 | True |
| A-final | 500 | 368 | 30 | 102 | True |
| A-verified | 500 | 368 | 30 | 102 | True |
| H5 | 30 | 28 | 2 | 0 | True |
| H5-final | 30 | 28 | 2 | 0 | True |
| H5-handoff | 30 | 30 | 0 | 0 | True |
| H5-verified | 30 | 30 | 0 | 0 | True |

All lab runs are deterministic with model calls blocked. None establishes live provider quality. The exact case IDs, categories, per-turn outputs, source notes and preserved earlier red runs are in results.json and the raw archive.

## Additional validation

- PostgreSQL18 release migrations: 12/12 after installing required pg_trgm; first missing-extension run retained.
- PostgreSQL18 authority, fresh readiness, financial and three browser suites passed (source predates final search/allowance-only refinements; migration/schema/financial paths unchanged).
- Frontend surfaces35/35, guest handoff9/9, DeepSeek stream/richtext19/19.
- Final typecheck/API build passed. Final DB-guard8/8 and secret scan1/1.
- Configured Arab-market/flexible-pricing3/3; pricing invariants5/5; seeded commission acceptance1/1; unseeded synthetic legal acceptance1/1.
- Source-binding negative control failed as required when canonical binding was broken; original source restored.
- Universal negotiation acceptance38/38 and employment12/12 pass on final runtime source.
- Explicit allowance-exhaustion intent passes, but the original USG-P12 contextual test remains failed.
- Early test/setup errors remain recorded. See HANDOFF.md for known oracle/fixture limitations.
