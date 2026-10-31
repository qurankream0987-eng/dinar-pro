# QODER 14 — W02U-3 Canonical Conversational Card Reliability Closure

Status: IMPLEMENTED and VERIFIED for every scenario in the acceptance matrix (CR-01 … CR-15) on one
tested SHA, with two explicit exceptions: spoken screen-reader output is `AT_MANUAL_BLOCKED`, and the
draft PR is not merged by design (§7). Nothing in this work changes server authority, database
schema, migrations, pricing, commission, settlement, refund, policy, WhatsApp or ledger code.

- Repository: `qurankream0987-eng/dinar-pro` (the old `dinar` URL redirects here)
- Baseline: `claude/10-ultra-closure` at `9a0f86f0b3c727f48be58aee7db11a3045a94613`
- Task branch: `qoder/14-w02u3-canonical-reliability`
- Worktree: `D:/DINAR/dinar-w02u3-canonical`
- Head at handoff: `683e1da` (implementation closure); final acceptance tested head: `b5a3772`
  (see §3 and §5). This document was committed after `b5a3772` and changes no code.
- Execution mode: every build/test ran in GitHub Actions on this branch (cloud-only); the Windows
  host was not used to build or test.

## 1. Problem this closure addresses

The canonical card envelope and its server invariants (UNDERSTAND → REVIEW → CONFIRM → RE-READ →
EXECUTE, one effect per pending action, expiry, supersede-on-change, history recomputation) already
existed on the baseline. What was missing was client-side reliability around them:

1. A card confirmed in one tab never reached a sibling tab; the second tab kept offering a stale
   `CONFIRM`.
2. A turn whose response was lost after the server committed was reported as a generic failure,
   inviting a duplicate send.
3. A pending review's expiry was known only to the server; an open tab could keep showing live
   actions past `expiresAt` until an unrelated re-read.

No new card runtime, registry, ledger or receipt concept was introduced. Every fix re-reads the
server and adopts the envelope it returns.

## 2. What changed

| File | Change |
| --- | --- |
| `artifacts/dinar/src/features/ai/card-sync.ts` (new) | `BroadcastChannel` invalidation signal, scoped to `dinar:card-sync:v1:<userId>:<marketId>`. The message carries only `type`, `userId`, `marketId`, `conversationId`, `issuedAt`; a strict parser refuses any other key, another account, another market, a malformed id or a non-invalidation type. The receiver never copies content — it only re-reads the conversation. |
| `artifacts/dinar/src/features/ai/ai-api.ts` | A transport failure before or during the SSE stream, and a stream that ends without a terminal event, are marked `deliveryUnknown` instead of being reported as a plain failure. Aborts are untouched. |
| `artifacts/dinar/src/pages/Ai.tsx` | (a) `useCardSync` revalidation; (b) focus/visibility revalidation; (c) timestamp-guarded adoption of server messages, so a settled card is never revived from a local copy and an in-flight turn is never rolled back; (d) `reconcileDeliveredTurn`: on `deliveryUnknown`/409 the server record decides — answered → adopt, delivered but unfinished → a "verify" state with Arabic explanation and a **تحقق من النتيجة** button, absent → safe retry with the same `clientMessageId`; (e) a pending-review expiry timer that only requests a server re-read at `expiresAt + 1s`; (f) publish an invalidation after a completed turn and after a listing is created; (g) scope reset clears the verify state. |
| `artifacts/dinar/package.json`, `test/tsconfig.surfaces.json` | The new sync unit test joins `test:surfaces`. |
| `artifacts/api-server/test/safe-development-database.ts` | Added approval keys `BDINAR_W02U3_TEST_DATABASE` and `BDINAR_W02U3_BROWSER`. No guard was weakened; both still require the disposable/development database rules. |
| Tests | `artifacts/api-server/test/w02u3-card-reliability.test.ts` (HTTP/PostgreSQL), `artifacts/api-server/test/w02u3-card-reliability-browser-journey.test.ts` (real Chromium wrapper), `artifacts/dinar/test/w02u3-card-reliability-ui.mjs` (browser harness), `artifacts/dinar/test/w02u3-card-sync.test.ts` (unit). The acceptance closure added six more browser journeys with their wrappers and a shared session helper: sessions (CR-04/05), expiry (CR-11), recovery (delivered-unanswered/absent), concurrency (two tabs), performance (CR-15) and accessibility (CR-14); all under `artifacts/**/test/`, no product code. |

