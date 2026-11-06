# Final 49-branch historical reconciliation

Candidate `9101672a7370bb8080e598344840d1fde2f88291`; owner-authorized branch `codex/dinar-next-unified-development`. Main and contributor branches remain unchanged. The read-only inventory contains **49 branches: 30 ancestor heads and 19 divergent heads**. Counts are inventory facts, not feature acceptance. No blind merges, replacement migration chain or recreated historical commit identities were used.

## Method and evidence

`git ls-remote --heads origin` and fetched remote heads establish the snapshot. For each divergent branch, inspect merge-base→branch contributions and branch→candidate source deltas, including source callers, API behavior, SQL, tests and UI—not filename similarity. [Machine-readable evidence](evidence/final-49-branches.json) includes every modified path, original unique commit identity and old/current blob comparisons. [Acceptance](FINAL_TEST_EVIDENCE.md) records actual source cuts, supported PG16/18 commands, raw failures and qualified reruns. Contained histories retain their original IDs, but their current behaviors are separately bound to regression suites below. Documentation/generated snapshots are not counted as new runtime engines.

Classification is per meaningful contribution; mixed branches have multiple classifications. PRESENT_AND_VERIFIED is scoped to named deterministic/local browser regressions, not live provider quality or launch approval. PRESENT_BUT_REGRESSION_UNVERIFIED explicitly retains an unproved property. Historical unsupported SQL numbering or tests that demanded unsafe states are not imported.

## Inventory

