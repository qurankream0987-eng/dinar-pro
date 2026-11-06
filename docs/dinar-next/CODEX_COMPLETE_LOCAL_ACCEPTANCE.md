# Complete local platform acceptance

Finite closure; no live providers, paid model calls, production DB, deployment or merge. Canonical status is CODEX_FINAL_CLOSURE_MATRIX.md. PASS/FAIL/SKIPPED/BLOCKED are kept separate, and first failures/retries remain available.

## Source and run provenance

| Cut | Meaning |
| --- | --- |
| `ebdd2d7a68f5a52af7ad973f21ef3b0cae914b4a` | Preserved Replit/PR5 Git authority; original 57 SQL and manifest entries unchanged |
| `414331473448a35426d4187587fdb095402baffe` | First frozen 352 standard suite executions: 326 suites passed, 26 failed; 3,422 passing case executions, 10 failing assertions and 14 skips. Startup/runner failures and timeouts explain why failing-suite and assertion counts differ. |
| `61cb9b1a785e0c89980984ca5e488c64d600998f` | Strict contract/recovery/performance harness alignment and guarded local G33 entry. Exposed real Docker permission and long-copy chronology defects. |
| `b13372afaec0214e4a8499591619505eb8c053f3` | Historical application/runtime cut: node-owned private source copy, past chronology and deployment framing. Full real local Docker G33 passed on PG16 and PG18. |
| `dc1636d39917f39dd1c6e63d08b0042d5b400b23` | Only security test fixture text and closure ledger differ from b13372a. App, contracts, SQL, dependencies and other tests are byte-identical. Complete inventory reuses 54 already-passing, proven-identical executions and runs the other 298 with existing harnesses. |
| `c2a8717e1f345b4c9a2c5f39ae5a41b6e868ad82` | Entire final API inventory run afresh on both PG versions: no reused earlier suite counts. Includes actual UNKNOWN repair and selective historical Replit/C1 behavior/test restoration. |
| `9101672a7370bb8080e598344840d1fde2f88291` | Final deployment-marker CSP correction plus deterministic public-tag and pending-auth reload fixture qualification. Exact affected/critical reruns and full local G33 are attributed to this source cut. No false application-tree equivalence with c2a8717 is claimed. |

Portable `evidence/final-local-acceptance.json` retains exact source cuts, per-suite statuses/counts, supported command profiles, raw first failures and qualified corrected attempts. Full logs remain under `/workspace/dinar-connect-evidence/`. Earlier reused dc1636d results remain historical, not relabeled as fresh final executions. The old 53-test main baseline is not evidence here.

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


## Executed supported commands

- Workspace: `pnpm run typecheck`, API/web builds through the exact source Dockerfile and normal package scripts; `pnpm --filter @workspace/dinar run test:surfaces` (35 cases). The first sandbox invocation failed before tests because tsx IPC was denied; the supported local-IPC retry passed.
- Contracts: `pnpm --filter @workspace/api-spec run codegen`, then `git diff --exit-code -- lib/api-zod lib/api-client-react lib/api-spec`: zero drift.
- DB/API/browser: `artifacts/api-server/test/isolation/local-suite.sh <suite>.test <exact flags>` on fresh `127.0.0.1:55416` PG16 and `127.0.0.1:55433` PG18 databases. Existing scheduler serializes seed compilation and browsers. No actual integration calls leave loopback; deterministic transport fixtures supply provider behavior.
- Legal: `DINAR_SUITE_SEED=none`, `dinar_test_legal_*`, `BDINAR_MARKET_LEGAL_ACCEPTANCE=development`, `DINAR_MARKET_LEGAL_TEST_FIXTURE=1`. Negative payment gate runs only with its own `BDINAR_W06_D16_AUDIT=development`, without unrelated Wave4 opt-in.
- Special storage: existing `test:storage-portability` and `test:storage-s3-wire` package commands (`--packages=external`); offline benchmark: `node test/run-benchmark.mjs live-model-benchmark.test`. Dedicated personal-memory runner uses its required loopback 55479 entry and fresh PG16/18 DBs, unique seed output and no live keys.
- Docker: `DINAR_LOCAL_G33_ACCEPTANCE=disposable G33_APP_IMAGE=dinar-next-g33:<exact clean source SHA> G33_POSTGRES_IMAGE=postgres:16|18 bash scripts/ci/g33-docker-acceptance.sh`. Guard cases reject wrong branch/dirty source/image and unsupported PG before Docker. See LOCAL_ACCEPTANCE_REHEARSAL.md for managed proxy/CA build trust.
- Security: `pnpm audit --json` reports zero known advisories at every severity. Official checksum-verified gitleaks 8.30.1 scans all accessible refs/full merge-parent diffs with 100% redaction and zero findings. Changed-file/historical pattern checks are separate. Hosted CI remains unverified.

## G33 is the complete local workflow

