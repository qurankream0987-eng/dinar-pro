# QODER — DINAR NEXT Wave 02 / D4 + D5 + D6 Closure Report

Status: **implemented and verified for the fifteen scenarios, D4, D5 and D6 acceptance** on one
tested SHA, against the canonical authorities, with the explicit exceptions and integration steps in
§8. This is not a merge, a deployment, or a launch-readiness claim.

- Repository: `qurankream0987-eng/dinar-pro` (the old `dinar` URL redirects here)
- Canonical branch: `replit/dinar-next-complete-development` at `ae8399b4436c9905a63e9e92ec9b1e1368690d98`
- Task branch: `qoder/wave02-d4-d6-closure`
- Worktree: `D:/DINAR/dinar-d4d6`
- **Tested head: `f7e9045e07b28408f69e688c6a0c8908d7b5f24c`**
- Execution mode: every build and test ran in GitHub Actions on this branch against a disposable
  loopback PostgreSQL. The Windows host was not used to build or test.

## 1. Objective and scope

Complete the D4 seller-employee delegation path, the D5 seller-employee work path and the D6 buyer
path without creating a second runtime, database, payment system, cart engine or business service.
The mandated sequence was TRACE → REUSE → IMPROVE → TEST → REGRESSION → COMMIT → PUSH → REPORT.

The mission named fifteen scenarios: multiple inquiries, accurate drafts, owner approval, discount
request, escalation, owner-confirmed change, multi-category discovery, three-offer comparison,
selection, cart review, server-authoritative checkout, reload recovery, revocation blocking,
failed operations without a success receipt, and replay without duplicate effects. Each is mapped to
an automated assertion in
`docs/dinar-next/QODER_WAVE02_D4_D5_D6_ACCEPTANCE_MATRIX.md`.

## 2. Constraints observed

- The canonical Replit branch was fetched and read before any change; the work happened in an
  isolated worktree and branch. No other Qoder/Replit working tree was shared.
- No merge into `replit/dinar-next-complete-development` or `main`; no force push; no deployment.
- No production database, no Railway, no real payment, no paid AI provider, no real money.
- No new conversation runtime, card registry, database, payment path, cart engine or business
  service. Every action still runs through the existing canonical authorities.
- Tests ran only in GitHub Actions; every cited run reports `outbound=0`.
- Assertions were not weakened to make a run pass. Test-authoring errors were corrected at the test
  layer and classified as such (§7).
- The canonical model/tool source was not rewritten by this mission; the only product change is one
  database constraint correction required for the canonical checkout's own multi-line order shape.

## 3. Exact change set

`git diff --name-only ae8399b..f7e9045`:

| File | Kind | Purpose |
| --- | --- | --- |
| `lib/db/drizzle/0051_order_multi_item_money.sql` | product (migration) | Allow one same-seller order to carry several offers at different unit prices while keeping per-line and payable invariants |
| `lib/db/drizzle/meta/_journal.json` | product (migration metadata) | Register `0051` |
| `lib/db/drizzle/release-manifest.json` | product (release metadata) | Register the `0051` sha256 `e99dce44…ad24` |
| `.github/workflows/qoder-api-suite.yml` | CI allowlist | Add the four new suite names so they can be dispatched intentionally |
| `artifacts/api-server/test/wave02-d4-d5-seller-journey.test.ts` | test | D4 + D5 acceptance over real HTTP/PostgreSQL |
| `artifacts/api-server/test/wave02-d6-buyer-journey.test.ts` | test | D6 acceptance over real HTTP/PostgreSQL |
| `artifacts/api-server/test/wave02-d5-browser-journey.test.ts` | test wrapper | Real Chromium D5 reload/approval/revocation journey |
| `artifacts/dinar/test/wave02-d5-ui.mjs` | test harness | D5 browser steps and responsive assertions |
| `artifacts/api-server/test/wave02-d6-browser-journey.test.ts` | test wrapper | Real Chromium D6 search/compare/reload/checkout journey |
| `artifacts/dinar/test/wave02-d6-ui.mjs` | test harness | D6 browser steps and responsive assertions |
| this report, the acceptance matrix and the handoff | docs | Evidence and integration instructions |

No source file under `artifacts/api-server/src` or `artifacts/dinar/src` was modified. The D4/D5/D6
implementation was already present on the canonical branch; this mission proves it, finds the one
real defect that blocked D6 completion, fixes only that defect, and records the evidence.

### The one product defect

