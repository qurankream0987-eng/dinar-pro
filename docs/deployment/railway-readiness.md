# DINAR Railway readiness package

**Status: G3–G7 inventory and local readiness evidence collected on 2026-11-03; the application
package is not deployed.** This document separates observed Railway state from local repository
evidence and unverified settings. No cloud resource was changed and no secret value was read.

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

The active public PostgreSQL proxy is an exposure to review. Do not use it for app runtime or
automated tests; the owner must confirm whether it is needed and separately authorize any restriction
or removal.

The service configuration did not report a healthcheck, restart policy, backup schedule, retention,
PITR, or restore history. The connector exposes no billing-plan or spending-limit inventory. The
168-hour metrics query returned 2,017 samples: CPU_USAGE averaged 0.000325 and peaked at 0.001153
(unit not stated); CPU_LIMIT was 8 (unit not stated); MEMORY_USAGE averaged 0.06167 GB and peaked at
0.06442 GB; MEMORY_LIMIT was 8 GB; DISK_USAGE averaged 0.12254 GB. The connector did not establish
whether DISK_USAGE refers to the attached 500 MB volume or the service filesystem. These are
PostgreSQL-service observations, not application capacity or cost estimates.

There is a Railway status inconsistency. `getStatus` still returns one staged `EnvironmentPatch`
entry, while `environment.stagedChanges` is null; `describeEnvironment` reports one live Postgres
service, one live 500 MB volume, no buckets, and zero staged changes; `getStagedChanges` and
`describeService` also report no changes. The exposed Railway tools do not include the documented
`environmentPendingWork` poller. Do not accept, apply, or cancel anything based on these conflicting
responses; resolve the marker in Railway's own environment view before any future cloud change.

One read-only transaction reached the existing Postgres service over TLS on 2026-11-03. It returned
PostgreSQL 18.6, the expected `railway` database, primary status, and a valid TLS service identity.
The migration ledger contains 28 of the 51 migrations expected by this branch. The connection was
closed without writes or migration attempts. This is the existing `development` database, not an
approved staging target; do not attach the application to it while its ledger is behind.

No cloud resource was changed, no secret value was read, and no provider, domain, or deployment was
enabled. No migration or restore was run.

The workspace, project, and environment IDs above are the identities returned by authenticated
Railway reads. `describe-service` returned these variable names only:
`DATABASE_PUBLIC_URL`, `DATABASE_URL`, `PGDATA`, `PGDATABASE`, `PGHOST`, `PGPASSWORD`, `PGPORT`,
`PGUSER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`, `POSTGRES_USER`,
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, and `SSL_CERT_DAYS`. No `WAL_ARCHIVE_*` names appeared in
that inventory, but the connector does not expose the Backups tab or archive health; this is not
definitive proof of PITR status. No variable values or bucket credentials were requested. Read access
does not establish permission to write.

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

The server now handles SIGTERM/SIGINT by stopping its maintenance timers, closing the HTTP server,
and ending the database pool. Local Docker stop/restart checks passed; this does not imply a
Railway deployment or multi-replica safety.

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

Only PostgreSQL service metrics are available; there is no DINAR application service to measure.
The connector's CPU-limit unit and the scope of its disk metric are unspecified, so these readings
cannot support application sizing or a volume-capacity percentage. Choose app CPU, memory, and
storage only after an approved staging workload is measured.

### Cost worksheet (unit rates verified; total remains unknown)

