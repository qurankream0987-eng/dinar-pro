# Generative UI: model proposal security

| Threat | Control | Evidence |
|---|---|---|
| Invalid JSON / non-object | `presentation` is `z.unknown()` in `ModelTurnOutput`, so the turn and its verified reads survive; the resolver rejects it | `generative-ui` «non-object proposal» |
| Invented reference / nonexistent resource | positions are only indices into the same turn's server result; out of range → rejected | G-UI-06 |
| Identifier instead of position | integer schema | «identifier instead of a position» |
| Unsupported component / layout | closed enum | G-UI-19 «unknown layout» |
| Forged price / URL / style / HTML / action / onClick | strict object: any extra property rejects | G-UI-19 «forged price»; resolver unit test (7 fields) |
| Excessive nesting | flat schema; a nested `layout` object is rejected | resolver unit test |
| Overlong / too many | ≤ 6 positions, ≤ 4 dimensions, unique | G-UI-20 (7 items, duplicates) |
| Sponsored result passed off as advice | `SPONSORED_HIGHLIGHT` rejection | G-UI-26 resolver unit test |
| Prompt injection in tool results | unchanged: listing text is marked untrusted (`<dinar_tool_results>` rule); a proposal can only rearrange verified cards | — |
| Authorization upgrade | the proposal carries no action; comparisons run through the canonical read tool scoped to the conversation and market | G-UI-02; "no order, cart line or listing change" |
| Provider failure after a verified read | verified results are kept, no composition | G-UI-28 |
| Repeated model calls | none added: the proposal rides on the existing single final `dinarConversationTurn` call | — |

**Fallback:** a rejected proposal is logged (`presentation proposal rejected`, with a reason and no content). The typed card is shown exactly as without a proposal: same listings, same order, no surface substitution.

**Scripted vs live:** every case above uses a scripted gateway. It proves the contract, validation and fallback. **It does not prove that a live model chooses good layouts.** That needs an approved provider budget (see `CLAUDE_SELF_HOSTED_MODEL_READINESS.md`).
