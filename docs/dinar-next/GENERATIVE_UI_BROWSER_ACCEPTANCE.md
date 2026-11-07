# Generative UI: browser acceptance

**Suite:** `artifacts/api-server/test/generative-ui-browser-journey.test.ts` drives `artifacts/dinar/test/generative-ui-browser.mjs` in real headless Chromium. It uses:
- the built web app;
- the real API;
- a disposable loopback PostgreSQL;
- the local third-party stub.

The data is produced through real HTTP turns: a scripted model searches, then proposes `GRID`, positions `[2,3,1]`, highlight `3`. A second conversation receives a rejected proposal (position 9).

**Result:** PASS. 0 console errors, 0 page errors, 0 external requests, 0 horizontal overflow. The browser made **no model call** (gateway call count unchanged).

| Check | Result |
|---|---|
| Restored block renders the model-proposed GRID with server-resolved cards in order | PASS |
| Exactly one card has a visible and accessible «اقتراح دينار» label | PASS |
| Grid exposes `role=list` / `listitem` | PASS |
| Card actions keyboard-focusable | PASS |
| RTL, no overflow, named buttons ≥ 32 px at 320 / 390 / 768 / 1280 | PASS |
| Reload restores the same layout and suggestion from the server | PASS |
| Rejected proposal → default carousel, no layout, no suggestion | PASS |

**Not covered in this mission's browser run.** Each journey below is covered by an existing suite, not re-run here:

| Journey | Existing suite |
|---|---|
| Internal add-to-cart and the cart animation | `wave03-d7-cart-browser-journey` |
| External merchant navigation | `connect-cards-browser-journey` |
| Pending action in two tabs | `w02u3-card-concurrency-browser-journey` |
| Slow API / stream recovery | `conversation-stream-recovery-browser-journey` |
| Expiry | `w02u3-card-expiry-browser-journey` |

They must be re-run on the joint integration candidate.

Widths 360 / 430 / 1024 / 1440 / 1920 were not individually measured. The responsive breakpoints are 420 px and `lg`; 768 and 1280 bracket them.
