# WAVE 05 — D15 Complete System Acceptance

**Integrated acceptance:** suite `wave05-d15-acceptance.test` at `b77be8e`, CI run `41664520596` (SUCCESS, PostgreSQL 16.15).
**Supporting evidence on the same branch:** isolation `a2a2db7` / run `41666288262`, shutdown `89688df` / run `41664280013`, seller-employee `b77be8e` / run `41664683083`, accessibility `b77be8e` / run `41664702077`, browser journeys `c73f7f9` / runs `41658929645` (`command-e-ui.test`) and `41658937281` (`command-f-journeys.test`).
**Not used:** a live payment provider, an SMS gateway, a paid model provider, a non-loopback database, a deployment.

Every verdict below is one of `VERIFIED_PASS`, `FAIL`, `PARTIAL`, `BLOCKED`, `NOT_RUN`. A server test never witnessed a pixel; browser claims come only from the Chromium suites named in §3.

## 1. The integrated matrix (run `41664520596`)

| Category | Verdict | Evidence measured in the run |
| --- | --- | --- |
| Buyer journey | `VERIFIED_PASS` | register → search → detail → idempotent order → duplicate denied → outsider 404 → seller-only accept → handoff → buyer confirm → completed |
| Seller journey | `VERIFIED_PASS` | publish at 45.750, accept, mark delivered, exactly one 9.150 due, other sellers' dues private |
| Seller employee | `VERIFIED_PASS` (separate suite) | `d5-seller-employee-acceptance.test` at `b77be8e`, run `41664683083`; not re-run inside the integrated suite |
| Assistant (AI) | `VERIFIED_PASS` | deterministic seller inventory read matched the DB availability/status; a scripted model advice turn ran through the production `interpretWithModel` loop and touched no cart or order; a planted listing title produced no order. Prompt-injection resistance and language quality are covered by AI-F10 and the D14 human-rating item, not claimed here |
| Infrastructure | `VERIFIED_PASS` | `/api/healthz` 200 `ok`; `/api/readyz` 200 with database ready and migrations current; `x-content-type-options: nosniff`; JSON 404 without internals |
| Security | `VERIFIED_PASS` | model claim withheld at HTTP and in storage; no payment row; conversation isolation 404; anonymous turn 401; JSON errors without internals |
| Money precision | `VERIFIED_PASS` | JOD 3 decimals: 91.500 / 9.150 / 82.350 (minor 91,500 / 9,150 / 82,350); DB rows agree; header price × quantity equals subtotal on this single-price order |
| Mixed-price cart | `BLOCKED` | `WAVE05_MONEY_GATE mm11/mm20`: the strict CHECK rejects a seller-grouped order, the Wave 02 relaxed CHECK accepts a header price × quantity that is not the subtotal, and the strict CHECK cannot be re-imposed (`mm20StrictReimposition`). Wave 01 + Wave 02 are not a valid combined money model — see `WAVE05_SECURITY_AND_FINANCIAL_CONSISTENCY.md` |
| Refunds and disputes | `BLOCKED` | refund/dispute accounting sits on the same unresolved order money model; no refund policy is invented |
| Browser — desktop | `VERIFIED_PASS` (separate suites) | `command-e-ui.test` at `c73f7f9`, run `41658929645`: 320/375/390/430/768/1024/1440/1600 px, light/dark, `reducedMotion=reduce`, captured and asserted |
| Browser — mobile | `VERIFIED_PASS` (separate suites) | `command-f-journeys.test` at `c73f7f9`, run `41658937281`: the authenticated journeys at 390 px plus a 320/390/768 layout pass with no overflow and a reachable composer; `w02u3-card-accessibility-browser-journey.test` at `b77be8e`, run `41664702077`: keyboard, RTL, live regions at 320 px |
| Browser — tablet | `VERIFIED_PASS` (separate suite) | `command-f-journeys.test`'s 768 px layout pass (full journeys themselves ran at 390 px) |
| WebKit / Firefox | `BLOCKED` | CI installs Chromium only; WebKit and Firefox are unavailable in this runner and no result is claimed for them |
| Screen reader | `BLOCKED` | no NVDA/JAWS/VoiceOver/TalkBack in CI; the w02u3 report carries `AT_MANUAL_BLOCKED` with a manual checklist |

## 2. What the integrated suite asserts, case by case

