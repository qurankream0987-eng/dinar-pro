> Preserved prior source audit; not a new acceptance claim. The 47 historical heads still match the latest authenticated 49-head read. See [current Claude coordination](CLAUDE_PLATFORM_COORDINATION.md) for the two newly visible branches and current scope.

# DINAR source preservation inventory

Snapshot: 2026-11-04. Engineering start `492944fb053dfbfc1a1507055ccb4e3ea2100bc4`; reference integration `ebdd2d7a68f5a52af7ad973f21ef3b0cae914b4a`. All original remote-tracking refs retained. An ancestor indicates history inclusion, not workflow acceptance. Nonancestor branches are preserved, not safe wholesale merge candidates.

| Source | Exact SHA | History relationship / unique commits | Contribution at tip |
| --- | --- | --- | --- |
| `origin/ai-foundation-02` | `2ef9c07ab5fdcd15eca167f5a01ab32b6054400e` | Ancestor; acceptance tracked separately | test(ai): assert the seller actor's runtime toolset is the role union |
| `origin/claude/02-sc-acceptance` | `9679e488c5f3d2260078d98c7d97704df6aac6ce` | Ancestor; acceptance tracked separately | docs: technical handoff for the next engineering agent |
| `origin/claude/04-reconciliation` | `e5bbd1ba59bddae8c5bd173a890fcdeafa046c25` | Ancestor; acceptance tracked separately | fix(conversation): quoted listing titles are not contact details; general questions stay general |
| `origin/claude/05-w04-context` | `4322fb6d7b66460626509401370f5ec3a5f6c6a8` | Ancestor; acceptance tracked separately | docs(w04): closure report with sealed first-run, battery evidence; stronger edit test |
| `origin/claude/06-w02-ultra` | `8f4662b8a8d0c1ebc90bec06cd17c89795d8a480` | Divergent; 2 unique commits preserved | docs(w02-ultra): full battery on 243a247 — 102/104, phase1 green, two generator flakes fixed on claude/08 |
| `origin/claude/07-legal-cards` | `e17fad27339b9d40ccea341e46bef96941d34db8` | Ancestor; acceptance tracked separately | feat(w02-ultra B10): policy review card and contract-acceptance gate |
| `origin/claude/08-model-native` | `09ff489f0a3f5950b9f0a0ba8b6cfc49230a7747` | Ancestor; acceptance tracked separately | feat(ai): §09 bounded multi-step example end to end; §13 per-provider breaker and disable switch |
| `origin/claude/09-dual-tier` | `d416a047f3707d1f03c6763c76e96eee2ab69da4` | Ancestor; acceptance tracked separately | docs(ai): dual-tier final report — battery on 09ff489 (104/108, classified) and on the final SHA (108/110, classified), defects fixed, open items |
| `origin/claude/10-ultra-closure` | `9a0f86f0b3c727f48be58aee7db11a3045a94613` | Ancestor; acceptance tracked separately | docs(ai): ultra-closure report (clean 111/111 battery on 4999aa0, 1233 tests, 0 outbound), updated tier/provider/contract docs |
| `origin/claude/11-c1-sql-search` | `d94477bad836bf4fe7b3330884170625d1698270` | Ancestor; acceptance tracked separately | docs(search): C1 Arabic technical report — caller matrix, before/after architecture, golden equivalence, 1k/10k/100k benchmark with plans, relevance, migration, security, clean 113/113 battery on 92227d1, risks, rollback |
| `origin/claude/12-d1-d2-business-foundation` | `91b09ee7e24b737879d1bcf0ff1f8c238026d3f4` | Ancestor; acceptance tracked separately | docs(d1-d2): final evidence — battery 75139b7 (114/115, one fixed), reruns on 8f46dfd, Actions 41265984814 PG16+PG18 success, OpenAPI coverage |
| `origin/claude/13-integration-preflight` | `fe1c23396930f836d97241a6e3333611c6a60e4d` | Ancestor; acceptance tracked separately | docs(integration): full battery on frozen 7cd334d — 132/132 suites, 1368 tests, 0 fail, 0 outbound |
| `origin/codex/11-c1-sql-search` | `f351f5d20d52d77b69bdcff66e2412796e53aa39` | Divergent; 7 unique commits preserved | test(search): audit plain decimal underflow and subnormal compatibility |
| `origin/main` | `b1b20e513ed25952bc086778fb71af88adcc54ba` | Ancestor; acceptance tracked separately | chore: create sanitized DINAR source export |
| `origin/qoder/04-sc02` | `f0a3c77fc1fd1a276fcb2a61214dd3b4b8e49ee3` | Ancestor; acceptance tracked separately | test(sc02): an accepted negotiation is ACCEPTED, and the order consumes it |
| `origin/qoder/05-sc06` | `56138dc97f2711862e41d635e2a009f5535da2bd` | Ancestor; acceptance tracked separately | fix(conversation): keep the mileage draft wording while new facts scope the buyer's question |
| `origin/qoder/06-general-specs` | `6335603bfb44857dd5a7261c6f32e06b5b085582` | Ancestor; acceptance tracked separately | fix(generality): keep loanword stems whole and pin the property fixtures in the suite |
| `origin/qoder/07-stock` | `a80bbe32fdf8d9703875658e81b58923e20a1a13` | Divergent; 3 unique commits preserved | fix(stock): keep the current result set in view across repeated questions |
| `origin/qoder/08-integration` | `5dda1466cc08e2d6d61d4d757bf541b853819f65` | Ancestor; acceptance tracked separately | test(integration): keep the two car fixtures distinguishable |
| `origin/qoder/09-launch-gates` | `5a005005224cf5ac05f72c8328258dd061a9846b` | Divergent; 2 unique commits preserved | ci(security): run the audit on pushes to the launch-gates branch |
| `origin/qoder/10-security-deps` | `2b0649066a8c9049f410c1224e9f6610bc99492a` | Ancestor; acceptance tracked separately | ci(security): scan the full git history for credential patterns |
| `origin/qoder/11-wave01-security-close` | `772cda7193923cebe95a696f7c7c53c7ad37865a` | Ancestor; acceptance tracked separately | chore(codegen): regenerate zod schemas with orval zod 4 |
| `origin/qoder/12-wave02-card-reliability` | `2da7f9721c8a915ab3630613f9d83a36a55ab3d6` | Ancestor; acceptance tracked separately | docs(wave02): record card reliability evidence |
| `origin/qoder/12-wave02-red-evidence` | `92aeb0c2858a2778a2cb496665c3f6b2b29ee5b5` | Divergent; 1 unique commits preserved | ci(evidence): let the failing web step not abort the red API suite |
| `origin/qoder/13-wave03-card-envelope` | `c6e45942cf122582db01eddaba7356ce1b72029e` | Ancestor; acceptance tracked separately | docs(wave03): record the card protocol evidence |
| `origin/qoder/14-w02u3-canonical-reliability` | `6687df2d033c1b71eee5b46afb3e39d193f66ec2` | Ancestor; acceptance tracked separately | docs(w02u3): final acceptance on tested head b5a3772 — CR-04/05/11/15 verified, AT manual-blocked, run ids and honest gaps |
| `origin/qoder/15-d3a-native-business` | `939930d1037387f39f1a2c64ac5b2ae61146b251` | Divergent; 13 unique commits preserved | docs(d3a): handoff, security model and acceptance matrix with the run evidence |
| `origin/qoder/17-unified-integration-candidate` | `4e60a56e3d21defea4c2d580c35fd3b198e52b5e` | Divergent; 41 unique commits preserved | docs(w12.2): تسجيل التكامل الموازي claude/13 في الجرد كمخاطر N8 |
| `origin/qoder/a01-baseline-audit` | `f107dd32984cbdcb8e7dce3602ea26d99d9af9b5` | Divergent; 5 unique commits preserved | docs(a01): state which SHA the verification runs actually covered |
| `origin/qoder/a02-d4-d5-security` | `8f9f6ad23067a7251a444dbe0e210ef4f1218b69` | Divergent; 5 unique commits preserved | test(a02): assert the session invalidation that actually blocks stale approval |
| `origin/qoder/closure-12-executing-recovery` | `2e0cca1345d2a2e0a4295c24aeac5b8b4ce59143` | Divergent; 3 unique commits preserved | test(d12): read the unknown receipt's negation without matching it as a success claim |
| `origin/qoder/d12-replit-integration` | `5d9bca1305245eb51686dda6083ae1aa2fb8e677` | Ancestor; acceptance tracked separately | test(d12): allowlist the AI authority boundary regression |
| `origin/qoder/parallel-w07-w12-ultra` | `af89cb340be4eb11a46b290e3dc5217e52af07ce` | Divergent; 20 unique commits preserved | docs(w12.1): verify qoder/14 head at 5a192d8 and correct the overlap set |
| `origin/qoder/temp-principal-sixwave-closure` | `44dfbf639fda27d4b8de7908c0aea8df25ab50ef` | Divergent; 16 unique commits preserved | docs(g7): stop the handoff from naming its own tip |
| `origin/qoder/wave01-d1-d3-closure` | `adf5a5f86ecd96fad8214eda51d20d05a0e2b2b4` | Ancestor; acceptance tracked separately | docs(wave01): record D1/D2/D3 evidence and 43-test D3-A acceptance |
| `origin/qoder/wave02-d4-d6-closure` | `845b0a48cfa7a726c97be75a00ed76fd8db5afca` | Ancestor; acceptance tracked separately | docs(w02): record merged-head D4/D5/D6 evidence and canonical sync |
| `origin/qoder/wave03-d7-d9-closure` | `c1e0a010c5eb0b1479b8ca21e4a410279b11cb3d` | Ancestor; acceptance tracked separately | docs(wave03): record the verified D7/D8/D9 acceptance evidence |
| `origin/qoder/wave04-d10-d12-closure` | `fd8215e8af4cf55e9f653c94cbc9105111e354eb` | Ancestor; acceptance tracked separately | docs(ai): wave-04 evidence at the repaired tip, including the two Chromium journeys |
| `origin/qoder/wave05-d13-d15-closure` | `0f50dc65bbf9120dc4d183825cfe7a243db4b398` | Ancestor; acceptance tracked separately | docs(d15): confirm the integrated suite at the branch tip |
| `origin/qoder/wave06-d16-d17-closure` | `891c37d6a904c4ba8809e4531040c63f030bed99` | Divergent; 23 unique commits preserved | docs(wave06): name the tested head once and keep the header unambiguous |
| `origin/qoder/wave06b-d16-d17-closure` | `d341917ec4a34ade3c1bdde8366a44dbbca9f35d` | Divergent; 14 unique commits preserved | docs(wave06): close D16/D17 with evidence report |
| `origin/replit/d16-legal-privacy-compliance` | `c196a9bf892547322644540a5d03c338020581da` | Divergent; 1 unique commits preserved | feat(d16): add country legal intake readiness |
| `origin/replit/dinar-next-complete-development` | `11d7fbe3326897924468ee4c6d5467972a92b973` | Ancestor; acceptance tracked separately | docs(ai): record AI-FOUNDATION-01 gate evidence at c36e6f1 |
| `origin/replit/dinar-next-six-wave-unification` | `ebdd2d7a68f5a52af7ad973f21ef3b0cae914b4a` | Ancestor; acceptance tracked separately | docs: record final PR evidence update |
| `origin/replit/railway-complete-infrastructure-readiness` | `21e8562a1b640ebcdd4a270146e7cf56c37f053b` | Divergent; 6 unique commits preserved | Document completed security acceptance evidence |
| `origin/replit/railway-integrations-readiness` | `75d59370884d8799df860d35895f19d987e93d17` | Divergent; 3 unique commits preserved | Complete DINAR Railway readiness evidence |
| `origin/replit/wave03-intent-integration` | `76a7e403117233122b6d5bce2009268bcc586680` | Divergent; 2 unique commits preserved | fix(ai): route basket product wording to search |