| Branch | Exact remote HEAD | Unique commits | Changed files | Classification |
| --- | --- | ---: | ---: | --- |
| `ai-foundation-02` | `2ef9c07ab5fdcd15eca167f5a01ab32b6054400e` | 0 | 0 | PRESENT_AND_VERIFIED |
| `claude/02-sc-acceptance` | `9679e488c5f3d2260078d98c7d97704df6aac6ce` | 0 | 0 | PRESENT_AND_VERIFIED |
| `claude/04-reconciliation` | `e5bbd1ba59bddae8c5bd173a890fcdeafa046c25` | 0 | 0 | PRESENT_AND_VERIFIED |
| `claude/05-w04-context` | `4322fb6d7b66460626509401370f5ec3a5f6c6a8` | 0 | 0 | PRESENT_AND_VERIFIED |
| `claude/06-w02-ultra` | `8f4662b8a8d0c1ebc90bec06cd17c89795d8a480` | 2 | 1 | DOCUMENTATION_ONLY |
| `claude/07-legal-cards` | `e17fad27339b9d40ccea341e46bef96941d34db8` | 0 | 0 | PRESENT_AND_VERIFIED |
| `claude/08-model-native` | `09ff489f0a3f5950b9f0a0ba8b6cfc49230a7747` | 0 | 0 | PRESENT_AND_VERIFIED |
| `claude/09-dual-tier` | `d416a047f3707d1f03c6763c76e96eee2ab69da4` | 0 | 0 | PRESENT_AND_VERIFIED |
| `claude/10-ultra-closure` | `9a0f86f0b3c727f48be58aee7db11a3045a94613` | 0 | 0 | PRESENT_AND_VERIFIED |
| `claude/11-c1-sql-search` | `d94477bad836bf4fe7b3330884170625d1698270` | 0 | 0 | PRESENT_AND_VERIFIED |
| `claude/12-d1-d2-business-foundation` | `91b09ee7e24b737879d1bcf0ff1f8c238026d3f4` | 0 | 0 | PRESENT_AND_VERIFIED |
| `claude/13-integration-preflight` | `fe1c23396930f836d97241a6e3333611c6a60e4d` | 0 | 0 | PRESENT_AND_VERIFIED |
| `claude/dinar-next-intelligence` | `d0c2f0390b6d06bece8bd2d95c5629d2384c19bc` | 17 | 57 | OWNER_DECISION_REQUIRED |
| `codex/11-c1-sql-search` | `f351f5d20d52d77b69bdcff66e2412796e53aa39` | 7 | 16 | SUPERSEDED_WITH_PROOF / INCOMPATIBLE_OR_UNSAFE / PRESENT_BUT_REGRESSION_UNVERIFIED |
| `codex/dinar-next-unified-development` | `9101672a7370bb8080e598344840d1fde2f88291` | 0 | 0 | PRESENT_AND_VERIFIED |
| `main` | `b1b20e513ed25952bc086778fb71af88adcc54ba` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/04-sc02` | `f0a3c77fc1fd1a276fcb2a61214dd3b4b8e49ee3` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/05-sc06` | `56138dc97f2711862e41d635e2a009f5535da2bd` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/06-general-specs` | `6335603bfb44857dd5a7261c6f32e06b5b085582` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/07-stock` | `a80bbe32fdf8d9703875658e81b58923e20a1a13` | 3 | 4 | PRESENT_AND_VERIFIED |
| `qoder/08-integration` | `5dda1466cc08e2d6d61d4d757bf541b853819f65` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/09-launch-gates` | `5a005005224cf5ac05f72c8328258dd061a9846b` | 2 | 1 | SUPERSEDED_WITH_PROOF |
| `qoder/10-security-deps` | `2b0649066a8c9049f410c1224e9f6610bc99492a` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/11-wave01-security-close` | `772cda7193923cebe95a696f7c7c53c7ad37865a` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/12-wave02-card-reliability` | `2da7f9721c8a915ab3630613f9d83a36a55ab3d6` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/12-wave02-red-evidence` | `92aeb0c2858a2778a2cb496665c3f6b2b29ee5b5` | 1 | 1 | SUPERSEDED_WITH_PROOF |
| `qoder/13-wave03-card-envelope` | `c6e45942cf122582db01eddaba7356ce1b72029e` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/14-w02u3-canonical-reliability` | `6687df2d033c1b71eee5b46afb3e39d193f66ec2` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/15-d3a-native-business` | `939930d1037387f39f1a2c64ac5b2ae61146b251` | 13 | 44 | PRESENT_AND_VERIFIED / SUPERSEDED_WITH_PROOF / INCOMPATIBLE_OR_UNSAFE |
| `qoder/17-unified-integration-candidate` | `4e60a56e3d21defea4c2d580c35fd3b198e52b5e` | 41 | 149 | PRESENT_AND_VERIFIED / SUPERSEDED_WITH_PROOF / INCOMPATIBLE_OR_UNSAFE |
| `qoder/a01-baseline-audit` | `f107dd32984cbdcb8e7dce3602ea26d99d9af9b5` | 5 | 7 | PRESENT_AND_VERIFIED |
| `qoder/a02-d4-d5-security` | `8f9f6ad23067a7251a444dbe0e210ef4f1218b69` | 5 | 4 | PRESENT_AND_VERIFIED |
| `qoder/closure-12-executing-recovery` | `2e0cca1345d2a2e0a4295c24aeac5b8b4ce59143` | 3 | 8 | PRESENT_AND_VERIFIED / SUPERSEDED_WITH_PROOF |
| `qoder/d12-replit-integration` | `5d9bca1305245eb51686dda6083ae1aa2fb8e677` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/parallel-w07-w12-ultra` | `af89cb340be4eb11a46b290e3dc5217e52af07ce` | 20 | 56 | PRESENT_AND_VERIFIED / SUPERSEDED_WITH_PROOF |
| `qoder/temp-principal-sixwave-closure` | `44dfbf639fda27d4b8de7908c0aea8df25ab50ef` | 16 | 17 | PRESENT_AND_VERIFIED / DOCUMENTATION_ONLY |
| `qoder/wave01-d1-d3-closure` | `adf5a5f86ecd96fad8214eda51d20d05a0e2b2b4` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/wave02-d4-d6-closure` | `845b0a48cfa7a726c97be75a00ed76fd8db5afca` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/wave03-d7-d9-closure` | `c1e0a010c5eb0b1479b8ca21e4a410279b11cb3d` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/wave04-d10-d12-closure` | `fd8215e8af4cf55e9f653c94cbc9105111e354eb` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/wave05-d13-d15-closure` | `0f50dc65bbf9120dc4d183825cfe7a243db4b398` | 0 | 0 | PRESENT_AND_VERIFIED |
| `qoder/wave06-d16-d17-closure` | `891c37d6a904c4ba8809e4531040c63f030bed99` | 23 | 113 | PRESENT_AND_VERIFIED / SUPERSEDED_WITH_PROOF / INCOMPATIBLE_OR_UNSAFE |
| `qoder/wave06b-d16-d17-closure` | `d341917ec4a34ade3c1bdde8366a44dbbca9f35d` | 14 | 108 | PRESENT_AND_VERIFIED / SUPERSEDED_WITH_PROOF / INCOMPATIBLE_OR_UNSAFE |
| `replit/d16-legal-privacy-compliance` | `c196a9bf892547322644540a5d03c338020581da` | 1 | 92 | PRESENT_AND_VERIFIED / SUPERSEDED_WITH_PROOF / INCOMPATIBLE_OR_UNSAFE |
| `replit/dinar-next-complete-development` | `11d7fbe3326897924468ee4c6d5467972a92b973` | 0 | 0 | PRESENT_AND_VERIFIED |
| `replit/dinar-next-six-wave-unification` | `ebdd2d7a68f5a52af7ad973f21ef3b0cae914b4a` | 0 | 0 | PRESENT_AND_VERIFIED |
| `replit/railway-complete-infrastructure-readiness` | `21e8562a1b640ebcdd4a270146e7cf56c37f053b` | 6 | 27 | SUPERSEDED_WITH_PROOF / DOCUMENTATION_ONLY |
| `replit/railway-integrations-readiness` | `75d59370884d8799df860d35895f19d987e93d17` | 3 | 11 | SUPERSEDED_WITH_PROOF |
| `replit/wave03-intent-integration` | `76a7e403117233122b6d5bce2009268bcc586680` | 2 | 19 | PRESENT_AND_VERIFIED |

Unique count means `candidate..remote-head`; changed paths mean `merge-base(candidate,remote-head)..remote-head`. An ancestor therefore has zero unique commits/branch-side paths while current source can have later improvements. Exact final code SHA and per-file evidence are in JSON.

## D16 / D17 first: strongest compatible controls

The three legal/privacy histories are reconciled against current source: qoder/wave06, qoder/wave06b, replit/d16. Most core routes/public/admin surfaces are exact historical blobs; the changed protection points are individually inspected. Current country gates add noncircular owner-approval blockers, locked/CAS readiness changes, atomic capability disable and approval clearing on suspension, immutable incident transitions, code-only evidence references and deployment-marker enforcement. Old tests B08/D12/E16/F18 that asserted stale enablement, retained approvals, editable closed incidents or URL evidence are superseded by stricter negative tests—not silently deleted. The adversarial 19 cases, legal/consent/isolation suites and restricted-market negative payment gate are executable evidence. Synthetic approvals are not real legal clearance.

D17 conversation-memory core is byte-identical in the reviewed Qoder versions. Historical 0055 conversation-memory SQL is byte-identical to canonical 0054 under the integrated numbering. Retention/consent/retrieval and user isolation remain in the shared engine; retrieved memory is a separate untrusted block. The retrieval fixture reindexes all indexed rows while preserving its 8192-byte bound and privacy guard. Context/adversarial/quality/performance regressions qualify current behavior, not inaccessible original V2 provenance.

No old 0051 order amendment or alternate 0041–0055 chain is imported. The original 57 SQL files/manifest prefix remain unchanged; current 60 reviewed entries include preserved Connect 0057–0059.

## Divergent source contributions

### `claude/06-w02-ultra`

HEAD `8f4662b8a8d0c1ebc90bec06cd17c89795d8a480`; 2 original unique commits; 1 modified paths. Complete file/commit/blob evidence is in JSON.

- **DOCUMENTATION_ONLY — Two report commits, one documentation file, no unique application source**
  Current equivalent: Original d06ee93a and 8f4662b8 remain reachable; historical report retained
  Missing/limit: None identified in the cited behavior
  Evidence/tests: Source/workflow/artifact inspection; no runtime test claimed for documentation or unintegrated Claude code.
  Security: Do not turn its 102/104 or other historical figures into current evidence.

### `claude/dinar-next-intelligence`

HEAD `d0c2f0390b6d06bece8bd2d95c5629d2384c19bc`; 17 original unique commits; 57 modified paths. Complete file/commit/blob evidence is in JSON.

- **OWNER_DECISION_REQUIRED — Eight absent model bindings and CAPABILITIES surface; existing canonical services are not absent**
  Current equivalent: Claude d0c2f039: describeDinarCapabilities, prepareBusinessListingAction, readAiUsage, readBusinessOverview, readOrderIssues, readSellerDues, searchDomains, searchPartnerOffers
  Missing/limit: These model bindings, usage forecast/context disambiguation, advisory routing, bounded verification and self-hosted prepared config are not integrated.
  Evidence/tests: Source/workflow/artifact inspection; no runtime test claimed for documentation or unintegrated Claude code.
  Security: 23 registered capabilities vs current 15; model tools remain read/preparation only. Preserve original 17 commits; owner-authorized joint candidate and role/initialization tests required.

- **OWNER_DECISION_REQUIRED — Claude regression/evaluation/doc work**
  Current equivalent: Exact 57 changed paths and nine current merge-tree text conflicts in FINAL_CLAUDE_INTEGRATION_HANDOFF
  Missing/limit: Current live Arabic quality and final independent approval remain unverified.
  Evidence/tests: Source/workflow/artifact inspection; no runtime test claimed for documentation or unintegrated Claude code.
  Security: PR6 Git head verified; API/draft metadata unavailable. Claude-reported tests are not joint-Codex acceptance.

### `codex/11-c1-sql-search`

HEAD `f351f5d20d52d77b69bdcff66e2412796e53aa39`; 7 original unique commits; 16 modified paths. Complete file/commit/blob evidence is in JSON.

- **SUPERSEDED_WITH_PROOF — Bounded indexed candidate retrieval, eligible organic/paid ordering and numeric compatibility**
  Current equivalent: src/lib/marketplace-listings.candidateBatches + keysetAfter, marketplace-search-index.ts, canonical JS predicate/sort conversion; 30 original numeric values ported to SF-HIST-C1
  Missing/limit: Old fixed-128 cursor/constant-space attribute-sort property is not retained. Current adaptive keyset batches cap at 2000; attribute sorting collects matches. Functional goldens and measured workloads are evidence, not proof of identical peak-memory/transaction-snapshot properties.
  Evidence/tests: `search-sql-foundation.test`, `search-sql-performance.test`
  Security: 88 caller-shaped goldens plus actual numeric filters/sorts. Current adaptive bound ≤2000 differs from old fixed 128 cursor; no claim of byte/transaction-snapshot equivalence.

- **INCOMPATIBLE_OR_UNSAFE — Alternate SQL functions, cursor module, numeric 0045 migration and specialized CI**
  Current equivalent: Keep canonical reviewed SQL and canonical C1 workflows; no duplicate cursor/search engine
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `development-tls.test`
  Security: Old 0041/0045 order conflicts. Removing its implementation does not remove numeric behavior: Number semantics and bounded search are measured in canonical service.

- **PRESENT_BUT_REGRESSION_UNVERIFIED — Historical fixed cursor memory profile and transactional snapshot strategy**
  Current equivalent: Canonical adaptive keyset SQL candidates, exact JavaScript attribute predicates/sort
  Missing/limit: No owner performance SLO or full heap equivalence is established. Preserve canonical engine, disclose difference and measure existing 100k benchmark; no second search engine.
  Evidence/tests: `search-sql-performance.test`
  Security: No financial/authorization difference identified; performance strategy remains a declared integration limit.

### `qoder/07-stock`

HEAD `a80bbe32fdf8d9703875658e81b58923e20a1a13`; 3 original unique commits; 4 modified paths. Complete file/commit/blob evidence is in JSON.

- **PRESENT_AND_VERIFIED — Read persisted available minus reserved stock; contextual one-result focus, unrelated-name precision**
  Current equivalent: src/ai/stock-question.ts + existing conversation runtime; t3-stock-questions and sc01 browser script exact historical blobs
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `t3-stock-questions.test`, `stock-spec-conversation.test`, `sc02-listing-facts.test`, `sc06-spec-questions.test`
  Security: Current additional contact/8-digit guard prevents phone-shaped stock interpretation; no reserve or cart mutation.

### `qoder/09-launch-gates`

HEAD `5a005005224cf5ac05f72c8328258dd061a9846b`; 2 original unique commits; 1 modified paths. Complete file/commit/blob evidence is in JSON.

- **SUPERSEDED_WITH_PROOF — Dependency advisory and redacted credential scanning workflow**
  Current equivalent: .github/workflows/qoder-security.yml replaces old nonblocking/unpinned qoder-security-audit.yml
  Missing/limit: None identified in the cited behavior
  Evidence/tests: Source/workflow/artifact inspection; no runtime test claimed for documentation or unintegrated Claude code.
  Security: Pinned actions, contents:read, blocking high/critical dependency audit. Local official gitleaks 8.30.1 scanned all accessible refs including merge-parent diffs (554 commits), zero findings; actual hosted run metadata remains unavailable.

### `qoder/12-wave02-red-evidence`

HEAD `92aeb0c2858a2778a2cb496665c3f6b2b29ee5b5`; 1 original unique commits; 1 modified paths. Complete file/commit/blob evidence is in JSON.

- **SUPERSEDED_WITH_PROOF — Dispatch API acceptance from historical red-evidence branch**
  Current equivalent: .github/workflows/qoder-api-suite.yml + artifacts/api-server/test/isolation/local-suite.sh
  Missing/limit: None identified in the cited behavior
  Evidence/tests: Source/workflow/artifact inspection; no runtime test claimed for documentation or unintegrated Claude code.
  Security: Current closed suite/chain/flag inputs and fixed interpreter reject arbitrary shell input; historical red output remains historical.

### `qoder/15-d3a-native-business`

HEAD `939930d1037387f39f1a2c64ac5b2ae61146b251`; 13 original unique commits; 44 modified paths. Complete file/commit/blob evidence is in JSON.

- **PRESENT_AND_VERIFIED — INTERNAL_DINAR setup, catalog drafts, publish/price/pause/resume/stock-out, storefront and insights**
  Current equivalent: src/ai/business-turn.ts; lib/business-catalog.ts; BusinessSurface/business-types/business-adapters components exact historical blobs; current API uses /businesses/:id/storefront
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `d3a-native-business.test`, `d3a-browser-journey.test`, `integration-business-listings.test`
  Security: Actual shared conversation/cart/listing authorities, D3A44/45 lost-ack safety and immutable existing order prices now checked.

- **SUPERSEDED_WITH_PROOF — Placeholder D2 identity/staff port and parallel D3 identity schema**
  Current equivalent: Canonical D2 persisted profiles/membership, forBusinessActor, D3 d2BusinessId association and D4 delegation
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `d1-d2-business-foundation.test`, `business-delegations.test`, `d4-d5-isolation-security.test`
  Security: Do not restore PENDING_D2-only adapter or infer STAFF authority; publication requires current VERIFIED/ELIGIBLE D2.

- **INCOMPATIBLE_OR_UNSAFE — Old migration 0042 native-business numbering and old public route**
  Current equivalent: Canonical 0047 operating-profile relationship; public /storefront route stays separate from D2 private detail
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `d3a-native-business.test`
  Security: Old schema/route collision would remove later safeguards or shadow private APIs. Public display uses business identity, not owner personal account.

### `qoder/17-unified-integration-candidate`

HEAD `4e60a56e3d21defea4c2d580c35fd3b198e52b5e`; 41 original unique commits; 149 modified paths. Complete file/commit/blob evidence is in JSON.

- **PRESENT_AND_VERIFIED — W07 immutable financial journal, versioned 10% fee basis and terminal accounting**
  Current equivalent: src/lib/order-journal.ts; order-terminal-accounting.ts; commission-policy.ts; payments/service.ts and obligations.ts are exact historical blobs where indicated in file evidence
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave07-financial-journal.test`, `financial-state-machine.test`, `wave07-w12-contract-hardening.test`
  Security: Stored fees/order lines immutable; identical payment replay cannot re-earn; currency is persisted per market.

