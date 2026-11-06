# Claude intelligence ↔ Codex — integration handoff

- **Claude:** `claude/dinar-next-intelligence`, 16 commits on Codex base `34bb754`, Draft PR #6.
- **Codex:** `codex/dinar-next-unified-development` @ `4143314`, not modified by Claude.
- **Status:** `git merge-tree` on the two heads reports no textual conflict. No merge is performed (owner authorization required).

## Conflict map

| File | Claude | Codex | Resolution |
|---|---|---|---|
| `lib/api-spec/openapi.yaml` | `CAPABILITIES` surface token | Connect diagnostics paths and schema | Keep both in the authored spec; run codegen once |
| `lib/api-zod/src/generated/*`, `lib/api-client-react/src/generated/*` | generated | generated | Regenerate, never copy |
| `artifacts/dinar/test/connect-finance-ui.mjs` | canonical `datetime-local` value | diagnostics assertions | Different lines |

## Semantic watch list (files only Claude changed, which Codex must not fork)

- **Model tools:** `ai/tool-registry.ts`, `ai/capability-registry.ts`, `ai/model-capability-tools.ts`, `ai/model-read-capabilities.ts`, `ai/dinar-capabilities.ts`. This is the single model-tool registry, 23 capabilities, guarded by `capability-init-order`.
- **Runtime:** `ai/conversation-runtime.ts` (seller-gate context rule), `ai/commerce-turn.ts` (`aiUsageCardTurn`, sufficiency note), `ai/usage-turn.ts` (`usageProjection`), `ai/business-turn.ts`, `ai/intent.ts`, `ai/seller-management.ts`, `ai/smart-turn.ts`.
- **Services and routes:** `lib/seller-dues.ts` plus `routes/marketplace.ts` (`/seller-dues` now calls the shared service).
- **Gateway:** `ai/model-gateway.ts` (`thinking`), `app.ts` (deployment-aware frame-ancestors).
- **Web:** `pages/Ai.tsx` and `features/ai/turn-recovery.ts` (bounded verification block).
- **Tests:** `test/isolation/local-suite.sh` (images.unsplash.com stub).
- **Migrations:** none added by Claude.

## Required on the joint SHA

See `CLAUDE_FINAL_INTEGRATION_PLAN.md` §4. In addition:
- `usage-intelligence`, `intelligence-capabilities`, `intelligence-routing-eval` in all three modes;
- `capability-init-order`, `self-hosted-model`.