No migration, schema, search, pricing, commission, settlement, refund, policy-lifecycle, WhatsApp or
ledger file is touched (`git diff --name-only 9a0f86f..683e1da` shows none).

## 3. Commits

Implementation closure (`9a0f86f` → `683e1da`):

```
683e1da test(w02u3): pin each deterministic path to zero model calls
b179e56 test(w02u3): read the 409 body from the API error envelope
fdb99d6 test(w02u3): a cross-market confirmation is refused and leaves both carts untouched
4f5de74 test(w02u3): read stored messages by actor; assert the conversation's market binds its effects
8fcc68e test(w02u3): register with 079-prefixed Jordanian numbers
932ba9c test(w02u3): generate valid Jordanian mobile numbers
3aafabf test(w02u3): treat the deliberately reset response as the only expected console error
faa1834 test(w02u3): allow the textarea newline in the offline draft check
babc70b test(w02u3): assert sync payload shape by key, not substring
be1c9dd feat(ai): cross-tab card revalidation, server reconciliation of lost turns, expiry re-read
eaadf0f test(w02u3): red acceptance for cross-tab card reliability and delivery reconciliation
9a0f86f (baseline)
```

Final acceptance closure (`683e1da` → `b5a3772`, test-only plus one CI line):

```
b5a3772 test(w02u3): import the db handle the accessibility wrapper queries with
d45e7da test(w02u3): assert the fieldset's own disabled flag and the confirm control, not the fieldset's isDisabled
da8cd2c test(w02u3): read the busy state from the action-group fieldset that wraps the card and gate the held turn
f1a205b test(w02u3): the benchmark opens the persistent sidebar at 1280, the drawer only on mobile
3c68b8f test(w02u3): CR-15 long-conversation benchmark and accessibility acceptance
3f38dfe test(w02u3): real-browser recovery and two-tab confirmation journeys
e8ad11d test(w02u3): prove the expiry refresh is a read, never a turn
5a192d8 test(w02u3): move the fixture's review snapshot with the shortened expiry
2a6067c test(w02u3): CR-11 short-TTL expiry in the real browser
f725c4f test(w02u3): park the pointer so login toasts cannot cover the drawer trigger
cdeb8ac test(w02u3): close the history drawer with Escape
4ecd493 test(w02u3): close the mobile history drawer through its own control
c775000 test(w02u3): CR-04/CR-05 real-browser account switch and logout isolation
e869a1e ci(w02u3): install chromium for the ultra browser suite
1129f7c docs(w02u3): canonical reliability report, acceptance matrix and Claude handoff
```

Everything after `683e1da` touched only `artifacts/**/test/**`, `artifacts/dinar/test/**` and one
workflow line; no product source, schema, migration or guard changed.

## 4. RED evidence (before the implementation)

- Run `41216639294`, branch head `eaadf0f`, workflow `qoder-api-suite.yml`,
  suite `w02u3-card-reliability-browser-journey.test`, flags `BDINAR_W02U3_BROWSER=development`.