- **PRESENT_AND_VERIFIED — W08 direct cash claim/ack and distinct cash-refund state machine**
  Current equivalent: src/lib/payments/cash.ts; src/routes/cash.ts before wildcard routes; order-before-refund lock order
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave08-cash-and-refunds.test`, `financial-state-machine.test`
  Security: A cash claim is not received money; concurrent open/confirm cannot deadlock or duplicate; physical partial-return policy remains owner-controlled.

- **PRESENT_AND_VERIFIED — W09 versioned policies/consent, age, seller verification and country gates**
  Current equivalent: src/lib/policy-lifecycle.requiredAcceptanceVersions and policy-gate.acceptReviewedPolicies; lib/compliance.ts
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave09-policy-consent-compliance.test`, `policy-consent-cards.test`, `wave07-w12-contract-hardening.test`
  Security: Conversation acceptance reuses canonical published versions and immutable consent evidence; optional consent is separate.

- **PRESENT_AND_VERIFIED — W10 moderation/reports, fraud, support/response targets and honest WhatsApp readiness**
  Current equivalent: src/lib/moderation.ts, fraud-signals.ts, support-cases.ts, response-targets.ts, whatsapp-readiness.ts; routes/trust-ops and trust-safety exact blobs
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave10-trust-support-whatsapp.test`
  Security: No automated punitive action or fake provider delivery; live WhatsApp remains NOT_CONNECTED.

- **SUPERSEDED_WITH_PROOF — W11/W12 evidence and CI isolation/dispatch contracts**
  Current equivalent: Pinned read-only-token workflows; fixed suite/chain/flag allowlists; existing local-suite.sh with net guard and serialized browser fixtures
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave07-w12-contract-hardening.test`
  Security: Historical CI counts are not final acceptance. Actual hosted job metadata unavailable; no test gate weakened.

