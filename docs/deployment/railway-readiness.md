# DINAR Railway readiness package

**Status: Railway inventory verified read-only on 2026-11-03; application package not deployed.**
This document separates observed Railway state from local repository evidence and unverified
settings. No cloud resource was changed.

## 1. Current access and scope

The authenticated Railway connection can read the personal workspace `القرآن الكريم's Projects`
(`331cfced-7e2a-4f2b-9e5f-79990c89f032`). The visible project `dinar-development-canonical`
(`3810e583-cc70-434c-b6fa-9ea15779f3c1`) contains the non-ephemeral `development` environment
(`4086de25-d270-4f39-89d1-93f611fe79c2`). This confirms the Railway project identity, not that the
repository is deployed there. The other visible project was not inspected because it is outside this
DINAR inventory.

The environment contains one `Postgres` service (`6a02fe25-1305-437c-9fe7-b989836c8949`), with no
DINAR API/web service, no buckets, and one 500 MB volume (`b8618f8c-29ac-4c6f-948f-c515b4c21f3c`)
mounted at `/var/lib/postgresql/data` in `iad`. The configured image is
`ghcr.io/railwayapp-templates/postgres-ssl:18`; this is image/config evidence, not a SQL query of
the running server's actual version. The service has one replica, a private network endpoint, and an
active public TCP proxy for port 5432 (endpoint omitted here). No service or custom domains were
listed. The latest deployment was `SUCCESS`
(`5331773a-cc0b-4bcc-a9f9-e6db312d06cd`, 2026-10-08).

The active public PostgreSQL proxy is an exposure to review. Do not use it for this work; the owner
must confirm whether it is needed and separately authorize any restriction or removal.

The service configuration did not report a healthcheck, restart policy, resource limits, backup
schedule, retention, PITR, or restore history. The connector exposes no billing-plan or spending-
limit inventory. Twenty-four-hour metrics returned CPU_USAGE average 0.00054 and maximum 0.00172
(the connector did not state a unit), plus memory average 0.06199 GB and maximum 0.07016 GB; each
measurement had 1,441 samples. These are short-window observations, not capacity or cost estimates.
The environment status reported a pending patch while the staged-change inventory returned no
staged patch/resources. This inconsistency remains unresolved; nothing was committed or applied.

No cloud resource was changed. No secret value was read. No remote database was contacted or
migrated. No provider was enabled, no domain was attached, and no deployment was performed.

The workspace, project, and environment IDs above are the identities returned by authenticated
Railway reads. `describe-service` returned these variable names only:
`DATABASE_PUBLIC_URL`, `DATABASE_URL`, `PGDATA`, `PGDATABASE`, `PGHOST`, `PGPASSWORD`, `PGPORT`,
`PGUSER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`, `POSTGRES_USER`,
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, and `SSL_CERT_DAYS`. No variable values or bucket credentials
were requested. Read access does not establish permission to write.

## 2. Proposed service shape

No application service currently exists in the inspected project. Use **one Node service** for a
future staging rehearsal. The API already serves the built React
app when `DINAR_WEB_DIST` is set. Keeping `/api` and the chat UI on the same origin preserves the
existing origin checks and session-cookie behavior; a second frontend service would add cross-origin
configuration without a demonstrated need.

Do not create a separate worker yet. The API process currently starts periodic reservation,
promotion, action-recovery, and search-index maintenance work. Keep the initial service at one
replica until multi-replica scheduler safety is verified. Do not add a separate public database
service, public database endpoint, custom domain, or production autodeploy as part of this package.

The repository root is the build context. The new `Dockerfile` builds the web assets and API from
the pnpm workspace, then starts the API bundle. It does not run migrations. The image binds to
Railway's injected `PORT`; do not hard-code a port.

## 3. Health and restart settings for owner review

After confirming the target service and environment, use these service settings for an isolated
staging rehearsal:

| Setting | Proposed value | Reason |
|---|---|---|
| Root directory | `/` | Required for the pnpm workspace and root lockfile |
| Builder | Dockerfile at repository root | Uses the checked-in `Dockerfile` |
| Start command | Image default | Runs the bundled API with Node |
| Healthcheck path | `/api/readyz` | Checks database, migration ledger, and required configuration; reports SMS separately |
| Healthcheck timeout | 120 seconds | Allows a cold start and dependency checks |
| Restart policy | `ON_FAILURE`, maximum 5 retries | Restarts crashes without treating a clean exit as a crash |
| Replicas | 1 | Avoid duplicate in-process maintenance loops |
| Public domain | None until separately approved | No unapproved exposure |
| Production autodeploy | Disabled | Prevents an experimental branch from reaching production |
| Pre-deploy command | None | In particular, do not run a migration automatically |

