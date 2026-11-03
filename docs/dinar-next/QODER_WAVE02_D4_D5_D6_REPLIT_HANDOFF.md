# QODER → Replit Handoff — Wave 02 / D4 + D5 + D6

- Branch: `qoder/wave02-d4-d6-closure`
- Base: `replit/dinar-next-complete-development` at `ae8399b4436c9905a63e9e92ec9b1e1368690d98`
- Canonical synced into the branch during the mission: `11d7fbe3326897924468ee4c6d5467972a92b973`
- Tested head: `e1df415204ebb8f486206e7b8e5ec269b6d6a493`
- Full evidence: `docs/dinar-next/QODER_WAVE02_D4_D5_D6_REPORT.md`
- Scenario mapping: `docs/dinar-next/QODER_WAVE02_D4_D5_D6_ACCEPTANCE_MATRIX.md`

## What this branch contains

- D4/D5 acceptance over real HTTP and PostgreSQL:
  `artifacts/api-server/test/wave02-d4-d5-seller-journey.test.ts` (5 tests).
- D6 acceptance over real HTTP and PostgreSQL:
  `artifacts/api-server/test/wave02-d6-buyer-journey.test.ts` (6 tests).
- Real-Chromium D5 and D6 reload/approval/checkout journeys with responsive assertions:
  `wave02-d5-browser-journey.test.ts` + `wave02-d5-ui.mjs`,
  `wave02-d6-browser-journey.test.ts` + `wave02-d6-ui.mjs`.
- CI allowlist entries for those four suites in `.github/workflows/qoder-api-suite.yml`.
- Migration `0051_order_multi_item_money.sql` plus journal/manifest entries. This is the only product
  change: the canonical checkout creates one order per seller with several line items, and the old
  order-level check rejected any cart with more than one line.
- Documentation only in this handoff/report/matrix.

No server or web source file was modified. No new runtime, database, payment path, cart engine or
business service was introduced. The branch was not merged or deployed.

## Integration steps

1. Review `0051_order_multi_item_money.sql` and confirm the release manifest hash
   `e99dce44bbb6cc81d0686c8193859e102b3a22076c4812af28ebdfde04adad24`.
2. Apply migration 0051 through the normal Replit release path. Do not skip it: without it, any
   same-seller multi-line checkout fails at the database.
3. Merge the branch through review (never directly into `main`), or cherry-pick the migration plus
   the four suites if only the tests are wanted.
4. Re-run the acceptance and regression commands with the flags listed in §8 of the report.
5. `ai-foundation` is green on the merged head (run `41550309349`); its earlier red was fixed by
   canonical `11d7fbe`. Do not attribute the historical red to this branch.

## Evidence summary

All runs are on the merged tested head `e1df415`.

| Area | Run | Result |
| --- | --- | --- |
| D4 + D5 API | `41550226803` | 5/5, outbound=0 |
| D6 API | `41550234059` | 6/6, outbound=0 |
| D6 browser | `41550249631` | 1/1, 10 checks, clean arrays |
| D5 browser | `41550242626` | 3/3, 14 checks, clean arrays |
| Card reliability regression | `41550256971` | 9/9 |
| D4/D5 authorization chain | `41550283195` | 4/4 + 3/3 + 8/8 |
| D6/G2/negotiation chain | `41550290381` | 8 suites, first_failed=none |
| Security acceptance | `41550297039` | 12/12 |
| Commerce journey | `41550303484` | 8/8 |
| AI foundation | `41550309349` | 13/13 + 4/4 + 3/3 |

Every cited run executed typecheck, both builds and the web surface protocol tests (32/32) and
reported `outbound=0`.

## Known blockers

- No current automated-suite blocker on the merged head. The historical `ai-foundation` red
  (AI-F04/F05/F07/F11/F12) was fixed by canonical `11d7fbe`, which this branch includes.
- No live AI provider was used; scripted model output proves authority boundaries, not Arabic model
  quality.
- No merge, deployment, production database, real payment or screen-reader claim is included.
