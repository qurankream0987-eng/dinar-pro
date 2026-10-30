# DINAR — Guardrails (binding for every agent)

These are the rules the reviewer (Claude) checks first. A change that breaks one is reverted,
whatever else it achieves. They extend `CLAUDE.md`; when in doubt, `CLAUDE.md` wins.

## A. Money and authority (never weaken)

1. Prices, totals, fees, currency come from persisted server state. Client amounts are ignored.
2. An order's price/fee snapshot is immutable. Commission is never recalculated after checkout.
3. A payment on a cancelled/lapsed order is never a sale: exactly one `payment_refund_obligations`
   row + intent `SIMULATION_BUYER_REFUND_DUE`. Only a provider-signed `REFUND_SUCCEEDED` resolves
   it. The table is append-only by trigger.
4. Payment events: signature-verified, deduplicated by provider event id, amount/currency matched.
5. Every order/listing/payment/negotiation action checks ownership server-side; strangers get 404.
6. **The model has no authority.** It sees three read-only tools (`getResource`, `openSurface`,
   `searchListings`). No tool or chat action may create orders, payments, approvals, captures,
   refunds, cancellations, settlements, commission, delivery confirmation, receipt confirmation
   or disputes. `test/ai-authority-boundary.test.ts` must pass **unchanged**.
7. Every state-changing chat action is a review + explicit user confirmation (`requiresConfirmation`).
   Delivery, receipt and disputes are **buttons on the order card** that call the existing REST
   routes — not chat actions.
8. No success text without a server receipt (published / agreed / paid / subscribed / delivered).
9. JSON bodies are bounded (128 KB, ≤2000 array elements) before any Zod schema runs.
10. Schema changes are new SQL migrations, registered as CLAUDE.md "Gotchas" requires. Never
    `drizzle-kit push`.

## B. Conversation quality (how to change understanding)

1. **General rules only.** No handling keyed on a product or brand («برادو», «بروستد», «ايفون»).
   A fix is a rule about Arabic or about the conversation.
2. **Every recall rule has a precision test.** Add phrases that must find *nothing*.
   Derived word forms must end a word (only inflectional endings ة/ه/ات/ي/ية may follow).
3. **Relaxation is announced.** If a word or category is relaxed, the reply says what
   (`broadenedFrom`, `widenedFromCategory`).
4. A bare «نعم» with nothing pending is ordinary conversation; never let it confirm something
   that is not the visible pending review.
5. Prefer the deterministic layer for commerce; leave general conversation to the model.
6. Measure with phrases you did not tune on. `test/arabic-generality.test.ts` floor (0.95) may
   only go up; add new phrases to the fixture rather than editing existing ones.

## C. Tests and evidence

1. Red first: write the failing test, run it, keep its output, then fix.
2. **Never weaken, delete or skip an assertion to make a test pass.** If wording legitimately
   changed, keep the substance and explain it in the commit (example: `command-a` A7c).
3. A browser claim needs a browser suite. "API passes" is `API_ONLY`, never `REAL_E2E`.
4. Detect model fallbacks by reply text, not only the call counter (no provider ⇒ no count).
5. Report every retry with its cause. Classify every failure: code / test / environment.
6. Do not edit `src` while a full battery runs; if you did, re-run the suites that ran before.

## D. Environment

1. Loopback PostgreSQL only; database names `dinar_(test|acceptance|wave<n>|migration)_*`.
2. No Railway, no production, no real payment accounts, no SMS, no paid AI, no live keys.
3. No new dependency without a written reason, license check and test. No copied remote code.
4. Do not change `CHAT_ONLY_MODE`; the product is chat-first by owner decision.

## E. Owner decisions (do not decide in code)

Leave undecided, and make the product say so honestly where users meet them:
P-SC03 non-price terms in counter-offers · P-SC04 food & product options · P-SC05 quotes &
appointments for services · P-SC06 inspection terms · P-SC08 digital deliverables & IP ·
P-SC09 cross-market sales & FX · P-01 admin refund of an active order · subscription prices,
quotas, renewal (`approved:false`) · return policy (no guessed 7/14 days) · launch market & scope ·
wholesale, partial returns, company accounts.

## F. Git

Base `claude/02-sc-acceptance`. One branch per command: `qoder/<NN>-<topic>`. Small commits with
reasons. No force-push, no rebase of others' commits, no merge to `main`, no tags, no releases.
