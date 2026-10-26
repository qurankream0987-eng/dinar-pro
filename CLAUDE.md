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
- `lib/db/src/schema/` — schema; `lib/db/drizzle/` — the 41 checked-in migrations (release authority).
- `lib/api-spec/openapi.yaml` → `lib/api-zod`, `lib/api-client-react` (generated; run codegen, never hand-edit).
- `artifacts/dinar/` — web app. `threat_model.md` — trust boundaries.

## Invariants (never weaken to make a test pass)

- Prices, totals, fees and currency come from persisted server state; client amounts are ignored.
- An order's price/fee snapshot is immutable; commission is never recalculated after checkout.
- A payment on an order that is cancelled or whose reservation lapsed is never a sale: it becomes one
  REFUND_DUE obligation. A paid order cannot be cancelled by a party (stock released) without a refund.
  Nothing marks money refunded except a provider-signed REFUND_SUCCEEDED.
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
# one suite on a fresh loopback DB (migrate + fixtures + clean env + net-guard), from artifacts/api-server:
DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh <suite>.test BDINAR_<FLAG>=development
```

- `local-suite.sh` options: `DINAR_SUITE_SEED=fixtures|development|none` (default fixtures; most
  suites need the active JO market), `DINAR_SUITE_DB=<name>`, `DINAR_CHROMIUM=<browser>`.
  Where user namespaces and PostgreSQL 18 exist, `test/isolation/sandbox.sh` is the stronger option.
- Unseeded: `admin-bootstrap`, `fresh-environment` (DB `dinar_test_fresh_*`), `readiness`.
  Development seed: `phase2-commission-acceptance`. `listing-pricing-invariants` needs `dinar_test_blockb_*`,
  `listing-image-publication-acceptance` needs `dinar_test_image_review*` and
  `BDINAR_IMAGE_PUBLICATION_ACCEPTANCE=disposable`; `personal-intelligence` needs its own server on 55479.
- Browser suites read `CHROMIUM_PATH` / `REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE` (never a fixed path) and
  need the Google Fonts stub (`test/isolation/third-party-stub.mjs`) or they fail on console errors.
  Many assume `BDINAR_PROMOTIONS_ENABLED=true` (Replit's development default).
- Upload suites import `test/local-object-storage.ts` before the app: outside Replit it starts the
  loopback S3-compatible server. Do not run two copies of one suite at once (`run.mjs` shares `.test-build/<suite>.mjs`).
- `lib/db` `test:release-migration` requires PostgreSQL 18+ (`DINAR_RELEASE_MIGRATION_TEST_PG`).
- Per-suite flags are listed in `artifacts/api-server/package.json` scripts.

## Gotchas

- Capture happens while the order is still `CREATED` (before the seller accepts).
- A verified payment on a cancelled or lapsed order becomes exactly one `payment_refund_obligations`
  row and intent `SIMULATION_BUYER_REFUND_DUE` (policy D3, `lib/payments/obligations.ts`); only a
  provider `REFUND_SUCCEEDED` resolves it. The table is append-only by DB trigger.
- A new migration must be added to `drizzle/release-manifest.json` (sha256), `REVIEWED_PENDING_MIGRATIONS`
  in `lib/db/src/clone-migration-guard.ts`, the reviewed-journal test in `development-tls.test.ts` and
  the expected head tag in `readiness.test.ts`.
- S3 object metadata must expose `generation` (VersionId or ETag); listing-photo completion depends on it.
- Zod is 3.25.76 (GHSA-mrhx-c7xc-m3w5); mitigated by the body array bound, upgrade still pending.
