# Four-contributor preservation audit (Replit · Qoder · Codex · Claude)

**Integration branch:** `claude/dinar-next-final-integration`. Built from Codex audit `0990a7e` (tested source `5121c91`). Qualified source: the merge of `claude/int-visual-search` into baseline `71e6234`. Test totals for that exact SHA are in `DINAR_FINAL_INTEGRATION_READINESS.md`. Its commits:

| Commit | What it adds |
|---|---|
| `c967387` | `claude/connect-01-modes` `7d42dd0` (no conflicts) |
| `6d91765` | `claude/dinar-next-intelligence` `974fb1e` (10 conflicts resolved semantically) |
| `a76c3d2` | merge `claude/int-gemma-readiness` `f7a24e0` (Gemma routing contracts) |
| `b6f0ad1`, `3e25d62`, `71e6234` | regression fixes found by qualification: restored `frame-ancestors`; explicit searches never consult the model; restore harness; screenshots outside the repo |
| merge of `claude/int-visual-search` | camera and photo search (`a211b28`…`8f6c8b9`) |

All are local and unpublished. No contributor branch was changed or rewritten.

**Method:** independent of Codex's classifications.
1. Branch containment: `git merge-base --is-ancestor <head> <integration>`.
2. Patch equivalence: `git cherry`.
3. File existence and byte identity against the integrated tree.
4. Behaviour proof: the qualification of the integrated source (see the qualification evidence).

Codex's per-contribution classifications (`branch-reconciliation.json`) are used as the starting hypothesis and checked, not copied.

**Status legend:**

| Status | Meaning |
|---|---|
| PRESERVED | branch head contained in the integration (every commit reachable) |
| INTEGRATED | a non-ancestor contribution whose behaviour exists in the integration, by equivalent patch or verified current equivalent |
| SUPERSEDED | replaced by a stronger canonical implementation, with tests |
| MISSING | not present and still needed |
| BLOCKED | cannot be verified without an unavailable artifact |

## 1. Branch containment (50 advertised heads)

**32 PRESERVED (fully contained):**

| Contributor | Branches |
|---|---|
| Replit | **`replit/dinar-next-six-wave-unification` `ebdd2d7`**, `replit/dinar-next-complete-development` `11d7fbe` |
| Qoder | `qoder/04-sc02`, `05-sc06`, `06-general-specs`, `08-integration`, `10-security-deps`, `11-wave01-security-close`, `12-wave02-card-reliability`, `13-wave03-card-envelope`, `14-w02u3-canonical-reliability`, `d12-replit-integration`, `wave01-d1-d3-closure`, `wave02-d4-d6-closure`, `wave03-d7-d9-closure`, `wave04-d10-d12-closure`, `wave05-d13-d15-closure` |
| Codex | `codex/dinar-next-unified-development` `ab196c5` (audit `0990a7e` is the base) |
| Claude | `claude/02`…`13` (11 branches), `claude/dinar-next-intelligence` `974fb1e`, `claude/connect-01-modes` `7d42dd0`, `ai-foundation-02` |
| Main | `main` `b1b20e5` |

This is two more than Codex's 30: both active Claude branches are now integrated.

**18 divergent heads:** resolved per contribution below.

## 2. Divergent branches: patch equivalence and status

