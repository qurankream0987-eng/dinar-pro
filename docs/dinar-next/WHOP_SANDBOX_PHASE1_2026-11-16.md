# Whop Phase 1: Sandbox subscriptions, test results and production readiness (2026-11-16)

**Scope:** JassimAI subscriptions only, in the **Whop Sandbox** (`sandbox-api.whop.com`). No real money moved. No
production key was used. Nothing was deployed, and Staging and Production were not touched.

**Owner-approved prices (2026-11-16):**

| Plan | Monthly (30 days) | Annual (365 days) |
|---|---|---|
| Go | $10 | $100 |
| Pro | $20 | $200 |
| Business | $49 | $490 |

Annual equals monthly × 10, which is two months free. Live billing is **not** approved.

## 1. Sandbox objects (account `biz_WYP6ZouGguI3gp`, title JassimAI, country JO)

| Plan | Whop plan | Billing period | Price |
|---|---|---|---|
| Go monthly | `plan_372Vm4jlUeds8` | 30 | $10 |
| Go annual | `plan_hgLyUQiTBHiHc` | 365 | $100 |
| Pro monthly | `plan_JvfEmbnJ4S1zn` | 30 | $20 |
| Pro annual | `plan_QMTtfprmzY3hh` | 365 | $200 |
| Business monthly | `plan_VY9LlhT7cipQK` | 30 | $49 |
| Business annual | `plan_pjRsrESWH0Vfh` | 365 | $490 |

All plans are hidden, in USD, and have `initial_price: 0`.

Ads, created for later phases:
- product `prod_FItzdy4a5wFu5`
- `plan_9QTFRKhQxcZOE`: $5 for 7 days
- `plan_8SuUud2vYRL4D`: $5 for 10 days
- `plan_QZ2BTLz8fwSLN`: $2 for 7 days, sponsored search

Test seller subaccount: `biz_3T48lHdFwdy9wk`, with `external_id` `jassim-test-seller-001`.

Plan map for the server:

```
DINAR_WHOP_PLAN_MAP={"DINAR_GO:30":"plan_372Vm4jlUeds8","DINAR_GO:365":"plan_hgLyUQiTBHiHc","DINAR_PRO:30":"plan_JvfEmbnJ4S1zn","DINAR_PRO:365":"plan_QMTtfprmzY3hh","DINAR_BUSINESS:30":"plan_VY9LlhT7cipQK","DINAR_BUSINESS:365":"plan_pjRsrESWH0Vfh"}
```

## 2. Defects that the Sandbox exposed, all fixed

| # | Found in Sandbox | Impact if shipped | Fix |
|---|---|---|---|
| 1 | A renewal plan's `initial_price` is an **extra** fee charged on top of the first period. The checkout showed $20 due today for Go monthly. | Every first payment double-charged. | All plans use `initial_price: 0`; the price is in `renewal_price`. This is documented in the plan-map comment. |
| 2 | API pin `2026-08-14` returns plain numbers and nested objects, but the adapter expected `Money` objects. | Every payment would be rejected (`AMOUNT_MISMATCH`). | The pin is now `2026-10-24`, verified against a real payment. |
| 3 | Whop adds US sales tax on top: $10.00 becomes a $10.83 `total`. | Every taxed payment would be rejected. | The pre-tax `subtotal` is compared with the stored price. Tax belongs to Whop as Merchant of Record. |
| 4 | The approved prices are in USD, but the catalog forced the market currency (KWD/JOD). | Currency mismatch on every payment. | Subscription plans (`DINAR_BUSINESS` with a plan code) may be priced in USD in any market. USD formats with 2 decimals. A USD plan is never charged to the simulated KWD/JOD wallet (`PLAN_NOT_WALLET_PAYABLE`). |
| 5 | Monthly and annual plans could not coexist: there was a unique index per (market, plan). | The annual plan could not be enabled. | Migration **0067** makes the index unique per (market, plan, period). It adds no rows. |
| 6 | A declined first card leaves Whop's payment `open`, so the buyer can retry on the same page. The old code made the subscription `PAYMENT_FAILED`, which is final. | The buyer pays on the retry and gets no access. | A failed **first** attempt keeps the subscription `PENDING`. Only a failed **renewal** makes it `PAST_DUE`. A new checkout for the same plan reuses the pending subscription and never creates a second one. |
| 7 | After a **full refund**, Whop kept the membership `active` and renewing until 2027-11-16. | The refunded buyer is charged again next year with no access. | On a full refund the server first cancels the Whop membership immediately (with an idempotency key). If Whop cannot be reached, nothing is recorded and Whop's retry repeats the cancel. Verified live: the membership became `canceled`. |
| 8 | `membership.deactivated` and `resolution_center_case.*` were not handled. | A deactivation was ignored and disputes were not recorded. | Deactivation ends access, but only when Whop confirms the membership has ended. Disputes are recorded for review and change no entitlement. |
| 9 | The refund amount was taken from the webhook body. | A forged partial refund could be read as a full refund. | The refunded amount is read back from Whop's payment. A partial refund is recorded for review and changes nothing. |

## 3. Test results

### 3.1 Live Whop Sandbox end-to-end: `test/whop-sandbox-e2e.mjs`, 10/10 PASS

The test runs the real JassimAI API server locally against a disposable loopback database, with Whop billing enabled
in Sandbox mode. Each checkout is created by our API, then paid in headless Chromium with Whop's documented test
cards. The server decides **only** from objects it reads back from the Whop Sandbox API.

