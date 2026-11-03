# QODER WAVE 02 — D4 + D5 + D6 Acceptance Matrix

- Canonical baseline: `replit/dinar-next-complete-development` at `ae8399b4436c9905a63e9e92ec9b1e1368690d98`,
  synced during the mission to canonical `11d7fbe3326897924468ee4c6d5467972a92b973`
- Task branch: `qoder/wave02-d4-d6-closure`
- Worktree: `D:/DINAR/dinar-d4d6`
- **Tested head: `e1df415204ebb8f486206e7b8e5ec269b6d6a493`** (mission commits + canonical sync merge)
- Evidence mode: every build and test ran in GitHub Actions (`qoder-api-suite.yml`) against a
  disposable loopback PostgreSQL created by `test/isolation/local-suite.sh`; every run reports
  `outbound=0`. The Windows host was not used to build or test.

Status vocabulary: **VERIFIED** = asserted by an automated test that ran green on the tested head;
**PARTIAL** = implemented and proven at one layer only; **PRE-EXISTING RED** = fails on the canonical
baseline for reasons outside this mission's changes.

Evidence sources:

- `S` — `artifacts/api-server/test/wave02-d4-d5-seller-journey.test.ts`, run `41550226803`
  (5/5, real HTTP + disposable PostgreSQL; surface protocol tests 32/32).
- `B` — `artifacts/api-server/test/wave02-d6-buyer-journey.test.ts`, run `41550234059`
  (6/6, real HTTP + disposable PostgreSQL; surface protocol tests 32/32).
- `SB` — `wave02-d5-browser-journey.test` → `artifacts/dinar/test/wave02-d5-ui.mjs`,
  run `41550242626` (3/3; real Chromium; 14 checks total; `pageErrors=[]`, `consoleErrors=[]`,
  `externalRequests=[]`, `horizontalOverflow=0`, `modelFallbacks=[]`).
- `BB` — `wave02-d6-browser-journey.test` → `artifacts/dinar/test/wave02-d6-ui.mjs`,
  run `41550249631` (1/1; 10 checks; same clean arrays; `order.quantity=1`).
- `CR` — `wave02-card-reliability.test`, run `41550256971` (9/9) — the Waves 02 reliability
  regression stays green after migration `0051`.
- `R1` — chain `d4-d5-authorization` (`business-delegations.test` 4/4,
  `d5-seller-employee-acceptance.test` 3/3, `d4-d5-isolation-security.test` 8/8), run `41550283195`,
  `LOCAL_SUITE_CHAIN suites=3 exit=0 first_failed=none outbound=0`.
- `R2` — chain `d6-g2-negotiation` (`next-g2-inquiry.test`, `universal-negotiation-acceptance.test`,
  `g2-smart-conversation.test`, `model-native-routing.test`, `bounded-multistep.test`,
  `promotion-intent.test`, `block-f2-buyer.test`, `block-f3-commerce.test`), run `41550290381`,
  `LOCAL_SUITE_CHAIN suites=8 exit=0 first_failed=none outbound=0`.
- `R3` — `security-acceptance.test` 12/12, run `41550297039`,
  `LOCAL_SUITE … exit=0 outbound=0`.
- `R4` — `commerce-journey.test` 8/8, run `41550303484`,
  `LOCAL_SUITE … exit=0 outbound=0`.
- `AF` — chain `ai-foundation` (`ai-foundation-acceptance.test` 13/13, `ai-authority-boundary.test`
  4/4, `bounded-multistep.test` 3/3), run `41550309349`,
  `LOCAL_SUITE_CHAIN suites=3 exit=0 first_failed=none outbound=0`.

Implementation anchors (source of truth, not restated logic):