Railway's documentation, checked 2026-11-03, lists storage buckets at **$0.015 per GB-month**.
Bucket API operations and bucket egress are free; uploads from a Railway service to a bucket count
as service egress. PITR has no separate fee: it uses bucket storage and service egress for compressed
WAL and base-backup uploads. Sources:
[Storage Buckets Billing](https://docs.railway.com/storage-buckets/billing) and
[Postgres PITR](https://docs.railway.com/volumes/point-in-time-recovery).

The Postgres PITR documentation describes weekly full and daily differential backups, with the last
four full backups retained (roughly four weeks). This is product documentation, not evidence that
PITR is enabled on this service. Calculate actual cost only after the owner confirms the billing
plan, eligible credits/limits, compressed write volume, retention window, and measured service
egress:

- App compute: selected CPU/RAM plan × one initial replica × measured active hours.
- PostgreSQL: selected plan + provisioned storage + compressed PITR bucket GB-month + service egress.
- Object storage: average stored GB × $0.015/GB-month; bucket operations and bucket egress are free.
- Network: measured ingress/egress and any private-network charges.
- Optional providers: SMS, AI, email, maps, web search, error reporting, and payment fees; currently
  unselected and not authorized for live use.
- Domains and monitoring: only if the owner separately approves them.

The app plan, backup archive size, write rate, service egress, and applicable credits/limits remain
unknown, so no total monthly cost is supportable yet.

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

The existing Railway `development` database was checked read-only: PostgreSQL 18.6, TLS identity
verified, primary, and 28/51 expected migrations applied. It is not a staging database and is behind
this branch; do not connect the new app or run migrations against it.

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

Backup schedules, snapshots, PITR enablement, archive health, retention, and restore history are
**not verified**. The connector cannot read the Backups tab or list backup jobs. The absence of
`WAL_ARCHIVE_*` names in the returned service-variable inventory and the absence of a bucket suggest
PITR may be off, but neither proves backup status. Do not enable PITR as part of this task: Railway
documents that enabling it creates a bucket, adds service variables, and redeploys the database.

For PostgreSQL, Railway's generic PITR documentation describes continuous WAL upload to a bucket,
weekly full and daily differential backups, and retention of the last four full backups. It also
warns that sustained bucket outages can fill a 5 GiB queue and truncate the PITR window. Archive
health and a current restore point therefore need monitoring; the documented window is not an
unconditional recovery guarantee. A PITR restore provisions a new Postgres service alongside the
source; it does not overwrite the source. Any rehearsal must use that separate restored service and
remain isolated until an owner approves a cutover.

Candidate targets for owner review are **RPO ≤15 minutes** and **RTO ≤4 hours**. These are proposed
operational objectives, not Railway guarantees or measured results. They are not accepted until a
restore rehearsal validates them.

The repository has an S3-compatible object-storage adapter with private-prefix handling,
permission checks, presigned uploads, and object-generation metadata. Local tests cover private
owner access and upload completion; this is code evidence only and does not prove that a
Railway-compatible bucket exists or that a live upload/download works.

Business-verification files are owner-scoped, limited to 10 MB, and restricted to PDF/JPEG/PNG.
Upload URLs expire after 15 minutes. No scanner is registered, so new documents remain
`NOT_SCANNED`/quarantined and cannot be used to verify a business. The code sets retention to 365
days after a decision while marking the policy not legally reviewed. No periodic retention or
orphan-file deletion job was found. Legal review of the period and a tested erasure process are
pre-live privacy blockers; do not treat `retainUntil` as proof that deletion occurs automatically.
Invalid-content uploads and files identified as infected have targeted cleanup, but that does not
replace an expiry sweep.

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

The inspected project has only its PostgreSQL service and attached volume; it has no DINAR app
service or bucket. The one read-only TLS query confirmed PostgreSQL 18.6, primary status, and service
identity, but the migration ledger is only 28/51. No app-to-database connection was tested.

The Railway status response still contains a staged-patch marker while environment/service/volume
inventories show no staged differences. The available tools cannot inspect that marker further.
Backup schedules, snapshots, PITR status, archive health, retention, and restore history are also
unavailable through the connector. The service-variable inventory has no `WAL_ARCHIVE_*` names, but
that is not definitive proof that backups are disabled. The owner must confirm both issues in
Railway before any staging change.

No bucket exists in this environment. Metrics are limited to the PostgreSQL service and do not
establish app resource limits, attached-volume utilization, or a total monthly cost. The returned
variable names contain no secret values; none were requested or read.

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

The reviewed G1/G2 baseline was pushed before this continuation:
`dbe35d47beb4895ce7dede008c515d8db1a3cead`.
The image was built locally after the readiness and shutdown-handling updates, then started and
exercised with throwaway settings and a loopback-only, deliberately unreachable database URL. No
image was deployed:

```sh
pnpm run typecheck
pnpm --filter @workspace/dinar run build
pnpm --filter @workspace/api-server run build
```

**Observed on this branch:** code generation, workspace typecheck, web build, and API build passed.
The API suite passed 63/63 on disposable PostgreSQL 18.6; readiness passed 15/15; fresh-environment
passed 9/9 on PostgreSQL 18.6 and 9/9 on PostgreSQL 16.15; release-migration passed 11/11 on
PostgreSQL 18.6. The prior local runs also passed the S3/storage checks (9/9), business D1/D2
acceptance (24/24), and secret scan (1/1). Local suite migration and API tests recorded zero outbound
attempts.

After adding signal handling, the Docker image built and ran with loopback-only placeholder settings.
It served `/api/healthz` and the built web app (200), returned JSON 404 for an unknown API route, and
returned `/api/readyz` 503 as expected with the deliberately unreachable loopback database; readiness
reported database unavailable, configuration ready, and phone verification not configured. SIGTERM
stopped the container with exit code 0; it served health again after restart and stopped cleanly a
second time. No live S3 endpoint or Railway database was contacted by this smoke test.

The image has no embedded Docker `HEALTHCHECK`; configure Railway's HTTP health path as
`/api/readyz`. At the bare `/healthz` and `/readyz` paths the SPA returns HTML, not the JSON health
response.

This does not establish Railway connectivity, live database readiness, backup readiness, provider
credentials, or deployment readiness. Run database-backed checks only with the documented
disposable loopback harness. Do not point them at Railway.

## 10. Next-stage sequence and approval gates

1. **G3 — PostgreSQL:** read-only version/TLS checks passed, but the current development database is
   28/51 migrations and must not be migrated or used as staging. Identify a separate staging
   database before app connectivity or migration rehearsal.
2. **G4 — Backups:** status remains unverified. Owner-inspect snapshots/PITR and resolve the
   environment's inconsistent staged-patch marker. If approved later, rehearse a restore only into a
   new disposable service/database; never overwrite the source.
3. **G5 — Buckets:** no bucket exists. Select a private staging bucket and least-privilege access
   only after legal review of document retention and a verified erasure/orphan-cleanup process.
4. **G6–G7 — Runtime and secrets:** local health, readiness, graceful stop, and restart checks pass.
   Keep one replica. Create no Railway service or variables until the exact staging target and owner
   approval are recorded; no secret values were read.
5. **G8–G11 — AI, maps, email, and monitoring:** select providers only after product/legal approval;
   use sandbox adapters for staging, keep live AI/provider calls disabled, and never place credentials
   in source, logs, or chat.
6. **G12–G14 — Web Search, embeddings, and payment preparation:** test only isolated adapters and
   non-financial preparation. Payments remain simulation-only; no live checkout, settlement, or
   payment-provider credentials are authorized.
7. **G15–G20 — Web quality, scaling, tests, and release:** verify authenticated browser flows,
   scheduler safety before multiple replicas, regression suites on disposable databases, rollback
   instructions, and a release checklist. Publishing requires separate explicit approval.

Before any cloud change, the owner must approve the exact project/environment, resource scope,
provider selection where relevant, and whether the existing public PostgreSQL proxy should remain.
