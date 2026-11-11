# DINAR NEXT — second-pass engineering audit

> Follow-up update (11 November 2026): see [final evidence and review readiness](follow-up/FOLLOW_UP_REPORT.md). New runtime `28f26779fbc4b23c6269795656a0d42db7aff9ef`; the original run counts below remain historical. The follow-up corrects the SQL exclusion count to eight, investigates all nine failures, and marks the source ready for independent review with declared limitations.

This is a new audit of the previous Codex delivery, not a release authorization or a handoff to Claude. Work remains on `codex/remaining-engineering-closure`; nothing was pushed, merged, deployed, restarted remotely, or sent to Claude. No production or staging data was modified. No paid provider request was made.

## Trace and scope

- Integrated baseline: `eda6d4205c2f0553b26a87c19255e3b06b598706` (`claude/staging-integration`). Refreshed remote references still identify this head; main remains `b1b20e513ed25952bc086778fb71af88adcc54ba`.
- Previous runtime: `9afe76cf8f9e4a74b9e14e7dce831888b9f1039e`.
- Previous delivery: `115e11850a9ce9d686fb8e6215c569775b42a378`.
- Second-pass runtime: `16f85e5a55ea360c646de56f4e42b93cf1755a1f`.
- Dependencies remain unchanged: Node 24.22.1, pnpm 10.32.1, checked-in lockfile, PostgreSQL 17.11 for isolated API/browser tests; PostgreSQL 18.6 for release-migration compatibility; Chromium `/usr/bin/chromium`.

All 27 original deterministic failures were independently reproduced on the previous runtime before repairs. Their exact original failures, root causes, implementation paths, corrections and new outcomes are recorded per test in `evidence/ORIGINAL_27_FAILURE_REGISTER.json`. Frozen catalog inputs and assertions were not edited. H5 retains its original independent provenance but, after exposing a regression used in repair, is reported as a frozen regression set rather than a new unseen quality evaluation. Superseded runs, infrastructure failures and newly exposed regressions remain in the raw evidence package. Four new test fixture setups were corrected to supply required car condition/description fields and a configured color filter. Their acceptance assertions and request wording were retained; original failed fixture versions remain in Git and their raw logs remain available. No preexisting test was edited.

The exact 17 changed implementation paths in this pass are listed in `evidence/CHANGED_IMPLEMENTATION_FILES.txt`. The local Git review bundle contains the complete delta from the integrated baseline, including preserved first-pass work.

## Implementation findings and corrections

Arabic request framing, attached particles, feminine possessives, beneficiary service verbs, Arabic/Persian digits and Arabic/Latin model spellings now use the existing parser/search services. The search-text version was incremented so old materialized search documents do not silently use different matching semantics. Product corrections replace product scope; attribute-only corrections preserve unrelated filters. Explicit budget increases refine current search rather than becoming negotiation writes. Hard numerical constraints and category-specific filters are retained during widening. Service recall cannot discard its target to return an unrelated service; a held-out computer-maintenance request also exposed an inferred-category regression, corrected by retaining the service/object while widening categories.

Deterministic read-only calculations cover source-bound annual service costs, budget capacity, hypothetical installments and explicit bounded arithmetic. Listing prices and commercial quantities use server-owned minor units. Responses retain exact current resource identities. Conflicting condition requests clarify; deictic condition updates retain the product. Negated title text cannot satisfy an omitted structured condition. Explicit fabricated endorsements/discount claims receive a server-authored refusal without publishing anything.

Existing draft review handles completeness questions and conversational listing edits. Ambiguous order continuation requires visible cart context; explicit checkout navigation and existing confirmation authority remain. Courier selection now reaches the existing delivery runtime rather than being intercepted by the generic order list. No courier service, cart, result store, renderer or conversation engine was added.

The most material security finding was vision account-allowance bypass: the earlier implementation reserved the global platform budget but did not enforce the user's image allowance. The existing `reserveAiUsage`/`settleAiUsage` path now reserves both before invoking the existing analyzer, uses a turn-specific key, and records actual reported usage. Independent negative and concurrent tests use an in-process fake provider; zero allowance makes zero provider calls, and one remaining allowance admits exactly one of two concurrent requests and settles exactly one cost event. The RED denial evidence is retained.

