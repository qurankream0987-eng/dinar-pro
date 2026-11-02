# DINAR Railway readiness package

**Status: prepared locally, not connected, not deployed.** This document records repository
evidence and a safe owner setup path. It does not assert that any Railway resource exists or is
configured.

## 1. Current access and scope

On 2026-11-03, the Railway integration remained unmounted (`not mounted yet; retried each turn`).
No Railway project or environment IDs, services, deployments, database version, bucket, variables,
network settings, backup policy, resource limits, usage, or billing details could be verified.
The read-only exception was approved, but no cloud request could be made.

No cloud resource was changed. No secret value was read. No remote database was contacted or
migrated. No provider was enabled, no domain was attached, and no deployment was performed.

Repeat the requested inventory only after the Railway integration is mounted. Verify the actual
workspace, project, and environment IDs before inspecting the historical
`dinar-development-canonical` project or treating any resource as canonical. Record variable names
only, never their values. A successful read does not establish write permission.

## 2. Proposed service shape

Use **one Node service** for the first staging rehearsal. The API already serves the built React
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
| Healthcheck path | `/readyz` | Checks database, migration ledger, configuration, and phone provider |
| Healthcheck timeout | 120 seconds | Allows a cold start and dependency checks |
| Restart policy | `ON_FAILURE`, maximum 5 retries | Restarts crashes without treating a clean exit as a crash |
| Replicas | 1 | Avoid duplicate in-process maintenance loops |
| Public domain | None until separately approved | No unapproved exposure |
| Production autodeploy | Disabled | Prevents an experimental branch from reaching production |
| Pre-deploy command | None | In particular, do not run a migration automatically |

`/healthz` is a process liveness response; it does not prove that the database or migrations are
ready. `/readyz` is expected to return 503 until the database is reachable, the migration ledger
matches the checked-in journal, required deployment configuration is valid, and a permitted phone
verification provider is registered.

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
| `DINAR_PHONE_VERIFICATION_PROVIDER` | Only after an SMS adapter and sandbox are selected | No vendor adapter is registered; readiness stays blocked |
| `DINAR_LIVE_PROVIDERS_ENABLED` | Keep unset/false | No live provider calls authorized |
| `DINAR_AI_MODEL_FALLBACK` | Keep unset/false | No model call is enabled by default |

Do not transfer Replit object-storage paths or provider secrets into Railway. The S3 adapter requires
explicit S3 configuration and keeps objects private unless a path is explicitly configured as
public. The current code has no registered staging/production SMS provider; setting a vendor name
alone will not make phone verification ready.

## 5. Database and migration gate

The application uses `DATABASE_URL` at runtime outside development. `/readyz` compares the applied
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

## 7. Exact read-only inventory checklist

When the connector is available, record (with IDs where Railway exposes them):

- Workspace and project identity; environment names and IDs; development/staging/production roles.
- Services, source repository/branch, deployment history, build/start configuration, autodeploy,
  healthchecks, restart policy, replicas, and public/private networking.
- PostgreSQL service/version, attached volumes, private address, variable **names**, backups,
  retention, PITR, and restore options.
- Storage buckets, access mode, region, variable **names**, and whether any public domain exists.
- Custom domains, usage/resource limits, and billing limits.

Keep every item `NOT_VERIFIED` until the integration returns evidence. Do not infer access rights or
resource ownership from names in this repository.

## 8. Railway configuration format

This package uses a Dockerfile for the build and process definition. It intentionally does not add
`railway.toml`: Railway's current documentation marks Config as Code (`railway.toml`/`railway.json`)
deprecated and gives **2026-12-01** as the end of support for existing legacy files. The modern
Railway IaC workflow requires a verified project/service target and a separate IaC package; neither
is available while the integration is unmounted. Do not apply a guessed IaC project or service.

After the target is verified, the owner can choose the current Railway IaC workflow and run its
non-mutating plan first. Stop if the plan proposes creating, deleting, or redeploying resources
outside the separately approved staging scope. Do not apply the plan or deploy until explicitly
authorized.

## 9. Prepared local verification

The Docker image itself was not built in this environment. Verify the workspace-equivalent steps
locally on this branch:

```sh
pnpm run typecheck
pnpm --filter @workspace/dinar run build
pnpm --filter @workspace/api-server run build
```

**Observed on this branch:** typecheck passed; web and API builds passed; secret scan passed (1/1);
storage portability passed (2/2); S3 wire tests passed (7/7). The web build emitted existing
Rollup annotation and large-chunk warnings; they did not fail the build.

The Docker image, database readiness route, Railway connectivity, live storage, backups, and
provider credentials were **not tested**. Run database-backed checks only with the documented
disposable loopback harness. Do not point them at Railway. A passing local build does not establish
Railway connectivity, database readiness, backup readiness, provider credentials, or deployment
readiness.
