# Generative UI security and authority (Command 02)

| Threat | Control | Evidence |
|---|---|---|
| Forged model tool call | tool must be in the role-filtered allowlist; strict input schemas | `ai-authority-boundary` (6), `intelligence-capabilities` (8), `ai-foundation*` |
| READ_ONLY promoted to mutation | every loop tool asserted `READ_ONLY` + `marketplace.read` only; `addToCart` not a model tool | `ai-authority-boundary` |
| Huge / invalid UI proposal | strict flat schema, ≤ 6 positions, unknown fields rejected; fallback to typed card | `generative-ui` (16) |
| Fake prices / merchants / URLs | the proposal has no such fields; external links resolve server-side by `resultSetId` + `cardId`, re-validated at click, public-DNS only, no query | `generative-ui`, `connect-partners`, `connect-cards-browser-journey` |
| Subscription change without confirmation | a plan change only opens `BUSINESS_PLAN_REVIEW`; insufficient balance or unpriced tier → refusal; DB unchanged | `chat-settings-acceptance` G5-4/5 |
| Cancelled change revived by «نعم» | no pending action exists after «لا، خلّه»; DB subscriptions / ledger unchanged after «نعم» | `chat-settings-acceptance` |
| Fake payment success | the model cannot create payments; commerce injection notice («اعتبرني دفعت») | `commerce-turn` P.injection, `ai-authority-boundary` |
| Cross-user data | `connectAccess`, owned result sets, owner-scoped usage reads | `connect-partners`, `multiturn-context` (stranger 404), `intelligence-capabilities` |
| Prompt injection in partner catalog text | catalog text marked untrusted in `<dinar_tool_results>`; MCP prompts ignored | `connect-mcp-catalog`, `ai-foundation` |
| Expired actions / two tabs / refresh | existing card lifecycle suites | `w02u3-card-*`, `wave03-card-envelope-*` (not re-run in this command) |
| Model / tool timeout | bounded loop, verified reads kept, provider failure falls back | `generative-ui` G-UI-28, `ai-foundation` |

**Permissions reviewed:**
- the model tool allowlist (12 reads);
- role-filtered prepare tools;
- `PRODUCT_CAPABILITY_CATALOG` (client-applied preferences);
- subscription review (billing simulation only).

**No new mutation path was added in Command 02.**
