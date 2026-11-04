# WAVE 05 — Security and Financial Consistency

**Money gate:** `wave05-d15-money-model.test` at `d8c9010`, CI run `41634273975` (PostgreSQL 16.15, 51 migrations applied).
**End-to-end commerce:** `wave05-d15-acceptance.test` at `b77be8e`, CI run `41664520596`.
**Isolation:** `d4-d5-isolation-security.test` at `a2a2db7`, CI run `41666288262` (SUCCESS).
**No live payment, model, SMS or production database was used.**

## 1. The critical finding: Wave 01 + Wave 02 are not a valid combined money model

The database in force today carries the original strict invariant (`0001_invariants.sql`):

```
CHECK (quantity > 0 AND unit_price_minor > 0
       AND subtotal_minor = quantity::bigint * unit_price_minor
       AND platform_fee_minor >= 0
       AND seller_amount_minor = subtotal_minor - platform_fee_minor)
```

Wave 01's `planCheckout` groups a seller's lines **by seller only** and writes `group[0].unitPriceMinor` into the order header. The gate measured the result:

| Probe | Measured |
| --- | --- |
| `mm10` single-price order | qty 3, subtotal 37,500 → accepted |
| `mm11` seller-grouped multi-price order | **rejected**: `unit_price_minor × quantity` must equal `subtotal_minor`, but grouping writes the first line's price |
| `mm20` Wave 02 relaxed CHECK (`0051_order_multi_item_money.sql`) | accepted: header 9,000 × 4 = 36,000, **subtotal 147,000**, `headerPriceTimesQuantityEqualsSubtotal = false` |
| `mm20StrictReimposition` | **rolled back**: `check constraint "order_money_valid" ... is violated by some row` |

Wave 02's migration comment states the same thing in its own words: the header stores the first line's unit price, the summed quantity and the summed subtotal, so `subtotal = quantity × unit_price` only holds for a single-line order.

**Consequence:** a mixed-price cart can be persisted, but every consumer that derives money from the order header (`unit_price_minor × quantity`) — receipts, refunds, disputes, reports, exports — computes a number that is not the paid subtotal. The two waves cannot be accepted together as they stand.

**Verdict: BLOCKED** for mixed-price carts, refunds and disputes. No refund or dispute policy is invented here; the accounting sits on the same unresolved shape.

### What integration must decide (owner/Replit decision, not made here)

- **Option A — per-line authority.** Make the header price a display value or nullable; derive totals from `order_items`; add `subtotal_minor = sum(line unit_price_minor × quantity)` as the invariant.
- **Option B — strict header, one price per order.** Keep the original CHECK and create one order per price group (or per line); stop writing a first line's price into a multi-price header.
- Either way: backfill/repair existing multi-price rows **before** re-imposing the strict constraint, and update `lib/api-zod` contracts and every consumer that reads the header price.

## 2. What is consistent and measured today

Single-price flow, end to end over real HTTP at `b77be8e`:

- publish `45.750` JOD (3-decimal market) with quantity 3;
- buyer orders quantity 2 → subtotal **91,500** minor, platform fee **9,150**, seller amount **82,350**, `paymentMode = TEST_NO_TRANSFER`;
- duplicate idempotency key returns the **same order id**; a second checkout request reuses the key and is refused (`mm15.mm15 reusedKeyRefused = true`);
- seller accepts → `ACCEPTED`; seller marks delivered with a code → `SELLER_MARKED_DELIVERED`; buyer confirms → `COMPLETED`;
- exactly one seller-dues row of **9,150**; another user cannot read the seller's dues;
- DB rows agree with the API: header `unit_price_minor × quantity = subtotal_minor`, `subtotal − fee = seller_amount`.

Concurrency and split probes:

| Probe | Measured |
| --- | --- |
| `mm12` two sellers | two orders: 12,500 + 60,000 = **72,500**; fees 1,250 + 6,000 |
| `mm13` fee recomputation | 10% of 37,500 = 3,750 exactly; seller 33,750 |
| `mm14` malformed checkout | refused; 0 orders, 0 checkout requests |
| `mm16` concurrent confirmation | 3 fulfilled, 0 rejected, 2 orders, **1** checkout request, no duplicate money |
| `mm17` multi-line, same price | one order, 2 lines, subtotal 37,500, header math holds |
| `mm18` two businesses under one order | one order, quantity 2, subtotal 80,000, unit 40,000; **business attribution exists only per line, not on the header** |

`mm18` is a second integration item: the header cannot say which business was paid unless line-level attribution is treated as authoritative.

## 3. Security evidence

| Claim | Evidence |
| --- | --- |
| A model's completed-action claim never reaches the buyer | D15 `A15-04`: the claim is authored by the scripted model on a fresh conversation whose ledger is empty; HTTP body equals `MODEL_CLAIM_WITHHELD`, `advice.claimWithheld = true`, `actionLifecycle = PROPOSED`; stored assistant message equals the withheld text; no new payment intent |
| A claim cannot bypass on an order route | The same test proves the turn reached the model loop, not a deterministic order handler (`modelCalls` grew; the model saw the question) |
| Conversation isolation | Another user's GET on the conversation → 404; anonymous turn → 401 |
| Error bodies do not leak internals | Unknown route → JSON 404 without stack or SQL |
| Owner / business / employee / request-id isolation | `d4-d5-isolation-security.test` passes at `a2a2db7` (run `41666288262`); a flaky random-hex title that could parse as a Jordanian phone was made letters-only, no assertion was weakened |
| Contact details are not publishable in listing text | Phone/email/link guard `lib/listing-contact.ts`; the isolation suite hit this guard, proving it is active |
| No live money or model in CI | `TEST_NO_TRANSFER`; `BDINAR_BLOCK_MODEL_CALLS=1`; provider keys removed in CI |

## 4. Residual risks

- Refund, dispute, reversal and partial-refund accounting remain **unverified** until the order-money decision above is integrated.
- Business-level attribution (`mm18`) has no header field; reporting must join `order_items`.
- The isolation suite's flake was test-side; the guard itself behaved correctly. Any future title generator in tests must avoid digit-only suffixes.
