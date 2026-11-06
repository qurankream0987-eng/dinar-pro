# Generative UI: Codex integration handoff

**Branches:**
- Claude: `claude/dinar-next-intelligence`. Start `eef3625`; final SHA in the commit that adds this file.
- Codex: `ab196c5`, untouched.
- Not merged.

## Files touched by this mission

**Contracts:**
- `lib/api-zod/src/surface-composition.ts`: added `PresentationProposalSchema`, `ResultCompositionSchema`, `resolvePresentationProposal`. Purely additive.
- `lib/api-spec/openapi.yaml`: `AiUiBlock.payload.composition`, plus `POLICIES` in the surface enum. Regenerate `lib/api-zod` and `lib/api-client-react` once on the joint tree; never copy a generated tree.

**Server:**
- `artifacts/api-server/src/ai/model-turn.ts`: optional `presentation` (opaque) + tool JSON schema + one prompt line.
- `artifacts/api-server/src/ai/smart-turn.ts`: resolution in the verified-SEARCH branch.
- `artifacts/api-server/src/ai/tool-registry.ts`: `ToolResult.composition` (type).
- `artifacts/api-server/src/routes/ai.ts`: stored / restored `composition`.
- `artifacts/api-server/src/ai/model-read-capabilities.ts`: canonical agreement DTO mapping (Codex R03 closed on Claude source).

**Web:**
- `artifacts/dinar/src/features/ai/ai-api.ts`
- `artifacts/dinar/src/features/ai/ConversationContent.tsx` (`ResultLayout`)

**Tests:**
- `generative-ui`
- `generative-ui-browser-journey` + `dinar/test/generative-ui-browser.mjs`
- `connect-partners` (positive agreement read)
- `ai-provider` (mirror checker handles the opaque field)
- `ai-authority-boundary` (current tool lists, read-only loop)

## Conflicts to expect

Run `git merge-tree` on the joint candidate.

Earlier conflicts:
- `intent.ts`
- `app.ts`
- seven test files

Likely new ones:
- `routes/ai.ts` (listing block schema)
- `ConversationContent.tsx` (result carousel area)
- `openapi.yaml` (surface enum, block payload)

**Resolution:** keep both. Codex's platform changes win on platform semantics; Claude's `composition` field, the `ResultLayout` wrapper and the `POLICIES` enum entry are additive.

## Acceptance on the joint SHA

1. `generative-ui`, `generative-ui-browser-journey`, `multiturn-context`, `connect-partners`, `ai-provider`, `ai-authority-boundary`, `command-d-acceptance`.
2. The full battery with per-suite flags: `w06-d16-adversarial` needs only its own flags (`BDINAR_W06_D16_AUDIT`) and fails if `BDINAR_WAVE4_ACCEPTANCE` is set globally.
3. Dedicated runners:
   - `personal-intelligence` (server on 55479; not re-run in this session);
   - `market-legal`;
   - `storage-portability`;
   - G33 Docker (Actions only).

## Owner approvals still required

- A live provider or GPU budget to measure real presentation judgement. Scripted evidence proves the contract only.
- Joint integration and any merge.
- Deployment.
