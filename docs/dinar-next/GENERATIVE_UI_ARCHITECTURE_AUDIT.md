# Generative UI: architecture audit (Gate 0)

**Branch:** `claude/dinar-next-intelligence`.
- Start: `eef3625`.
- Remote heads at start:

  | Branch | Head | Note |
  |---|---|---|
  | Claude | `eef3625` | — |
  | Codex | `ab196c5` | Codex's documentation reconciliation |

- Codex's branch was not modified.

## What already existed (reused, not rebuilt)

| Concern | Existing source | Notes |
|---|---|---|
| One conversation runtime | `api-server/src/ai/conversation-runtime.ts`, `smart-turn.ts`, `routes/ai.ts` (`POST /ai/conversations/:id/turns`, SSE) | No second runtime added |
| Model output contract | `ai/model-turn.ts` `ModelTurnOutput` (strict) + `dinarConversationTurn` tool schema | Extended with one optional field |
| Model gateway | `ai/model-gateway.ts` (provider-agnostic, `OPENAI_COMPATIBLE` slot, LIGHT/HEAVY) | Unchanged |
| Tools / capabilities | `ai/tool-registry.ts`, `ai/capability-registry.ts` (25) | Unchanged |
| Composition primitives | `lib/api-zod/src/surface-composition.ts` `ComposedSurfaceSchema`: header, text, facts, metrics, meter, money, timeline, bars, options, notice, actions | 16 KB cap, one primary action, no SEND action in a terminal state |
| Card authority | same file `CardEnvelopeSchema` + `applyCardEnvelope` | Server-decided `allowedActions`, lifecycle, expiry, pending review |
| Actions | `SurfaceActionSchema`: SEND (utterance re-entered through the runtime), NAVIGATE (in-app path regex), EXTERNAL_LINK (`resultSetId` + `cardId` + `providerId` only) | No URL, script or endpoint can be expressed |
| Persistence | `aiResultSets` (owned result sets with expiry), `aiUiBlocks` (`LISTING_RESULTS` / `SURFACE`) | Restored and re-validated on `GET /ai/conversations/:id` |
| Renderer | `dinar/src/features/ai/ConversationContent.tsx` (listing blocks, `ResultCarousel`), `surface/ComposedSurface.tsx`, `surface/primitives.tsx`, `surface/*-adapters.ts`, `UniversalCards.tsx`, `ExternalLinkAction.tsx` | Typed families kept |
| Comparison | `compareListings` tool + COMPARISON surface (buyer-turn) | Reused for model-proposed comparisons |
| External buy | `POST /connect/outbound` → `GET /connect/outbound/:id` (`routes/connect.ts`) | See `GENERATIVE_UI_CONNECT_EXTERNAL_BUY.md` |
| Pending actions | `action-foundation.ts` lifecycle, `confirmPendingAction`, purchase review | Unchanged |
| Cart animation | existing web cart flight (W02 / F3) | Unchanged in this slice |

## The gap

Every card was chosen deterministically from a typed payload. The model could not influence how verified results were presented:
- which results to show;
- their order;
- a grid, list or comparison;
- a highlighted best fit.

## What this mission added

One optional, server-validated **presentation proposal**. It flows through the existing pipeline:

```
user → runtime → model loop → searchListings (verified) → model proposes presentation
     → resolvePresentationProposal (server, same-turn result set) → typed LISTING_RESULTS block
       with `composition` or the canonical compareListings COMPARISON surface
     → persisted (aiResultSets order + block composition) → React ResultLayout → reload restores
```

Files changed:
- `lib/api-zod/src/surface-composition.ts`
- `api-server/src/ai/model-turn.ts`
- `api-server/src/ai/smart-turn.ts`
- `api-server/src/ai/tool-registry.ts` (type only)
- `api-server/src/routes/ai.ts`
- `lib/api-spec/openapi.yaml` (+ regenerated clients)
- `dinar/src/features/ai/ai-api.ts`
- `dinar/src/features/ai/ConversationContent.tsx`