- **PRESENT_AND_VERIFIED — Canonical card restore/refetch, expiry, tabs, receipts, keyboard/RTL/performance**
  Current equivalent: Existing Card Envelope/renderer and card-sync.ts; six historical UI/helper blobs remain exact; current chronology and deterministic busy fixture repair are stronger
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w02u3-card-reliability.test`, `w02u3-card-reliability-browser-journey.test`, `w02u3-card-concurrency-browser-journey.test`, `w02u3-card-sessions-browser-journey.test`, `w02u3-card-recovery-browser-journey.test`, `w02u3-card-expiry-browser-journey.test`, `w02u3-card-accessibility-browser-journey.test`, `w02u3-card-performance-browser-journey.test`
  Security: Never resend a possibly executed request or animate external/failed/replayed cart success.

- **PRESENT_AND_VERIFIED — D1/D2 contract and listing association fixes; shared published-policy evidence**
  Current equivalent: lib/business-catalog-contract.ts; lib/policy-gate.ts; canonical D2 routes/generated contracts
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `d1-d2-business-foundation.test`, `policy-consent-cards.test`
  Security: Owner/business/market binding and published policy version govern; historical schema numbering is not imported.

- **INCOMPATIBLE_OR_UNSAFE — Renumbered duplicate W07–W10 migrations**
  Current equivalent: Current original Replit migration prefix; parallel W07 originals are already byte-identical at canonical names
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `development-tls.test`
  Security: Never insert old 0043–0046 alternate identities into the immutable current chain.

### `qoder/a01-baseline-audit`

HEAD `f107dd32984cbdcb8e7dce3602ea26d99d9af9b5`; 5 original unique commits; 7 modified paths. Complete file/commit/blob evidence is in JSON.

- **PRESENT_AND_VERIFIED — Omit unauthorized/absent seller facts from model context; expose D4/D5 test chains**
  Current equivalent: smart-turn modelContext spreads sellerListing only when marketingFacts exists; canonical workflow allowlists
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `d4-d5-isolation-security.test`, `wave04-d10-d11-acceptance.test`
  Security: No seller fact is invented when authorized data is absent; read/preparation contracts retained.

### `qoder/a02-d4-d5-security`

HEAD `8f9f6ad23067a7251a444dbe0e210ef4f1218b69`; 5 original unique commits; 4 modified paths. Complete file/commit/blob evidence is in JSON.

- **PRESENT_AND_VERIFIED — Owner/business/employee/principal/market isolation, grant revocation/expiry, stale prepared actions and prompt injection**
  Current equivalent: Canonical lib/business-delegations.ts; smart-turn sellerListing omission; original eight scenario assertions retained with valid timestamp/privacy-safe fixture tokens
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `d4-d5-isolation-security.test`, `business-delegations.test`
  Security: Live grants/version/expiry and row-lock ordering rechecked before canonical writes; no raw staff keys or inherited Connect writes.

### `qoder/closure-12-executing-recovery`

HEAD `2e0cca1345d2a2e0a4295c24aeac5b8b4ce59143`; 3 original unique commits; 8 modified paths. Complete file/commit/blob evidence is in JSON.

- **PRESENT_AND_VERIFIED — Execution lease, UNKNOWN instead of permanent EXECUTING, no replay and sweep registration**
  Current equivalent: action-recovery.ts/action-foundation.ts/business-turn.ts were exact prior to narrow 99cb052 extension; index.ts still invokes sweep and now uses common graceful shutdown
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `d12-execution-recovery.test`, `d3a-native-business.test`
  Security: All original cases retained; additional real committed effects with lost ACK stay UNKNOWN and cannot replay or overwrite late CONFIRMED.

- **SUPERSEDED_WITH_PROOF — Per-receipt N+1 reads**
  Current equivalent: action-receipts verifiedReceiptRecords batches the same owned records before formatting
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w02u3-card-performance-browser-journey.test`, `wave04-d10-d12-acceptance.test`
  Security: Owner/negotiation/order/intent filtering survives batching; no receipt trusts client/model figures.

### `qoder/parallel-w07-w12-ultra`

HEAD `af89cb340be4eb11a46b290e3dc5217e52af07ce`; 20 original unique commits; 56 modified paths. Complete file/commit/blob evidence is in JSON.

- **PRESENT_AND_VERIFIED — W07 immutable financial journal, versioned 10% fee basis and terminal accounting**
  Current equivalent: src/lib/order-journal.ts; order-terminal-accounting.ts; commission-policy.ts; payments/service.ts and obligations.ts are exact historical blobs where indicated in file evidence
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave07-financial-journal.test`, `financial-state-machine.test`, `wave07-w12-contract-hardening.test`
  Security: Stored fees/order lines immutable; identical payment replay cannot re-earn; currency is persisted per market.

- **PRESENT_AND_VERIFIED — W08 direct cash claim/ack and distinct cash-refund state machine**
  Current equivalent: src/lib/payments/cash.ts; src/routes/cash.ts before wildcard routes; order-before-refund lock order
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave08-cash-and-refunds.test`, `financial-state-machine.test`
  Security: A cash claim is not received money; concurrent open/confirm cannot deadlock or duplicate; physical partial-return policy remains owner-controlled.