## Compatibility and semantic review

- Replit unified: authoritative 57-migration chain, business profile association 0047, delegation 0048, D16/D17 and protected order-line snapshots 0056. Current integration remains the ancestor of local development. Current suite-level behavior is tracked separately; similarity of paths does not certify equivalence.
- Replit Railway readiness: graceful shutdown and pool error handling already have current implementations. The readiness branch also decouples SMS from health readiness and lacks later migration history. Do not overwrite the unified tree or weaken the phone verification gate. Docker/Railway runbooks are preserved as source, not executed deployment instructions.
- Codex C1 alternative: SQL numeric parsing and keyset/cursor work has a divergent migration order. Current canonical C1 uses SQL candidate supersets with JavaScript eligibility and numeric semantics. Preserve the alternative and its underflow/whitespace tests; do not import its older 0041/0045 sequence. Current `search-sql-foundation` and `search-sql-performance` verify the selected implementation, not semantic identity of every alternative optimization.
- Claude commerce/reconciliation and canonical C1/D1/D2: ancestry includes the implementation commits. Financial reconciliation, cash/refund, business and integration suites must pass on this candidate. Claude/06 has two additional historical evidence documents, no unique application source to import.
- Qoder stock: current `stock-question.ts` reads persisted available minus reserved inventory, rejects unrelated named products, and falls back to a sole current result set for repeated questions. Current `t3-stock-questions`, `stock-spec-conversation`, `sc02-listing-facts` and `sc06-spec-questions` test these behaviors.
- Qoder native business alternative: a parallel old schema is not imported. Current business-profile, catalog and employee paths use the later canonical schema. Verify D3-A, D4/D5 and business-delegation suites rather than copying old branches.
- Qoder closure-12: current `ai/action-recovery.ts` settles abandoned EXECUTING actions to UNKNOWN after a lease, with compare-and-set protection and bounded batches; `index.ts` invokes recovery. It never replays an unknown transaction. `d12-execution-recovery` is the semantic regression target.
- Qoder parallel W07–W12 / unified alternatives: retain original journal/refund/legal/card contributions. Current later integration is tested with financial, cash-lock, privacy, consent and card suites; wholesale merging older trees could remove integrated safeguards.
- Qoder waves 01–06 and 06b: current unified history includes or integrates successive seller/delegation/buyer/cart/campaign/delivery/performance/legal/memory capabilities. Divergent D16/D17 report branches are preserved. Their historical test counts are not new acceptance evidence.
- Qoder temporary principal at `44dfbf639fda27d4b8de7908c0aea8df25ab50ef`: nine attributed operational corrections already incorporated before this mission. The four newest commits beyond 5446ccb are documentation changes. Latest handoff is archived separately. No additional unpublished workspace is accessible. Its original Stop-policy question is now resolved by the owner; its assertion that `isComposing` covers the entire IME risk class was disproved by the browser keyCode 229 regression.
- Gemini: adapter and isolated gateway tests exist. No separate verifiable Gemini author branch, task snapshot or implementation artifact was discovered; do not infer authorship from a filename.

## Original Conversation V2 preservation blocker

`719d4715a869f69831049a6a2f6c349cec934344` and tested source `442008a5fdcb9dc6529a55364cd66e033c6a0909` are unavailable in accessible Git objects. Exact fetches returned “not our ref”; this does not prove the previous task is lost. Expected artifact `codex-conversation-v2-authorized.bundle` is not accessible. Owner confirms the previous task workspace is unavailable here. Status: **BLOCKED** until the actual original task or artifact can be recovered. New local implementation commits retain their own identities and never impersonate those originals.

Raw inventory `source-inventory.json` records each divergent branch’s merge base, changed source, tests, reports and migration paths. `nonancestor-diffs.txt` retains source/migration difference summaries. The final bundle must preserve all available refs, not only the development tip.
