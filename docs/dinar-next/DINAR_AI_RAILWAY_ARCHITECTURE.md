# DINAR AI Railway Architecture

**Code SHA reviewed:** `6b56704ff04dc7682a57e0a6fa8fcc594600e53a`
**Canonical branch SHA:** `995d2e57b94bfe552d25e902137c584e554b8114`
**Checked:** 2026-11-08
**Status:** Staging proposal only. No Railway write, deployment, database query or DNS change was performed.

## Current state and deployment fit

The read-only Railway inventory available to this audit showed a development PostgreSQL service, but no DINAR app deployment or visible Railway Bucket. Production was not inspected. Do not infer backup/PITR, app availability, or database contents from that inventory.

Unlike older drafts, the canonical candidate has a root `Dockerfile`. It builds `artifacts/dinar` and `artifacts/api-server`, sets `DINAR_WEB_DIST=/app/artifacts/dinar/dist/public`, then starts the API bundle. The API includes a static frontend handler. There is no Railway-specific service manifest (`railway.toml`/`railway.json`) in the inspected root. This supports a simple first deployment as one public web/API container, not a required frontend rewrite or a mandatory two-service split. `Dockerfile` also has not been proven on Railway; the final report lists G33 Docker acceptance as not run because Docker was unavailable.

## Recommended topology

```text
Internet
  └─ owner-controlled DNS and HTTPS domain
      └─ one public DINAR container (initial staging; Vite dist + Express API)
          ├─ /api/* and /api/healthz, /api/readyz
          ├─ public web assets
          └─ private connection to same-environment PostgreSQL

Same Railway project, isolated environments
  ├─ staging: app container, synthetic-data PostgreSQL, staging S3 Bucket
  └─ production: create only after separate owner/legal/release approval;
                separate container configuration, PostgreSQL and Bucket
```

Keep the first API deployment to one replica. `artifacts/api-server/src/index.ts` and `lib/marketplace-search-index.ts` start recurring work in-process; horizontal replicas could duplicate timers unless jobs gain database leases or move to a dedicated idempotent worker. Add a worker only when observed load/reliability requires it. Railway private networking is for app-to-database traffic; never expose a database with a public domain for application access.

### Service configuration and readiness

Source paths: `Dockerfile`, `artifacts/api-server/src/app.ts`, `lib/deployment-configuration.ts`, `routes/health.ts`, `server-lifecycle.ts`.

- The container must bind the Railway-provided `PORT` and start from the repository's Docker build context. Confirm image size, build time, runtime permissions, and static asset path in staging.
- `/api/healthz` is liveness. `/api/readyz` checks database reachability, migration ledger, deployment configuration and phone-verification readiness. A configured-but-unregistered SMS adapter can therefore block readiness.
- Production-mode configuration requires a sufficiently long `SESSION_SECRET`, explicit `DINAR_DEPLOYMENT_ENV` (`staging` or `production`), valid object-storage configuration and any supplied `APP_ORIGIN` to be a valid origin. Confirm the exact required names against source; keep values in Railway's environment/secret manager, never in code or chat.
- Test `APP_ORIGIN`, trusted proxy/origin behavior, CSRF/SameSite cookies, API origin, CSP connect origins and CORS after selecting a domain. In production the frame policy is self-only.
- `server-lifecycle.ts` drains HTTP connections and closes the database pool on SIGTERM/SIGINT. Test Railway's shutdown grace period against that behavior.
- Do not run schema migration concurrently from multiple replicas or assume container startup migrates the DB. Use the reviewed release-migration process.

## PostgreSQL and release sequence

The candidate uses PostgreSQL and Drizzle. `lib/db/drizzle/release-manifest.json` is the release authority; the final readiness report describes 61 reviewed migrations and 12/12 PG18 release-migration acceptance. This is repository-reported local evidence, not a Railway compatibility test.

1. Create a separate staging PostgreSQL service in the staging environment and use its private network URL only in staging.
2. Compare the expected manifest/journal with the empty staging ledger before applying changes.
3. Apply the reviewed migration release step once, confirm the ledger, then start the app. Do not use `drizzle-kit push` or allow multiple API instances to race migrations.
4. Test an upgrade on disposable synthetic data, including rollback/forward-recovery decisions. Prefer forward-compatible schema changes; restoring a DB is not an app transaction rollback.
5. Size each process pool against database connection limits. Multiply pool size by replicas and workers before scaling.
6. Keep staging and production databases, credentials and provider accounts separate. Never use production records in acceptance.