`/api/healthz` is a process liveness response; it does not prove that the database or migrations are
ready. `/api/readyz` returns 503 until the database is reachable, the migration ledger matches the
checked-in journal, and required deployment configuration is valid. Missing SMS is reported as
`phoneVerification: not_configured` but does not make unrelated web service readiness fail.
Phone-verification routes and features that require verified phone ownership remain disabled or
fail closed until a permitted adapter is registered; this change does not relax authentication,
identity, legal, or commercial gates.

No resource-size or cost estimate is asserted. Choose CPU, memory, and storage only after the
owner inspects Railway limits and measures a staging workload.

### Cost worksheet (prices intentionally blank)

Do not estimate a total until the owner confirms region, plans, limits, and current usage. Use the
provider's current rates and record the date of the estimate:

- App compute: selected CPU/RAM plan × one initial replica × measured active hours.
- PostgreSQL: selected plan + provisioned storage + backup/PITR retention.
- Object storage: stored GB-month + request volume + data egress.
- Network: measured ingress/egress and any private-network charges.
- Optional providers: SMS, AI, email, maps, web search, error reporting, and payment fees; currently
  unselected and not authorized for live use.
- Domains and monitoring: only if the owner separately approves them.

The present inventory, region, usage, provider plans, and billing limits are unknown, so no numeric
monthly cost is supportable yet.

## 4. Environment-variable matrix

Set values only in the verified Railway environment's secret/settings interface. Do not put values
in this repository, a commit, a log, or chat.

| Name | Staging use | Current status |
|---|---|---|
| `PORT` | Platform-injected listener port | Required by the API; do not set a fixed value |
| `NODE_ENV` | `production` in the container | Set by the image |
| `DINAR_WEB_DIST` | Built web directory | Set by the image |
| `DINAR_DEPLOYMENT_ENV` | `staging` only after staging is approved | Required by readiness; not set by the image |
| `DATABASE_URL` | Private URL for the verified staging database | Must be supplied by the owner after inventory |
| `DINAR_DEV_DATABASE_URL` | Must be absent | Deployed-target guard rejects it |
| `SESSION_SECRET` | Secret of at least 32 characters | Required; create/store through the platform secret flow |
| `OBJECT_STORAGE_PROVIDER` | `s3` | Required outside Replit |
| `OBJECT_STORAGE_S3_ENDPOINT` | HTTPS S3-compatible endpoint | No provider or endpoint selected |
| `OBJECT_STORAGE_S3_REGION` | Provider region | No bucket selected |
| `OBJECT_STORAGE_S3_BUCKET` | Private staging bucket | No bucket selected |
| `OBJECT_STORAGE_S3_ACCESS_KEY_ID` | Least-privilege staging identity | Secret; not configured |
| `OBJECT_STORAGE_S3_SECRET_ACCESS_KEY` | Matching secret | Secret; not configured |
| `OBJECT_STORAGE_S3_PRIVATE_PREFIX` | `private` unless reviewed otherwise | Adapter default |
| `OBJECT_STORAGE_S3_PUBLIC_PREFIXES` | Leave empty unless each public prefix is approved | No public bucket access |
| `APP_ORIGIN` | Exact approved HTTPS origin, if explicitly configured | No domain has been approved |
| `DINAR_PHONE_VERIFICATION_PROVIDER` | Only after an SMS adapter and sandbox are selected | No vendor adapter is registered; phone features stay unavailable, core readiness is independent |
| `DINAR_LIVE_PROVIDERS_ENABLED` | Keep unset/false | No live provider calls authorized |
| `DINAR_AI_MODEL_FALLBACK` | Keep unset/false | No model call is enabled by default |

Do not transfer Replit object-storage paths or provider secrets into Railway. The S3 adapter requires
explicit S3 configuration and keeps objects private unless a path is explicitly configured as
public. The current code has no registered staging/production SMS provider; setting a vendor name
alone will not make phone verification ready.

## 5. Database and migration gate

The application uses `DATABASE_URL` at runtime outside development. `/api/readyz` compares the applied
Drizzle migration ledger with the journal bundled in the source. This is a readiness check, not a
backup, migration, or schema-repair mechanism.

Before any staging deployment, the owner must identify a **separate staging database** and verify:

1. Project/environment identity and private networking.
2. PostgreSQL server version and TLS requirements.
3. The deployed migration ledger against the checked-in release manifest and journal.
4. A successful backup and a restore rehearsal into a disposable database.
5. The explicit release migration procedure and a recovery/rollback decision.

Do not connect automated tests to a Railway database. Do not use the canonical development or
production database as a clone. Do not run `drizzle-kit push`, an application-start migration, or
any remote migration without separate owner authorization.

## 6. Backups, storage, and incident preparation

Backup schedules, retention, PITR, volume attachment, and restore history are **not verified**.
Before staging is approved, inspect those settings read-only. A restore rehearsal must target a
separate disposable database, never the source database.

The repository has an S3-compatible object-storage adapter with private-prefix handling,
permission checks, presigned uploads, and object-generation metadata. This is code evidence only;
it does not prove that a Railway-compatible bucket exists or that a live upload/download works.
Before any object migration, approve the bucket, least-privilege credentials, retention, checksum
verification, reference reconciliation, and rollback plan. Do not copy or delete production objects
as part of this readiness task.

