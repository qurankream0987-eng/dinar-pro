# DINAR AI: responsive acceptance

## How it was run

- Real Chromium against the real built app and API.
- A disposable PostgreSQL database with the development seed.
- Run from the isolated worktree on random ports.
- No port-443 font stub, because the full qualification of `b078317` held it. External requests were blocked instead, so the screenshots use system Arabic fonts, not IBM Plex.
- Simulated camera.
- 39 screenshots; key ones are in `evidence/premium-frontend/`.

## Matrix

8 widths × 2 themes: empty chat plus a real search result.

| Width | Composer text (px) | Overflow |
|---|---|---|
| 320 | 266 | 0 |
| 375 | 313 | 0 |
| 390 | 328 | 0 |
| 430 | 368 | 0 |
| 768 | 396 | 0 |
| 1024 | 339 | 0 |
| 1280 | 390 | 0 |
| 1440 | 390 | 0 |

These results are the same in light and dark.

**Mobile composer (P1, fixed):**
- At ≤640 px the composer has two rows: full-width text on top; attach, camera, thinking level, mic and send below.
- Controls are 44 px.
- The safe-area bottom padding is kept.
- See `empty-light-390.png` and `composer-long-light-390.png`.

## Journeys

| Journey | Result |
|---|---|
| Text search results | PASS |
| Camera open, capture and preview | PASS |
| Photo results with badge | PASS |
| Add to cart: arc flight, then basket catch | PASS (`cart-flight-mid`, `cart-catch`) |
| Cart counter | PASS |
| Polite announcement «أُضيف «…» إلى السلة.» | PASS |
| Camera focus trap (8 Tabs stay inside) | PASS |
| Escape returns focus to the camera button | PASS |

## Pending

These existing browser suites need the 443 stub. They are deferred until the qualification of `b078317` releases the port, so they have **not** yet run on this branch:
- `camera-search-browser-journey`;
- `wave03-d7-cart-browser-journey`;
- `premium-ux-browser-journey`;
- `generative-ui-browser-journey`;
- `conversation-v2-browser-journey`.

The full PG16 / PG18 qualification of this branch's SHA is also still to run.

## Not verified

- Real iPhone Safari and Android Chrome, including virtual keyboard, notch and camera behaviour: NOT_VERIFIED_DEVICE.
- Landscape.
