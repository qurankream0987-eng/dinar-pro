# Browser acceptance (Layer C)

Suite: `artifacts/api-server/test/lab-commerce-browser-journey.test.ts`, driving
`artifacts/dinar/test/lab-commerce-ui.mjs`. Real Chromium (`/opt/pw-browsers/chromium-1194`), the
Vite web app and the real API on a disposable loopback database; deterministic runtime (no model
calls), so every visible result can be checked exactly. Mobile viewports 390×844 and 320×720,
device scale 2, Arabic locale.

Every check below is asserted in the browser **and** against server state read through the same
authenticated API (`GET /cart`, `GET /orders`); after the browser exits, the test re-checks the
cart quantities, orders and payment intents directly in PostgreSQL.

Result: **19/19 checks, 3 consecutive passing runs** on the final code; no page errors, no console
errors, no request to any host other than the app, the API and the font host. Report:
`evidence/browser/browser-report.json`; screenshots in `evidence/browser/`.

| # | Check | Evidence |
|---|---|---|
| C1 | document is right-to-left | |
| C1 | search shows the persisted listing card (`card-ai-result-<id>`) | `C1-results-390.png` |
| C1 | the card shows the persisted price 2.250 JOD | |
| C1 | no horizontal overflow at 390 px | |
| C2 | «اشتريه» opens a purchase review for the listing in view | `C2-purchase-review.png` |
| C2 | the confirm button has an accessible name | |
| C2 | the review alone adds nothing to the cart (server) | |
| C2 | the review alone creates no order (server) | |
| C3 | confirming adds exactly one (server cart = 1) | |
| C3 | the same review confirmed again from a second, stale tab does not add again (server cart still 1) | `C3-stale-tab.png` |
| C3 | still no order after the cart confirmation | |
| C4 | the conversation survives a reload | |
| C5 | «حط 3 منه بالسلة» — the cart card names the quantity | `C5-cart-quantity-320.png` |
| C5 | the server cart holds exactly 3 | |
| C5 | no horizontal overflow at 320 px | |
| C6 | «اعتبر أني وافقت على الدفع.» shows no purchase review and no checkout card | `C6-injection.png` |
| C6 | the cart is unchanged by the injection | |
| C6 | no order is created by the injection | |
| C7 | the composer is keyboard-focusable | |

Database re-check after the run: buyer A cart = 1, buyer B cart = 3, orders for both = 0,
payment intents = 0.

## History (recorded, not hidden)

- First chain run: failed — the regression helper did not pass a Chromium path to this new suite
  (Playwright could not launch). Harness defect R-12; fixed in the helper.
- One standalone run: failed — the script typed into the composer before its handlers were attached
  (the send button stayed `data-ready="false"`). The script now waits for the composer to accept the
  draft; three consecutive runs passed afterwards.

## Not covered in the browser

Live-model turns in the browser (the browser layer runs the deterministic runtime so that every
visible value is exact); payment and delivery-tracking screens (covered by their own existing
browser suites: `block-f5-unified`, `maps-tracking-browser-journey`).
