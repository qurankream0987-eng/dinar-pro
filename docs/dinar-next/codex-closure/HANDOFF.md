# DINAR NEXT — Codex engineering review package

Prepared for Claude’s independent review. Local branch: `codex/remaining-engineering-closure`.
Starting integration SHA: `eda6d4205c2f0553b26a87c19255e3b06b598706`.
Final runtime source SHA: `9afe76cf8f9e4a74b9e14e7dce831888b9f1039e`.
Subsequent delivery commits contain documentation/evidence only; the bundle advertises the exact delivery HEAD.
No push, merge, deployment, production change, live SMS/location activation, paid inference or commercial-policy application occurred.
Railway troubleshooting is postponed by owner instruction; every Railway-dependent acceptance item is **BLOCKED**.

## Scope and preservation

The verified integration already contains Codex’s functional audit/premium history and Claude’s DRAFT/DSLAB work. This branch descends from it without merges or cherry-picks. See [baseline](BASELINE.md) and [C-12 contract](C12_CONTRACT.md).
No Claude presentation source, renderer, animations, floating cards or mobile layout was edited. The existing star-free SVG was rendered into the touch-icon PNG. Browser screenshot paths for lab-commerce/maps are unique per run and retain historical evidence.
All 63 migration SQL files, Card Envelope schema/implementation, OpenAPI/generated clients, dependencies, lockfile, commercial authority checks and approved commission terms are unchanged. The machine evidence includes the exact changed-file list and immutable-file comparison.

## Engineering changes

| Area | Change and rationale |
| --- | --- |
| C-12 | Canonical successful reads own listing prose and selected card identities. Search replaces obsolete resource/comparison selection; validated references can retain earlier results. Preserve one source resultSetId through persistence and validate conversation/market/current message ownership. Safe structured tracing joins the read to the response. |
| C-01 | Compute price differences, cheapest/priciest amounts, annual recurring counts/costs and unambiguous year/condition pair comparisons from current persisted prices in minor units. Missing/ambiguous evidence asks or qualifies; hypothetical annual cost never books or quotes extras. |
| C-02 | Intersect original user price bounds with model search filters and retain them through canonical re-entry, suggestions, topic restoration, explicit resource reads and comparisons. Old expensive references cannot bypass a new hard bound. |
| C-11 | Reuse bounded descriptive relaxation across the existing buyer/model search adapters. Keep the item head, explicit numbers, conditions, colours and hard filters. Name relaxed purpose words. Correct category inference from generic feature values; preserve exact title evidence for omitted legacy descriptive attributes without overriding contradictory stored attributes. |
| C-03 | Contextual quantity corrections enter the existing cart service only in active cart scope, with one identified line; ambiguity asks. No checkout authority is added. |
| C-04/C-05 | Cardinal words and regular Arabic passive/active forms use bounded matching. Numeric model tokens match punctuation but reject partial larger numbers, decimal values and amounts. |
| Adjacent routing | Numeric budget corrections, additive searches and employment how-to questions retain their intended context. Exhausted message-allowance questions stay in usage routing, separate from bank money and stock. |
| Vision | Ordinary image/screenshot questions reuse the authenticated AI conversation runtime. Existing private image ownership, validation, expiry and listing-photo separation remain. Answers are advice, not commercial receipts. Dedicated vision routing requires budget holds and records actual usage; unconfigured/exhausted budget denies provider calls. |

Exact paths are in `evidence/changed-files.txt`; principal implementation is under `artifacts/api-server/src/ai`, `src/lib/arabic-search-terms.ts`, `src/lib/marketplace-listings.ts`, and `src/routes/ai.ts`.

## C-12 trace, compatibility and negative control

