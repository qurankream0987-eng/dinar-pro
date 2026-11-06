# Generative UI: performance evidence

| Measure | Value | Source |
|---|---|---|
| Extra model calls for a presentation | **0**: the proposal rides on the existing final `dinarConversationTurn` call | design, `smart-turn.ts` |
| Extra tool rounds | 0 for layouts; 1 server-side `compareListings` read for COMPARISON (no model round) | `smart-turn.ts` |
| Server validation | one pure function over ≤ 24 listings | `resolvePresentationProposal` |
| Composition payload | ≤ ~120 bytes (`source`, `layout`, one id) | `ResultCompositionSchema` |
| Restore → grid visible (Chromium, local) | 679 ms, including page reload and API restore | browser report |
| DOM nodes on the page after both conversations | 322 | browser report |
| Proposal suite runtime | 16 tests in ~6 s on the real runtime | `generative-ui` |

**Economics:** with no proposal, behaviour and cost are unchanged. A deterministic (LEGACY) search never calls the model. A proposal is used only when the model was already called.

**Not measured:** live-model token use, time-to-first-token, mobile CPU throttling, memory over long sessions. These need a live provider or device lab.
