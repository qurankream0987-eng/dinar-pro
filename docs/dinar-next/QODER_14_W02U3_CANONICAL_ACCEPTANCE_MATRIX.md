# QODER 14 — W02U-3 Acceptance Matrix (CR-01 … CR-15)

Evidence sources:

- `S` = `artifacts/api-server/test/w02u3-card-reliability.test.ts`, run `41222844647` (8/8, real HTTP +
  disposable PostgreSQL).
- `B` = `artifacts/api-server/test/w02u3-card-reliability-browser-journey.test.ts` →
  `artifacts/dinar/test/w02u3-card-reliability-ui.mjs`, run `41220827185` (real Chromium, 19 checks).
- `U` = `artifacts/dinar/test/w02u3-card-sync.test.ts`, part of `test:surfaces` (31/31 in both runs).
- `R` = regressions: `wave03-card-envelope.test` `41223109850`, `w02-ultra-cards.test` `41223323544`,
  `wave03-card-envelope-browser-journey.test` `41223523144`.
- RED = run `41216639294` (head `eaadf0f`), failure at the cross-tab wait, proving the gap existed.

Status vocabulary: VERIFIED = asserted by an automated test that ran green; PARTIAL = implemented
and/or proven at one layer only; NOT BENCHMARKED = no measurement; BLOCKED = could not run for an
environmental reason.

| # | Scenario | Status | Evidence | Remaining gap |
| --- | --- | --- | --- | --- |
| CR-01 | Two tabs of one account show the same pending review | VERIFIED | B ("CR-01: two tabs … one identity", same `surfaceId`/lifecycle); S CR-01 (two sessions deep-equal envelopes); RED showed the pre-fix state | — |
| CR-02 | A confirmation propagates to the other tab | VERIFIED | B CR-02 (tab 2 reaches CONFIRMED without reload, no buttons); S CR-02 (other session's next read is CONFIRMED) | — |
| CR-03 | Concurrent/double confirmation has one effect | VERIFIED | S CR-03 (two concurrent confirms, cart 1, exactly one success claim); B CR-14 (Enter path executes once) | No separate two-tab simultaneous confirm in the browser; the server serialises it. |
| CR-04 | Account switch while a card is visible | PARTIAL | Scope reset on `user.id`/market change in `Ai.tsx`; S CR-12 proves cross-account 404 and cross-market refusal at the API | No browser test that switches accounts with a card on screen. |
| CR-05 | Logout, then another login | PARTIAL | Same reset path; session cookie change re-reads the server | Not browser-proven. |
| CR-06 | Stale resource after review is refused, Arabic explanation, new review | VERIFIED | S CR-06 (price PATCH → `تغيّرت بيانات العرض`, cart 0, old card EXPIRED/no actions, fresh PENDING with new identity); R green | — |
| CR-07 | Network failure before submission | VERIFIED | B CR-07 (offline: draft kept, send disabled, zero `/turns` POSTs; online: exactly one turn) | — |
| CR-08 | Network failure after server commitment (unknown → verify) | VERIFIED | B CR-08 (response fetched then connection reset: reconciled card PENDING_REVIEW, assistant +1, no failure text, cart 0); `deliveryUnknown` + `reconcileDeliveredTurn` in code | The "verify" button state itself is not browser-clicked; the answered case is. |
| CR-09 | Safe replay with the original idempotency identity | VERIFIED | S CR-09 (409 with `اكتملت/قيد المعالجة`, cart unchanged, card still CONFIRMED, zero model calls); U (sync event strictness) | — |
| CR-10 | Refresh / historical restoration | VERIFIED | B CR-10 (reload restores CONFIRMED, no second effect); S CR-10 (same `surfaceId`, stable message ids) | — |
| CR-11 | Expired / rejected / cancelled never executable | VERIFIED (server) / PARTIAL (client timer) | S CR-11 (DB-expired review → EXPIRED, no actions, late "نعم" has no effect); R green for cancelled/rejected lifecycles | The client `expiresAt` timer is implemented but not exercised by a short-TTL browser test. |
| CR-12 | Cross-account / cross-market confidentiality; forged broadcast & storage | VERIFIED | B CR-12 (forged channel events + planted localStorage ignored, server record wins); S CR-12 (stranger 404 on read and confirm; SA cannot see the JO listing; confirm in SA refused, both carts untouched); U (strict event parser) | — |
| CR-13 | Arabic RTL responsive 320/390/768/1024/1280, no overflow, ≥44px targets | VERIFIED | B checks for both the pending and the reconciled review at five widths; `horizontalOverflow: 0` | — |
| CR-14 | Keyboard and screen-reader usability | VERIFIED (keyboard/names) / PARTIAL (AT) | B CR-14 (focus + Enter executes once; every button named; card `aria-label`) | No NVDA/VoiceOver session. |
| CR-15 | Long-conversation performance | NOT BENCHMARKED | Windowing (40 messages) and memoized bubbles exist on the baseline | No numeric benchmark or stress transcript run. |

## Server-authority invariants re-checked by this work

- One pending action → one effect; a second confirm sees `CONFIRMED`/`IN_PROGRESS` and changes
  nothing (S CR-03).
- A changed resource supersedes the review and requires a fresh confirmation (S CR-06).
- Expiry is decided by the server (`expiresAt <= now`, `SUPERSEDED → EXPIRED`), never extended by the
  client (S CR-11).
- History reads rebuild envelopes from the server; the stored transcript is stable (S CR-10).
- A replay with the original `clientMessageId` is a 409 before any execution (S CR-09).
- Market is part of the action context: a conversation's pending action is refused outside its
  market, and listings/cart are market-scoped (S CR-12).
- No deterministic path calls the model gateway (S CR-01/02/03/06/09/11/12; B model count unchanged).

## Honest coverage notes

- The browser suite had to treat the single `net::ERR_CONNECTION_RESET` console entry as the expected
  consequence of the deliberately dropped response; every other console error still fails the run.
- The server suite's phone generator uses `079`-prefixed Jordanian numbers because libphonenumber
  rejects some random third digits; this is test data only.
- `w02-ultra-browser.test` could not run in this workflow (Chromium is installed only for suite names
  containing `browser-journey`/`security-acceptance`). The same AI page is covered by the three green
  suites listed above.