## Object storage and media

The active application adapter in the inspected source is Replit-managed Object Storage. The candidate also has an S3-compatible implementation and a `storage-s3-wire` test, but the final report lists external-storage suites as not run. Railway Bucket compatibility is therefore **not verified**. Railway Bucket is an S3-style object API; a Railway Volume is not a substitute for object storage.

| Data class | Staging/production handling |
|---|---|
| Public approved product image | Only after canonical moderation/publication approval; versioned key and cache policy. |
| Buyer visual-search image | Private and uploader-bound; max one photo, 5 MB; define deletion/retention after the search. Never put in a public prefix. |
| Merchant source media | Import through DINAR validation; do not trust arbitrary URLs or imported policy status. |
| Seller replacement/generated draft | Private until explicit seller approval and DINAR moderation; generated editing is not currently integrated. |
| Profile images | Keep distinct from product originals and order records. |
| Identity/business/support documents | Private least-privilege access, short-lived access, audit and approved retention/deletion. |

Before moving storage, test S3 signature/endpoint compatibility, metadata generation (ETag/VersionId), presigned upload/download, CORS, owner ACLs, content-type and magic-byte validation, maximum size, image re-encoding, deletion, cache invalidation and restore. Do not remove the Replit adapter until the staging test passes and the owner approves cutover. A PostgreSQL backup does not restore bucket objects.

## Backups, recovery and operations

Railway documents volume backups and optional PostgreSQL PITR. PITR must be enabled and is not proven by service existence. Confirm current account plan, backup schedule, retained recovery points, bucket/archive charges and point-in-time range in the owner account. No database was queried and no backup or restore was run here.

Before production: define RPO/RTO; take a staging backup; restore into a separate database; verify migration ledger, representative synthetic user/listing/order and `/api/readyz`; separately recover a media sample; record who approves any traffic cutover. Configure log retention and operational alerts for readiness, DB errors, webhook rejection, AI spend limits and background jobs. Application logging is structured/redacted; the monitoring adapter is log-only until a provider is explicitly registered.

## Domain, TLS and staged deployment

1. Owner selects and controls the domain/registrar.
2. Deploy staging on an owner-approved temporary Railway domain first.
3. Validate public HTTPS, redirects, origin/cookie/CSRF behavior, uploads, `/api/healthz` and `/api/readyz`.
4. If adding a custom domain, use only the CNAME and TXT records displayed by Railway and have the owner apply them at the registrar. Railway provisions TLS after verification.
5. Add a production hostname only after legal, provider, migration, backup/restore, device and independent-review gates pass.

No registrar or DNS credential should be given in chat. Replit-hosted custom-domain setup does not modify a Railway domain or external DNS.

## Costs, risks and acceptance

Illustrative usage is in [the cost model](DINAR_AI_INTEGRATIONS_COST_MODEL.md); it is not a resource-sizing forecast. Plan subscription fees contribute to usage. Bucket storage is currently $0.015/GB-month; service traffic to a bucket can still incur service egress. Optional Pro/monitor plan status must be confirmed by the owner.

**Priority: P0 staging foundation.** Missing: owner authorization/account configuration, staging app/DB/bucket, complete runtime configuration, migration rehearsal, storage compatibility, backups and restore proof. Security risks: public DB exposure, staging/prod credential reuse, private media leakage, duplicate timers and unsafe migration order. Claude must review the exact Docker/runtime config, migration ledger, least-privilege networking, readiness semantics, storage ACLs and restore/cutover evidence.

**Acceptance tests (not run in this audit):** clean container build; startup and graceful SIGTERM; liveness/readiness including failure cases; private DB-only connectivity; migration ledger exactness; one-replica timers; public asset routing; cookie/CSRF/CSP; storage upload/ACL/delete/restore; logs redaction; staged restore drill. The checked-in final report says Docker acceptance and external storage tests were not run.

## Official Railway sources

Checked 2026-11-08:

- [Pricing and resource rates](https://docs.railway.com/reference/pricing)
- [Private networking](https://docs.railway.com/networking/private-networking)
- [Domains and TLS](https://docs.railway.com/networking/domains/working-with-domains)
- [Storage Bucket billing](https://docs.railway.com/storage-buckets/billing)
- [Postgres backups and restore](https://docs.railway.com/guides/postgres-backups-restores)
- [Point-in-time recovery](https://docs.railway.com/volumes/point-in-time-recovery)