Additional broad-regression findings were frozen before repair: Google pending-ticket parsing accepted noncanonical base64url MAC encodings and ignored trailing segments; this does not prove forged identity acceptance, but violates the issued-ticket integrity contract. Account-balance show requests could also be mistaken for marketplace search. Ticket validation now requires exactly two canonical base64url segments and the original constant-time MAC comparison; account-balance questions defer to the existing conversation/model read path. Their independent RED evidence and final verification are retained separately. An intermittent randomized-tag dialect-search failure is retained even if its isolated retry passes; a passing retry does not erase the original failure.

## C-01–C-12 review coverage

| Defect | Engineering evidence and limit |
| --- | --- |
| C-01 calculations/comparisons | Existing source-bound financial answers plus new minor-unit annual/budget/installment tests; the frozen catalog tests actual numerical answers. General reasoning quality remains separately provider-blocked. |
| C-02 hard price constraints | Model-request re-entry, explicit ceiling replacement, strict lower/upper bounds and negative controls; no category-specific hard filter is silently discarded. |
| C-03 cart quantities | Contextual cart edit, quantity/count distinction, cancellation, authorization and browser cart/checkout suites. No payment is authorized by prose or cards. |
| C-04 number words | Existing cardinal normalization retained; Arabic/Persian digits and model-prefix spelling audited with independent phrases and frozen cases. |
| C-05 morphology | Existing form-II rules retained; bounded beneficiary and feminine possessive variants added; unrelated service targets are negative controls. |
| C-06 conservative search/Arabizi | Bounded Arabizi request normalization and existing translation-service routing; no claim of unrestricted dialect or live-model comprehension. |
| C-07 missing structured attributes | Existing positive-title fallback retained with negation rejection; stored attributes remain authoritative. Two historical golden expectations conflict with this stricter condition behavior and remain visible. |
| C-08 multi-turn refinements | Product changes, attribute refinements, budget changes, deictic conditions, ordinal focus and topic interruptions exercised; incomplete/contradictory references clarify. |
| C-09 general advice versus jobs | Existing advice/write boundary retained; general prompts do not create profiles, jobs or applications. Generated advice quality requires an authorized provider. |
| C-10 provider transient failure | Transport, unavailable-provider and no-false-success tests retained. Live retry/recovery quality remains BLOCKED without authorized provider execution. |
| C-11 filtered recall | Hard budgets/preferences survive bounded widening; service target precision and held-out positives are measured separately. |
| C-12 prose/card sources | Exact resource identity, changing topics, multiple reads, explicit historical references, account/market isolation and recovery suites; the original source-binding negative control and approved server-generated listing prose contract are preserved. |

## Financial and market policy

All 22 configured markets retain their existing currencies and scales. Independent listing tests exercise arbitrary positive seller prices at each currency's scale, without introducing a regional price cap or changing commercial terms. Free-form pricing is preserved; this change does not invent a zero-price order representation.

The approved 5%/10% direction is implemented as a side-effect-free, versioned per-market preview with explicit effective dates. At or below the configured threshold it selects 5%; above it selects 10% on the entire eligible item subtotal, excluding separately recorded shipping/tax. Integer HALF_UP uses `floor((subtotalMinor × basisPoints + 5000) / 10000)` with safe-integer checks. At 20.000 JOD the fee is 1.000; at 20.001 JOD it is 2.000. Existing checkout resolution, historical order snapshots, settlements and refund reversals remain unchanged.

**Activation is disabled.** All expanded-market thresholds and effective dates require owner decisions. `COMMISSION_READINESS.md` and `COMMISSION_THRESHOLD_PROPOSALS.json` provide the complete 22-market matrix; nominal-20 proposals are not approved rules or FX equivalents. Persisting/publishing/resolving newly activated tier policies remains a separately reviewed integration dependency.

