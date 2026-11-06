# Premium chat UX: defects

| # | Defect | Status |
|---|---|---|
| X1 | UX16: «سجّل متجري في دينار كونكت» created a D2 draft without any mention of Connect | FIXED (`business-turn.ts`); verified in the browser |
| X2 | Test harness: the open chat saves its current conversation on unload, so setting the key and reloading sometimes reopened the previous conversation. This caused flaky timeouts in early runs | FIXED in the test (set the key from `/connect`, assert the open conversation). Product behaviour is correct |
| X3 | Environment: worker restarts stopped PostgreSQL mid-run several times | runner now starts PostgreSQL itself; not a product defect |
| O1 | Main JS chunk 269 KB gzip | OPEN: code-split review recommended |
| O2 | Long history: 40 messages ≈ 3.3k DOM nodes, ≈ 2.2 s | OPEN: virtualization candidate |
| O3 | Lighthouse / axe not run | OPEN: no tool installed |
| O4 | UX25 auth-transition journey not re-run | OPEN |
| O5 | Live-model intelligence | BLOCKED_PROVIDER |

Early failure screenshots from runs superseded by X2 / X3 were deleted.
