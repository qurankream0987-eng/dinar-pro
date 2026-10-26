# DINAR

Arabic-first conversational marketplace: sellers publish products/services, buyers search and
negotiate in chat, orders reserve stock, payment is SIMULATION_ONLY. pnpm monorepo, Node 24
(runs on 22), TypeScript 5.9, Express 5, PostgreSQL + Drizzle, React/Vite web.

## Map

- `artifacts/api-server/src/routes/` — HTTP routes. `marketplace.ts` (listings, checkout, orders),
  `payments.ts` (simulation-only intents/webhooks), `ai.ts` (conversation turns, SSE).
- `artifacts/api-server/src/ai/` — conversation runtime. Model-callable tools are only in
  `tool-registry.ts` (read-only + `addToCart`). Orders, payments and listing writes never come
  from model output.
- `artifacts/api-server/src/lib/` — domain services: `negotiations.ts`, `commerce.ts`,
  `order-terminal-accounting.ts`, `payments/service.ts`, `auth.ts`, `auth-rate-limiter.ts` (DB-backed).
- `lib/db/src/schema/` — schema; `lib/db/drizzle/` — the 40 checked-in migrations (release authority).
- `lib/api-spec/openapi.yaml` → `lib/api-zod`, `lib/api-client-react` (generated; run codegen, never hand-edit).
- `artifacts/dinar/` — web app. `threat_model.md` — trust boundaries.

## Invariants (never weaken to make a test pass)

- Prices, totals, fees and currency come from persisted server state; client amounts are ignored.
- An order's price/fee snapshot is immutable; commission is never recalculated after checkout.
- Money is never recorded against an order that is cancelled or whose reservation lapsed, and a
  paid order cannot be cancelled (stock released) without a refund.
- Payment events are signature-verified, deduplicated by provider event id, and amount/currency matched.
- Every order/listing/payment action checks the actor's ownership server-side (404 for strangers).
- Model output is untrusted: no tool may create orders, payments or approvals; no success text
  without a backend receipt.
- JSON bodies are bounded (128 KB, ≤2000 array elements in total) before any Zod schema runs.
- Never run `drizzle-kit push` (`pnpm --filter @workspace/db run push` is deliberately denied);
  schema changes are new SQL migrations.

## Environment rules

- Never connect to Railway, Replit, production or any non-loopback database. DB tests require
  `BDINAR_DISPOSABLE_ACCEPTANCE_DB=1`, a loopback URL and a name matching `dinar_(test|acceptance|wave<n>|migration)_*`.
- No live AI calls (`test/run.mjs` strips provider keys and sets `BDINAR_BLOCK_MODEL_CALLS=1`), no real payments.
- Do not push or merge without the owner's explicit approval; work on `claude/*` branches.

## Running tests

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/dinar run build
# fresh DB per suite, then from artifacts/api-server:
NODE_ENV=development DINAR_DEV_DATABASE_URL=$URL DATABASE_URL=$URL pnpm --filter @workspace/db run migrate
BDINAR_ACCEPTANCE_FIXTURES=development BDINAR_SEED_PASSWORD=<random> \
  BDINAR_ACCEPTANCE_FIXTURE_MODULES=MARKET_FIXTURES,USER_FIXTURES,PRODUCT_LISTINGS,PHASE1_LISTINGS \
  node test/run.mjs acceptance-fixtures.seed      # most suites need the active JO market
node test/run.mjs <suite>.test                    # plus the suite's BDINAR_*_ACCEPTANCE=development flag
```

- `admin-bootstrap`, `fresh-environment` and `readiness` expect an unseeded database.
- Browser suites need `REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE`/`CHROMIUM_PATH` and the
  Google Fonts stub (`test/isolation/third-party-stub.mjs`) or they fail on console errors.
- `lib/db` `test:release-migration` requires PostgreSQL 18+ (`DINAR_RELEASE_MIGRATION_TEST_PG`).
- Per-suite flags are listed in `artifacts/api-server/package.json` scripts.

## Gotchas

- Capture happens while the order is still `CREATED` (before the seller accepts).
- Reservation expiry (`releaseExpiredReservations`) does not yet handle already-captured payments —
  needs an owner refund policy (see `docs/dinar-next/CLAUDE_RELEASE_BLOCKERS.md`).
- Zod is 3.25.76 (GHSA-mrhx-c7xc-m3w5); mitigated by the body array bound, upgrade still pending.