## Preservation and compatibility

The existing server-owned Card Envelope, result-set identities, commercial lifecycle, pending reviews, allowed actions and confirmation requirements remain the compatibility authority. C-12 continues to derive listing prose and cards from selected authoritative reads, with current-turn or validated explicit earlier references. No Claude card styling, floating cards, mobile composition, animations or renderer was imported or rewritten. DRAFT/DSLAB and DeepSeek remain inherited implementations. No schema, SQL migration, OpenAPI, generated client, dependency or lockfile change was introduced in this pass.

The broad battery uses fresh loopback databases per suite. Browser suites run serially because their synthetic font/image server owns a shared loopback port, and evidence directories are isolated. In the final battery one serialized browser chain overlaps three isolated core workers; performance acceptance runs alone afterward. A browser timeout under that load is retained and investigated with an isolated unchanged retry. Scripted/fake provider tests verify routing, accounting and boundaries; they do not establish live model quality, provider privacy operation or staging readiness.

## Evidence hygiene

Configured protected values are scanned without printing their contents; none were found in the collected second-pass evidence at the recorded scan. One early, overly broad diagnostic search did match a synthetic loopback seed-password line in a private preparation log and display it in tool output. That search scope was a mistake. The private log and seed file are excluded from delivery, and subsequent value scans report file paths only. No Railway or provider credential value was printed or committed.

## Staging and external boundaries

See `STAGING_READ_ONLY_STATUS.md`. Health, readiness and public page checks could not reach the staging origin: Cloud proxy CONNECT returned 403, and Chromium reported `ERR_TUNNEL_CONNECTION_FAILED`. No origin status/body was obtained. Database, migrations, application configuration, phone/SMS readiness and deployed source are individually BLOCKED. SMS-only 503 is not inferred. Railway management access is a separate CONNECT blocker; protected-token presence does not prove token scope or validity. Comparing deployed staging source with the local runtime is BLOCKED until its SHA is reliably observed.

Live Gemini/OpenRouter and DeepSeek calls, live provider retention/privacy verification, real SMS/Google OAuth, driver-provider activation and deployed acceptance remain unverified. No provider credentials or approved paid-call budget were supplied for those checks. Local request-parameter and denial tests are reported separately from external readiness.

## Results

| Frozen 500-case population | PASS | FAIL | BLOCKED |
| --- | ---: | ---: | ---: |
| Previous runtime | 370 | 27 | 103 |
| Final runtime `16f85e5` | 409 | 0 | 91 |

The historical label `NOT_EXECUTABLE_DET` is reported as BLOCKED, never PASS. Of the original 27 failures, 26 now pass; G04-008 now passes its executable order-context assertions but remains blocked on its general exercise-advice turn. Of the original 103 unexecuted cases, 13 now pass with deterministic source-bound calculations/refusals; 90 still require an authorized general model. These 90 plus G04-008 account for all 91 blocked cases. The per-case classifications retain prompts, reasons and exact result references.

Frozen H5: **30 PASS / 0 FAIL**, including positive and wrong-target negative cases. Laboratory calls/tokens/spend: **zero**. Counts for different or repeated populations must not be summed as unique cases.

The complete broad battery ran **126 suites / 853 tests: 843 PASS / 9 FAIL / 1 SKIP / 0 CANCELLED**, with **0 outbound requests** recorded by the isolation harness. It covers general conversation/routing, DRAFT and DeepSeek, search, arithmetic, cart/checkout, buyer/seller and cross-account authorization, order/receipt state, markets, vision/accounting and real Chromium journeys.

Two failures passed unchanged isolated retries: SC01 browser delivery-proof input timeout (**1/1 PASS**) and SC conversation routing's local `ECONNRESET` (**5/5 PASS**). The original full-battery total remains 9 FAIL. These retries establish reproducibility limits, not a proven root-cause fix. The additional current-contract SQL equivalence test passes (**1/1**) across stale and refreshed search documents; it does not replace either historical golden assertion.