| Test | Result | Evidence |
|---|---|---|
| Setup: USD plans for Go and Pro, monthly and annual, in the KW catalog | PASS | $10 / $100 / $20 / $200 |
| Go monthly, card 4242 | PASS | `pay_rLnKGBwJwl655F`: subtotal 10.00, tax 0.83, total 10.83, 30-day period from Whop |
| Go annual, card 4242 | PASS | `pay_0u3PnFqnDVAbUo`: subtotal 100.00, tax 8.25, total 108.25, 365-day period |
| Pro monthly, card 4242 | PASS | `pay_kI43ZndzH1DdmT`: subtotal 20.00, tax 1.65, total 21.65 |
| Entitlements | PASS | Go grants `DINAR_GO` and Pro grants `DINAR_PRO`. The browser returning from checkout granted nothing. A repeated announcement was `IGNORED` (`NOT_PENDING`). |
| Card 4000…0002 declined, then retry with 4242 | PASS | `pay_z4iqCSi7aFFL19` stayed `open`, so the subscription stayed PENDING. The retry `pay_J2ovQEO3xCMyFg` made the **same** subscription ACTIVE. |
| Cancel at period end | PASS | Whop reported `cancel_at_period_end: true`, so the subscription is `CANCEL_AT_PERIOD_END` and access continues to 2026-12-16. A forged "canceled" body was not believed. |
| Full refund of the annual plan | PASS | $108.25 refunded, subscription `CANCELLED`, entitlement removed, **Whop membership `canceled`** (no renewal). |
| Immediate cancellation and `membership.deactivated` | PASS | Whop reported `canceled`, so the subscription is `EXPIRED`. |
| Forgery | PASS | An unknown `pay_` id gets 503 and nothing is recorded. A bad signature gets 401. |

### 3.2 Contract suite: `whop-billing.test`, 15/15 PASS, outbound 0

The contract suite covers:
- official SDK parity: `@whop/sdk/helpers` `unwrapWebhook` accepts our signatures and rejects a changed body;
- duplicate and concurrent deliveries;
- pending, renewal and **failed renewal**, which becomes `PAST_DUE` with no access, then recovers to `ACTIVE`;
- cancellation and expiry;
- an abandoned checkout, which is resumed;
- refunds: partial, pending, full, and full **with Whop down** (503, then the retry also cancels the membership);
- disputes and resolution-center cases;
- wrong secret, tampered body, stale timestamp and another account;
- amount, currency and owner mismatches;
- network interruption and out-of-order events;
- annual plan mapping;
- a USD plan in a KWD market.

### 3.3 Regressions on fresh databases, all outbound 0

| Suite | Result |
|---|---|
| `d1-d2-business-foundation` | 25/25 |
| `advertising-acceptance` | 5/5 |
| `readiness` | 15/15 |
| `development-tls` | 7/7 |
| `lib/db test:release-migration` on PostgreSQL 18 | 12/12 |
| `pnpm run typecheck` | clean |

## 4. Observed Sandbox fees (unconfirmed for production; confirm with Whop)

On a $10.00 plan, the buyer paid $10.83 and JassimAI received **$8.82**. The fees beyond tax were $1.18, about 11.8%
of the price:

| Fee | Amount |
|---|---|
| Sales tax (remitted by Whop) | $0.83 |
| Card processing, percentage | $0.29 |
| Card processing, fixed | $0.30 |
| Whop tax service | $0.22 |
| Cross-border | $0.16 |
| Orchestration | $0.09 |
| Radar | $0.07 |
| Billing | $0.05 |

On $100 annual, JassimAI received $91.51 of $108.25. This is Sandbox data; production rates for a Jordanian account
must be confirmed with Whop.

## 5. Not tested, and why

- **Real webhook delivery from Whop to our server.** Whop cannot reach a loopback server, so events were signed
  locally. The signature scheme matches the official SDK, and every decision is taken from the Whop API. Testing it
  needs a public HTTPS endpoint, which means a deployment (separate approval).
- **A renewal that actually happens.** It cannot be fast-forwarded in Sandbox. Renewal, failed renewal and recovery
  are covered by the contract suite only.
- **Business plan live.** It requires a verified business in JassimAI. It is covered by `d1-d2-business-foundation`.
- **Cancellation from inside JassimAI.** There is still no button; the subscriber cancels from Whop's manage page,
  and `membership.updated` arrives.
- Marketplace, ads, invoices and payouts belong to later phases.

## 6. Before production (each step needs owner approval)

1. **Whop account:** enable Require 2FA. Create the production products and plans (`initial_price: 0`) and the
   production API key and webhook secret. These must be set by the owner as sealed variables.
2. **Deployment:** a production environment separate from Staging. Currently `jassimai.com` serves Staging.
3. **Webhook endpoint:** a public `POST /api/billing/whop/webhook` (raw body, 128 KB limit) registered in Whop for the
   payment, membership, refund, dispute and resolution-center events. Then one end-to-end Sandbox run through it.
4. **Decisions needed from the owner:**
   - shown prices: "plus tax" or tax-inclusive (currently Whop adds US tax on top);
   - refund policy: currently a full refund ends access immediately and a partial refund goes to review;
   - an in-app cancel button.
5. **Questions for Whop:**
   - production fee schedule for a Jordanian account;
   - cross-border fee;
   - settlement currency.