| Concern | Source |
| --- | --- |
| Capability vocabulary and publication gate | `artifacts/api-server/src/lib/business-capabilities.ts:6`, `:40` |
| Delegation create | `artifacts/api-server/src/lib/business-delegations.ts:297` |
| Delegation activate / suspend / resume / revoke | `business-delegations.ts:557`, `:561`, `:565`, `:569` |
| Session creation (conversation, business, owner, grant, market binding) | `business-delegations.ts:1254`–`:1266` |
| Session resolution for every employee turn | `business-delegations.ts:1285` |
| Execution-time authorization (session, grant, market, capability, listing scope) | `business-delegations.ts:1053`–`:1182` |
| Capability guard used by AI actions | `business-delegations.ts:1326`, `:1337` |
| Grant expiry settled by the server clock | `business-delegations.ts:1084`, `:1135`–`:1140`, `:613`–`:630` |
| Session invalidation on revoke/suspend/expiry | `business-delegations.ts:1515`, `:1540`, `:990`, `:1025` |
| Order reads scoped to business + listing allowlist | `business-delegations.ts:1371` |
| Negotiation escalation (read-only, no accept/counter) | `business-delegations.ts:1441`, `:1503` |
| Catalog/stock read for the employee | `business-delegations.ts:641`; `src/ai/conversation-runtime.ts:598` |
| Confirm-time revalidation of delegated authority | `src/ai/action-foundation.ts:1235`, `:1342` |
| Inquiry send-time revalidation + scope binding | `src/lib/inquiries.ts:256`; `src/ai/inquiry-turn.ts:418` |
| Owner-reviewed draft send in the web UI | `artifacts/dinar/src/features/ai/InquirySurface.tsx:26`, `:46`, `:49` |
| Buyer comparison / selection grounded in stored result sets | `src/ai/buyer-turn.ts:102`, `:104`, `:685`; `src/ai/marketplace-intent.ts:173` |
| Canonical checkout authority | `src/routes/marketplace.ts:654`, `:688`, `:778`, `:850`, `:931` |

## A. The fifteen required scenarios

| # | Scenario | Status | Evidence | Remaining gap |
| --- | --- | --- | --- | --- |
| 1 | Seller receives multiple inquiries | VERIFIED | S test at `:327` opens two buyer inquiries on two assigned listings and finds the DINAR inquiry inbox; SB restores that inbox in Chromium | — |
| 2 | Employee drafts accurate responses | VERIFIED | S `:364`–`:371`, `:398`–`:406`: the model receives only the screened question and that listing's recorded stock (35 then 17), and the other customer's question never enters the context | — |
| 3 | Owner approves a reply | VERIFIED | S `:379`–`:385`: drafting writes zero seller messages, one "أرسل" writes exactly one, the buyer reads it in DINAR, inquiry becomes `AWAITING_BUYER`; SB approves once from the page and the customer thread has one message | — |
| 4 | Customer requests a discount | VERIFIED | S `:447`–`:455`: a real `BUYER_PRICE_OFFER` negotiation is `OPEN` at 2.5 JOD | — |
| 5 | Employee escalates | VERIFIED | S `:458`–`:466`: `ESCALATE_NEGOTIATION` lists the open offer, leaves status `OPEN` and `counterAmountMinor` null, and writes `D5_NEGOTIATION_ESCALATED`; a model proposal to accept is refused at `:469`–`:474` | — |
| 6 | Seller confirms the authorized change | VERIFIED | S `:479`–`:507`: owner counter review is a stored `PENDING` `COUNTER_NEGOTIATION`; "نعم" produces `COUNTERED` at 3 JOD with zero additional model calls; replay leaves one effect | — |
| 7 | Buyer searches several categories | VERIFIED | B `:180`–`:214`: fashion, cars (Arabic make/model «تويوتا»/«كورولا») and home are each discovered from the buyer's words; «أرخص واحد» narrows the same category | — |
| 8 | Buyer compares three actual offers | VERIFIED | B `:246`–`:255`: comparison lists the three stored ids in order and its price row equals the stored `unitPriceMinor` values; BB shows `21.000/19.000/17.000 JOD` from DINAR rows | — |
| 9 | Buyer selects one product | VERIFIED | B `:257`–`:271`: "أبي الأول" resolves against the stored set into `PURCHASE_REVIEW` at the listing price, creates no order; an invented ordinal is refused | — |
| 10 | Buyer reviews and confirms the cart | VERIFIED | B `:274`–`:298`: two real same-seller lines enter the cart, `CART` then `CHECKOUT` are rebuilt from server rows after a reload | — |
| 11 | Checkout uses actual server authority | VERIFIED | B `:300`–`:338`: `POST /checkout` returns one order for the same seller, `TEST_NO_TRANSFER`, commission 1000 bps, summed subtotal, two order items, zero payment intents, cart emptied; replay returns the same order | — |
| 12 | Reload preserves relevant state | VERIFIED | B `:237`–`:244` result set, `:292`–`:298` cart/checkout, `:357`–`:376` open order review; BB reload keeps the same pending review id and orders nothing; SB reload keeps the pending reply and later the rejected card; S `:612`–`:619` rebuilds the rejected draft after revocation | — |
| 13 | Revocation blocks subsequent employee actions | VERIFIED | S `:593`–`:609`: revoke marks the pending action `REJECTED` / `GRANT_REVOKED`, "أرسل" is refused with the invalid-session message, zero model calls, zero sent messages; SB after revocation shows a rejected card with no action; R1 covers revoke/suspend/resume invariants | — |
| 14 | Failed operations produce no success receipt | VERIFIED | S `:545`–`:553`: a failed draft turn is an honest refusal with no listing and no success claim; S `:604`–`:609` refused approval sends nothing; S `:469`–`:474` refused acceptance changes nothing; B `:382`–`:389` stale-price confirmation produces no order and no success text | — |
| 15 | Replayed confirmations do not duplicate effects | VERIFIED | S `:422`–`:427` replayed send adds no message and claims no success; S `:504`–`:507` replayed "نعم" keeps `COUNTERED`; B `:328`–`:338` replayed checkout returns one order and one idempotency record; B `:398`–`:400` replayed confirmation keeps one order; BB reload offers no second confirmation | — |