| Remaining frozen assertion | Exact difference / disposition |
| --- | --- |
| `lab-defect-regressions`: checkout continuation | Expects CHECKOUT after unrelated general turns without a visible cart; frozen G03-015 forbids that navigation. Runtime clarifies. Both assertions remain unchanged. |
| `model-native-routing`: two prose markers | Expects `SCRIPTED_GROUNDED_COMPARISON` and `RESUMED_FROM_PERSISTED_RESULTS`; approved C-12 emits canonical server-owned listing facts instead. No arbitrary marker is injected into product facts. |
| `search-sql-foundation`: SF-03/SF-01 | Historical golden expects two contradictory-condition listings in a used-item search. Current strict eligibility excludes them. Independent stale/fresh SQL equivalence passes; historical golden failures remain. |
| `api`: seller draft step | Frozen flow expects `contact`, current inherited Claude DRAFT returns `review` after already supplied/default fields. This preexisting contract difference is preserved; no presentation or draft rebuild was made. |
| `deepseek-chat-compatibility`: DS-01 | Expects the identity sentence at the very start of the system prompt. Claude commit `8a9c7c1` prepends the no-emoji instruction; the identity sentence is still present. That inherited prompt is unchanged. Later assertions in this failed test are not counted as executed. |

DeepSeek final result is **20 PASS / 1 FAIL**, including the unchanged 40-attempt orders-entry browser case. Its older intermittent failure remains in prior evidence; a clean final repetition is not claimed as a new UI-race fix. The intermediate randomized-tag dialect-search failure also remains recorded; the unchanged isolated and final repetitions pass, without a proven root-cause correction.

The single SKIP is the opt-in live TLS database identity/CA acceptance test (`DINAR_TLS_ACCEPTANCE` unset; verified TLS fixture not configured). PostgreSQL 18 release-migration acceptance is **12/12 PASS** on a separate disposable cluster. Frontend surface/contract tests are **35/35**, guest-handoff logic **9/9**, stream/emoji rendering **19/19**, disposable-database guard **8/8**, and delivery secret scan **1/1**. Root typecheck/build passed before the last API-only repairs; the final API typecheck/build also passed. Web source and DB/migrations remained unchanged after those checks.

Exact suite counts and failures are in `evidence/FINAL_RESULTS.json`, `REGRESSION_SUITES.json`, `REMAINING_BATTERY_FAILURES.json`, and `ADDITIONAL_CHECKS.json`. Populations and retries overlap and must not be summed.

## Release verdict and owner review

| Required verdict | Result |
| --- | --- |
| CODEX_ENGINEERING_COMPLETE | **NO** — unresolved frozen acceptance conflicts and external verification remain. |
| INTELLIGENCE_RELIABILITY_VERIFIED | **PARTIAL** — 409 deterministic cases pass, 91 remain blocked; live general-purpose quality unverified. |
| VISION_READY | **LOCAL CONTRACTS PASS / LIVE BLOCKED** — privacy request controls, account/global reservations and accounting tested with synthetic providers only. |
| STAGING_ACCEPTANCE_STATUS | **BLOCKED** — application and management access denied separately before reaching the origins. |
| SECURITY_VERIFIED | **PARTIAL, LOCAL SCOPE** — local authority/security checks pass; live deployment/provider verification remains blocked. |
| CLAUDE_REVIEW_HANDOFF_READY | **HELD FOR OWNER** — review package prepared; no handoff or message sent to Claude. |

Remaining dependencies are acceptance-contract reconciliation, approved 22-market thresholds/effective dates and reviewed activation integration, protected provider credentials plus an approved paid-test budget, verified staging access/version/readiness, live SMS/OAuth configuration, and investigation of intermittent browser/transport observations. No staging migration, deployment, restart or infrastructure change is authorized by this report. No production modification is authorized or performed.

Review the source delta against the integrated baseline and prior delivery, the per-27 failure register, the per-103 classification, preserved Card Envelope contract and raw evidence before deciding next steps. The isolated branch and evidence package remain local. Stop after this report; Claude's independent review has not been initiated.
