# DINAR Block E — Promotions, sponsored placement and recommendations

Block E adds paid listing promotion and internal recommendations without changing
marketplace authority. New orders keep the 1500 bps commission; historical order
snapshots are untouched. Promotion revenue is separate from order commission.

## Promotion authority

- One generic model: `promotion_products` (admin plans per market and category) and
  `listing_promotions` (one campaign per listing purchase). No category-specific tables.
- `artifacts/api-server/src/lib/promotions.ts` is the only code that creates, activates or
  changes a campaign. REST (`/listings/:id/promotions`, `/promotions…`) and the
  conversation adapter (`src/ai/promotion-turn.ts`) both call it.
- Only marketplace listings can be promoted. Jobs, candidates and applications have no
  promotion path, and employment ranking never reads promotion data.

## Purchase and payment (simulation only)

- The seller is the authenticated actor; the market is their active market. Price,
  currency, duration and placement come from the admin plan and are snapshotted on the
  campaign. A database trigger makes the accepted contract immutable.
- Payment uses the Wave 4 `TestOnlyPaymentAdapter` (TEST_NO_TRANSFER). The campaign
  becomes ACTIVE only after a capture webhook whose signature, amount and currency verify
  and whose provider snapshot is CAPTURED. No order payment intent, order, commission,
  seller due or delivery is created. A decline leaves the campaign PAYMENT_FAILED.
- `simulatedPaymentOutcome: "DECLINE"` is a test-card equivalent: it can only make a
  payment fail.
- Idempotency: the seller's idempotency key (the action id in conversation) returns the
  same campaign and the same single intent on retries and concurrent confirmations.

## Lifecycle

`PENDING_PAYMENT → ACTIVE ⇄ PAUSED → CANCELLED`; `PENDING_PAYMENT → PAYMENT_FAILED`;
`ACTIVE/PAUSED → EXPIRED` (by time). Terminal states are final. Pausing never extends
the window. There is no auto-renewal and no stored payment authority.

One pending or live campaign per listing and placement (partial unique index); no
boost stacking.

## Serving rule

A campaign serves only while `status = ACTIVE`, payment is `SIMULATION_CAPTURED` and
`startsAt <= now < expiresAt`, evaluated on every read. The periodic sweep that marks
expired rows is housekeeping only. Pre-Block-E rows are marked `LEGACY_UNVERIFIED` by the
migration and never serve.

The listing must also pass every organic gate: published, market, active seller,
moderation/policy, category, hard filters, availability and query relevance. Payment
never creates relevance and never bypasses moderation.

## Sponsored placement (deterministic)

- Search: up to **2** labelled slots per result page, taken by the first eligible listings
  with a serving campaign **in organic order**; every other result keeps its organic
  position, and each listing appears once.
- Slots apply to the default view (relevance or the category's default order, which the
  web search page always sends). A user-chosen order such as cheapest first is never
  reordered or labelled by payment.
- Recommendations: up to **1** labelled slot, only for a listing that already passed the
  similarity gate with a listing the buyer is looking at.
- Every paid slot is rendered with the text label «إعلان ممول». A restored result keeps the
  labels of its stored paid positions; listings that became ineligible disappear.

## Plan configuration policy

Admins create and edit plans per market. Disabling a plan stops new purchases
immediately; campaigns already bought keep running until their own `expiresAt`.
Price changes never rewrite an accepted campaign. Plans are disabled, not deleted.

## Recommendations

One generic recommender (`src/lib/recommendations.ts`) over DINAR inventory only. Signals:
category, registry attributes, title words, price proximity, public listing city,
existing rating and freshness. A specialised category (vehicles, property) is comparable
as a whole; broad categories require a shared attribute or title word. The viewed listing
and shown results are not repeated. Results are an ordinary persisted result set, so
ordinals, back and refinements (`أرخص`, `في عمان`) work. Each card shows only the
reasons that actually matched. No behavioural tracking, no precise location and no
external catalogues are used.

## Deferred

Real payment providers, real refunds, impression/click metrics and scheduling are not
part of Block E.
