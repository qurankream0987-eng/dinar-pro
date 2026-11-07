# DINAR AI: final integration readiness

## A. Source identity

| Item | Value |
|---|---|
| Final branch | `claude/dinar-ai-final-candidate` (local, not pushed) |
| **Tested source SHA** | `6b56704ff04dc7682a57e0a6fa8fcc594600e53a` |
| Final HEAD | this documentation-only commit on top of `6b56704`; only `docs/` changes |
| Working tree during qualification | clean (the runner refuses a dirty tree) |

How the tested source was built:
- `6b56704` merges `claude/dinar-ai-premium-frontend` (`81a83cc`) into `b078317`;
- `b078317` holds visual search (`8f6c8b9`) plus the four-contributor preservation audit, on the integrated baseline `71e6234`;
- `71e6234` holds Codex audit `0990a7e` plus the Claude intelligence, Connect modes and Gemma work, with integration fixes.

Contributor ancestry and preservation are covered in `FOUR_CONTRIBUTOR_PRESERVATION_AUDIT.md`:
- 32 of the 50 advertised heads are fully contained, including Replit `ebdd2d7` and `11d7fbe`, `main`, and all contained Qoder and Claude branches;
- the 18 divergent heads were classified by `git cherry` and by functional acceptance suites;
- the 57 original Replit migrations are byte-identical; the manifest has 61 entries.

## B. Test evidence

Each run below is for the exact SHA shown. Raw results are in `evidence/final-qualification/`.

| SHA | PG | Suites | Passing suites | Passing cases | Failing cases | Skipped | Outbound |
|---|---|---|---|---|---|---|---|
| **`6b56704` (final)** | **16** | **192** | **192** | **1,925** | **0** | **1** | **0** |
| **`6b56704` (final)** | **18** | **192** | **192** | **1,925** | **0** | **1** | **0** |
| `b078317` | 16 | 192 | 191 | — | 1 (flaky) | 1 | 0 |
| `b078317` | 18 | 192 | 191 | — | 1 (test race, fixed) | 1 | 0 |
| `71e6234` | 16 | 189 | 189 (after reruns of 5 suites blocked by port 443) | 1,856 + rerun | 0 | 1 | 0 |
| `71e6234` | 18 | 189 | 189 | 1,902 | 0 | 1 | 0 |

**Also run on the final SHA:**
- `lib/db test:release-migration` on PostgreSQL 18.6: **12/12**. A fresh database receives exactly the 61 reviewed migrations; the resume, tamper and concurrency cases pass.
- Type-check: 0 errors. Builds: pass.

**Not run (NOT_RUN), with reasons:**

| Suite | Reason |
|---|---|
| `personal-intelligence` | needs its own server on port 55479 |
| `storage-portability`, `storage-s3-wire` | external storage |
| `live-model-benchmark` | needs live keys; paid calls are forbidden. Its contract part is covered by `gemma-gateway-readiness` and `ai-provider` |
| `g33-docker-acceptance` | needs Docker |

These exclusions match Codex's runner.

**History of failures (logs kept in `evidence/final-qualification/b078317-failure-logs/`):**

| Failure | Disposition |
|---|---|
| `w02u3-card-accessibility-browser-journey` on `b078317` PG16 ("fixture did not hold the turn request") | **FLAKY**: passed on PG18 for the same SHA, 3/3 reruns, and on `6b56704` PG16 and PG18 |
| `camera-search-browser-journey` on `b078317` PG18 (refusal text read before it was rendered) | **TEST RACE**: reproduced 1/3. The fix waits for the same text with the same assertion (`81a83cc`); then 5/5 passed, and it passes on `6b56704` PG16 and PG18 |
| 5 suites on `71e6234` PG16 exited 97 | **ENVIRONMENT_BLOCKED**: a port-443 collision with a parallel browser run, so they never started. Rerun one at a time: all passed |

**Coverage by area** (suites in the 192 run, all PASS on `6b56704`):

| Area | Suites |
|---|---|
| Browser journeys | `*-browser-journey`, `command-e-ui`, `g3-ui`, `premium-ux-browser-journey`, `w02u3-*` |
| Camera and visual search | `visual-search` (7), `visual-search-turn` (15), `camera-search-browser-journey` (23 checks) |
| Security | `same-origin-web`, `ai-authority-boundary`, `d4-d5-isolation-security`, `closure-privacy`, `hostile-input-performance`, `conversation-marketplace-isolation` |
| Finance | `financial-state-machine`, `wave08-cash-and-refunds`, `wave07-financial-journal`, `phase2-commission-acceptance`, `connect-commission-math` |
| Migrations | `fresh-environment` (PG18 release migrations), `readiness`, `development-tls`, plus `test:release-migration` |
| Performance | `search-sql-performance`, `connect-performance`, `wave05-d13-*`; frontend figures in `DINAR_AI_FRONTEND_PERFORMANCE.md` |

**Frontend acceptance outside the release gate** (real Chromium, the real IBM Plex Sans Arabic font, simulated camera; `evidence/premium-frontend/`):
- 58 checks;
- axe (WCAG 2.2 AA tags): 0 violations on 4 pages;
- no overflow at 320–1440 px in light and dark.

## C. Known limitations

| Limitation | Status |
|---|---|
| External model credentials and live Gemma (31B / 26B A4B) | not evaluated; **LIVE_GEMMA_EVALUATED = NO** |
| Live visual search | **LIVE_VISUAL_SEARCH_EVALUATED = NO**; image analysis is tested with a local stand-in only |
| Payment provider | SIMULATION_ONLY |
| Maps / live tracking | not live |
| Native devices (iOS Safari, Android Chrome: camera, keyboard, notch, HEIC photos) | NOT_VERIFIED_DEVICE |
| Manual accessibility review with a screen reader | not done (automated axe and keyboard only) |
| Original Conversation V2 artifact (B-V2) | BLOCKED; never recreated |
| Admin APPROVED → SUSPENDED transition for Connect partners | owner decision pending |
| Staging infrastructure | not available to this work |
| Production | not authorized |

## D. Readiness verdicts

| Verdict | Value | Evidence |
|---|---|---|
| FOUR_CONTRIBUTOR_INTEGRATION_COMPLETE | **YES**, with blockers B-V2 and B-C1 recorded | preservation audit plus 192/192 on both PG versions |
| CORE_PLATFORM_ENGINEERING_READY | **YES** (local) | 192/192 PG16 and PG18, release migration 12/12 |
| CAMERA_WEB_ACCEPTANCE_READY | **YES in Chromium (simulated camera)**; real devices not verified | camera journey, frontend QA |
| VISUAL_SEARCH_CONTRACTS_READY | **YES** | `visual-search`, `visual-search-turn` |
| LIVE_VISUAL_SEARCH_EVALUATED | **NO** | no authorized live model |
| MODEL_INTEGRATION_READY | **YES (contracts)**: OpenRouter routing pinned, ZDR, data_collection deny, model-identity check | `gemma-gateway-readiness`, `ai-provider` |
| LIVE_GEMMA_EVALUATED | **NO** | paid calls not authorized |
| STAGING_READY | **NO** | no staging environment or secrets; deployment not authorized |
| PRODUCTION_READY | **NO** | requires staging, live model, payment provider and device acceptance |

Publication (push), merge into `main` and deployment all need the owner's separate, explicit approval.
