# QODER 14 — W02U-3 Acceptance Matrix (CR-01 … CR-15)

Evidence sources (final acceptance runs are all on tested head `b5a3772`):

- `S` = `artifacts/api-server/test/w02u3-card-reliability.test.ts`, run `41245095592` (8/8, real HTTP +
  disposable PostgreSQL).
- `B` = `artifacts/api-server/test/w02u3-card-reliability-browser-journey.test.ts` →
  `artifacts/dinar/test/w02u3-card-reliability-ui.mjs`, run `41245222389` (real Chromium, 19 checks).
- `SS` = `w02u3-card-sessions-browser-journey.test` → `w02u3-card-sessions-ui.mjs`, run `41245502937`
  (account switch and logout/re-login, 11 checks; delayed response held in flight).
- `E` = `w02u3-card-expiry-browser-journey.test` → `w02u3-card-expiry-ui.mjs`, run `41245718734`
  (short-TTL review in the real client, 5 checks).
- `V` = `w02u3-card-recovery-browser-journey.test` → `w02u3-card-recovery-ui.mjs`, run `41245889451`
  (delivered-but-unanswered verify path and absent-turn retry, 5 checks).
- `K` = `w02u3-card-concurrency-browser-journey.test` → `w02u3-card-concurrency-ui.mjs`, run
  `41246114023` (two tabs, both confirmations held before either answer, 4 checks).
- `P` = `w02u3-card-performance-browser-journey.test` → `w02u3-card-performance-ui.mjs`, run
  `41246348213` (40/100/500-message transcripts, 6 checks; budgets in §CR-15).
- `A` = `w02u3-card-accessibility-browser-journey.test` → `w02u3-card-accessibility-ui.mjs`, run
  `41244786883` (keyboard/announcements/focus at 390 and 320, 5 checks; report carries
  `at.screenReader: "AT_MANUAL_BLOCKED"`).
- `U` = `artifacts/dinar/test/w02u3-card-sync.test.ts`, part of `test:surfaces` (31/31 in every run).
- `R` = regressions on `b5a3772`: `wave03-card-envelope.test` `41246654084` (9/9),
  `wave03-card-envelope-browser-journey.test` `41246826500`, `w02-ultra-cards.test` `41247096828` (6/6),
  `w02-ultra-browser.test` `41247269702`, `api.test` `41247620760` (63/63), `conversation.test`
  `41249383853` (29/29), `commerce.test` `41249618801` (23/23), `security-acceptance.test`
  `41249857637` (12/12).
- RED = run `41216639294` (head `eaadf0f`), failure at the cross-tab wait, proving the gap existed.

Status vocabulary: VERIFIED = asserted by an automated test that ran green; PARTIAL = implemented
and/or proven at one layer only; NOT BENCHMARKED = no measurement; BLOCKED = could not run for an
environmental reason.

