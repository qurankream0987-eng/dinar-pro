# Advanced general AI engineering — review package

Date: 2026-11-12 Asia/Riyadh. Branch: `codex/advanced-general-ai`. Engineering increment delivered; GPT-class quality, live search and release acceptance are NOT VERIFIED.

## Source and baseline

- Starting delivery: `217ac4840d15a03c64e895092396fda17f2f3663`; preserved original runtime `28f26779fbc4b23c6269795656a0d42db7aff9ef` and all prior history/evidence.
- GitHub heads read live using git ls-remote (raw remote-heads.txt retained): Claude staging integration `eda6d4205c2f0553b26a87c19255e3b06b598706`; main `b1b20e513ed25952bc086778fb71af88adcc54ba`; Replit six-wave `ebdd2d7a68f5a52af7ad973f21ef3b0cae914b4a`. No remote source was merged or copied. Latest owner-acknowledged local source was the starting delivery; this package is not independently accepted yet.
- Core runtime/profile/context commit: `1292150f447448b1e49f7b72d79e62ba19e13001`.
- Final runtime source: **`6417ce27048291eb321ea3a6548ba20ba1933196`**, adding the offline source-contract helper/tests. Delivery SHA is recorded in the external artifact manifest.
- All 63 release-manifest SQL hashes verified, source head 0062_account_identities. No migrations executed; no live staging ledger verification. Synthetic test databases cloned the existing migrated template; fixture repairs used only standard seed code on disposable clones, no destructive database operations.

## Exact changes and rationale

| File under artifacts/api-server | Change |
|---|---|
| src/ai/model-profiles.ts | Strict bounded/versioned operator profile manifest, exact existing slot identity binding, no secrets/activation. |
| src/ai/model-gateway.ts | Optional profile binding/readiness; primary image compatibility and fallback image preservation; per-slot serialized context guard before counted provider dispatch; profile identity retained on adapters. |
| src/ai/model-turn.ts | Preserve beginning and end of long prior messages within original budget; explicit dialect/correction/reasoning/coding honesty guidance; final active-slot profile/release in metadata/logs. |
| src/ai/conversation-memory.ts | Distinguish assistant claims/user quotes; prioritize direct matches ahead of historical derived summaries and fairly allocate the existing block budget. |
| src/ai/research-source-contract.ts | Offline no-dispatch source planner; strict scoped source/citation contract, approved/internal identity gates, private-query checks and known malicious-excerpt quarantine. Not registered as an active runtime tool. |
| test/advanced-general-ai.test.ts | 12 independent new profile/context/memory/fallback contracts. |
| test/research-source-contract.test.ts | 13 offline source contracts including all eight owner research scenarios and negative/approval controls. |

No new dependency, agent framework, renderer, Card Envelope schema, result store, memory store, vector database or conversation runtime. Commercial services, action confirmation, finance snapshots and disabled unapproved policies unchanged. Claude UI and Replit implementations were not overwritten/imported.

## Test evidence and limits

- Latest selected evidence across **32 suites: 375 PASS / 6 FAIL / 0 SKIP**, 381 tests. This aggregate combines retained 31-suite core regression, corrected API/browser setup and final focused runs; it is not a single full-battery run. Core runtime sources are unchanged since 1292150; the later runtime commit adds an offline helper only.
- Final focused run: **52 PASS / 0 FAIL / 0 SKIP** in research contracts, advanced AI, conversation router, authority boundary and source binding.
- API with standard fixtures: **62 PASS / 1 preserved contract FAIL**. DeepSeek including browser: **21 PASS / 0 FAIL / 0 SKIP**. Memory suites 50+42 PASS, cost suite 19 PASS, authority 6 PASS, vision accounting/storage/metering and source binding PASS. These are local/mock providers, never real DeepSeek/OpenRouter calls.
- Initial 31-suite run: **340 PASS / 22 FAIL / 6 SKIP**. Sixteen additional API failures were caused by using the altered lab-template seed rather than standard API fixtures; standard acceptance seeding on a fresh disposable clone recovered all sixteen without source/assertion edits. Six DeepSeek browser cases were initially not enabled, then executed successfully. An intervening setup attempt used a disallowed .seed suite argument and exited96 before tests; preserved as setup error, not a product failure. All runs and retry reasons retained.
- Red evidence: original nine new advanced tests failed before implementation (0/9); long-summary starvation test failed (9/10 prior cases pass); historical-summary priority test failed (11/12 pass). Research contract initially failed to build because its module did not exist; unknown-intent control subsequently failed before its guard (12/13 pass). Frozen assertions were not weakened.
- API server typecheck and production build PASS, including final source. Separate repository secret scan: 1 PASS (not added to the 375-suite aggregate); protected-value evidence scan PASS. Zero outbound test attempts and paid calls. No new all-500 evaluation run is claimed: prior 409 PASS/0 FAIL/91 BLOCKED belongs to its historical runtime. All 91 classifications and frozen/held-out evidence remain unchanged. The new 24 synthetic live-workload plans are unexecuted and separate from those 91.