No monitoring account, error-reporting project, email provider, maps provider, web-search provider,
embedding store, or payment provider is verified here. Payments remain simulation-only. Do not
enable these providers or infer readiness from an adapter alone.

### Domain and incident checklist

- Keep generated/public domains disabled until the owner approves the exact environment and origin.
- Before an incident response, record the environment, deployment ID, UTC time, and symptom without
  copying secrets, session data, phone numbers, or message content into a ticket or log.
- If readiness fails, keep traffic blocked; inspect the named readiness checks and platform logs
  for redacted metadata only.
- Roll back the application to a previously reviewed image if needed. Do not reverse database
  migrations or restore over a source database without an approved recovery plan.
- Preserve relevant platform logs and deployment metadata before changing settings. Do not delete
  or recreate resources as a diagnostic step.

## 7. Read-only inventory and remaining unknowns

The verified project and environment are recorded in section 1. The inspected project currently has
only its PostgreSQL service and attached volume; it has no app service or bucket. `describe-service`
returned variable names only. No live database connection was made, so the actual SQL version,
migration ledger, TLS identity, and connectivity from the application remain unverified.

Backup schedules, retention, PITR, restore options, billing plan, spending limits, and configured
resource caps were not available in the connector response. The owner must inspect these in Railway
before staging approval. Runtime CPU/memory samples do not establish a resource limit or monthly
cost. Do not infer a database backup from the attached volume.

## 8. Railway configuration format

This package uses a Dockerfile for the build and process definition. It intentionally does not add
`railway.toml`: Railway's current documentation marks Config as Code (`railway.toml`/`railway.json`)
deprecated and gives **2026-12-01** as the end of support for existing legacy files. The modern
Railway IaC workflow requires a verified project/service target and a separate IaC package. The
project identity is now verified, but no DINAR app service or approved IaC plan exists. Do not apply
a guessed IaC project or service.

After a separate staging service and environment are identified, the owner can choose the current
Railway IaC workflow and run its non-mutating plan first. Stop if the plan proposes creating,
deleting, or redeploying resources outside the separately approved staging scope. Do not apply the
plan or deploy until explicitly authorized.

## 9. Prepared local verification

The image was built locally after the readiness-policy edit, then started and exercised with
throwaway settings and a loopback-only, deliberately unreachable database URL. No image was deployed:

```sh
pnpm run typecheck
pnpm --filter @workspace/dinar run build
pnpm --filter @workspace/api-server run build
```

**Observed on this branch:** code generation and workspace typecheck passed; readiness tests passed
(15/15); fresh-environment tests passed (9/9) on disposable PostgreSQL 18 with zero outbound
attempts; the Docker image built successfully. The container bound its injected `PORT`, served
`/api/healthz` and built web assets, returned 404 for an unknown API route, reported invalid
configuration without exposing values, stopped cleanly, and served again after restart. With the
deliberately unreachable loopback database, `/api/readyz` returned 503 with database unavailable,
configuration ready, and phone verification not configured. A short signing secret made the
configuration check invalid. The image has no embedded Docker `HEALTHCHECK`; configure Railway's
HTTP health path as `/api/readyz`. At the bare `/healthz` and `/readyz` paths the SPA returns HTML,
not the JSON health response.

This does not establish Railway connectivity, live database readiness, backup readiness, provider
credentials, or deployment readiness. Run database-backed checks only with the documented
disposable loopback harness. Do not point them at Railway.

## 10. Next-stage sequence and approval gates

1. **G3–G4 — PostgreSQL and backups:** locally validated container/readiness policy is complete.
   Next, owner-inspect the actual PostgreSQL version, TLS identity, backup schedule, retention, and
   PITR in Railway. Only rehearse restore into a separately approved disposable database; never
   migrate or restore over the canonical database.
2. **G5–G7 — Buckets, health, and secrets:** plan a private staging bucket, least-privilege access,
   approved prefixes, and secret names/ownership. No bucket or variables are to be created until the
   exact staging environment and required owner approval are recorded.
3. **G8–G11 — AI, maps, email, and monitoring:** select providers only after product/legal approval;
   use sandbox adapters for staging, keep live AI/provider calls disabled, and never place credentials
   in source, logs, or chat.
4. **G12–G14 — Web Search, embeddings, and payment preparation:** test only isolated adapters and
   non-financial preparation. Payments remain simulation-only; no live checkout, settlement, or
   payment-provider credentials are authorized.
5. **G15–G20 — Web quality, scaling, tests, and release:** verify authenticated browser flows,
   scheduler safety before multiple replicas, regression suites on disposable databases, rollback
   instructions, and a release checklist. Publishing requires separate explicit approval.

Before any cloud change, the owner must approve the exact project/environment, resource scope,
provider selection where relevant, and whether the existing public PostgreSQL proxy should remain.