The canonical checkout groups a cart by seller: one order per seller with multiple `order_items` and
`data.items`. The `orders` row stores the first line's unit price, the summed quantity and the summed
subtotal. The pre-existing database check `order_money_valid` required
`subtotal_minor = quantity * unit_price_minor`, which holds only for a single-line order. Every
multi-line same-seller cart was therefore rejected by PostgreSQL while inserting the order — with a
raw constraint violation, not a usable business refusal. Run `41540174779` at `6d58451` ends with
`new row for relation "orders" violates check constraint "order_money_valid"` during the D6
same-seller two-line checkout.

Migration `0051` drops and recreates only the order-level check:

```sql
ALTER TABLE "orders" DROP CONSTRAINT "order_money_valid";
ALTER TABLE "orders" ADD CONSTRAINT "order_money_valid" CHECK (
  quantity > 0 AND unit_price_minor > 0 AND subtotal_minor > 0 AND platform_fee_minor >= 0
  AND seller_amount_minor = subtotal_minor - platform_fee_minor
);
```

Per-line `order_item_money_valid` remains in force, so each line still has
`subtotal = quantity × unit price`; the payable split and platform fee are still enforced on the
order row. Nothing about pricing, commission, settlement or refund logic changed.

## 4. TRACE and REUSE — the canonical authorities used

- **Delegation and session authority** — `src/lib/business-delegations.ts`: create `:297`,
  activate/suspend/resume/revoke `:557`/`:561`/`:565`/`:569`, session creation `:1254`, session
  resolution `:1285`, execution-time authorization `:1053`–`:1182`, capability guards `:1326`/`:1337`,
  server-clock expiry `:1084`/`:1135`, invalidation `:1515`/`:1540`, order reads `:1371`,
  escalation `:1441`.
- **Capability vocabulary** — `src/lib/business-capabilities.ts:6` and the publication gate `:40`.
- **Action confirmation** — `src/ai/action-foundation.ts:1235` (review) and `:1342` (confirm)
  re-check the live delegated authority; no new confirmation engine was created.
- **Inquiry authority** — `src/ai/inquiry-turn.ts:418` drafts from the screened question;
  `src/lib/inquiries.ts:256` re-checks the three inquiry capabilities and scope at send time.
- **Employee actions** — `src/ai/conversation-runtime.ts:598` (each action), `:720` (orders),
  `:869` (escalation), `:641` (catalog/stock).
- **Buyer authority** — `src/ai/buyer-turn.ts:102`/`:104`/`:685` (comparison),
  `src/ai/marketplace-intent.ts:173` (back to results), and the canonical result sets.
- **Checkout authority** — `src/routes/marketplace.ts:654` (request lookup), `:688` (policy gate),
  `:778` (`planCheckout` grouping), `:850` (`TEST_NO_TRANSFER`), `:931` (idempotency record).
- **Web** — `artifacts/dinar/src/features/ai/InquirySurface.tsx:26`/`:46`/`:49` shows the approval
  only for a pending draft on the active surface; the browser wrapper proves the page path.

## 5. What each layer now proves

### D4 — delegation is server-owned

The suite creates a real business and listing, then drives the public HTTP endpoints. It proves:
human employees cannot receive D5 capabilities; duplicate capabilities and unknown fields are 400;
a refused request writes no delegation and no audit; another account gets 404 on read, activate and
revoke; a stored grant already past its expiry cannot be activated and stays `DRAFT`; a live grant
that passes its expiry is settled by the authorization path itself (`EXPIRED`, `expiredAt`, reason
`GRANT_EXPIRED`, session `INVALIDATED`); revocation invalidates the running session and writes the
audit trail. Public regression R1 re-proves create/activate/suspend/resume/revoke and the isolation
suite.

### D5 — the employee works, the owner decides

