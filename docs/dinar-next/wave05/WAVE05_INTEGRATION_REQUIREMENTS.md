# WAVE 05 — Exact Integration Requirements for Replit and Claude

These are the conditions under which the Wave 05 branch may be integrated. They are requirements, not suggestions; each one names the evidence that produced it. Nothing here authorises a merge, a deployment, a production database change or a paid provider.

## 1. The order money model must be decided before any commerce integration

**Evidence:** `wave05-d15-money-model.test` at `d8c9010`, run `41634273975`; probes `mm00`, `mm11`, `mm20`, `mm20StrictReimposition` in `WAVE05_SECURITY_AND_FINANCIAL_CONSISTENCY.md`.

The current branch stack contains two incompatible rules:

- canonical `0001_invariants.sql`: `subtotal_minor = quantity::bigint * unit_price_minor` on `orders`;
- Wave 02 `0051_order_multi_item_money.sql`: drops that CHECK and keeps only money sanity plus `seller_amount_minor = subtotal_minor - platform_fee_minor`.

`order_items` already carries a strict per-line invariant (`order_item_money_valid`), so the line data is trustworthy; the header is not.

The integration candidate is **`qoder/wave06b-d16-d17-closure`**, which already places the identical Wave 02 file at `0051` (byte-for-byte diff = identical) and renumbers legal migrations to `0052`–`0054`, adding `0055_conversation_memory.sql`. In other words, the money defect is present on the newest integration candidate, not only on Wave 02.

**Owners must choose one and record it in the schema:**

- **Option A — header stays meaningful.** Emit one order per (seller, unit price) group, or move the header's unit price to a nullable/reporting field and keep the strict CHECK. Consequence: one cart can produce several orders and several payment intents per seller; the checkout API contract changes.
- **Option B — lines are authoritative.** Keep Wave 02's relaxed header CHECK, add a database-enforced rule that `orders.subtotal_minor = SUM(order_items.subtotal_minor)`, `orders.quantity = SUM(order_items.quantity)`, and that `platform_fee_minor` is computed from that subtotal; every consumer (receipts, dues, refunds, disputes, exports, reports) must read lines, never `unit_price_minor × quantity`. Consequence: the header unit price must be documented as "first line" and must never be used for arithmetic.

**Wave 05 does not pick a policy.** Until one is chosen and enforced in SQL, integrated commerce acceptance — mixed-price carts, refunds, disputes — stays `BLOCKED`.

## 2. Migration journal must be reconciled, not concatenated

**Evidence:** branch contents read from the remote on 2026-11-03.

| Branch | 0051 | 0052 | 0053 | 0054 | 0055 |
| --- | --- | --- | --- | --- | --- |
| `qoder/wave02-d4-d6-closure` | `order_multi_item_money` | — | — | — | — |
| `qoder/wave06-d16-d17-closure` | `d16_legal_readiness_incidents` | `d16_readiness_constraints` | `d16_country_legal_intake` | — | — |
| `qoder/wave06b-d16-d17-closure` | `order_multi_item_money` (same bytes as Wave 02) | `d16_legal_readiness_incidents` | `d16_readiness_constraints` | `d16_country_legal_intake` | `conversation_memory` |

- Do **not** merge Wave 02 and Wave 06 before Wave 06b's numbering; two different migrations would claim `0051` and Drizzle's journal would apply an unrelated file.
- Verify `lib/db/drizzle/meta/_journal.json` matches the file names, and that a fresh database applies all of them in order (the Wave 05 profile suite applies 51 migrations; the number grows with each wave).
- Never run `drizzle-kit push`; migrations only.

## 3. Conversation history needs a page (API contract change)

**Evidence:** `WAVE05_DB_PROFILE.pf60_unboundedHistory` at `d8c9010`, run `41634279885`.

At 600 messages the endpoint returns 85,894 bytes in one response while the statement count stays flat (6 statements). The read is not N+1; it is simply unbounded. A long conversation is one large payload, and the mobile client must parse all of it before rendering the latest turn.

Required change (owner-approved, because it touches the public contract):

- `GET /ai/conversations/:id` gains `?before=<messageId>&limit=<n>` (default 50, max 200) and returns `{ messages, nextCursor }`; the web client loads older pages on demand and always renders the latest page first.
- Update `lib/api-zod`, the web conversation store and the D7 UX tests together; keep the server default bounded so no caller can request an unbounded history.
- Re-run `PF-60` (600 messages) and the D7 browser journey after the change. Wave 05 records the requirement; it does not silently change the contract.

## 4. Pooling and connection budget per replica

