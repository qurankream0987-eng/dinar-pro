# WAVE 05 — D13 Scalability, Query Performance and Railway Compatibility

**Profile suite:** `wave05-d13-db-profile.test` at `d8c9010`, CI run `41634279885` (PostgreSQL 16.15, 20,000 synthetic offers, 25 runs per predicate).
**Shutdown suite:** `wave05-d13-shutdown.test` at `89688df`, CI run `41664280013`.
**Load suite:** `wave05-d13-load-baseline.test` at `fd23782`, CI run `41682386840` (green, 7/7) — see §7.
**No production load test was run. No Railway environment was contacted. Every number below was measured on the CI runner's loopback disposable database.**

## 1. Method

- Synthetic market grown to 20,000 offers in one statement; the search worker then built 20,006 documents (`pf01`), so plans and latencies are measured against a catalog that is two orders of magnitude larger than the profile's working set.
- Each predicate is executed 25 times after warm-up; p50/p95/max and slow-query counts (>250 ms) are recorded, plus `EXPLAIN (ANALYZE, BUFFERS)` text.
- The application pool is the library default (`max = 10`, `connection_timeout = 2000 ms`) and is an environment knob (`DINAR_DB_POOL_MAX`), recorded as `poolMaxIsEnvKnob: true`.
- The load suite drives the real HTTP app on `127.0.0.1:0` with the same disposable database; the model gateway is blocked and promotions are enabled only inside the test process.

## 2. Query plans — the paths the product actually uses

| Path | Plan measured | Rows | Sort | Heap read | Execution |
| --- | --- | --- | --- | --- | --- |
| Organic browse (first marketplace page) | **Index Only Scan** `offers_market_status_created_idx` | 24 | none | none | 0.029 ms |
| Price sort | Index Scan `offers_market_status_price_idx` | 30 | none | none | 0.067 ms |
| Seller's own catalog | **Index Only Scan** `offers_seller_created_idx` | 1 | none | none | 0.017 ms |
| Listing detail | Index Scan `offers_pkey` | 1 | none | none | 0.010 ms |
| Background stale claim | Index Scan `offers_search_stale_idx` (partial, keyed by market) | 1 | none | none | 0.011 ms |
| Text search (trigram) | Bitmap Heap Scan `offer_search_documents` + GIN `text_trgm_idx` | 2,500 | none | none | 1.122 ms |
| Category filter | Seq Scan `offers` (planner may Bitmap-Or the two expression indexes) | 24 | none | `offers` | 0.598 ms |
| Buyer orders | Seq Scan `orders` | 1 | none | `orders` | 0.016 ms |
| Conversation messages | Seq Scan `messages` | 1 | 1 node | `messages` | 0.016 ms |

Readings:

- The **organic browse plan is index-only and stops at 24 rows**: the first page every visitor loads never touches the heap and does not sort.
- Category and city filters fall back to a heap scan on this dataset. That is acceptable at 20,000 rows (≤1.1 ms) but is a **known future index candidate**, to be justified by these numbers rather than added on suspicion.
- Buyer-orders and conversation-message scans are cheap because those tables are tiny in this fixture; the real scaling risk there is payload size (§3), not the plan.

## 3. Latency by predicate (25 runs each, 20,000 offers)

| Predicate | p50 | p95 | max | Slow (>250 ms) |
| --- | --- | --- | --- | --- |
| Organic browse | 0.29 ms | 0.46 ms | 0.49 ms | 0 |
| Price sort | 0.30 ms | 0.59 ms | 0.85 ms | 0 |
| Seller catalog | 0.28 ms | 0.34 ms | 0.52 ms | 0 |
| Buyer orders | 0.25 ms | 0.41 ms | 0.47 ms | 0 |
| Conversation messages | 0.26 ms | 0.29 ms | 0.49 ms | 0 |
| Stale claim | 0.27 ms | 0.36 ms | 0.47 ms | 0 |
| Listing detail | 0.27 ms | 0.29 ms | 0.32 ms | 0 |
| Category filter | 0.50 ms | 0.71 ms | 1.13 ms | 0 |
| Text trigram | 1.83 ms | 3.18 ms | 3.80 ms | 0 |
| City filter | 0.54 ms | 0.87 ms | 1.00 ms | 0 |

These are **SQL-layer** latencies, not end-to-end HTTP latency (which §7 measures under concurrency). Every predicate stays three orders of magnitude under the 250 ms slow-query line at this scale.

## 4. History reads — flat statements, growing payload

| Measurement | Result |
| --- | --- |
| 20 messages / 120 actions | 10 statements, 19.7 ms, 30,332 bytes |
| 40 messages | 14 statements, 20.3 ms (`pf31`: +4 statements versus 20 messages) |
| 600 messages | 6 statements, 10.3 ms, **85,894 bytes** |
| Bytes per message | 143 |