| Branch (head) | Equivalent commits | Non-equivalent | Status | Evidence |
|---|---|---|---|---|
| `qoder/07-stock` `a80bbe3` | 3 | 0 | **INTEGRATED** | all patches present under other identities; `stock-spec-conversation` |
| `qoder/closure-12-executing-recovery` `2e0cca1` | 3 | 0 | **INTEGRATED** | all patches present; `d12-execution-recovery` |
| `qoder/15-d3a-native-business` `939930d` | 10 | 3 | INTEGRATED + SUPERSEDED | INTERNAL_DINAR catalog / storefront in `business-turn.ts` and `lib/business-catalog.ts` (`d3a-native-business` 48, `d3a-browser-journey`). Placeholder D2 identity superseded by canonical D2 / D4. Old migration 0042 numbering not imported (canonical 0047) |
| `qoder/17-unified-integration-candidate` `4e60a56` | 16 | 25 | INTEGRATED + SUPERSEDED | W07 journal (`order-journal.ts`), W08 cash (`payments/cash.ts`, `routes/cash.ts`), W09 policy / consent (`policy-lifecycle.ts`, `policy-gate.ts`, `compliance.ts`), W10 trust / support (`moderation.ts`, `fraud-signals.ts`, `support-cases.ts`, `response-targets.ts`, `whatsapp-readiness.ts`) all exist. Renumbered duplicate migrations correctly not imported |
| `qoder/parallel-w07-w12-ultra` `af89cb3` | 13 | 7 | INTEGRATED + SUPERSEDED | same W07–W10 services; the four SQL modules exist at canonical names; W11 / W12 CI superseded by pinned workflows |
| `qoder/wave06-d16-d17-closure` `891c37d` | 5 | 16 | INTEGRATED + SUPERSEDED | country legal readiness (`country-legal-readiness.ts`, `routes/compliance.ts`); conversation memory **byte-identical** (`ai/conversation-memory.ts`); D16 race / integrity fixes superseded by `d16-readiness.ts` + 0055 |
| `qoder/wave06b-d16-d17-closure` `d341917` | 3 | 10 | INTEGRATED + SUPERSEDED | as above; memory file byte-identical |
| `qoder/temp-principal-sixwave-closure` `44dfbf6` | 9 | 7 | INTEGRATED (+ docs) | nine operational fixes present; four handoff commits are documentation |
| `qoder/a01-baseline-audit` `f107dd3` | 0 | 5 | INTEGRATED | seller-fact omission in `smart-turn`; `d4-d5-isolation-security` |
| `qoder/a02-d4-d5-security` `8f9f6ad` | 0 | 5 | INTEGRATED | `lib/business-delegations.ts`; `d4-d5-isolation-security` + `business-delegations` |
| `qoder/09-launch-gates` `5a00500` | 0 | 2 | SUPERSEDED | `.github/workflows/qoder-security.yml` |
| `qoder/12-wave02-red-evidence` `92aeb0c` | 0 | 1 | SUPERSEDED | `qoder-api-suite.yml` + `local-suite.sh` |
| `replit/wave03-intent-integration` `76a7e40` | 0 | 1 | INTEGRATED | basket comparison / purchase reference restored by Codex `c2a8717` in `intent.ts`. **Kept through the Claude merge:** conflict resolved by feeding `stripCorrectionPrefix` into Codex's `marketplaceComparisonSearchTerms` request |
| `replit/d16-legal-privacy-compliance` `c196a9b` | 0 | 1 | INTEGRATED + SUPERSEDED | legal / privacy services present; historical SQL numbering not imported |
| `replit/railway-complete-infrastructure-readiness` `21e8562` | 0 | 6 | SUPERSEDED (+ docs) | `server-lifecycle.ts` graceful drain, pool error handling, readiness |
| `replit/railway-integrations-readiness` `75d5937` | 0 | 3 | SUPERSEDED | same lifecycle / readiness authority |
| `codex/11-c1-sql-search` `f351f5d` | 0 | 7 | SUPERSEDED / BLOCKED (part) | canonical keyset search (`marketplace-search-index.ts`); alternate SQL / cursor engine not imported (no duplicate engine); historical fixed-cursor memory profile = **BLOCKED (B-C1)**, not provable without an owner-defined SLO |
| `claude/06-w02-ultra` `8f4662b` | 0 | 2 | documentation only | reports remain reachable on the branch |

## 3. Independent byte-level checks on the integrated tree

