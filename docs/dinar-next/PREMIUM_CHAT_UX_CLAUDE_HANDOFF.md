# Premium chat UX: integration handoff

**Branch:** `claude/dinar-next-intelligence` (Commands 02 + 03), plus `claude/connect-01-modes` (Command 01).

**Source changed in Command 03:**
- `artifacts/api-server/src/ai/business-turn.ts`: one reply-text addition.

**Tests added:**
- `artifacts/api-server/test/premium-ux-browser-journey.test.ts`;
- `artifacts/dinar/test/premium-ux-browser.mjs`.

**Evidence:** `docs/dinar-next/evidence/premium-ux/` (screenshots, about 8 MB). Keep them out of release bundles.

## Compatibility

Nothing was removed. Card Envelope, pending actions, seller / buyer / Connect / delivery flows, financial protections, the 25-entry registry and conversation persistence are all exercised by the regression run above.

## Recommended integration work

1. Run `premium-ux-browser-journey` on the joint Codex + Claude candidate.
2. Code-split review of the main chunk.
3. Virtualize long histories if real histories exceed about 50 messages.
4. Lighthouse / axe in CI.
5. The UX25 auth-transition journey.
6. The live-model benchmark once a provider is approved.
7. Join Command 01 (Connect modes) so the UX16 reply's `/connect` modes exist on the same tree.