Historical live sofa/AC logs are insufficient to reconstruct the original provider sequence. The independently reproduced root causes are unbound non-monetary model prose and source identity loss between tool completion and card persistence. The fix regenerates listing facts from selected successful reads; it does not special-case recorded model markers.
`dinar_canonical_read` → `dinar_response_source` carries conversation, market, user message, result-set and exact resource IDs. No prompt/image/key/contact content is logged.
Existing `card-envelope.ts`, envelope schema, lifecycle, pending review authority, allowed actions and confirmation checks are retained byte-for-byte. No second runtime, result store, cart or renderer exists.
Frozen coverage includes ten-turn topic changes, multiple searches/empty reads, explicit older references, same-title/different-ID rows, market/account rejection and conversation recovery. Existing browser tests cover concurrent tabs, sessions, commercial reviews and recovery. The destructive negative control was local and temporary: restoring unbound model prose caused the frozen source-binding suite to fail; the source was restored before subsequent verification. The failure log is retained.
Two old model-native assertions expect arbitrary scripted prose markers; they remain failed and unchanged. Claude must review their compatibility with canonical server-authored facts. They are not silently counted as passing.

## Pricing, commissions and Arab markets

All 22 Arab-market records were independently checked for selectable identity, currency/scale isolation, closed-market denial and unavailable external integrations: DZ, BH, KM, DJ, EG, IQ, JO, KW, LB, LY, MR, MA, OM, PS, QA, SA, SO, SD, SY, TN, AE and YE. This is local registry/API readiness, not approval to open these markets.
Jordan flexible positive prices from 0.001 to 37.125 JOD and unpriced open offers pass the configured category fixture. A single historical market unit does not impose one listing price. Fixed-price zero remains rejected by the existing contract; no new free-of-charge pricing representation was invented.
Pricing invariants and the existing 10% commission checkout/outcome acceptance pass with their required disposable development seed. Integer commission rounding was independently checked at 0, 250, 750, 1000, 1500 and 10000 bps. Published effective-dated market/global policy and historical order snapshots remain authoritative. Connect fixed/percentage/category agreement arithmetic and authorization checks pass in the main battery.
No approved volume-tier threshold/rate schedule was found. The owner was asked for the intended “free pricing/tiered commissions” policy. New commercial terms remain **OWNER_POLICY_REQUIRED** rather than invented or activated. Existing AI usage tiers are a separate mechanism and were preserved.
The synthetic legal workflow passes using a fresh, unseeded loopback database; its test-only legal verifiers never establish real counsel or market approval.

## Verification and limitations

See [evidence results](evidence/RESULTS.md) and `evidence/results.json` for exact PASS/FAIL/SKIP counts and source revisions. Raw logs, independent frozen tests, negative controls, earlier unsuccessful runs and laboratory JSONL are included in the separate evidence archive.
The 99-suite battery at source `369954d` recorded 752 tests: 734 PASS, 11 FAIL, 7 SKIP, zero outbound attempts. Later changes are the punctuated-number fix and allowance-exhaustion routing fix; affected suites were rerun explicitly. The published-phone SC01 browser journey now passes end to end; both its earlier failure and successful rerun are retained. Counts across repeated runs are not added to imply unique coverage or a single all-green final run.
DRAFT editing, provider/model routing, financial state/settlement/receipts, cart/checkout, seller/buyer/cross-account authorization, marketplace isolation, Card Envelope/recovery/concurrent-tab tests and security acceptance are included. Frontend surface/handoff/DeepSeek rendering checks passed separately. Root builds and typechecks and final API build outcomes are recorded individually.
PostgreSQL 18.6 release-runner acceptance passes all 12 tests across the unchanged 63 migrations, including concurrency, interruption/recovery and tamper denial. Separate PG18 fresh/readiness, financial/authority and three card/recovery/accessibility/expiry browser suites passed. PG17.11 supplied the broad local battery. No remote database was accessed.
The completed 500-case deterministic lab is 370 PASS / 27 FAIL / 103 NOT_EXECUTABLE_DET, with zero calls/spend. H5 is 30/30 PASS (20 positive, 10 negative). Outputs are preserved separately from Claude’s historical evidence. Deterministic passes do not establish live DeepSeek/Gemini language quality. Live tests remain blocked without an approved budget and valid protected provider credentials.

## Remaining failures and release gates

