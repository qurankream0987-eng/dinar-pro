# 03 — Application deployment configuration

**Status:** Docker configuration is `READY_AND_VERIFIED` locally; Railway deployment is
`PREPARED_NOT_DEPLOYED`.

## Build and runtime contract

- Build context: repository root (`/` in Railway service settings).
- Builder: repository-root `Dockerfile`.
- Base image: `node:24-bookworm-slim`.
- Package manager: Corepack with pnpm `10.26.1`; install uses
  `pnpm install --frozen-lockfile`.
- Build commands in the Dockerfile:
  `pnpm --filter @workspace/dinar run build` and
  `pnpm --filter @workspace/api-server run build`.
- Runtime: bundled API server serves the built web assets from
  `/app/artifacts/dinar/dist/public`.
- Runtime user: non-root `node`.
- Listener: use platform-injected `PORT`; never hard-code a Railway port.
- Migrations: not run at app startup; no pre-deploy migration command is configured.
- Shutdown: SIGTERM/SIGINT stops maintenance timers, closes HTTP, and ends the database pool.
- Idle PostgreSQL connection errors are logged by code only; a lost idle connection must not crash
  the API process.
- No `railway.toml` or `railway.json` was added. Railway's current documentation marks Config as
  Code deprecated and gives 2026-12-01 as the end of support for existing legacy files. No Railway
  IaC plan was run because no DINAR app service or approved infrastructure plan exists.

The container working directory is `/app/artifacts/api-server`. The readiness route resolves the
checked-in migration journal relative to that directory; changing the runtime working directory
without updating that contract makes readiness report migrations unavailable.

## Proposed Railway service settings

| Setting | Value for a later approved staging service |
|---|---|
| Root directory | `/` |
| Builder | Dockerfile at repository root |
| Start command | Image default |
| Healthcheck path | `/api/readyz` |
| Healthcheck timeout | 120 seconds |
| Restart policy | `ON_FAILURE`, maximum 5 retries |
| Replicas | 1 |
| Public domain | None until separately approved |
| Pre-deploy command | None; migrations remain a separately approved release step |
| Production autodeploy | Disabled |

`/api/healthz` is process liveness. `/api/readyz` returns 503 until the database, expected migration
journal, and essential configuration are ready. Missing SMS integration is reported separately and
does not block the web service; phone-dependent operations remain unavailable.

## Local verification record

The following checks were run against the isolated Docker image and a loopback-only disposable
PostgreSQL 18.6 container, with synthetic storage settings and no provider credentials:

| Check | Result |
|---|---|
| Clean Docker build and frozen dependency install | Passed |
| Fresh local migration | 51/51 journal entries applied |
| Readiness contract tests | 15/15 passed |
| Same-origin web/API tests | 8/8 passed |
| S3 protocol tests against local mock | 7/7 passed |
| Production-mode `/api/healthz`, `/api/readyz`, and `/` | 200, 200, and 200 |
| Browser page load | Chromium rendered the DINAR page title |
| Database interruption | App stayed running; liveness 200; readiness 503 |
| Database recovery | Readiness returned to 200 without restarting the API |
| SIGTERM and controlled app restart | Exit 0; readiness returned to 200 |
| Empty database startup | Readiness 503; no migration ledger was created |

The browser was restricted to loopback, and the S3 wire test used only its local mock server. No
Railway database, live storage provider, or AI/SMS/payment provider was contacted.

The full `security-acceptance.test` suite initially reported 3/12 passing and 9/12 failing on a
pristine local database because no active market or current market-price fixtures existed. The
approved fixture harness then seeded synthetic active markets and baseline prices in a fresh,
loopback-only PostgreSQL 18.6 database; the full suite passed 12/12, with zero failures and zero
skips. Exact prerequisite details, all nine unseeded dependent failures, the tested SHA, and the
source-change review map are recorded in
[15 — Security acceptance evidence](./15_SECURITY_ACCEPTANCE_EVIDENCE.md).
