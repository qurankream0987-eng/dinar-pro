# Claude → Codex integration handoff (Phase 2)

**Heads:**
- Claude: `claude/dinar-next-intelligence` (Draft PR #6).
- Codex: `codex/dinar-next-unified-development` at **`9101672`**. Seven new commits since `4143314`, through `61cb9b1`…`9101672`.

**No migration added by Claude.** The method is unchanged from `CLAUDE_FINAL_INTEGRATION_PLAN.md`:
- a new branch from Codex's final head;
- `git merge --no-ff` of Claude's branch;
- codegen once.

## `git merge-tree` now reports conflicts (it reported none at `4143314`)

| File | Resolution |
|---|---|
| `src/ai/intent.ts` | Combine. Codex's `const request = message.replace(<address>)` becomes `const request = stripCorrectionPrefix(message).replace(...)`. Keep Claude's leading-only price-noun rule |
| `src/app.ts` | Take **Codex's** `frame-ancestors` logic (stricter: `'self'` outside explicit development/test and under Replit deployment). Delete Claude's `frameAncestors()` helper if it becomes unused |
| `test/command-d-acceptance`, `deepseek-chat-compatibility`, `experience-upgrade-acceptance`, `same-origin-web`, `w02u3-card-recovery-browser-journey`, `dinar/test/w02u3-card-performance-ui.mjs`, `w02u3-card-recovery-ui.mjs` | Test files: keep **both** sides' assertions. Where both edited the same expectation, take Codex's platform expectation and re-add Claude's intelligence assertion. Re-run each suite |

## Semantic watch list (in addition to the plan)

- **Registry is 25.** The count is asserted in:
  - `ai-foundation-acceptance`, `ai-foundation-02-acceptance`;
  - `wave04-d10-d11`, `wave04-d10-d12`;
  - `capability-init-order`;
  - `model-native-routing` D6-AI-01 (exact tool list).

  Any Codex capability must be added through `capability-registry.ts` and bump all of these.
- `describeDinarCapabilities` is role-filtered via `modelRolesForActor`. Do not pass a fixed role list.
- `executeConnectReadTurn` has a new `deferWithoutDomain` option. Keep it if Codex changes Connect turn parsing.
- The plan-step soft-miss in `executeWithRoutingMode` must stay **before** the `plain` check.