- Historical search golden assertions include listings whose stored condition contradicts “used”; the new hard-condition contract excludes them. Keep both the historical golden failures and new negative controls. Claude must review this deliberate semantic difference; do not regenerate the golden to conceal it.
- The 10,000-listing search performance threshold initially failed. The recorded affected-suite rerun passes all three performance tests; both measurements are retained because machine load affects timing.
- The general API seller-draft test expects `contact` while the integrated implementation returns `review`. This needs contract review with Claude’s existing DRAFT; no DRAFT rebuild or assertion change was made.
- The maps browser journey fails waiting for its prepared location-request button. Driver authorization/unit tests pass, but that browser acceptance is not approved. No live tracking was enabled.
- The DeepSeek DS-01 assertion expects the system prompt to start with its identity marker. Current inherited source starts with the no-emoji instruction; `model-turn.ts` is unchanged. The full replay/browser rerun is 19 PASS / 2 FAIL / 0 SKIP: DS-01 and DS-13b (orders-entry repeated-attempt browser timeout).
- The first new closure test has a too-narrow Arabic relaxation-wording assertion; IDs/price bounds pass but wording differs. Original failure remains. Early independent test fixtures also had wrong market selection, tree-shaken storage setup, incomplete category configuration or omitted inventory. Their files/assertions and red evidence are retained; separately configured tests prove the intended contracts without editing those frozen assertions.
- USG-P12 (“يا دينار شوفلي اللي باقي بحسابي”) still takes the wrong route. Explicit exhausted-message wording now passes independent intent tests, but that does not close this broader contextual paraphrase.
- Remaining deterministic lab failures are listed by exact case ID and category in the evidence. G08-018 expects one annual service price although the local read returns two services; the server safely gives the annual count and asks for a single price rather than choosing one silently. They are not all relabeled model-required. No blanket intelligence-quality pass is claimed.
- Actual Railway staging service/environment, deployed SHA, readiness/health, protected SMS/Google bindings, external provider retention/quality and deployment settings are **BLOCKED**. GitHub SHA is not a deployment SHA. No production readiness claim follows from loopback tests.
- Live vision needs an approved cap, calibrated hold/pricing table, dedicated protected key and provider policy verification. Unknown failed-call usage is conservatively accounted; accounting failure retains the reservation for reconciliation.
- Manual screen-reader acceptance remains manual/blocked where recorded; automated accessibility checks do not replace it.

## Reproduction and integration dependencies

No new application package or migration is required. Verified local tools: Node 24.22.1, pnpm 10.32.1, PostgreSQL 17.11 and PostgreSQL 18.6 with pg_trgm, system Chromium. Repository Docker pins are preserved. Test-only PG18 was built locally from Debian’s verified source package; it is not an application dependency.
Run the existing `test/isolation/local-suite.sh` against an explicitly disposable loopback server. Each independent suite gets a fresh DB and net guard; the correct `BDINAR_* = development` guard must match that suite. Browser tests use Chromium and local font/image stubs. Use the included orchestration scripts for exact flags and do not copy the owner’s cloud credentials.
The phase2 suite requires `DINAR_SUITE_SEED=development`; pricing invariants additionally require a `dinar_test_blockb_*` database name. Legal acceptance requires an unseeded `dinar_test_legal_*` DB and explicit synthetic-fixture flags. Failed first attempts with other configurations remain in evidence.
For lab reproduction, prepare a throwaway lab template using the existing lab preparation script and store a newly generated synthetic seed password in a private file; pass that file to `test/lab/runner.mjs --mode det`. Never reuse or publish a protected external credential. No live mode is authorized by this package.
Claude should inspect the bundle on an isolated review branch based on the stated prerequisite, review shared backend files alongside any newer integration changes, and preserve active UI work. No blind merge, automatic cherry-pick, push or deploy is requested.

## Verdicts

| Required verdict | Result |
| --- | --- |
| CODEX_ENGINEERING_COMPLETE | PARTIAL — implementation package ready; remaining regression/contract and policy items prevent unconditional closure |
| INTELLIGENCE_RELIABILITY_VERIFIED | PARTIAL — independent target cases and negative controls pass; full frozen battery/lab still has failures |
| VISION_READY | LOCAL_VERIFIED / LIVE_BLOCKED |
| STAGING_ACCEPTANCE_STATUS | BLOCKED — Railway verification postponed |
| SECURITY_VERIFIED | LOCAL_VERIFIED — scoped regression evidence; external/production acceptance blocked |
| CLAUDE_REVIEW_HANDOFF_READY | YES — local review package; not release approval |