**Evidence:** `WAVE05_DB_PROFILE.pf70_capacity` at `d8c9010`, run `41634279885`; `wave05-d13-load-baseline.test` (pool ceiling cell).

- The server has `max_connections = 100` (3 reserved for superusers → 97 usable) on the CI runner image; the application pool defaults to 10.
- Deployment rule: `replicas × DINAR_DB_POOL_MAX + 3 < max_connections`. Raise both together; raising only the pool turns the surplus into connection refused errors.
- Railway numbers are **not** asserted here. The owner must set the two values on the deployment and re-run `wave05-d13-db-profile.test` against that instance before quoting any capacity.
- The profile suite shows the query plans (`offers_market_status_created_idx` index-only for organic browse, `offers_market_status_price_idx` for price sort, `offers_search_stale_idx` for the worker's claim read, trigram GIN for text). A `city` filter has no index; adding one requires a migration justified by `pf20_latencies`/`pf10_plans`, not by guesswork.

## 5. Graceful shutdown on Railway

**Evidence:** `wave05-d13-shutdown.test` at `89688df`, run `41664280013`: `SIGTERM` → drain in 26 ms, listener closed, new connections refused, pool ended, a second signal does not re-drain.

- The platform must send `SIGTERM` and allow at least 10 seconds before `SIGKILL` (the code's own deadline). Instant kills lose in-flight requests and leave sessions open.
- The process installs its own handlers; do not add a shell wrapper that forwards the signal only to a child unless it forwards to the Node process group.
- Health checks may keep hitting `/api/readyz` during the drain; the listener stops accepting at once, so the platform's LB must remove the instance on the same signal.

## 6. Background work in a multi-replica deployment

**Evidence:** `WAVE05_DB_PROFILE.pf50_replicaCoordination` (5 workers, 5,000 stale rows → 5,000 unique documents, none duplicated, no stale rows left) and `LD-02` (an up-to-date index does no duplicate work).

- The search-index refresher runs in-process every 30 s (10 × 500 rows) and claims with `FOR UPDATE SKIP LOCKED`; multiple replicas are safe and deduplicate by construction.
- The reservation sweep runs every 60 s per process; it is status-transition based and must stay idempotent. If a future change makes it send notifications, it needs a claim (the same `SKIP LOCKED` pattern) before it can run on more than one replica.
- The search documents are not required for search correctness: stale rows are candidates, and the planner falls back when the text version is not current. They are required for the trigram path to stay fast.

## 7. Browser and accessibility evidence must be pinned to the final web SHA

**Evidence:** Command E run `41658929645`, Command F run `41658937281` (both at `c73f7f9`); accessibility run `41664702077` at `b77be8e`.

The commits after `c73f7f9` change the server lifecycle and tests only, but any future web change invalidates the screenshots. Before integration, re-dispatch `command-e-ui.test` and `command-f-journeys.test` on the exact commit to be merged and attach the run IDs to the release record. WebKit, Firefox and real screen readers remain manual/`BLOCKED` in this runner.

## 8. What Wave 05 deliberately did not change

- `CHAT_ONLY_MODE` stays on; no payment provider, SMS gateway or model provider is contacted.
- No gift, coupon, refund or dispute behaviour was invented. Refunds and disputes remain `BLOCKED` behind the money-model decision.
- No CSP rule was weakened; no Replit-owned Railway file was edited.
- No production database, Railway environment or canonical branch was touched. The only database used is the disposable loopback instance created per CI run.

## Integration-candidate reconciliation — 2026-11-03

The Wave 05 source did not choose between its two order-money options. The unified candidate chooses **Option A**: retain `order_money_valid` and split checkout by seller and unit price. The 11-case money gate and five-case D15 acceptance passed on PostgreSQL 16.10 with this behavior; Wave 02/Wave 06b's relaxed `0051_order_multi_item_money.sql` remains excluded.

Candidate Chromium coverage also passed: Command E was 2/2 with 96 states across eight widths and light/dark themes, and Command F was 3/3 across nine authenticated journeys; both reported zero outbound requests. WebKit/Firefox and manual assistive-technology checks remain unverified.

This is not a claim that the whole financial model is complete. The tests verify that the canonical checkout service creates per-price orders whose headers and lines agree, but a database-level cross-table aggregate rule has not yet been selected and validated. Audit Wave 06b's migration sequence and historical usage before designing that rule; test any migration on both PostgreSQL 16 and 18. Refunds/disputes remain blocked until their accounting and policy paths are implemented and tested. The full integration candidate remains **NO-GO for commerce release**.