## B. D4 — delegation, identity, scope, revocation and audit

| Requirement | Status | Evidence |
| --- | --- | --- |
| Employee creation / invitation | VERIFIED | `createBusinessDelegation` (`business-delegations.ts:297`); R1 `business-delegations.test`; S `:246`–`:272` rejects a human employee, duplicate capabilities and unknown fields with 400 and writes no delegation/audit |
| Owner authorization | VERIFIED | Activation requires `confirm` + `expectedVersion` (`:557`); S `:275`–`:291`; SB/R1 approve through the same endpoint |
| Role / capability scope | VERIFIED | `business-capabilities.ts:6`; S grants an explicit subset (`ALL_CAPABILITIES`) and the guards at `business-delegations.ts:1141`, `:1156` enforce capability and listing scope at every execution |
| Business and market isolation | VERIFIED | `authorizeEmployeeSessionTx` binds session market (`:1086`), conversation and owner market (`:1105`), and the grant's business/market (`:1108`–`:1120`); S `:276`–`:278` stranger gets 404; R1 `d4-d5-isolation-security.test` |
| Session identity | VERIFIED | `business-delegations.ts:1254`–`:1266` stores conversation, business, owner, grant and market; `resolveSellerEmployeeSession` (`:1285`) is the only entry point; S `:299`, `:316` |
| Permission revocation | VERIFIED | `revokeBusinessDelegation` (`:569`) invalidates sessions (`:1515`, `:1540`); S `:317`–`:323`; S `:593`–`:609` pending action rejected; R1 |
| Expired delegation | VERIFIED | Stored-date activation refusal (`:557` + server clock) and `expireGrantIfNeeded` (`:1135`); S `:280`–`:309` proves `DRAFT` stays unchanged on refusal, a live grant becomes `EXPIRED`, the session resolves `INVALIDATED/GRANT_EXPIRED`, and `DELEGATION_EXPIRED` is audited |
| Cross-account access | VERIFIED | S `:276`–`:278` (read/activate/revoke all 404); `authorizeEmployeeSessionTx:1074`, `:1101`; R1 isolation suite |
| Administrative intervention | VERIFIED | Suspend/resume (`:561`, `:565`) with session invalidation; R1 `business-delegations.test` and `d4-d5-isolation-security.test` |
| Complete audit history | VERIFIED | `recordDelegationAudit` verbs `DELEGATION_CREATED/REVOKED/EXPIRED`, `D5_EMPLOYEE_SESSION_STARTED/INVALIDATED`, `D5_EMPLOYEE_CAPABILITY_AUTHORIZED`, `D5_NEGOTIATION_ESCALATED`, `D5_PENDING_ACTION_INVALIDATED`; S `:272`, `:309`, `:320`–`:323`, `:420`, `:466`, `:601` |
| All permissions revalidated at execution time | VERIFIED | Every path re-checks the live grant: `action-foundation.ts:1235`/`:1342` (review and confirm), `inquiries.ts:256` (send), `conversation-runtime.ts:598` (each employee action); S `:593`–`:606` proves revocation at confirm time |