- **PRESENT_AND_VERIFIED — W09 versioned policies/consent, age, seller verification and country gates**
  Current equivalent: src/lib/policy-lifecycle.requiredAcceptanceVersions and policy-gate.acceptReviewedPolicies; lib/compliance.ts
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave09-policy-consent-compliance.test`, `policy-consent-cards.test`, `wave07-w12-contract-hardening.test`
  Security: Conversation acceptance reuses canonical published versions and immutable consent evidence; optional consent is separate.

- **PRESENT_AND_VERIFIED — W10 moderation/reports, fraud, support/response targets and honest WhatsApp readiness**
  Current equivalent: src/lib/moderation.ts, fraud-signals.ts, support-cases.ts, response-targets.ts, whatsapp-readiness.ts; routes/trust-ops and trust-safety exact blobs
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave10-trust-support-whatsapp.test`
  Security: No automated punitive action or fake provider delivery; live WhatsApp remains NOT_CONNECTED.

- **SUPERSEDED_WITH_PROOF — W11/W12 evidence and CI isolation/dispatch contracts**
  Current equivalent: Pinned read-only-token workflows; fixed suite/chain/flag allowlists; existing local-suite.sh with net guard and serialized browser fixtures
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave07-w12-contract-hardening.test`
  Security: Historical CI counts are not final acceptance. Actual hosted job metadata unavailable; no test gate weakened.

- **PRESENT_AND_VERIFIED — Original four SQL modules**
  Current equivalent: 0041 financial journal, 0042 cash, 0043 policy, 0044 trust are byte-identical at canonical paths
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `development-tls.test`
  Security: No duplicate ledger or changed fee policy was introduced.

### `qoder/temp-principal-sixwave-closure`

HEAD `44dfbf639fda27d4b8de7908c0aea8df25ab50ef`; 16 original unique commits; 17 modified paths. Complete file/commit/blob evidence is in JSON.

- **PRESENT_AND_VERIFIED — Nine operational/test corrections and history-render benchmark previously incorporated**
  Current equivalent: Current 0056 hash/journal expectation; card cross-market refusal; D17 measured index; digit-free refund fixture; immutable cash-only fixture and history-render test
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `development-tls.test`, `w02u3-card-reliability.test`, `w06-d17-retrieval-quality.test`, `wave08-cash-and-refunds.test`, `g2-smart-conversation.test`
  Security: Current tests preserve every actual security/financial assertion. IME keyCode229 browser proof is stronger than its historical isComposing-only claim.

- **DOCUMENTATION_ONLY — Last four unique handoff/billing/report commits**
  Current equivalent: Original 16da2f16, ad394690, 798dcaa2, 44dfbf63 retained
  Missing/limit: None identified in the cited behavior
  Evidence/tests: Source/workflow/artifact inspection; no runtime test claimed for documentation or unintegrated Claude code.
  Security: No unique unpublished application code found at these heads; no inaccessible workspace is claimed empty.

### `qoder/wave06-d16-d17-closure`

HEAD `891c37d6a904c4ba8809e4531040c63f030bed99`; 23 original unique commits; 113 modified paths. Complete file/commit/blob evidence is in JSON.

- **PRESENT_AND_VERIFIED — Country intake, topic/evidence/policy records, distinct counsel/owner/technical authority**
  Current equivalent: src/lib/country-legal-readiness.ts; src/routes/compliance.ts; src/pages/admin/AdminLegalReadiness.tsx
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `d16-readiness.test`, `market-legal-acceptance.test`, `w06-d16-adversarial.test`
  Security: Real legal approval is not fabricated; only guarded synthetic approvals are tested.

- **SUPERSEDED_WITH_PROOF — Emergency-disable race D16-B08 and country-suspension ladder D16-D12**
  Current equivalent: src/lib/d16-readiness.ts locked state/CAS; country-legal-readiness.suspendCountryReadiness clears country/capability approvals
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w06-d16-adversarial.test`
  Security: Current source rejects stale enable and requires fresh approvals; historical assertions documenting ENABLED after stop are not protections to re-import.

- **SUPERSEDED_WITH_PROOF — Closed incident/evidence integrity D16-E16 and code-only references D16-F18**
  Current equivalent: src/lib/d16-readiness.ts; lib/db/drizzle/0055_d16_incident_integrity.sql
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w06-d16-adversarial.test`
  Security: Closed rows cannot be downgraded; incident insert needs its OPENED event; URL locators are rejected as evidence references.

- **PRESENT_AND_VERIFIED — Deployment markers, privacy/consent, age and market restrictions**
  Current equivalent: src/lib/d16-readiness.marketLegalGateEnforced; lib/compliance.ts; lib/privacy-rights.ts; lib/policy-lifecycle.ts; lib/markets.ts
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w06-d16-adversarial.test`, `wave09-policy-consent-compliance.test`, `closure-privacy.test`, `wave06-d16-compliance-acceptance.test`
  Security: REPLIT_DEPLOYMENT wins over development exemptions; password-confirmed owned export, retention/real counsel remain unapproved.

- **INCOMPATIBLE_OR_UNSAFE — Historical SQL identities/journal numbering**
  Current equivalent: Canonical original Replit 57-file prefix plus 0057–0059 only
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `development-tls.test`, `g33-docker-acceptance.test`
  Security: Qoder 0051 order amendment and shifted D16/D17 names conflict with the reviewed prefix. Preserve objects, never apply that alternate chain.

- **PRESENT_AND_VERIFIED — Bounded summary/keyword retrieval, stale refresh, ownership/market isolation, PII redaction and derived export**
  Current equivalent: src/ai/conversation-memory.ts is byte-identical at both Qoder heads; original 0055_conversation_memory.sql is byte-identical to canonical 0054_conversation_memory.sql; current privacy export also includes Connect
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave06-conversation-memory.test`, `wave06-conversation-memory-adversarial.test`, `w06-d17-retrieval-quality.test`
  Security: No other actor/tenant/history grants authority; summaries are disclosed and removed with owned deletion.

- **PRESENT_AND_VERIFIED — Retrieved history separated from current user request (db4c2654)**
  Current equivalent: src/ai/model-turn.modelMessagesFor uses its own bounded untrusted history block; smart-turn passes server-owned memory
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave06-conversation-memory.test`, `wave06-conversation-memory-adversarial.test`
  Security: Preserve data/instruction boundary and model no-writer invariant; no live model quality inferred.