The statement count does **not** grow with history (no N+1); the response does. The 600-message read returns 85,894 bytes in a single response because the endpoint has no page. This is an API contract issue, recorded as an integration requirement (`WAVE05_INTEGRATION_REQUIREMENTS.md` §3), not silently changed here. A receipt-heavy conversation measured 80 statements and 33.4 ms for the per-message cycle — that path is bounded by the 40-line display bound.

## 5. Multi-replica index work

| Measurement (5 workers, 5,000 stale rows, claim limit 2,000) | Result |
| --- | --- |
| Unique documents written | 5,000 |
| Duplicated documents | 0 |
| Stale rows left after drain | 0 |
| Per-worker rows considered | `[0, 2000, 2000, 1000, 0]` |
| Claim transaction held | 40 / 753 / 753 / 384 / 40 ms |
| A naive read without the claim | considered 10,000, unique 2,000, **8,000 duplicated** |

The `FOR UPDATE SKIP LOCKED` claim is what prevents duplicate document builds across replicas; without it the same 2,000 rows would be processed five times. The in-process maintenance loop (30 s, 10 × 500 rows) can therefore run on every replica safely.

## 6. Capacity and the connection budget

| Item | CI runner value |
| --- | --- |
| PostgreSQL | 16.15 (Debian) |
| `max_connections` / usable for non-superusers | 100 / 97 (3 reserved) |
| `shared_buffers` / `work_mem` / `maintenance_work_mem` | 128 MB / 4 MB / 64 MB |
| `effective_cache_size` | 4 GB |
| `statement_timeout` / `idle_in_transaction_session_timeout` | 0 / 0 |
| Application pool max / connection timeout | 10 / 2,000 ms |
| Open backends during profile | 7 |
| Replicas testable within the limit (`floor(97 / 10)`) | 9 |

**No Railway figure is asserted here.** The deployment must raise `DINAR_DB_POOL_MAX` and the database `max_connections` together — the rule is `replicas × pool + 3 < max_connections` — and re-run the profile suite against the real instance before quoting any capacity. `statement_timeout = 0` on the runner is a risk to confirm on the deployment; a long analytical query would otherwise hold a connection indefinitely.

## 7. Synthetic HTTP load baseline

Run `41682386840` at `fd23782` (`wave05-d13-load-baseline.test`, PostgreSQL 16.15, 5,000 synthetic listings in the **JO** market, default pool), 7/7 tests green. Raw report: `WAVE05_LOAD_BASELINE` in the job log.

Environment: 2 logical cores (AMD EPYC 7763), 7,932 MB RAM, Node 24.22.1, database 29 MB, 5,020 offers, 54 users. Pool `max = 10`, connection timeout 2,000 ms. The test sampler holds one client of the same pool, so LD-13 treats `max − 1` as the effective application ceiling.

### 7.1 Read cells (anonymous reads pinned to the JO guest market)

| Workload | c | RPS | p50 ms | p95 ms | p99 ms | 4xx/5xx | Slow >250 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Browse `GET /listings` | 1 | 75.9 | 12.4 | 18.2 | 20.0 | 0 / 0 | 0 |
| Browse | 10 | 104.1 | 94.3 | 119.7 | 133.5 | 0 / 0 | 0 |
| Browse | 24 | 102.9 | 221.0 | 296.2 | 319.1 | 0 / 0 | 156 |
| Search `GET /listings?search=` | 1 | 50.6 | 19.0 | 24.9 | 37.7 | 0 / 0 | 0 |
| Search | 10 | 67.7 | 145.8 | 188.8 | 208.2 | 0 / 0 | 0 |
| Search | 24 | 66.6 | 354.5 | 431.0 | 477.3 | 0 / 0 | 794 |
| Listing detail `GET /listings/:id` | 1 | 184.2 | 5.3 | 6.4 | 9.1 | 0 / 0 | 0 |
| Listing detail | 10 | 234.0 | 40.7 | 58.0 | 67.1 | 0 / 0 | 0 |
| Listing detail | 24 | 238.9 | 96.6 | 130.3 | 169.6 | 0 / 0 | 0 |
| Session `GET /auth/me` | 24 | 478.4 | 49.2 | 61.3 | 78.5 | 0 / 0 | 0 |
| Conversation history | 24 | 314.2 | 75.9 | 85.1 | 87.0 | 0 / 0 | 0 |
| Cart read | 24 | 403.8 | 57.8 | 77.8 | 83.6 | 0 / 0 | 0 |

A probe before timing asserts that anonymous JO browse returns 24 listings, so these were not requests against an empty default (KW) market. **Text search is the read bottleneck on this runner**: at c=24 it saturates the 2 cores and 794/800 requests cross the 250 ms line, while detail and authenticated reads stay under 170 ms p99. That is a runner-CPU observation, not a capacity claim for Railway.

### 7.2 Write cells (all 2xx, all zero 5xx)