| Check | Result |
|---|---|
| 57 original Replit SQL migrations byte-identical to `ebdd2d7` | **0 differences** |
| Migration chain | 61 entries = 60 canonical (`0000`–`0059`) + Claude `0060_connect_participation_mode` |
| Release migration on PostgreSQL 18.6 (`lib/db test:release-migration`) | **12 / 12**, "a fresh database receives exactly the 61 reviewed migrations"; resume / ledger-prefix / tamper / concurrency cases pass |
| 28 key service files named by contributions (journal, cash, obligations, policy, compliance, moderation, fraud, support, WhatsApp readiness, legal readiness, D16, privacy, memory, business catalog / contract / delegation, server lifecycle, search index, business / inquiry / negotiation turns, capability tools) | **all present** |

## 4. Claude merge regression review (did Claude's work undo Replit or Codex work?)

The Claude merge changed 28 source files.
- **5 are new:** `model-read-capabilities`, `dinar-capabilities`, `seller-dues`, `connect/conversation` additions, `turn-recovery`.
- **23 existed in Replit's line:** almost all purely additive (registry entries, tools, runtime resolvers, composition contract).

Changes that **removed or replaced** behaviour, each reviewed:

| File | Change | Verdict |
|---|---|---|
| `routes/marketplace.ts` (−34) | `/seller-dues` body moved to `lib/seller-dues.ts` for reuse by the model read | **Equivalent**: identical snapshot-rate, fallback, reversal and formatting logic; same unscoped call |
| `app.ts` (−3) | Claude's `frameAncestors()` removed | Codex's stricter policy kept (a superset of Claude `53ca8ef`); both sides' tests kept |
| `ai/intent.ts` (−10) | search-term pipeline | Codex comparison extraction kept; Claude correction stripping added in front |
| `ai/conversation-runtime.ts` (−27) | routing / context resolvers | additive resolvers; covered by `multiturn-context`, `conversation-router`, `model-native-routing`, `g2-smart-conversation` |

**Test resolution (10 conflicts):** no assertion intent was deleted.
- In 7 files Codex's stricter assertion was kept.
- `same-origin-web` keeps both suites.
- `deepseek` keeps Codex's exact contract (updated to the integrated 22-tool set) plus Claude's invariants.

## 5. MISSING / BLOCKED register

| ID | Item | Status | Requirement |
|---|---|---|---|
| B-V2 | Original Conversation V2 history (`442008a` / `719d471`) | BLOCKED | the genuine `codex-conversation-v2-authorized.bundle` or original task; never recreated |
| B-C1 | Historical fixed-cursor constant-space / snapshot equivalence | BLOCKED | owner-defined performance / snapshot requirement, then measure |
| — | Gemini adapter original artifact provenance | BLOCKED | separate original artifact |
| — | Admin APPROVED→SUSPENDED partner transition | MISSING (product decision) | owner decides whether admins may suspend an approved Connect partner |

**No functional contribution from Replit or Qoder was found MISSING.** Every divergent contribution is either present (by equivalent patch, byte identity or a verified current equivalent) or deliberately superseded by a stronger canonical implementation. Duplicate migrations and a duplicate search engine were deliberately not imported.

## 6. Functional proof: contribution → acceptance suites

A file existing is not proof. Each row names the suites that exercise the behaviour through the integrated runtime. Every suite runs in the full PG16 and PG18 qualification of the qualified SHA; results are in the readiness report.