- **SUPERSEDED_WITH_PROOF — Retrieval measurement and injection-fixture fixes**
  Current equivalent: w06-d17-retrieval-quality R6 reindexes and divides by all indexed live rows; adversarial D1 uses digit-free literal suffix
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w06-d17-retrieval-quality.test`, `wave06-conversation-memory-adversarial.test`
  Security: Original 8192-byte ceiling and literal SQL-injection assertion retained; privacy redaction is never disabled.

### `qoder/wave06b-d16-d17-closure`

HEAD `d341917ec4a34ade3c1bdde8366a44dbbca9f35d`; 14 original unique commits; 108 modified paths. Complete file/commit/blob evidence is in JSON.

- **PRESENT_AND_VERIFIED — Country intake, topic/evidence/policy records, distinct counsel/owner/technical authority**
  Current equivalent: src/lib/country-legal-readiness.ts; src/routes/compliance.ts; src/pages/admin/AdminLegalReadiness.tsx
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `d16-readiness.test`, `market-legal-acceptance.test`, `w06-d16-adversarial.test`
  Security: Real legal approval is not fabricated; only guarded synthetic approvals are tested.

- **SUPERSEDED_WITH_PROOF — Emergency-disable race D16-B08 and country-suspension ladder D16-D12**
  Current equivalent: src/lib/d16-readiness.ts locked state/CAS; country-legal-readiness.suspendCountryReadiness clears country/capability approvals
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w06-d16-adversarial.test`
  Security: Current source rejects stale enable and requires fresh approvals; historical assertions documenting ENABLED after stop are not protections to re-import.

- **SUPERSEDED_WITH_PROOF — Closed incident/evidence integrity D16-E16 and code-only references D16-F18**
  Current equivalent: src/lib/d16-readiness.ts; lib/db/drizzle/0055_d16_incident_integrity.sql
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w06-d16-adversarial.test`
  Security: Closed rows cannot be downgraded; incident insert needs its OPENED event; URL locators are rejected as evidence references.

- **PRESENT_AND_VERIFIED — Deployment markers, privacy/consent, age and market restrictions**
  Current equivalent: src/lib/d16-readiness.marketLegalGateEnforced; lib/compliance.ts; lib/privacy-rights.ts; lib/policy-lifecycle.ts; lib/markets.ts
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w06-d16-adversarial.test`, `wave09-policy-consent-compliance.test`, `closure-privacy.test`, `wave06-d16-compliance-acceptance.test`
  Security: REPLIT_DEPLOYMENT wins over development exemptions; password-confirmed owned export, retention/real counsel remain unapproved.

- **INCOMPATIBLE_OR_UNSAFE — Historical SQL identities/journal numbering**
  Current equivalent: Canonical original Replit 57-file prefix plus 0057–0059 only
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `development-tls.test`, `g33-docker-acceptance.test`
  Security: Qoder 0051 order amendment and shifted D16/D17 names conflict with the reviewed prefix. Preserve objects, never apply that alternate chain.

- **PRESENT_AND_VERIFIED — Bounded summary/keyword retrieval, stale refresh, ownership/market isolation, PII redaction and derived export**
  Current equivalent: src/ai/conversation-memory.ts is byte-identical at both Qoder heads; original 0055_conversation_memory.sql is byte-identical to canonical 0054_conversation_memory.sql; current privacy export also includes Connect
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave06-conversation-memory.test`, `wave06-conversation-memory-adversarial.test`, `w06-d17-retrieval-quality.test`
  Security: No other actor/tenant/history grants authority; summaries are disclosed and removed with owned deletion.

- **PRESENT_AND_VERIFIED — Retrieved history separated from current user request (db4c2654)**
  Current equivalent: src/ai/model-turn.modelMessagesFor uses its own bounded untrusted history block; smart-turn passes server-owned memory
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave06-conversation-memory.test`, `wave06-conversation-memory-adversarial.test`
  Security: Preserve data/instruction boundary and model no-writer invariant; no live model quality inferred.

- **SUPERSEDED_WITH_PROOF — Retrieval measurement and injection-fixture fixes**
  Current equivalent: w06-d17-retrieval-quality R6 reindexes and divides by all indexed live rows; adversarial D1 uses digit-free literal suffix
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w06-d17-retrieval-quality.test`, `wave06-conversation-memory-adversarial.test`
  Security: Original 8192-byte ceiling and literal SQL-injection assertion retained; privacy redaction is never disabled.

- **PRESENT_AND_VERIFIED — D4/D5 privacy-safe listing fixture and Wave04 chain exposure**
  Current equivalent: Current safeTag() and canonical fixed CI chains retain the same authorization assertions
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `d4-d5-isolation-security.test`, `wave04-d10-d12-acceptance.test`
  Security: Test tokens cannot accidentally resemble phone numbers; no real contact guard disabled.

### `replit/d16-legal-privacy-compliance`

HEAD `c196a9bf892547322644540a5d03c338020581da`; 1 original unique commits; 92 modified paths. Complete file/commit/blob evidence is in JSON.

- **PRESENT_AND_VERIFIED — Country intake, topic/evidence/policy records, distinct counsel/owner/technical authority**
  Current equivalent: src/lib/country-legal-readiness.ts; src/routes/compliance.ts; src/pages/admin/AdminLegalReadiness.tsx
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `d16-readiness.test`, `market-legal-acceptance.test`, `w06-d16-adversarial.test`
  Security: Real legal approval is not fabricated; only guarded synthetic approvals are tested.

- **SUPERSEDED_WITH_PROOF — Emergency-disable race D16-B08 and country-suspension ladder D16-D12**
  Current equivalent: src/lib/d16-readiness.ts locked state/CAS; country-legal-readiness.suspendCountryReadiness clears country/capability approvals
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w06-d16-adversarial.test`
  Security: Current source rejects stale enable and requires fresh approvals; historical assertions documenting ENABLED after stop are not protections to re-import.

- **SUPERSEDED_WITH_PROOF — Closed incident/evidence integrity D16-E16 and code-only references D16-F18**
  Current equivalent: src/lib/d16-readiness.ts; lib/db/drizzle/0055_d16_incident_integrity.sql
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w06-d16-adversarial.test`
  Security: Closed rows cannot be downgraded; incident insert needs its OPENED event; URL locators are rejected as evidence references.

- **PRESENT_AND_VERIFIED — Deployment markers, privacy/consent, age and market restrictions**
  Current equivalent: src/lib/d16-readiness.marketLegalGateEnforced; lib/compliance.ts; lib/privacy-rights.ts; lib/policy-lifecycle.ts; lib/markets.ts
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `w06-d16-adversarial.test`, `wave09-policy-consent-compliance.test`, `closure-privacy.test`, `wave06-d16-compliance-acceptance.test`
  Security: REPLIT_DEPLOYMENT wins over development exemptions; password-confirmed owned export, retention/real counsel remain unapproved.

- **INCOMPATIBLE_OR_UNSAFE — Historical SQL identities/journal numbering**
  Current equivalent: Canonical original Replit 57-file prefix plus 0057–0059 only
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `development-tls.test`, `g33-docker-acceptance.test`
  Security: Qoder 0051 order amendment and shifted D16/D17 names conflict with the reviewed prefix. Preserve objects, never apply that alternate chain.

### `replit/railway-complete-infrastructure-readiness`

HEAD `21e8562a1b640ebcdd4a270146e7cf56c37f053b`; 6 original unique commits; 27 modified paths. Complete file/commit/blob evidence is in JSON.

- **SUPERSEDED_WITH_PROOF — Graceful SIGTERM/drain, pool idle-error handling, honest configuration readiness and environment runbooks**
  Current equivalent: src/server-lifecycle.ts + index.ts shutdown hook; lib/db/src/index.ts pool.on(error) and bounded pool settings; routes/health.ts
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave05-d13-shutdown.test`, `fresh-environment.test`, `readiness.test`, `g33-docker-acceptance.test`
  Security: Current source retains phoneVerification as a readiness blocker and D16 activation refusal; never reintroduce old SMS-independent readiness as launch green.