| Workload | c | RPS | p50 ms | p99 ms | Lock-wait samples | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Seller publish `POST /listings` | 8 | 124.1 | 61.9 | 94.9 | 0 | 120/120 created |
| Cart write `PUT /cart` | 8 | 139.4 | 55.9 | 84.6 | 1 | 120/120 |
| Checkout simulation `POST /checkout` | 8 | 61.6 | 124.6 | 212.9 | 3 | 80/80, no idempotency collision |
| Inquiry processing (in-process) | 4 | 112.3 | 34.7 | 42.9 | 0 | 24/24 |

Backpressure recorded: inquiry throttled 0, inquiry/publish/cart/checkout client errors 0.

### 7.3 Pool ceiling and recovery

- **Ceiling burst (c=60, 600 requests):** 67.8 RPS, p50 835.1 ms, p99 1,108.9 ms, 600/600 answered, **0 timeouts, 0 5xx**, peak server connections **10** (= the configured pool `max`), peak in-flight queue 89. The pool never exceeded its configured cap; excess concurrency queued instead of opening backends.
- **Pool knob:** see §7.4.
- **Outage recovery:** every client backend was terminated with `pg_terminate_backend`. The API answered `500` on the first probe and `200` on the next one → 5 consecutive 200s; no manual restart. Post-outage browse p50 **131.9 ms** vs the pre-outage search baseline **145.8 ms** (ratio 0.90), 0 5xx.
- **Index worker:** 5,020 documents in 4 rounds / 883 ms (5,687 documents/s) with no duplicate work; the idle tick refreshed 0 rows.
- **Peak RSS:** 476.6 MB by the end of the matrix. `cpuPercent` is process CPU summed across threads divided by wall time on a runner that reports 2 logical cores; values above 200 % mean the cgroup exposes more cores than `os.cpus()` reports and must **not** be quoted as per-core utilisation.

### 7.4 Raised-pool comparison

`41683066149` at `fd23782`, `DINAR_DB_POOL_MAX=20`, same 5,000 listings; green, 7/7.

| Measurement | Pool 10 | Pool 20 |
| --- | --- | --- |
| Ceiling burst RPS (c=60) | 67.8 | 70.3 |
| Ceiling p50 / p99 (ms) | 835.1 / 1,108.9 | 818.1 / 1,171.3 |
| Peak server connections | 10 | 20 |
| Peak waiting queue | 89 | 88 |
| Browse c=24 RPS / p99 | 102.9 / 319.1 ms | 114.1 / 284.6 ms |
| Search c=24 RPS / p99 | 66.6 / 477.3 ms | 71.5 / 482.5 ms |
| Checkout RPS / p99 | 61.6 / 212.9 ms | 64.2 / 197.6 ms |
| Timeouts / 5xx | 0 / 0 | 0 / 0 |

Doubling the pool changed throughput by ~4 % and left the queue and latency flat: on this runner the ceiling is **CPU**, not connections. The pool is therefore not the first Railway lever; the replica count and instance CPU are. The knob itself is proven to take effect (peak connections 10 → 20 without breaking the ceiling assertion).

**No Railway production load test was run.** These numbers describe a 2-core GitHub runner on a loopback database; they justify the `replicas × pool + 3 < max_connections` rule but do not predict Railway throughput.

## 8. Graceful shutdown

Run `41664280013` at `89688df`:

```json
{"signal":"SIGTERM","exitCodes":[0],"drainMs":26,"listenerClosed":true,"newConnectionRefused":true,"poolEnded":true,"repeatedSignalRanDrainAgain":false}
```

- `SIGTERM` closes the listener immediately (new connections are refused), lets in-flight requests finish, ends the pool, and exits 0; a second signal does not start a second drain.
- The deadline is 10 s; beyond it the process force-closes connections and exits 1. Railway must allow at least that long between `SIGTERM` and `SIGKILL`.

## 9. Optimisations actually made in this wave

Only one change was justified by measurement, and it is an availability change, not a micro-optimisation: the graceful shutdown above. **No index was added and no query was rewritten.** At this scale every product path measured under 4 ms at the SQL layer; adding an index for the city filter or rewriting the category predicate without a failing measurement would be guesswork, and the mission forbids inventing capacity. The profile suite is the harness that will justify any future index with before/after numbers.

The load harness itself was hardened after two runs that idled until the job timeout: every driver request now aborts at 15 s, each cell and index round prints a `LOAD_STAGE` marker, idle sockets are closed before `server.close()`, and a 45-minute watchdog reports the cells measured instead of an opaque timeout. A third correction matters for the numbers above: anonymous requests default to the **KW** market, so the first synthetic runs timed an empty market. Every anonymous read cell now sends the JO guest-market cookie and LD-10 asserts that the JO catalog is served before timing. Earlier load figures taken without that cookie are superseded by §7 and are not quoted in this report.