At b13372a, image `sha256:7d80cf1998b8da218b6ced3c04e46ccacce86656ab0f85234b774a5dbcf07652` runs as node on an internal-only network, with no published host ports. PG16 completed in 323.89s and PG18 in 371.86s. Both passed legal activation of a synthetic market, the Connect/unchanged AI-authority chain, the simulated cash/commission API journey, actual app stop/restart and the persistence handshake. PG18 additionally ran release migration/concurrency checks. The 60-entry ledger fingerprint stayed unchanged through startup/restart; shutdown exits were zero. Production-mode health 200 and readiness 503 for unconfigured SMS are expected assertions, not launch approval. Complete `G33_CONTAINER_ACCEPTANCE=passed` markers, not just startup, establish these results. No GitHub Actions run is claimed.

## Failures and retries retained

- Stale CART-first enum, single-tool DeepSeek and empty-demand surface expectations: corrected to exact existing contracts; membership, no-writer/role, zero-model and other assertions retained. Claude overlap documented.
- Missing four approval labels / five stock-spec suite startups; wrong market-legal prefix/flags/active seed; global Wave4 contamination of a negative payment gate: use the supported scoped setup, never weaken a guard.
- Recovery fixture lacked reply correlation and waited for idle during deliberate verification: fix fixture/expected locked state; keep exact original retry ID and one cart effect.
- Long history: unbounded Playwright streaming wait hid a real chronology defect. Bounded owned server completion exposed the missing visible edit; copy timestamps were repaired and exact ordering/UI-idle assertions added. All original 18 cold samples, 40→80 window, DOM/growth/load budgets and zero assistant rerenders during 12 draft edits remain.
- Managed image: root-owned private source dirs blocked node. Fix image ownership, preserve non-root runtime and source privacy; complete both G33 workflows then pass.
- Deployment framing: new strict regression failed before middleware repair; runtime-production, deployment-label and Replit-marker presence cases are qualified without weakening development/CSRF/XSS assertions.
- Security setup: one PG18 run cascaded from a 400 during listing creation. Bounded diagnostic run 14 reproduced the real precise-location privacy refusal from a random fixture suffix; digit-free harmless area fixes the fixture, not the privacy policy.
- Accessibility: retain both original transient busy-state failures and the controlled DOM/keyboard diagnostics; final held-request/timeout fixture repair retains every original assertion and is rerun on both PG versions.
- Uncertain execution: a real canonical profile write followed by lost acknowledgement was stored as REJECTED; synthetic business ledger-ack failures likewise left committed activation/price writes marked FAILED. The existing recovery boundary now stores UNKNOWN with a compare-and-set, no success claim, raw exception or replay; original known validation refusals remain tested. Temporary diagnostic entry-path/unseeded attempts are retained as setup errors, not product failures.
- Generic special-suite entry renamed AWS commands and missed benchmark isolation, causing a failure/skip. The documented package/benchmark wrappers pass; no production storage/model change was made.

## Scope limits

Actual browser evidence includes seller/buyer SC journeys, partner/admin finance, domain/external navigation, V2/IME/Stop/recovery, card reliability/concurrency and mobile RTL. Five fresh selected screenshots from the full PG18 inventory at c2a8717 are preserved with SHA-256 provenance: [internal product](evidence/closure-internal-product-320.png), [domain fallback](evidence/closure-domain-320.png), [observed website offer](evidence/closure-website-320.png), [read-only staff](evidence/closure-staff-320.png) and [admin simulation/diagnostics](evidence/closure-admin-finance-320.png). The final code retains that exact frontend source tree; its server-side CSP deployment-marker change has separate HTTP/security/container evidence. Earlier images/evidence remain historical and retain their own source cuts; current results are recorded separately. Manual spoken screen-reader output remains BLOCKED, not a DOM pass. Optional live Railway TLS is deliberately SKIPPED because production resources are forbidden. Provider sandbox/live acceptance, model quality, commercial/legal approvals, account billing and GitHub API reachability remain in CODEX_EXTERNAL_LAUNCH_BLOCKERS.md.

## Final reconciliation qualification

The PG16 fresh-environment attempt accidentally selected the PG18-only release runner; its SERVER_VERSION refusal is expected and retained. The corrected PG16 SQL-compatibility run uses the supported Drizzle path; PG18 release checks remain mandatory. A W07 public random token hit the real contact guard: a bijective digit-free public marker fixes the fixture, not policy. DS15's immediate commit/reload produced a CDP detached-page error: the controlled first-auth hold makes initialization pending explicitly, while original outcome/page-error assertions remain. These qualified attempts do not erase raw failures.

The final source review reproduced a real framing gap under REPLIT_DEPLOYMENT presence with development NODE_ENV. The minimal existing CSP predicate now includes that marker, matching D16 deployment policy; empty/zero marker presence is also covered. The historical Replit comparison restoration has real zero-model HTTP/search/comparison and canonical cart-receipt evidence. Exact current Docker image/source, backup/restore and full-scale C1 results are in the portable evidence and final test table.

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
