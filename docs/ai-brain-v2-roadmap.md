# Jassim AI Brain v2 — 7 Core Intelligence Upgrades (Owner-Authorized)

Base commit: `c9477f5` (`claude/jassim-connect-universal-engine`).
All modules are strictly typed, feature-flagged (OFF by default until Claude enables in `qa-lab`), zero new dependencies, zero DB/payment/production touches, and verified with `7/7` passing unit tests + `api-server typecheck` + `api-server build`.

| # | Branch | Module | Feature Flag / Activation |
|---|---|---|---|
| **AI-01** | `google/ai-01-token-streaming` | `dual-channel-stream.ts` | `DINAR_AI_TOKEN_STREAMING=1` |
| **AI-02** | `google/ai-02-model-first-routing` | `model-first-router.ts` | `DINAR_AI_ROUTING_MODE=MODEL_FIRST` |
| **AI-03** | `google/ai-03-context-compression` | `context-compressor.ts` | L1 Hot / L2 Rolling Digest / L3 Recall |
| **AI-04** | `google/ai-04-readonly-react-loop` | `read-only-agent-loop.ts` + `task-plan.ts` | `DINAR_AI_READONLY_LOOP=1` |
| **AI-05** | `google/ai-05-hybrid-search` | `hybrid-search.ts` | Wire `VectorIndexAdapter` after `pgvector` migration |
| **AI-06** | `google/ai-06-infinite-card-adapter` | `infinite-card-adapter.ts` | Bridges external LLMs to `JassimCardSpec v1` with server-only prices |
| **AI-07** | `google/ai-07-prompt-cache-evals` | `prompt-cache-layout.ts` + `ai-brain-v2.test.ts` | Static prefix SHA-256 + `cache_control: ephemeral` |

All 7 engines + the unified test suite are also bundled together on `google/ai-brain-v2-complete` for one-step review and testing.