# Whop readiness for JassimAI (2026-11-13)

Owner decision: Whop is the intended future payment provider. This document records what Whop's
**current official documentation** says (docs.whop.com, read 2026-11-13; `@whop/sdk` 2.8.0
published 2026-11-12), what is implemented on `claude/jassimai-premium-product-evolution`, and what
remains blocked. **Whop has not reviewed or approved JassimAI.** Nothing here is legal or tax advice.

## 1. What the official documentation states

| Topic | Fact | Source |
|---|---|---|
| Environments | Sandbox API `https://sandbox-api.whop.com/api/v1` (keys at sandbox.whop.com, no real money); production `https://api.whop.com/api/v1`. They share no accounts or keys. | docs.whop.com/llms.txt |
| API auth | `Authorization: Bearer <API_KEY>` from the server only; pin `Api-Version-Date`. | llms.txt |
| Webhook format | Standard Webhooks; headers `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64>`); envelope `{id, type, api_version: "v1", api_version_date, timestamp, account_id, data}` (`company_id` on pins before 2026-08-14). | /developer/guides/webhooks |
| Signature | HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`; secret is a `ws_…` string passed as-is (the official SDK keys the HMAC with the literal UTF-8 bytes of the whole secret — confirmed in `@whop/sdk` `verifyWebhook.js`); reject timestamps more than 5 minutes off; constant-time compare. | webhooks guide + SDK source |
| Delivery | At least once; the same `webhook-id` on every retry; 12 retries over ~71 hours; answer within 5 s. | webhooks guide |
| Events used | `payment.succeeded`, `payment.failed`, `payment.pending`, `membership.activated`, `membership.updated` (deactivation, cancel toggles), `refund.created/updated` (listed under legacy), `dispute.created/updated`. | webhooks guide event table |
| Checkout | `POST /checkout_configurations` with `variant_id` (`plan_…`) and `metadata` (copied to payments and memberships); returns `purchase_url`; `Idempotency-Key` header supported. | SDK request/response types |
| Money | `Money { amount: "10.00" (major units, exact decimal string), currency (lowercase ISO), decimals }`. Currency enum includes `kwd`, `jod`, `sar`, `aed`, `usd`. | SDK `Money`, `Currencies` |
| Memberships | Statuses `trialing, active, past_due, completed, canceled, expired, unresolved, drafted, canceling`; cancel immediately or `cancel_at_period_end`; pause/resume/extend emit no status event. | /developer/guides/memberships |
| Refunds / disputes | Refund statuses `pending, requires_action, succeeded, failed, canceled`; dispute statuses incl. `needs_response, under_review, won, lost`. | SDK types, refunds-and-disputes guide |
| Merchant of record | "On Whop Payments, Whop is the Merchant of Record." Settlement currencies selectable: USD, EUR, GBP, CAD, AUD. | /manage-your-business/manage-payouts/payout-methods |
| Fees (standard) | 2.7% + $0.30 per successful domestic card transaction; +1.5% international cards; +1% when currency conversion is needed. | /payments-and-billing/fees/fees |
| Platforms | Subaccounts; **direct charges** with `application_fee_amount` (the subaccount bears Whop fees, refunds and disputes) or **transfers** from the platform account. | /developer/platforms/collect-payments-for-subaccounts |
| KYC | Required before payouts; verification API (`kind: individual` …); sanctioned countries fail with `address_country_sanctioned`. | /developer/verification/overview |
| Sanctioned / unsupported | Afghanistan, Belarus, Burundi, CAR, Comoros, Cuba, DRC, Eritrea, Haiti, Iran, **Iraq**, Lesotho, Libya, Myanmar, North Korea, **Palestine**, PNG, Russia, Somalia, South Sudan, Sudan, **Syria**, parts of Ukraine, Venezuela, **Yemen**. Jordan and Kuwait are **not** listed. | /trust-and-safety/.../sanctioned-countries |
| Physical goods | "Whop continues to improve support for selling physical products." | /supported-business-models/dtc-ecommerce |
| Tax | Managed tax options do not remove the seller's own obligations. | /payments-and-billing/fees/taxes |

Not stated in the pages read: a positive country list for **merchant onboarding or payouts in
Jordan or Kuwait**, KYB document requirements for a Jordanian/Kuwaiti company, local payout rails
(JOD/KWD bank payouts), or platform-specific (subaccount) pricing. These must be confirmed with Whop.

## 2. Two separate payment domains

| | A. JassimAI subscriptions (Go / Pro / Business) | B. Marketplace transactions |
|---|---|---|
| Who sells | JassimAI (platform) | Sellers |
| Whop model | One JassimAI Whop account; plans = `plan_…` ids | Subaccounts per seller + direct charges with `application_fee_amount`, or transfers |
| JassimAI code | `lib/billing/whop.ts` → `subscription-billing.ts` (business_subscriptions, billing_webhook_events) | `lib/payments/*` (orders, immutable price/fee snapshot, refund-due obligations) — **unchanged, still SIMULATION_ONLY** |
| Status | Adapter implemented, flag-gated off, mock-tested | Not started: needs seller KYC flow, subaccount mapping, Whop-as-MoR legal review, physical-goods support confirmation |

Subscription checkout is never used to settle marketplace orders.

## 3. Implemented (local branch, off by default)

- `artifacts/api-server/src/lib/billing/whop.ts`
  - Signature verification identical to the official SDK; 5-minute tolerance; multiple signatures.
  - Raw-body route `POST /api/billing/whop/webhook` (mounted before the JSON parser, 128 KB bound).
  - **Authority from Whop, not the body**: every payment/membership decision re-reads
    `GET /payments/{id}` / `GET /memberships/{id}`; `payment.succeeded` counts only when Whop reports
    `status: "paid"` now.
  - Applied through the existing lifecycle machine and ledger: idempotent by `webhook-id`
    (including concurrent deliveries), amount + currency must equal the subscription snapshot,
    the payer must be the subscription owner, the event must belong to the JassimAI Whop account.
  - Out-of-order reconciliation (a cancellation seen before activation is re-applied from Whop's
    membership state); a renewal after expiry never re-activates.
  - Whop unreachable → HTTP 503 and **no record**, so Whop's retry schedule re-delivers.
  - Disputes are recorded for owner review and change no entitlement.
  - Checkout: `POST /checkout_configurations` with `variant_id` from `DINAR_WHOP_PLAN_MAP` and
    metadata `{jassim_subscription_id, jassim_user_id}`; PENDING grants nothing.
- Activation requires all of: `DINAR_WHOP_BILLING_ENABLED=true`, `WHOP_API_KEY`, `WHOP_BILLING_WEBHOOK_SECRET`
  (`ws_…`, the subscription webhook's own secret), `WHOP_COMPANY_ID` (`biz_…`; `WHOP_ACCOUNT_ID` still accepted), `DINAR_WHOP_PLAN_MAP`; production additionally
  `DINAR_WHOP_ENVIRONMENT=production` and `DINAR_LIVE_PROVIDERS_ENABLED=true`.
- Defect fixed while building it: the lifecycle machine allowed `PAYMENT_FAILED → ACTIVE` and
  `EXPIRED → CANCELLED`, which the database integrity trigger refuses (HTTP 500). Now
  `TERMINAL_STATUS`; a retry after a failed first payment is a new checkout.

## 4. Test coverage — `test/whop-billing.test.ts` (PURE MOCK, not sandbox evidence): 11/11

WH-00 verifier vectors and exact money parsing · WH-01 checkout metadata, PENDING grants nothing,
forged/unsigned and canonical-intake attempts refused · WH-02 success, duplicate, 4 concurrent
identical deliveries → one ledger row, entitlement BUSINESS_GO · WH-03 pending ignored, failed →
PAYMENT_FAILED (final), retry via new checkout, renewal extends period, cancel at period end keeps
access, expiry removes it · WH-04 dispute recorded only, partial refund rejected for review, refund
pending ignored, full refund cancels · WH-05 wrong secret, tampered body, stale (replayed) timestamp,
other Whop account · WH-06 amount, currency and account-owner mismatch · WH-07 network interruption
then retry · WH-08 out-of-order cancellation, renewal after expiry · WH-09 upgrade needs a new paid
subscription (no unapproved proration), unknown payment id, unknown subscription.

## 5. Remaining blockers before any real payment

1. Whop account for the JassimAI legal entity; Whop's confirmation that a Jordan- or Kuwait-based
   operator can onboard, pass KYB and receive payouts (and in which currency).
2. Owner-approved prices for Go / Pro / Business, created as Whop plans; currency decision (KWD/JOD
   pricing vs USD settlement).
3. Sandbox credentials (sandbox key, `ws_` webhook secret, `biz_` id) entered through the secure
   credential form — then rerun WH-* against the sandbox for real evidence.
4. A reviewed migration storing the Whop membership id on the subscription (needed for
   in-app cancellation; until then users cancel from Whop's manage page).
5. Legal review: Whop as Merchant of Record, refund policy (partial refunds currently end access
   and are held for review), tax responsibilities.
6. Marketplace domain (B) is a separate project: seller KYC, subaccounts, application fee = the
   immutable commission snapshot, refund-due obligations mapped to Whop refunds.