## C. D5 — seller-employee work within canonical authority

| Requirement | Status | Evidence |
| --- | --- | --- |
| Authorized catalog and stock reads | VERIFIED | `business-delegations.ts:641` + `conversation-runtime.ts:598`; S `:363`–`:371` supplies only the assigned listing's stock as a server fact |
| Inquiry handling | VERIFIED | `inquiry-turn.ts:418` drafts from the screened question; S `:327`; SB inbox restore |
| Accurate drafting | VERIFIED | S `:398`–`:406` proves the second draft uses 17 (its own listing) and excludes the other buyer's private question; S `:426` proves a replay is a refusal |
| Listing creation / corrections | VERIFIED | Employee drafts only (`DRAFT_LISTING`); S `:525`–`:536` creates no listing and no `PUBLISH_LISTING` pending action; R1 `d5-seller-employee-acceptance.test` covers the canonical draft/publish gates |
| Marketing proposals | VERIFIED | Canonical promotion intent preserved (`promotion-intent.test` in R2); no new marketing executor was added by this mission |
| Negotiation escalation | VERIFIED | `business-delegations.ts:1441` is read-only; S `:458`–`:466` leaves the offer untouched |
| Discount approval | VERIFIED | The employee cannot accept or counter (`:469`–`:474`); only the owner's canonical confirmation (`:498`–`:502`) changes the negotiation |
| Publication review | VERIFIED | S `:538`–`:543` refuses "انشر المسودة" with "النشر يحتاج مراجعة المالك" and creates no listing |
| Order status / customer communication | VERIFIED | `readSellerEmployeeOrders` (`:1371`) scopes to business + market + listing allowlist; the approved reply is written by `inquiries.ts:256` through the canonical thread |
| Reload and process-restart recovery | VERIFIED | SB reload (pending and rejected draft); S `:612` API rehydration; B `:292`, `:357`; BB reload; every browser run uses a fresh process against persisted PostgreSQL |
| Multiple simultaneous inquiries | VERIFIED | S `:327` two buyers/two listings, each draft grounded in its own listing, one approved reply each |
| Model proposes but never executes | VERIFIED | Scripted gateway only proposes `sellerEmployeeAction`; S `:458`–`:474`, `:538`–`:543`, `:545`–`:553`; SB/BB assert `modelFallbacks=[]` and deterministic turns never call the model |
| All permissions revalidated at execution | VERIFIED | Same guards as D4; S `:593`–`:606` proves a revoked session cannot send a pending reply |

## D. D6 — buyer completion through canonical services

