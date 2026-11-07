# Claude AI integration requirements (for the joint candidate)

## Claude branches

| Branch | Content | Head |
|---|---|---|
| `claude/dinar-next-intelligence` | intelligence + generative UI + Command 02 | see `git log` |
| `claude/connect-01-modes` | Connect participation modes on Codex `ab196c5` | `7d42dd0` |

## Must be preserved at integration

- The 25-entry capability registry and every count assertion:
  - `ai-foundation-acceptance`, `ai-foundation-02-acceptance`;
  - `wave04-d10-d11`, `wave04-d10-d12`;
  - `capability-init-order`;
  - `model-native-routing`;
  - `ai-authority-boundary`.
- `ModelTurnOutput.presentation` (opaque) + `PresentationProposalSchema` and the `ai-provider` mirror checker for it.
- `executeWithRoutingMode`:
  - the plan-step soft-miss;
  - the new long-query zero-result model consult;
  - their order before the `plain` return.
- `resolveConversationReference` before the buyer turn and before the correction clarify.
- `commerce-turn` `PLAN_VIEWS` / `KEEP_PLAN` claim and the relative-tier resolution.

## Known conflicts

- **With Codex `ab196c5`:** `git merge-tree` showed 9 textual conflicts earlier (2 source: `intent.ts`, `app.ts`; 7 tests). New likely ones:
  - `routes/ai.ts`;
  - `ConversationContent.tsx`;
  - `openapi.yaml`;
  - `commerce-turn.ts`;
  - `conversation-runtime.ts`.
- **Between the two Claude branches:**
  - The intelligence branch's `readConnectPartnerStatus` should add `participationMode` / `participation` from Command 01 once both are joined.
  - The migrations differ: 0060 exists only on the Connect branch.

## Dependency contract if Codex builds on this before merging

Consume, do not reimplement:
- `PresentationProposalSchema`;
- `resolvePresentationProposal`;
- `ResultCompositionSchema`;
- the capability catalog (`describeDinarCapabilities`, role-filtered).
