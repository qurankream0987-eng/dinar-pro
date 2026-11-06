# Final test evidence

Fresh complete inventory frozen at `c2a8717e1f345b4c9a2c5f39ae5a41b6e868ad82`; the later explicit-local-preview CSP correction is separately qualified at final code/test cut `9101672a7370bb8080e598344840d1fde2f88291`. Delivery adds documentation/evidence plus two exact historical scanner fingerprints for reviewed documentation false alarms; application, contracts and SQL remain unchanged. All counts are actual executions, not a union of historical success claims.

| Gate | Actual result and source |
| --- | --- |
| Fresh full regular inventory | 350 executions at C2A: 347 suite passes / 3 raw failures; 3,527 passing case executions / 6 failing assertions / 2 TLS skips. One raw failure is pre-test PG version refusal. No earlier suite success reused. |
| Qualified complete inventory | **180 API test files, 357 qualified executions: 3,585 passing case executions, 0 failing assertions, 2 deliberate live Railway TLS skips.** This combines fresh C2A and explicit final-source qualification, not a claim that all cases reran at the final SHA. |
| Final-source qualification | 13 successful groups / 161 cases at 9101672, including paired same-origin/security/D16/W07/DS suites and PG16 fresh compatibility. One additional generator/esbuild race failed before assertions and is retained as setup failure. |
| Special / personal coverage | Supported storage 2 + S3 wire/outage 8 + offline benchmark 27, personal memory 1 per PG; already included in the 357 total. No live model call. |
| Full G33 exact final image | Both PG16 and PG18 PASS; image sha256:f711bf12a0cc55ad95b6f4155554180aa7e3c36e30a41427ecd223eb61a7370c. Internal networks, non-root, canonical cash/commission journey, real stop/restart/persistence and unchanged 60-entry migration fingerprint. PG18 release/concurrency included. Two G33 cases are included in inventory; nested Connect/authority tests are not inflated into the headline count. |
| Workspace / contracts / builds | Final full typecheck PASS; authored regeneration zero drift; real Dockerfile API and web builds PASS with frozen lock and PNPM_VERSION=10.30.3. Optional session CA mounted as BuildKit secret only; existing bundle-size warning retained. |
| Shared card and harness guards | 35 surface cases, 6 G33 entry guards and 9 database/credential guards PASS; supplemental, separate from inventory total. |
| Original native wrapper | 1 pass / **5 pre-session failures, ENVIRONMENT_BLOCKED**: kernel lacks sit0. Unchanged preflight 21/21 passes only in documented non-browser loopback-only namespace setup; never relabeled full-wrapper success. |
| Backup / restore | PG16 and PG18: all 133 public/Drizzle table hashes/counts equal, real canonical synthetic orders/items/journal nonempty, exact restored P0001 / 55000 / 23514 trigger protections reject mutation. Own dumps/databases removed. |
| Existing 100k search rehearsal | Both PG16/18 PASS, four cases each: exact results at 1k/10k/100k, bounded selective/early reads and original speed assertions. Measurements below; no invented production SLO. |
| Browser / scope | Actual Chromium and 96 width/theme runs, no reported overflow/unnamed controls/console errors in that matrix; V2/IME/Stop/cards/admin/partner journeys. Five fresh C2A screenshots retain source hashes. Manual spoken AT and other browser engines remain BLOCKED. |
| Security / hosted CI | Official checksum-verified gitleaks 8.30.1, all refs/full merge-parent diffs: 555 commits at qualified code, zero leaks; dependency audit zero at every severity. Hosted PR/run metadata remains API-policy blocked, not called green CI. |


[CODEX_COMPLETE_LOCAL_ACCEPTANCE](CODEX_COMPLETE_LOCAL_ACCEPTANCE.md) and `evidence/final-local-acceptance.json` provide exact commands, per-suite source SHAs/status/counts, seed/approval profiles, all first failures and corrected attempts. The final complete inventory is run afresh; earlier 4143314/dc1636d and 53-test main figures remain historical and are not relabeled as final tests.

Supported commands: `pnpm run typecheck`; `pnpm --filter @workspace/api-spec run codegen` followed by zero drift; API/web Dockerfile builds with frozen lockfile; `test/isolation/local-suite.sh <suite>.test <approved switches>` on 127.0.0.1 PostgreSQL 16/18. Legal uses an unseeded legal-prefix DB; the negative payment gate does not inherit Wave4 opt-in. Browser/font/provider fixtures serialize. Specialized storage/benchmark and personal-memory runners are used instead of unsupported generic entry points. Full local G33 executes its real internal-network non-root app, canonical API financial journey and restart/persistence handshake on each PG version, not just startup or fake GITHUB_* identity.

