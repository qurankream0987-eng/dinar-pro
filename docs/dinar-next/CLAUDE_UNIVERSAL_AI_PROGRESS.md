# Phase 2: Universal Intelligence (progress)

**Branch:** `claude/dinar-next-intelligence`.
- Start: `d0c2f03`.
- Code milestone: `7f84cfb`.
- Docs and self-hosted contracts: the commit that adds this file.

**What is not true yet:**
- No live model has run.
- Every model behaviour here is **scripted**: the gateway returns scripted tool calls, and DINAR's real orchestration executes them.
- No GPU was provisioned and nothing was spent.

## What changed (same runtime, same gateway, same registry)

| Area | Change | File |
|---|---|---|
| Capability discovery | `describeDinarCapabilities` lists only the capabilities the actor's **server-derived roles** may call. A buyer is no longer told about seller dues | `dinar-capabilities.ts`, `tool-registry.ts` |
| New reads (real services only) | `readConnectPartnerStatus` (the actor's own Connect partnerships and agreements; 403/404 → `NOT_PERMITTED`) | `model-read-capabilities.ts` |
| | `readPolicy` (published policies; unknown key → 404) | `model-read-capabilities.ts` |
| Registry | 23 → **25** entries, each mirroring one tool. Every count assertion was updated | `capability-registry.ts` |
| Multi-step | A plan step that the deterministic path misses (zero-result search, unknown phrasing) consults the model **once**, then falls back to the deterministic answer | `conversation-runtime.ts` |
| Connect parsing | «قهوة.» is no longer read as a domain. Long messages and plan steps without a real domain token defer to the planner | `connect/conversation.ts` |
| Arabic search | Price nouns are stripped only at the start («قطعة سعر ABC» keeps «سعر») | `intent.ts` |

**Not added, by design:** dispute creation, refunds, fund transfers, subscription activation, financial writes, and admin APIs. The model still only reads, or prepares an action that the user confirms and the server re-verifies.

## Evidence

- **Deterministic and scripted:** the 32 suites listed in `CLAUDE_MULTISTEP_INTELLIGENCE_ACCEPTANCE.md` are all green, with outbound=0.
- **Local open-weight:** none (no GPU).
- **Live hosted:** none (no approval).
- **Browser:** not re-run this phase. The earlier phase's journeys stand.