| Requirement | Status | Evidence |
| --- | --- | --- |
| Arabic / dialect comprehension | VERIFIED | B `:183`, `:190`, `:196`, `:206`, `:247`, `:258`; canonical intent suites in R2 (`next-g2-inquiry`, `g2-smart-conversation`) |
| Discovery and multi-turn filtering | VERIFIED | B `:180`–`:214`; refinement keeps category and narrows by price |
| Comparison grounded in actual listings | VERIFIED | B `:246`–`:255`; BB 3 real offers |
| Historical result references | VERIFIED | B `:224`–`:244`: opening a detail keeps the stored set id; "رجعني" restores the same ids in order without a new result set; reload keeps the stored card. This is the canonical `BACK_TO_RESULTS` behavior (`marketplace-intent.ts:173`) |
| Inquiry drafts and sends through approved actions | VERIFIED | S `:327`, `:379`; SB owner approval |
| Negotiation | VERIFIED | S `:431`; R2 universal negotiation |
| Cart review | VERIFIED | B `:274`–`:298` |
| Checkout confirmation | VERIFIED | B `:300`–`:338`; BB `purchase-continue` → `purchase-confirm` |
| Order tracking | VERIFIED | R2 `block-f3-commerce.test`; B summary reads the created order back |
| Stale inventory / price detection | VERIFIED | B `:378`–`:403`: a price change refuses the old confirmation (`تغير السعر`), supersedes it, requires a fresh review, and orders at the fresh price once |
| Error / retry | VERIFIED | B `:266`–`:271` invented ordinals refused; replay paths safe (`:328`, `:398`); S `:545` honest failure |
| Safe task continuity | VERIFIED | B reload restores result set, cart, checkout and pending review; BB reload restores the same pending review and creates nothing |

## Server-authority invariants re-checked by this mission

- One approved reply → one customer message; a replayed "أرسل" sends nothing and claims nothing
  (S `:379`–`:427`).
- One pending owner counter → one negotiation effect; a replayed "نعم" leaves `COUNTERED`
  (S `:498`–`:507`).
- The employee session is bound to actor, conversation, business, grant, market and expiry; every
  turn re-authorizes against the live grant (S `:238`; `business-delegations.ts:1053`–`:1182`).
- Expiry is decided by the server clock and persisted (`EXPIRED`, `expiredAt`), never by a client
  claim (S `:280`–`:309`).
- Revocation invalidates running sessions and pending employee actions before any capability is
  returned (S `:593`–`:609`).
- Cross-account delegation endpoints are 404, not silently scoped (S `:274`–`:278`).
- Checkout is the canonical transaction with request hashing and idempotency (`marketplace.ts:654`,
  `:931`); a repeated request returns the same order and no second payment intent (B `:328`–`:338`).
- A stale listing price cannot be ordered; the review is superseded and re-priced (B `:378`–`:403`).
- The model gateway is never called on deterministic employee/buyer paths; browser wrappers assert
  the call count is unchanged (`SB`, `BB`).
- One order may contain multiple line items from the same seller; per-line money invariants remain
  in force (migration `0051`, verified by B `:300`–`:323`).

## Honest coverage notes

- `ai-foundation` was red at the start of this mission: run `41546911097` on canonical `ae8399b`
  and run `41547309738` at mission head `f7e9045` both failed the same five tests — AI-F04
  foreign-data leak regex, AI-F05 expired result set, AI-F07 call limit, AI-F11 oversized results,
  AI-F12 replay signature (13 tests, 8 pass, 5 fail). The canonical branch then advanced to
  `11d7fbe` with AI-foundation fixes (`4124607`, `c36e6f1`, `2a67135`) and evidence of its own. The
  mission branch merged that canonical head; on the merged tested head `e1df415`, run `41550309349`
  is green: `ai-foundation-acceptance.test` 13/13, `ai-authority-boundary.test` 4/4,
  `bounded-multistep.test` 3/3, `LOCAL_SUITE_CHAIN suites=3 exit=0 first_failed=none outbound=0`.
  The earlier red is recorded as history, not as a current blocker.
- `commerce-journey`, `security-acceptance`, `d4-d5-authorization` and `d6-g2-negotiation` were first
  re-dispatched without their required development flags and were rejected by the workflow's input
  gate (`exit 96`) or the suite's own guard. They were re-dispatched with the documented allowlisted
  flags; those are the runs cited above. A flag rejection is not a product failure and is not
  counted as evidence.
- The browser runs use real Chromium against the built web app and the real API on loopback; no
  external host is contacted (`externalRequests=[]`). Fonts are stubbed locally by the runner.
- The D6 browser journey asserts the price row as rendered (`21.000/19.000/17.000 JOD`); the API
  suite separately asserts the comparison row equals the stored integer prices.
- No live AI provider was used. Scripted model output proves the authorization boundary, not live
  Arabic model quality; live model quality remains a separate benchmark gate.
