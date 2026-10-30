# DINAR — Launch readiness: the destination and its gates

"Ready to launch" means **every gate below is green with evidence**, for a launch scope the
owner has written down. It never means "no bugs"; it means known risks, a recovery plan, and no
open P0/P1 inside the declared scope. An agent may *prepare* every gate; only the owner decides
the scope, approves policies and money, and authorises Staging and production.

Status on 2026-10-27 (head `9679e48`): ✅ done with evidence · 🟡 partial · ⛔ blocked · ⬜ not started · 👤 owner decision.

## G1 — Reference code and reproducible tests
| Item | Status |
|---|---|
| One reference branch on GitHub (`claude/02-sc-acceptance`) | ✅ |
| Isolated DB + browser harness (`local-suite.sh`, fonts stub) | ✅ |
| Full battery green except environment-bound suites | ✅ 84/86 (phase1 ⛔ external images; pre-switch ✅ on its seed) |
| PostgreSQL 18 release-migration test | ⛔ needs PG18 in the environment (owner: network allowlist or image) |
| Sample data without external images (unblocks phase1) | ⬜ |

## G2 — Commerce journeys (REAL_E2E, browser + API + DB)
| SC | Status |
|---|---|
| SC01 sell a used phone → buy → complete | ✅ |
| SC03 multi-round negotiation | ✅ (non-price terms 👤 P-SC03) |
| SC07 seller stock + last unit race | ✅ |
| SC10 fake payment, tampering, dispute, admin decision | ✅ |
| SC02 search, narrow, compare, refer | 🟡 API; browser ⬜ (command Q02) |
| SC06 industrial machine + spec questions | 🟡 API; browser ⬜ (Q03); inspection 👤 P-SC06 |
| SC05 cleaning service | 🟡 search; quotes/appointments ⬜ 👤 P-SC05 |
| SC04 food with options | ⬜ 👤 P-SC04 |
| SC08 logo design + deliverables | 🟡 search; deliverables ⬜ 👤 P-SC08 |
| SC09 other market / currency | 🟡 honest refusal ⬜ (Q04); FX 👤 P-SC09 |

## G3 — Conversation quality
| Item | Status |
|---|---|
| Deterministic handling of commerce steps (no model fallback in journeys) | ✅ for SC01/03/07/10 |
| Generality on phrases outside the scenarios | 🟡 95% on a Claude-written set; **independent owner/user phrases** ⬜ |
| Topic change and return, corrections, context after reload | 🟡 partial coverage (G2 suites); dedicated journey ⬜ (Q06) |
| SSE cancel/recovery, provider failure, prompt injection | 🟡 existing suites; live model quality needs paid calls 👤 |

## G4 — Cards and UI
| Item | Status |
|---|---|
| 320/390/desktop, RTL, no overflow, touch targets on journey cards | ✅ on journey surfaces |
| Expired/denied/superseded cards keep no live actions — every surface | 🟡 (Q05) |
| Proportional card size; financial terms never folded away | 🟡 (Q05) |
| Loading/failure/expired states on every action card | 🟡 (Q05) |

## G5 — Conversation services
| Item | Status |
|---|---|
| «أريد أن أشترك في برو» honest, no fake subscription | ✅ (prices 👤) |
| Change country in chat end to end | 🟡 contract exists; journey ⬜ (Q06) |
| Internal search first; external search only explicit/empty, labelled | ⬜ provider 👤; honest "not configured" ⬜ (Q06) |
| «ابحث لي عن سائق» bound to the order, no fake driver | 🟡 driver flows exist; honest journey ⬜ (Q06) |

## G6 — Integrations (each: configured / available / unavailable, honest failure)
| Item | Status |
|---|---|
| AI provider (DeepSeek) | 🟡 adapter + offline tests; live 👤 (paid) |
| Payments (real provider) | ⬜ 👤 provider choice; simulation ✅ |
| Object storage (S3-compatible) | ✅ wire test; Staging bucket 👤 |
| SMS / phone verification | 🟡 development bypass; provider 👤 |
| Notifications, maps, delivery providers | ⬜ 👤 scope |

## G7 — Security, privacy, performance, operations
| Item | Status |
|---|---|
| Authority boundary, ownership, body bounds, same-origin | ✅ |
| Zod advisory GHSA-mrhx-c7xc-m3w5 | 🟡 mitigated; upgrade plan ⬜ (Q07) |
| Dependency audit, secret scan in CI | 🟡 manual; CI ⬜ (Q07) |
| Privacy: personal data inventory, retention, deletion path | 🟡 (Q07 inventory) 👤 policy |
| Load/performance baseline (p95 turn latency, checkout under concurrency) | ⬜ (Q07) |
| Backup and **tested** restore of a disposable database | ⬜ (Q08) |
| Monitoring, alerting, logs without personal data | ⬜ (Q08) |
| Railway **Staging** (separate DB, secrets, rollback plan) | ⬜ prepared by agent (Q08); executed only with owner approval 👤 |

## G8 — Owner decisions required before launch
Launch market(s) and scope · return/refund policy text · subscription prices/quotas/renewal ·
payment provider · SMS provider · food/services/deliverables/FX in or out of scope · P-SC03,
P-01 · legal review per market (`DINAR_COUNTRY_LEGAL_REVIEW_CHECKLIST.md`).

## How an agent declares a gate green
A gate turns ✅ only with: the suite(s) that prove it, three consecutive green runs for browser
journeys, the full battery on that head, and the evidence block from `TESTING_GUIDE.md` §6. The
reviewer re-runs it from a clean checkout before accepting.