The canonical release migration runner deliberately requires PostgreSQL 18+. PG16 proves fresh reviewed SQL/Drizzle compatibility; PG18 proves release-manifest/concurrency/upgrade checks. One attempt to request the PG18-only runner on PG16 was refused before tests and remains visible, not converted into PASS or fixed by weakening SERVER_VERSION.

Controlled local performance covers indexed search/goldens, historical numeric edge cases, history 40/100/500 with original 18 cold samples and load/DOM/window/rerender budgets, report-query growth, D13 load/shutdown and the explicit C1 full-scale rehearsal. Hardware/fixture figures are not production SLOs. Actual Chromium spans 320–1600px, RTL/light/dark, focus/keyboard/reduced motion, pending/tabs/recovery and external navigation. Manual spoken screen readers and optional forbidden live Railway TLS remain BLOCKED/SKIPPED, not green.

Backup/restore uses pg_dump/pg_restore only on newly created disposable loopback DBs with real canonical synthetic finance state. All table hashes and restored immutable order/item/journal guards are checked; dumps and own DBs are removed. Readiness remains correctly 503 for missing live SMS/configuration. No production DB, deployment, paid model/provider or real payment was used.

## Native isolation harness evidence

Existing API database/credential guards pass 9/9 from the documented API working directory. The first wrong-working-directory invocation is retained as a runner error. The original native sandbox suite records 1 pass / 5 failures before PostgreSQL: this kernel lacks `sit0` (`OSError: [Errno 19] No such device`), despite user/network namespace creation being supported. Those five remain ENVIRONMENT_BLOCKED, never relabeled PASS.

The unchanged preflight's 21 assertions were additionally executed successfully in a genuine user/network namespace with loopback only and a fresh sentinel PostgreSQL cluster. An explicitly documented outside-repository non-browser copy omits only the three address-only sit0 setup statements; routes/probes/nonce/data-directory/credential checks and preflight assertions are unchanged, zero outbound attempts, own cluster removed. This does not prove the original sit0/browser wrapper passed. Actual application inventory uses the supported clean-environment/loopback/net-guard runner; Docker G33 uses its real internal-only network. No production interface or source guard was altered.

## Full-scale search measurements

| PostgreSQL / 100k fixture | SQL p50 / p95 ms | Legacy p50 ms | SQL rows read | Observed heap growth KiB |
| --- | ---: | ---: | ---: | ---: |
| PG16 narrowText | 10.7 / 26.6 | 1715.6 | 18 | 1644 |
| PG16 browse | 33.3 / 36.2 | 2050.5 | 1550 | 19233 |
| PG16 attributeSort | 177.2 / 200 | 1297 | 7503 | 27295 |
| PG18 narrowText | 8.2 / 8.9 | 1644.1 | 18 | 1587 |
| PG18 browse | 33.1 / 35.7 | 2139 | 1550 | 19232 |
| PG18 attributeSort | 192.2 / 205 | 1225.5 | 7503 | 27289 |

All eight query shapes retain exact canonical/legacy result ordering at 1k/10k/100k; original row-bound and median-improvement assertions pass (4 cases per PG). Heap figures are observed per-query growth, not an absolute peak-memory proof or production SLO. Fixed-128 cursor/constant-space/snapshot equivalence remains explicitly unproved.

Backup probe attempts are retained. An initial assertion expected only 55000/23514; diagnostic proved the preserved migration-0001 trigger correctly returns P0001. Final probes require the exact code, message and trigger function, and explicitly select version-1 canonical checkout rows. No database invariant was changed. The one final-qualification setup failure was caused by concurrent generation cleaning source outputs; generation finished at zero drift and the affected/remaining groups reran serially.

Delivery scanner review: [two documented non-secret detections and exact fingerprint exclusions](evidence/DELIVERY_SCANNER_TRIAGE.md). The qualified-code scan remains 555 commits/zero findings; later delivery sweeps report reviewed exclusions separately, never as nonexistent raw detections. Application/contract/migration acceptance still refers to the exact unchanged code cut.