- **DOCUMENTATION_ONLY — Railway staging/operations documentation**
  Current equivalent: Historical runbooks preserved plus FINAL_LAUNCH_READINESS procedure
  Missing/limit: None identified in the cited behavior
  Evidence/tests: Source/workflow/artifact inspection; no runtime test claimed for documentation or unintegrated Claude code.
  Security: No Railway/production resource inspected or modified; actual staging/backup/provider/legal acceptance remains separately authorized.

### `replit/railway-integrations-readiness`

HEAD `75d59370884d8799df860d35895f19d987e93d17`; 3 original unique commits; 11 modified paths. Complete file/commit/blob evidence is in JSON.

- **SUPERSEDED_WITH_PROOF — Early readiness/shutdown package**
  Current equivalent: Same canonical lifecycle and readiness authority as later Railway branch, with retained stricter phone/legal gates
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `wave05-d13-shutdown.test`, `fresh-environment.test`, `readiness.test`
  Security: Its old 200-without-SMS expectation is superseded by documented current 503. No deployment performed.

### `replit/wave03-intent-integration`

HEAD `76a7e403117233122b6d5bce2009268bcc586680`; 2 original unique commits; 19 modified paths. Complete file/commit/blob evidence is in JSON.

- **PRESENT_AND_VERIFIED — Merged negotiation/read-tool/card contribution**
  Current equivalent: inquiry-turn.ts, intent baseline, model-capability-tools.ts, negotiation-turn.ts and unchanged ai-authority-boundary were exact at initial cut; later source includes bounded read feedback, memory and Connect
  Missing/limit: None identified in the cited behavior
  Evidence/tests: `ai-authority-boundary.test`, `ai-foundation-acceptance.test`, `ai-foundation-02-acceptance.test`, `wave03-d7-cart-browser-journey.test`
  Security: Only read/preparation model tools; ordinary canonical order/cart/negotiation services retained.

- **PRESENT_AND_VERIFIED — 76a7e403 basket-product comparison and purchase-reference regressions**
  Current equivalent: c2a8717 selective restoration in intent.ts, marketplace-intent.ts and authored lib/api-zod/conversation-runtime.ts; original parser and MODEL_FIRST cases plus actual G2 HTTP product/comparison test
  Missing/limit: Missing at initial Codex cut, now restored with original attribution; no branch merge or history recreation.
  Evidence/tests: `conversation-router.test`, `model-native-routing.test`, `g2-smart-conversation.test`
  Security: Routing and query extraction share one grammar; concrete product titles no longer match unanchored BUY_LISTING. Cart navigation and confirmed writes retain separate semantics.

## Contained heads: current behavior verification