| Case | Asserts | Result |
| --- | --- | --- |
| A15-01 buyer journey | 201 register, search finds the listing, detail matches, `POST /orders` with an idempotency key creates one order, the same key returns the same order, a second order for the same unit is denied, an outsider gets 404, only the seller can accept, the seller marks delivery, the buyer confirms, status ends `COMPLETED` | pass |
| A15-02 seller journey | publish accepts 45.750; acceptance and delivery are seller-authorized; `GET /seller-dues` shows exactly 9.150 for that seller and hides the other seller's dues | pass |
| A15-03 assistant grounding | a seller asks for their own inventory; the reply's «title», availability and status are read back from the `offers` row (`available = available_quantity − reserved_quantity`); a scripted model advice turn (`goal: BUY`) runs through the production loop and changes no cart or order; a listing whose title contains an instruction creates no order | pass |
| A15-04 authority | a model reply claiming "payment done / delivered / completed" is replaced by `MODEL_CLAIM_WITHHELD`, the payload carries `claimWithheld: true` and `actionLifecycle: PROPOSED`, and no order or payment row exists | pass |
| A15-05 infrastructure | `healthz`/`readyz` 200 with ready database and current migrations, `nosniff`, JSON 404 | pass |
| A15-06 security | conversation isolation (404), anonymous turn (401), no internals in error bodies | pass |

The suite never calls a model provider: the conversation gateway is a scripted `ConversationModelGateway`, and `BDINAR_BLOCK_MODEL_CALLS=1` guards accidental egress.

## 3. Browser evidence — what was actually observed

| Suite | Viewport coverage | What is asserted | Run |
| --- | --- | --- | --- |
| `command-e-ui.test` | 320, 375, 390, 430, 768, 1024, 1440, 1600 px; light + dark; `reducedMotion=reduce` | layout, navigation, composer reachability, no horizontal overflow, captured screenshots | `41658929645` |
| `command-f-journeys.test` | journeys at 390 px; a 320/390/768 px layout pass | authenticated buyer/seller journeys, no overflow, reachable composer | `41658937281` |
| `w02u3-card-accessibility-browser-journey.test` | 320 px | keyboard order, RTL direction, live regions; `AT_MANUAL_BLOCKED` for screen readers | `41664702077` |

Limitations, stated plainly:

- Chromium only. WebKit and Firefox are `BLOCKED`, not "assumed fine".
- The browser suites ran at `c73f7f9`; the commits after it (`89688df`, `06f50ea`, `b933f0b`, `b77be8e`, `a2a2db7`) change server shutdown, tests and one test-only title seed — no web bundle change. If the owner wants browser evidence pinned to the exact final SHA, the two suites must be re-dispatched after the last web-affecting commit.
- Loading, error and reduced-motion states are asserted in Command E; a screen reader was not available.

## 4. Regression suites that back this matrix

| Suite | Run | Result |
| --- | --- | --- |
| `d4-d5-isolation-security.test` | `41666288262` at `a2a2db7` | SUCCESS (after a test-only fix: a random hex title suffix could parse as a Jordanian phone number and trip the listing contact guard) |
| `wave05-d13-shutdown.test` | `41664280013` at `89688df` | SUCCESS — `SIGTERM` drain 26 ms, listener closed, new connection refused, pool ended, a second signal does not re-drain |
| `d5-seller-employee-acceptance.test` | `41664683083` at `b77be8e` | SUCCESS |
| `w02u3-card-accessibility-browser-journey.test` | `41664702077` at `b77be8e` | SUCCESS with `AT_MANUAL_BLOCKED` |

## 5. Honest gaps

1. **Commerce acceptance is BLOCKED at the money model**, not at the journeys. A buyer can complete a single-price purchase end to end; a mixed-price cart cannot be accepted while Wave 01 and Wave 02 disagree (`WAVE05_SECURITY_AND_FINANCIAL_CONSISTENCY.md`, `WAVE05_INTEGRATION_REQUIREMENTS.md`).
2. **Refunds and disputes** were not exercised because they inherit the same unresolved money model.
3. **WebKit, Firefox and real assistive technology** are unavailable in this runner (`BLOCKED`, with a manual checklist for AT).
4. **Language quality and dialect authenticity** are not part of D15; they are `NOT_MEASURED` in `WAVE05_D14_INTELLIGENCE.md` pending the blind human rating.
5. **Capacity** is reported only from the synthetic runner baseline (`WAVE05_D13_PERFORMANCE.md`); no production or Railway load was generated.