| Contributor / branch | Capability | Integrated implementation | Acceptance suites |
|---|---|---|---|
| Replit `ebdd2d7` (six-wave) | 57 original migrations, byte-identical; release ledger | `lib/db/drizzle`, `release-manifest.json` | `fresh-environment` (PG18 release migrations), `readiness`, `development-tls`, `lib/db test:release-migration` |
| Replit `c196a9b` / Qoder W06 | country legal readiness, privacy | `country-legal-readiness.ts`, `routes/compliance.ts` | `market-legal-acceptance`, `d16-readiness`, `w06-d16-adversarial`, `wave06-d16-compliance-acceptance` |
| Replit `21e8562`, `75d5937` | graceful drain, pool errors, readiness | `server-lifecycle.ts` | `wave05-d13-shutdown`, `readiness` |
| Replit `76a7e40` + Codex `c2a8717` | basket comparison / purchase reference | `ai/intent.ts` | `arabic-understanding`, `api`, `block-e-acceptance`, `intelligence-routing-eval` |
| Qoder W07 | financial journal | `order-journal.ts` | `wave07-financial-journal` |
| Qoder W08 | cash and refunds | `payments/cash.ts`, `routes/cash.ts`, `payments/obligations.ts` | `wave08-cash-and-refunds`, `financial-state-machine`, `wave07-w12-contract-hardening` |
| Qoder W09 | policy lifecycle, consent gate | `policy-lifecycle.ts`, `policy-gate.ts`, `compliance.ts` | `wave09-policy-consent-compliance`, `integration-policy-consent` |
| Qoder W10 | moderation, fraud signals, support cases, response targets, WhatsApp readiness | `moderation.ts`, `fraud-signals.ts`, `support-cases.ts`, `response-targets.ts`, `whatsapp-readiness.ts` | `wave10-trust-support-whatsapp`, `block-c/d/e-acceptance`, `closure-notifications` |
| Qoder W06 | conversation memory (byte-identical) | `ai/conversation-memory.ts` | `wave06-conversation-memory`, `-adversarial`, `-performance`, `w06-d17-retrieval-quality` |
| Qoder `939930d` | INTERNAL_DINAR catalogue / storefront | `business-turn.ts`, `lib/business-catalog.ts` | `d3a-native-business`, `d3a-browser-journey`, `connect-card-contract` |
| Qoder `8f9f6ad`, `f107dd3` | D4/D5 delegation, isolation, seller-fact omission | `lib/business-delegations.ts`, `smart-turn` | `business-delegations`, `d4-d5-isolation-security`, `d5-seller-employee-acceptance`, `wave02-d4-d5-seller-journey` |
| Qoder `a80bbe3`, `2e0cca1` | stock questions; D12 execution recovery | patch-equivalent | `t3-stock-questions`, `d12-execution-recovery`, `stock-spec-conversation` |
| Qoder dialect / card reliability waves | card envelope, reliability | Card Envelope, `ComposedSurface` | `wave03-card-envelope-browser-journey`, `w02u3-*`, `g2-smart-conversation` |
| Codex `ab196c5` / `5121c91` | canonical search index, keyset search | `marketplace-search-index.ts` | `search-sql-foundation`, `search-sql-performance`, `wave05-d13-db-profile`, `wave05-d13-load-baseline` |
| Codex | strict CSP `frame-ancestors` | `app.ts` | `same-origin-web`, `wave03-d7-cart-browser-journey` |
| Codex | 22-tool buyer contract, provider compatibility | `tool-registry.ts` | `deepseek-chat-compatibility`, `ai-provider`, `model-native-routing` |
| Claude `974fb1e` | 25 capabilities, seller dues read, turn recovery | `dinar-capabilities`, `lib/seller-dues.ts`, `turn-recovery` | `intelligence-capabilities`, `commerce-journey`, `phase2-commission-acceptance`, `conversation-router`, `multiturn-context` |
| Claude `7d42dd0` | Connect participation modes, migration 0060 | `connect/partners.ts`, `0060_connect_participation_mode` | `connect-modes-*`, `connect-partners`, `connect-cards-browser-journey`, `fresh-environment` |
| Claude `f7a24e0` | Gemma routing contracts (no paid calls) | `model-gateway.ts` | `gemma-gateway-readiness`, `self-hosted-model`, `ai-provider`, `live-model-benchmark` (contract part only; excluded from the run because it needs live keys) |
| Claude visual search | camera, private photo search | `lib/visual-search-images.ts`, `ai/visual-search.ts`, `CameraCapture.tsx` | `visual-search`, `visual-search-turn`, `camera-search-browser-journey` |

### Decisions on the 18 divergent heads (re-checked against the merged SHA)

The `git cherry` counts are unchanged after the visual-search merge; see section 2. Nothing in section 2 was imported blindly. What was deliberately not imported:
- duplicate migrations (renumbered 0042 and similar);
- the alternate SQL search engine `codex/11-c1-sql-search`;
- historical CI workflows already superseded by the pinned workflows.