The employee session is bound to the actor, conversation, business, grant and market. Drafting sends
nothing; the model receives only the screened question and the assigned listing's recorded stock;
another customer's private question never enters the context. One owner "أرسل" writes exactly one
customer message and the inquiry becomes `AWAITING_BUYER`. A second customer on a second listing gets
its own grounded draft. The employee can escalate an open negotiation but cannot accept or counter;
the owner's canonical counter review plus "نعم" is the only thing that changes the negotiation, and a
replay has no second effect. The employee can draft a listing but cannot publish it ("النشر يحتاج
مراجعة المالك"), and a model failure produces an honest refusal with no listing and no success text.
Revocation marks the pending reply `REJECTED`/`GRANT_REVOKED`; a later "أرسل" is refused without a
model call and without a customer message, and a reload still shows the rejected draft.

### D6 — the buyer completes through canonical services

Discovery from Arabic words covers fashion, cars (Arabic make/model) and home, with refinement
keeping the category. Three actual offers are compared by stored id and stored price; selection
resolves an ordinal against the server result set and creates nothing; an invented ordinal is
refused. A two-line same-seller cart is reviewed and checked out through the canonical `/checkout`
path: one order, two line items, summed subtotal, `TEST_NO_TRANSFER`, commission 1000 bps, zero
payment intents, cart emptied. Replaying the checkout returns the same order and one idempotency
record. Reopening the conversation rebuilds the cart, checkout and pending review from server rows.
A seller price change refuses the old confirmation (`تغير السعر`), supersedes it, and the fresh
review orders once at the fresh price. Opening a detail and going back restores the same stored
result set without a new search; a reload keeps the stored card.

## 6. GREEN evidence on the tested head

All rows are `qoder-api-suite.yml` on `qoder/wave02-d4-d6-closure` at
`f7e9045e07b28408f69e688c6a0c8908d7b5f24c`. Each run also executed typecheck, both builds and the
web surface protocol tests (32/32).

| Run | Suite / chain | Result | Closing line |
| --- | --- | --- | --- |
| `41548159965` | `wave02-d4-d5-seller-journey.test` | 5/5 | `LOCAL_SUITE suite=wave02-d4-d5-seller-journey.test db=dinar_test_local_a94cd2037556 exit=0 outbound=0` |
| `41548166120` | `wave02-d6-buyer-journey.test` | 6/6 | `LOCAL_SUITE suite=wave02-d6-buyer-journey.test db=dinar_test_local_7dd4ab957b80 exit=0 outbound=0` |
| `41548537282` | `wave02-d6-browser-journey.test` | 1/1, 10 checks | `LOCAL_SUITE suite=wave02-d6-browser-journey.test db=dinar_test_local_a3089748c3c2 exit=0 outbound=0` |
| `41546897609` | `wave02-d5-browser-journey.test` | 3/3, 14 checks | `LOCAL_SUITE suite=wave02-d5-browser-journey.test db=dinar_test_local_3d759846b498 exit=0 outbound=0` |
| `41546904430` | `wave02-card-reliability.test` | 9/9 | `LOCAL_SUITE suite=wave02-card-reliability.test db=dinar_test_local_481af27d432b exit=0 outbound=0` |
| `41549229217` | chain `d4-d5-authorization` | 4/4, 3/3, 8/8 | `LOCAL_SUITE_CHAIN suites=3 db=dinar_test_local_db6d89f8b090 exit=0 first_failed=none` |
| `41549314061` | chain `d6-g2-negotiation` | 8 suites | `LOCAL_SUITE_CHAIN suites=8 db=dinar_test_local_6c52dfa8bb5a exit=0 first_failed=none` |
| `41549320279` | `security-acceptance.test` | 12/12 | `LOCAL_SUITE suite=security-acceptance.test db=dinar_test_local_f597122cf381 exit=0 outbound=0` |
| `41549326754` | `commerce-journey.test` | 8/8 | `LOCAL_SUITE suite=commerce-journey.test db=dinar_test_local_28a3eb28052d exit=0 outbound=0` |

Browser signals:

- D6 review run: `checks` contains search, RTL/overflow at 320/390/1280, the three recorded prices,
  the priced review, reload with no order, one canonical checkout, reload with no second
  confirmation; `pageErrors=[]`, `consoleErrors=[]`, `externalRequests=[]`,
  `horizontalOverflow=0`, `modelFallbacks=[]`.
- D5 review phase: pending status and 35-piece draft, reload keeps it, one approval sends once,
  reload shows the settled thread; clean arrays. D5 revoked phase: the rebuilt card reads
  "لم تُرسل؛ لم يتغير شيء" with zero send buttons, survives reload, nothing sent; clean arrays.
- Neither browser journey changed the model gateway call count.

## 7. RED evidence and classification

| Run | Head | What failed | Classification | Resolution |
| --- | --- | --- | --- | --- |
| `41540174779` | `6d58451` | D6 two-line same-seller checkout: `new row for relation "orders" violates check constraint "order_money_valid"` | **Genuine product defect** | Migration `0051` relaxes only the order-level equality; per-line invariants kept |
| `41540162125` | `6d58451` | Seller suite inserted an already-expired delegation and hit `business_delegations_expiry_valid` | Test-authoring error | The test now updates a stored live grant's dates instead of inserting an invalid row; the expiry path is still proven |
| `41543419428` | `29b1d99` | D6 "back to results" expected a previous search set, while canonical `BACK_TO_RESULTS` restores the latest stored set | Test expectation error | Test rewritten to the canonical detail→back and reload rehydration path; product untouched |
| `41543426446` | `29b1d99` | Seller replay expected a different refusal phrase | Test expectation error | Assertion aligned to `inquiry-turn.ts:426`; the no-success-receipt and no-second-send assertions were kept |
| `41545189196` | `5c6501a` | D5 browser had no send button because a newer surface message became the active workflow | Test orchestration error | Second inquiry creation moved into the revocation phase, so the reviewed draft stays the newest surface |
| `41545956905` | `5ce0d32` | D5 browser expected `REJECTED`/`أُرسلت` text that the real page renders differently | Test expectation error | UI assertion reads the canonical rebuilt card and settled thread text |
| `41546036846` | `5ce0d32` | Card-reliability suite refused to start without `BDINAR_W02U3_TEST_DATABASE` + `BDINAR_WAVE02_ACCEPTANCE` | Missing flag | Re-run `41546904430` green |
| `41545999533`, `41546911097`, `41547309738` | canonical `ae8399b` and `f7e9045` | `ai-foundation` fails AI-F04/F05/F07/F11/F12 identically on the canonical baseline and on this head | **Pre-existing canonical red** | Reported as a blocker; not caused by this mission and not counted as green |

The three flag-rejected dispatches during the final regression pass (`41548933931`, `41548940518`,
`41548947595`, `41548953378`) are also classified as missing-flag orchestration, not product
failures; their corrected runs are the green rows in §6.

## 8. Verdict, limitations and integration instructions

**Verdict.** The fifteen scenarios, the D4 delegation requirements and the D5/D6 completion
requirements are covered by executable evidence on `f7e9045`, using DINAR's existing authorities.
The only product change required was the order-level money invariant correction for the canonical
multi-line order shape. Nothing was merged, deployed or released.

**What is not proven / not done.**

1. **Live Arabic model quality** — the suites use scripted model output to prove the authorization
   boundary. This is not a live-provider benchmark. Live-model comprehension remains a separate gate.
2. **`ai-foundation` chain** — red on the canonical baseline (five tests) and unchanged by this
   branch. It must be addressed by its owners before those five capabilities can be called verified.
3. **No merge or deployment** — by design. The branch is for review and Replit integration.
4. **No production data or real payments** — checkout used `TEST_NO_TRANSFER`; zero payment intents.
5. **Screen-reader spoken output** — not part of this mission; no visual/AT claim is made for the new
   surfaces beyond the responsive and DOM assertions in the browser runs.

**Replit integration steps (owner/reviewer).**

1. Review this branch and the acceptance matrix; do not merge into `main`.
2. Apply migration `0051_order_multi_item_money.sql` through the existing release mechanism
   (`lib/db/drizzle/meta/_journal.json` idx 51 and `release-manifest.json` sha256
   `e99dce44bbb6cc81d0686c8193859e102b3a22076c4812af28ebdfde04adad24`). The release manifest already
   contains the matching hash.
3. Run the four new suites plus the regressions with the same flags:
   - `wave02-d4-d5-seller-journey.test` with `BDINAR_WAVE02_ACCEPTANCE=development`
   - `wave02-d6-buyer-journey.test` with `BDINAR_WAVE02_ACCEPTANCE=development`
   - `wave02-d5-browser-journey.test` with `BDINAR_WAVE02_ACCEPTANCE=development`
   - `wave02-d6-browser-journey.test` with `BDINAR_WAVE02_ACCEPTANCE=development`
   - chain `d4-d5-authorization` with `BDINAR_D4_ACCEPTANCE=development BDINAR_D5_ACCEPTANCE=development BDINAR_A02_ISOLATION=development`
   - chain `d6-g2-negotiation` with `BDINAR_G2_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development BDINAR_TEST_DATABASE=development BDINAR_BLOCKF_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true`
   - `security-acceptance.test` with `BDINAR_SECURITY_ACCEPTANCE=development`
   - `commerce-journey.test` with `BDINAR_TEST_DATABASE=development BDINAR_WAVE4_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true`
4. Treat `ai-foundation` as a known pre-existing red until its five tests are fixed; do not attribute
   it to this branch.
5. Do not deploy on the strength of these runs alone; release gates remain the owner's.

## 9. Commits and push

Mission commits (`ae8399b` → `f7e9045`):

```
f7e9045 test(w02): read the settled inquiry thread status after the send
5ce0d32 test(w02): keep the reviewed draft newest and assert the rejected status text
5c6501a test(w02): assert canonical restore and no-op replay messages
29b1d99 test(w02): prove D4/D5 seller and D6 buyer journeys, relax multi-item order money
6d58451 test(w02): use a registration number range the server accepts
1f97985 test(w02): prove D4/D5 seller and D6 buyer journeys end to end
ae8399b (canonical baseline)
```

The branch is pushed to `origin/qoder/wave02-d4-d6-closure`. The documentation commit that adds this
report, the acceptance matrix and the handoff changes no code and is not part of the tested
`f7e9045` product/test state.