| # | Scenario | Status | Evidence | Remaining gap |
| --- | --- | --- | --- | --- |
| CR-01 | Two tabs of one account show the same pending review | VERIFIED | B ("CR-01: two tabs … one identity", same `surfaceId`/lifecycle); S CR-01 (two sessions deep-equal envelopes); RED showed the pre-fix state | — |
| CR-02 | A confirmation propagates to the other tab | VERIFIED | B CR-02 (tab 2 reaches CONFIRMED without reload, no buttons); S CR-02 (other session's next read is CONFIRMED) | — |
| CR-03 | Concurrent/double confirmation has one effect | VERIFIED | S CR-03 (two concurrent confirms, cart 1, exactly one success claim); B CR-14 (Enter path executes once); K (both confirmations were in flight before either answer, cart 1, both tabs converge) | — |
| CR-04 | Account switch while a card is visible | VERIFIED | SS (A sees a server-identified review, A's re-read is held in flight while B signs in, the delayed response never lands in B, B inherits no card/conversation/title, backend refuses B's read and turn with 404, B's own review settles without touching A's cart) | — |
| CR-05 | Logout, then another login | VERIFIED | SS (B signs out, no A data survives, A signs back in and the server returns A's CONFIRMED card with the same `surfaceId`, no stale buttons, B's conversation is neither listed nor rendered, cart stays 1) | — |
| CR-06 | Stale resource after review is refused, Arabic explanation, new review | VERIFIED | S CR-06 (price PATCH → `تغيّرت بيانات العرض`, cart 0, old card EXPIRED/no actions, fresh PENDING with new identity); R green | — |
| CR-07 | Network failure before submission | VERIFIED | B CR-07 (offline: draft kept, send disabled, zero `/turns` POSTs; online: exactly one turn) | — |
| CR-08 | Network failure after server commitment (unknown → verify) | VERIFIED | V (the record exists but no answer: the client offers **تحقق من النتيجة**, sends nothing while verifying, adopts the server's answer; the absent case retries with the original id and executes once); B CR-08 (dropped response reconciled, assistant +1, no failure text, cart 0); S CR-09 (replay 409) | — |
| CR-09 | Safe replay with the original idempotency identity | VERIFIED | S CR-09 (409 with `اكتملت/قيد المعالجة`, cart unchanged, card still CONFIRMED, zero model calls); U (sync event strictness); V (retry posts 3, one user row) | — |
| CR-10 | Refresh / historical restoration | VERIFIED | B CR-10 (reload restores CONFIRMED, no second effect); S CR-10 (same `surfaceId`, stable message ids); K (both reloads) | — |
| CR-11 | Expired / rejected / cancelled never executable | VERIFIED | E (short-TTL review: the client timer fires at the server expiry, the re-read returns EXPIRED with no action, the refresh sends no turn, a late "نعم" is refused and keeps the identity, exactly one deliberate late turn); S CR-11; R green for cancelled/rejected lifecycles | — |
| CR-12 | Cross-account / cross-market confidentiality; forged broadcast & storage | VERIFIED | B CR-12 (forged channel events and planted localStorage ignored, server record wins); SS (planted foreign conversation id never opened; delayed A response never delivered to B); S CR-12 (stranger 404 on read and confirm; SA cannot see the JO listing; confirm in SA refused, both carts untouched); U | — |
| CR-13 | Arabic RTL responsive 320/390/768/1024/1280, no overflow, ≥44px targets | VERIFIED | B asserts RTL, no overflow and ≥44px named card buttons at all five widths for both the pending and the reconciled review; A asserts the 320 card stays inside the viewport, all visible buttons are named and at least 32px, `documentOverflow: 0`, `threadOverflow: 0`; P measures the 320 long thread | — |
| CR-14 | Keyboard and screen-reader usability | VERIFIED (keyboard/names) / PARTIAL (AT blocked) | A (keyboard opens/closes/reopens the drawer with focus restored, composer and send reachable by Tab, busy label `دينار يعمل الآن` + disabled confirm + status regions, RTL, focus live after confirmation, no trap at 320); B CR-14; report `at.screenReader: "AT_MANUAL_BLOCKED"` with a 4-item manual checklist | No NVDA/VoiceOver/TalkBack session was possible in CI; spoken output is not claimed. |
| CR-15 | Long-conversation performance | VERIFIED | P: cold open of 40/100/500-message transcripts at 320 and 1280, 3 reps each. Medians 447/421/477ms at 320 and 243/245/247ms at 1280; p95 458/451/485ms and 335/266/280ms (budgets 2500ms median / 4000ms p95). Thread renders 40 bubbles and 521–522 nodes for every size; one "older" load is 80 bubbles / 1042 nodes; no document or thread overflow at 320 | — |

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
- `w02-ultra-browser.test` now runs in this workflow: the Chromium install gate was widened for that
  suite in `e869a1e`, and run `41247269702` is green on `b5a3772`. The earlier "cannot run" note is
  historical (see run `41223814591`).
- Every run above reports `LOCAL_SUITE … exit=0 outbound=0` and executes typecheck, both builds and
  `test:surfaces` (31/31) before its suite.
- No screen reader was available; CR-14 records `AT_MANUAL_BLOCKED` rather than a spoken-output pass.
  The manual checklist is in the handoff (§Known gaps) and in the run's `W02U3_A11Y` report.
