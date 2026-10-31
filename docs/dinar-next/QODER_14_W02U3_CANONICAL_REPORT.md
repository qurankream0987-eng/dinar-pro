# QODER 14 — W02U-3 Canonical Conversational Card Reliability Closure

Status: IMPLEMENTED and VERIFIED for the scenarios listed below; the remaining gaps are stated
explicitly in §7 and in the acceptance matrix. Nothing in this work changes server authority,
database schema, migrations, pricing, commission, settlement, refund, policy, WhatsApp or ledger
code.

- Repository: `qurankream0987-eng/dinar-pro` (the old `dinar` URL redirects here)
- Baseline: `claude/10-ultra-closure` at `9a0f86f0b3c727f48be58aee7db11a3045a94613`
- Task branch: `qoder/14-w02u3-canonical-reliability`
- Worktree: `D:/DINAR/dinar-w02u3-canonical`
- Head at handoff: `683e1da` (see §3 for the full commit list)
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
| Tests | `artifacts/api-server/test/w02u3-card-reliability.test.ts` (HTTP/PostgreSQL), `artifacts/api-server/test/w02u3-card-reliability-browser-journey.test.ts` (real Chromium wrapper), `artifacts/dinar/test/w02u3-card-reliability-ui.mjs` (browser harness), `artifacts/dinar/test/w02u3-card-sync.test.ts` (unit). |

No migration, schema, search, pricing, commission, settlement, refund, policy-lifecycle, WhatsApp or
ledger file is touched (`git diff --name-only 9a0f86f..683e1da` shows none).

## 3. Commits

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

All runs are `qoder-api-suite.yml` on `qoder/14-w02u3-canonical-reliability`; each run also executes
typecheck, both builds and `test:surfaces`.

| Run | Suite | Flags | Result | Key lines |
| --- | --- | --- | --- | --- |
| `41220827185` | `w02u3-card-reliability-browser-journey.test` | `BDINAR_W02U3_BROWSER=development` | success | 19 checks incl. CR-01/02/07/08/10/12/13/14; `pageErrors: []`, `consoleErrors: []`, `externalRequests: []`, `horizontalOverflow: 0`; `LOCAL_SUITE … exit=0 outbound=0` |
| `41222844647` | `w02u3-card-reliability.test` | `BDINAR_W02U3_TEST_DATABASE=development` | success | surface tests 31/31; server suite 8/8 (CR-01/02/03/06/09/10/11/12); `LOCAL_SUITE … exit=0 outbound=0` |
| `41223109850` | `wave03-card-envelope.test` | `BDINAR_WAVE03_ACCEPTANCE=development` | success | regression |
| `41223323544` | `w02-ultra-cards.test` | `BDINAR_TEST_DATABASE=development` | success | regression |
| `41223523144` | `wave03-card-envelope-browser-journey.test` | `BDINAR_TEST_DATABASE=development` | success | browser regression on the shared AI page |

The browser journey exercises the real web build, real Chromium, real API and the disposable
PostgreSQL of the isolation runner. It measured the pending review and the reconciled review at
320/390/768/1024/1280 with RTL, zero horizontal overflow and every visible button ≥44px with an
accessible name. The model gateway was blocked and its call count was unchanged.

The `surfaces` report from run `41220827185`:
`{"pending":{"surfaceId":"caeaa221-f033-4e09-ab18-c9df0ae46ea1:CHECKOUT_CONFIRMATION","lifecycle":"PENDING_REVIEW"}}`.

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
  same server action once; the card exposes its `aria-label`.

## 7. What is not proven (explicit)

| Item | Status | Why / what remains |
| --- | --- | --- |
| CR-04 account switch with a card visible | PARTIAL | Scope reset and server-only card content are implemented and API isolation is proven (CR-12), but no browser test switches accounts mid-conversation. |
| CR-05 logout then another login | PARTIAL | Same as CR-04: session change triggers the same reset path; not browser-proven. |
| Client-side expiry re-read in the UI | PARTIAL | Server expiry is verified (CR-11); the timer path is implemented but not exercised by a browser test with a short-TTL review. |
| Screen-reader verification (AT run) | PARTIAL | Accessible names and focus order are asserted; no NVDA/VoiceOver session was run. |
| CR-15 long-conversation performance | NOT BENCHMARKED | The page keeps windowing (40 messages) and memoized bubbles, but no numeric benchmark was produced. |
| `w02-ultra-browser.test` regression | BLOCKED (environment) | Run `41223814591`: the workflow installs Chromium only for suite names containing `browser-journey` or `security-acceptance`, so this suite launched Playwright's default `chromium_headless_shell-1243` that does not exist. Not a product failure; the same page is covered by the three green suites above. |
| Migration 0041 integration | OUT OF SCOPE | Mission forbids migration changes; conflicts are left for the integration step. |
| PR merge | NOT DONE BY DESIGN | A draft PR is opened; merging is the owner's decision. |

## 8. Constraint compliance

- No migration/manifest change; no search/SQL/index/pagination/sponsored-ranking change; no pricing,
  commission, settlement, refund, policy, WhatsApp or ledger change.
- No production database, no paid AI provider, no Railway deployment, no weakened server guard.
- No second card runtime/registry/receipt ledger; the card remains the single server envelope.
- No force push; main untouched; the other task branches were not modified.
- Tests ran only in GitHub Actions; the isolation runner reported `outbound=0` in every run.