| Branch | Current semantic contribution | Regression evidence |
| --- | --- | --- |
| `ai-foundation-02` | Read/review-only capability/model contract | `ai-foundation-acceptance.test`, `ai-foundation-02-acceptance.test`, `ai-authority-boundary.test` |
| `claude/02-sc-acceptance` | Integrated marketplace/conversation/finance/business platform; no unique branch-side source remains | `commerce-journey.test`, `g2-smart-conversation.test`, `financial-state-machine.test`, `d4-d5-isolation-security.test`, `w06-d16-adversarial.test`, `wave06-conversation-memory-adversarial.test` |
| `claude/04-reconciliation` | Integrated marketplace/conversation/finance/business platform; no unique branch-side source remains | `commerce-journey.test`, `g2-smart-conversation.test`, `financial-state-machine.test`, `d4-d5-isolation-security.test`, `w06-d16-adversarial.test`, `wave06-conversation-memory-adversarial.test` |
| `claude/05-w04-context` | Sealed conversation context, explicit corrections and owned reference resolution | `context-sealed.test`, `context-understanding.test` |
| `claude/07-legal-cards` | Canonical envelope, action receipt/reliability, expiry and cross-session isolation | `wave03-card-envelope.test`, `w02u3-card-reliability.test`, `w02u3-card-concurrency-browser-journey.test` |
| `claude/08-model-native` | Model-first canonical re-entry without purchase/decision authority | `model-native-routing.test`, `ai-authority-boundary.test` |
| `claude/09-dual-tier` | Model-tier/provider controls with canonical authority boundaries | `model-tiers.test`, `provider-controls.test` |
| `claude/10-ultra-closure` | Integrated marketplace/conversation/finance/business platform; no unique branch-side source remains | `commerce-journey.test`, `g2-smart-conversation.test`, `financial-state-machine.test`, `d4-d5-isolation-security.test`, `w06-d16-adversarial.test`, `wave06-conversation-memory-adversarial.test` |
| `claude/11-c1-sql-search` | Canonical indexed candidate retrieval and reference-compatible search | `search-sql-foundation.test`, `search-sql-performance.test` |
| `claude/12-d1-d2-business-foundation` | D1/D2 identity, verified business roles and native business foundation | `d1-d2-business-foundation.test`, `d3a-native-business.test` |
| `claude/13-integration-preflight` | Integrated marketplace/conversation/finance/business platform; no unique branch-side source remains | `commerce-journey.test`, `g2-smart-conversation.test`, `financial-state-machine.test`, `d4-d5-isolation-security.test`, `w06-d16-adversarial.test`, `wave06-conversation-memory-adversarial.test` |
| `codex/dinar-next-unified-development` | Integrated marketplace/conversation/finance/business platform; no unique branch-side source remains | `commerce-journey.test`, `g2-smart-conversation.test`, `financial-state-machine.test`, `d4-d5-isolation-security.test`, `w06-d16-adversarial.test`, `wave06-conversation-memory-adversarial.test` |
| `main` | Integrated marketplace/conversation/finance/business platform; no unique branch-side source remains | `commerce-journey.test`, `g2-smart-conversation.test`, `financial-state-machine.test`, `d4-d5-isolation-security.test`, `w06-d16-adversarial.test`, `wave06-conversation-memory-adversarial.test` |
| `qoder/04-sc02` | Persisted listing facts and incomplete attribute honesty | `sc02-listing-facts.test`, `sc02-browser-journey.test` |
| `qoder/05-sc06` | Precise Arabic specification/stock questions without model-created facts | `sc06-spec-questions.test`, `spec-question-generality.test` |
| `qoder/06-general-specs` | Precise Arabic specification/stock questions without model-created facts | `sc06-spec-questions.test`, `spec-question-generality.test` |
| `qoder/08-integration` | Integrated marketplace/conversation/finance/business platform; no unique branch-side source remains | `commerce-journey.test`, `g2-smart-conversation.test`, `financial-state-machine.test`, `d4-d5-isolation-security.test`, `w06-d16-adversarial.test`, `wave06-conversation-memory-adversarial.test` |
| `qoder/10-security-deps` | Shared session/role/origin/input safeguards | `security-acceptance.test`, `d4-d5-isolation-security.test` |
| `qoder/11-wave01-security-close` | Shared session/role/origin/input safeguards | `security-acceptance.test`, `d4-d5-isolation-security.test` |
| `qoder/12-wave02-card-reliability` | Canonical envelope, action receipt/reliability, expiry and cross-session isolation | `wave03-card-envelope.test`, `w02u3-card-reliability.test`, `w02u3-card-concurrency-browser-journey.test` |
| `qoder/13-wave03-card-envelope` | Canonical envelope, action receipt/reliability, expiry and cross-session isolation | `wave03-card-envelope.test`, `w02u3-card-reliability.test`, `w02u3-card-concurrency-browser-journey.test` |
| `qoder/14-w02u3-canonical-reliability` | Canonical envelope, action receipt/reliability, expiry and cross-session isolation | `wave03-card-envelope.test`, `w02u3-card-reliability.test`, `w02u3-card-concurrency-browser-journey.test` |
| `qoder/d12-replit-integration` | Executing lease recovery and truthful owned receipts | `d12-execution-recovery.test`, `w02u3-card-recovery-browser-journey.test` |
| `qoder/wave01-d1-d3-closure` | D1/D2 identity, verified business roles and native business foundation | `d1-d2-business-foundation.test`, `d3a-native-business.test` |
| `qoder/wave02-d4-d6-closure` | D4/D5 live delegation and D6 buyer/seller isolation | `business-delegations.test`, `wave02-d4-d5-seller-journey.test`, `wave02-d6-buyer-journey.test` |
| `qoder/wave03-d7-d9-closure` | D7 persistent cart, canonical checkout and authoritative campaigns | `wave03-card-envelope.test`, `commerce-journey.test`, `wave03-d9-campaign-audit.test` |
| `qoder/wave04-d10-d12-closure` | D10–12 canonical action execution, confirmation, outcomes and receipts | `wave04-d10-d11-acceptance.test`, `wave04-d10-d12-acceptance.test`, `d12-execution-recovery.test` |
| `qoder/wave05-d13-d15-closure` | D13–15 shutdown/profile/load, evaluation and money authority | `wave05-d13-shutdown.test`, `wave05-d14-evaluation.test`, `wave05-d15-money-model.test` |
| `replit/dinar-next-complete-development` | Integrated marketplace/conversation/finance/business platform; no unique branch-side source remains | `commerce-journey.test`, `g2-smart-conversation.test`, `financial-state-machine.test`, `d4-d5-isolation-security.test`, `w06-d16-adversarial.test`, `wave06-conversation-memory-adversarial.test` |
| `replit/dinar-next-six-wave-unification` | Integrated marketplace/conversation/finance/business platform; no unique branch-side source remains | `commerce-journey.test`, `g2-smart-conversation.test`, `financial-state-machine.test`, `d4-d5-isolation-security.test`, `w06-d16-adversarial.test`, `wave06-conversation-memory-adversarial.test` |

## Proven repairs and historical reuse

The reconciliation found a genuine partial loss in original Replit `76a7e403117233122b6d5bce2009268bcc586680`: available-product comparison search and exact basket-product/selection semantics. `c2a8717e1f345b4c9a2c5f39ae5a41b6e868ad82` selectively restores that rule/test, shares extraction in the existing intent module and restores anchored BUY_LISTING matchers in the authored registry. Real HTTP red→green proves search and comparison return published listings without a model, cart or financial mutation. Three original model-native tests retain their behaviors under current fixtures; 30 historical C1 numeric inputs are ported into the canonical SQL search tests. No second cart, router or SQL engine was created.

The separate confirmed lost-ack defect is fixed by `99cb0529c05c4af2c320922704d3128c155ea947`: a committed canonical generic/business effect followed by an acknowledgement failure becomes UNKNOWN, never a false rollback/success or an automatic replay. Existing conditional recovery records preserve claim evidence/later completion; native business price changes cannot rewrite historical order snapshots. D12/D3-A red counterexamples and paired PG16/18 regressions are recorded.

## Claude and original artifacts

Claude `d0c2f0390b6d06bece8bd2d95c5629d2384c19bc` / PR6 Git head is active and untouched. Its eight missing model bindings and capabilities, 17 original commits, file/behavior deltas and nine current textual conflicts are handed off in [FINAL_CLAUDE_INTEGRATION_HANDOFF](FINAL_CLAUDE_INTEGRATION_HANDOFF.md). Underlying existing services are reused; unmerged intelligence is not claimed complete. API draft/base/run metadata is blocked, distinct from verified Git refs.

Original Conversation V2 heads `719d4715a869f69831049a6a2f6c349cec934344` and `442008a5fdcb9dc6529a55364cd66e033c6a0909` remain **PRESERVATION_BLOCKED**, not declared lost. All accessible refs and 16 verified authorized bundles were inspected in a quarantined bare repository: 64 advertised tips are already reachable and neither object is present. No approved old-task/artifact search connector or expected `codex-conversation-v2-authorized.bundle` is available. Original IDs are never fabricated. Current V2/Stop/IME/stream/recovery tests independently prove named behaviors, not historical provenance. Gemini gateway implementation/testing exists; separate Gemini-agent artifact and live model quality/price/free quota are unverified.

## Closure limits

C1 functional results and numeric edges are verified; fixed-128 cursor/constant-space and transaction-snapshot equivalence are explicitly not claimed for current keyset/attribute-sort strategy. Active Claude intelligence, original artifacts, manual assistive technology, live/sandbox providers, legal/commercial approval and staging remain separate gates. No production readiness is inferred from local acceptance. [Launch matrix](FINAL_LAUNCH_READINESS.md) separates platform handoff, joint engineering, staging and production.

Remote snapshot includes the verified code publication. The later documentation-only delivery tip is given by the final publication receipt/owner-facing report; all other 48 heads remain unchanged.