Read TEST_RESULTS.json and FAILURES_AND_RETRIES.json for exact suite logs, per-test names and setup explanations. Raw evidence includes runners, source hashes, original failures, screenshots and no-migration reuse markers. Prior delivery artifact hashes were rechecked successfully.

## Remaining six conflicts

Same exact tests fail: context-free checkout navigation; two opaque model-prose markers; SF-03/SF-01 historical used-condition golden rows; old draft contact/payment step. No commercial behavior or frozen expectations changed. Full requirements, traces and smallest recommendations remain in ../contract-openrouter/CONTRACT_RECONCILIATION.md, with pending D01/D03 owner and D02/D04 acceptance decisions. New G3 clarification does not settle those decisions. No new deterministic product regression was found in this scoped evidence.

## Research recommendation and integration contract

Evaluate **OpenRouter native openrouter:web_search/web_fetch first**, then Gemini Google Search grounding only on a route proven to support it. Brave/Exa remain conditional alternatives requiring measurable gains; do not install multiple providers. Actual native tool schemas, support, billing and current documentation are unverified: a read-only documentation GET was proxy-blocked (curl56/CONNECT403/HTTP000). See RESEARCH_DESIGN.md for source kinds, exact implemented offline gates, no-dispatch status, external/native comparison, budgets/privacy/SSRF and required adversarial acceptance. No external web capability is advertised or activated in DINAR by this patch.

For Replit/Claude: profiles are opt-in and do not rename existing credentials or widen tool authority. Preserve Card Envelope identifiers/current-turn binding/pending-review lifecycle and renderer. Agree exact profile manifest hash/release/source SHA, text and dedicated vision slots, source bundles/citation display and staged invocation/budget schemas before registering any native research adapter. Existing prompt still truthfully says no live internet until a future approved retrieval integration supplies current verified evidence. The source-contract helper has no provider bridge or API entry point; live source selection and combined internal/external answers remain integration work, not a passing feature claim.

Required configuration is in MODEL_PROFILES.md plus ../staging-access/STAGING_ACCESS_REPORT.md. Budget/price approval, protected credentials, permitted provider domains, selected exact model/provider capability and a trusted deployed SHA remain prerequisites. DINAR_AI_MODEL_FALLBACK stays disabled. Current staging access still has no successful live acceptance; no Railway/network setting was modified or retried in this mission. Replit acknowledgement remains outstanding.

GPT-class Arabic/English/coding/reasoning quality, real source coverage/citations, provider privacy/retention, grounding compatibility and comparative cost/latency require authorized live evaluation. MEMORY_AND_EVALUATION.md specifies reproducible workload and retrieval measurement; no empirical quality ranking or benefit from vectors is claimed. No private-user-data training/embedding was performed.

Verdict: READY FOR INDEPENDENT SOURCE REVIEW WITH SIX CONTRACT FAILURES AND LIVE ACCEPTANCE BLOCKED. No push, merge, migration, paid call, SMS, Railway change, deployment or production mutation. Stop at this package pending owner decisions and authorized integration evidence.