- Result: `failure`. The report reached and passed CR-01 (`checks` contained "CR-01: two tabs of one
  account show one pending review with one identity") and then failed at the CR-02 wait:
  `page.waitForFunction: Timeout 20000ms exceeded` inside `waitForCardLifecycle(second, "CONFIRMED")`
  (`artifacts/dinar/test/w02u3-card-reliability-ui.mjs`), i.e. the second tab never learned about the
  confirmation without a reload.
- Line: `LOCAL_SUITE suite=w02u3-card-reliability-browser-journey.test db=dinar_test_local_ed87646e9cd9 exit=1 outbound=0`.

This is the gap the implementation closes; the test file was written first and failed for the
expected reason.

## 5. GREEN evidence (after the implementation)

### 5.1 Implementation closure runs

All runs are `qoder-api-suite.yml` on `qoder/14-w02u3-canonical-reliability`; each run also executes
typecheck, both builds and `test:surfaces`.

| Run | Suite | Flags | Result | Key lines |
| --- | --- | --- | --- | --- |
| `41220827185` | `w02u3-card-reliability-browser-journey.test` | `BDINAR_W02U3_BROWSER=development` | success | 19 checks incl. CR-01/02/07/08/10/12/13/14; `pageErrors: []`, `consoleErrors: []`, `externalRequests: []`, `horizontalOverflow: 0`; `LOCAL_SUITE … exit=0 outbound=0` |
| `41222844647` | `w02u3-card-reliability.test` | `BDINAR_W02U3_TEST_DATABASE=development` | success | surface tests 31/31; server suite 8/8 (CR-01/02/03/06/09/10/11/12); `LOCAL_SUITE … exit=0 outbound=0` |
| `41223109850` | `wave03-card-envelope.test` | `BDINAR_WAVE03_ACCEPTANCE=development` | success | regression |
| `41223323544` | `w02-ultra-cards.test` | `BDINAR_TEST_DATABASE=development` | success | regression |
| `41223523144` | `wave03-card-envelope-browser-journey.test` | `BDINAR_TEST_DATABASE=development` | success | browser regression on the shared AI page |

### 5.2 Final acceptance regression on one tested SHA (`b5a3772`)

Every row below ran `qoder-api-suite.yml` on `qoder/14-w02u3-canonical-reliability` at head
`b5a37722f98435d1966b16a1098ef4894dc6c497`, one dispatch at a time, and each ended with
`LOCAL_SUITE … exit=0 outbound=0` and `test:surfaces` 31/31.

| Run | Suite | Result | Evidence line |
| --- | --- | --- | --- |
| `41245095592` | `w02u3-card-reliability.test` | success | 8/8 tests |
| `41245222389` | `w02u3-card-reliability-browser-journey.test` | success | 19 checks; clean arrays |
| `41245502937` | `w02u3-card-sessions-browser-journey.test` | success | 11 checks; `delayedResponseHeld: true`, `staleResponseLeak: false`, `horizontalOverflow: 0` |
| `41245718734` | `w02u3-card-expiry-browser-journey.test` | success | 5 checks; fixture shortens the ~10-minute expiry by ~9m42s; the client re-reads after `elapsedMs: 9924` and sends no turn |
| `41245889451` | `w02u3-card-recovery-browser-journey.test` | success | 5 checks; delivered posts 1 → verify/adopt; absent `posts: 3`, `serverUserRows: 1`, identical retry id |
| `41246114023` | `w02u3-card-concurrency-browser-journey.test` | success | 4 checks; both confirmations held before either answer, cart 1 |
| `41246348213` | `w02u3-card-performance-browser-journey.test` | success | 6 checks; medians/p95 in §CR-15 of the matrix |
| `41244786883` | `w02u3-card-accessibility-browser-journey.test` | success | 5 checks; `at.screenReader: "AT_MANUAL_BLOCKED"` |
| `41246654084` | `wave03-card-envelope.test` | success | 9/9 |
| `41246826500` | `wave03-card-envelope-browser-journey.test` | success | browser regression |
| `41247096828` | `w02-ultra-cards.test` | success | 6/6 |
| `41247269702` | `w02-ultra-browser.test` | success | browser regression (Chromium now installed for this suite) |
| `41247620760` | `api.test` | success | 63/63 |
| `41249383853` | `conversation.test` | success | 29/29 |
| `41249618801` | `commerce.test` | success | 23/23 |
| `41249857637` | `security-acceptance.test` | success | 12/12 |

The browser journeys exercise the real web build, real Chromium, real API and the disposable
PostgreSQL of the isolation runner. They measured the pending review and the reconciled review at
320/390/768/1024/1280 with RTL, zero horizontal overflow and every visible card button ≥44px with an
accessible name. The model gateway was blocked and its call count was unchanged in every run.

The `surfaces` report from run `41220827185`:
`{"pending":{"surfaceId":"caeaa221-f033-4e09-ab18-c9df0ae46ea1:CHECKOUT_CONFIRMATION","lifecycle":"PENDING_REVIEW"}}`.

CR-15 (run `41246348213`, cold open, 3 reps per cell):

| Viewport | 40 msgs (median / p95) | 100 msgs | 500 msgs | DOM nodes |
| --- | --- | --- | --- | --- |
| 320×844 | 447 / 458 ms | 421 / 451 ms | 477 / 485 ms | 521 / 522 / 522 |
| 1280×900 | 243 / 335 ms | 245 / 266 ms | 247 / 280 ms | 521 / 522 / 522 |

Budget: 2500 ms median, 4000 ms p95. The thread renders 40 bubbles for every size, one older batch
loads 40 more (40 → 80 bubbles, 1042 nodes at both widths), and the 320 px document/thread have no
horizontal overflow.

## 6. Behavioural summary by scenario

- Cross-tab: both tabs render the same `surfaceId`; a confirmation in tab 1 reaches tab 2 through a
  scoped invalidation and a server re-read (< 20s, observed in the run), with no payload copying and
  no stale action left. A reload independently restores the settled card.
- Offline: the composer keeps the draft, the send button is disabled, no `POST /turns` leaves the
  tab; once online the held draft becomes exactly one turn.
- Lost response after commitment: the route fetches the response then aborts it; the client reads the
  conversation, shows the pending review once (assistant count +1), never prints "تعذر إكمال الرد
  الآن", and the cart stays untouched by reconciliation. The only console error is the deliberately
  reset connection (asserted to be exactly one).
- Stale facts: the server refuses an old confirmation after a price change (`تغيّرت بيانات العرض`),
  marks the old card EXPIRED with no actions and offers a fresh review; nothing enters the cart.
- Replay: the original `clientMessageId` returns 409 (`اكتملت/قيد المعالجة`) and adds no unit.
- Expiry: a DB-expired review is returned as EXPIRED with no actions; a late "نعم" executes nothing.
- Cross-account: a stranger gets 404 on read and on confirm. Cross-market: the conversation keeps
  its original market as tool context, SA cannot see the JO listing, a confirm sent while in SA is
  refused (`ليس في سوقك الحالي`) and leaves both carts untouched. Forged broadcast events (extra
  `card` payload, `execute` type) and planted localStorage are ignored.
- Keyboard/a11y: the confirm button is focusable, has an accessible name, and Enter executes the
  same server action once; the card exposes its `aria-label`. The final acceptance pass drove
  everything by keyboard (drawer open/Escape/reopen, conversation selection, composer, Enter-to-send),
  asserted the busy send state (`دينار يعمل الآن`, disabled), the card action group's `aria-busy` and
  disabled confirm control, `role="status"` progress and hint regions, RTL, focus restoration and a
  live (non-trapped) Tab stop after confirmation, and repeated the card checks at 320px. Spoken output
  remains unverified: `AT_MANUAL_BLOCKED` with an explicit manual checklist.
- Sessions: A's review has a server identity; a held re-read from A's session is released only after
  B signs in and is never rendered in B; B sees none of A's cards, conversations or titles; the
  backend answers B's read and turn on A's conversation with 404; B's own review settles without
  touching A's cart. After B logs out, A signs back in and the server returns A's CONFIRMED card with
  the same `surfaceId`, no stale buttons, B's conversation absent, and no repeated effect.
- Recovery: a turn the server recorded but never answered shows **تحقق من النتيجة**; verifying sends
  nothing and keeps the pending state; once the server records the answer, the client adopts it. An
  absent turn offers a retry, the retry reuses the original `clientMessageId`, and the confirmation
  executes exactly once (two deliberate resets only).
- Concurrency: both tabs confirm; both POSTs are held in flight before either answer returns; the
  account receives one effect (cart 1); both tabs converge on one settled card with no stale buttons
  and both reloads restore it.
- Expiry: the client's short-TTL fixture moves the server expiry ~10s ahead; the browser re-reads the
  server at expiry, the server returns EXPIRED with no action, the refresh sends no turn, and a late
  "نعم" is refused without reviving or changing the identity.
- Performance: 40/100/500-message transcripts open cold in well under budget at 320 and 1280, the
  thread stays at 40 bubbles and ~522 DOM nodes, and one older batch loads 40 more.

## 7. What is not proven (explicit)

| Item | Status | Why / what remains |
| --- | --- | --- |
| CR-04 account switch with a card visible | VERIFIED | Run `41245502937`: A's held re-read never lands in B; B inherits nothing; backend 404s B's read/turn; B's own review is isolated. |
| CR-05 logout then another login | VERIFIED | Run `41245502937`: B's logout leaves no A data; A's re-login restores the server's CONFIRMED card and history with no repeated effect. |
| Client-side expiry re-read in the UI | VERIFIED | Run `41245718734`: short-TTL review in the real browser; EXPIRED returned by the server; the refresh is a re-read; late confirm refused. |
| Screen-reader verification (AT run) | BLOCKED (manual) | Run `41244786883` reports `at.screenReader: "AT_MANUAL_BLOCKED"`; keyboard/focus/names/announcement regions are asserted, no spoken-output pass is claimed. Manual checklist: NVDA+Firefox, VoiceOver+Safari iOS, TalkBack+Chrome, announcement review. |
| CR-15 long-conversation performance | VERIFIED | Run `41246348213`: 40/100/500 messages at 320/1280 within budget; DOM bounded at ~522 nodes; windowing 40 → 80. |
| `w02-ultra-browser.test` regression | VERIFIED | Run `41247269702`: the Chromium install gate was widened in `e869a1e`; the suite is green on `b5a3772`. |
| Migration 0041 integration | OUT OF SCOPE | Mission forbids migration changes; conflicts are left for the integration step. |
| PR merge | NOT DONE BY DESIGN | A draft PR is opened; merging is the owner's decision. |

## 8. Constraint compliance

- No migration/manifest change; no search/SQL/index/pagination/sponsored-ranking change; no pricing,
  commission, settlement, refund, policy, WhatsApp or ledger change.
- No production database, no paid AI provider, no Railway deployment, no weakened server guard.
- No second card runtime/registry/receipt ledger; the card remains the single server envelope.
- No force push; main untouched; the other task branches were not modified.
- Tests ran only in GitHub Actions; the isolation runner reported `outbound=0` in every run.
- The final acceptance closure (`683e1da..b5a3772`) is test-only plus one CI install-condition line:
  no product source, schema or guard was edited while the final runs were recorded.
- The fixtures use disposable registrations (§test passwords only), loopback-only control servers
  (`127.0.0.1`, per-run UUID header) and no external host; `externalRequests` is empty in every
  browser report.
- Assertions were only strengthened: CR-15 budgets are unchanged (2500/4000 ms, 40 bubbles, 8000
  nodes), the a11y pass gained explicit `disabled` and confirm-control checks, and every wrapper
  re-verifies the stored server state after the browser run.
