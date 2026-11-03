# 01 — Current Railway inventory

**Observed:** 2026-11-03, authenticated Railway control-plane reads only.
**Overall status:** `PREPARED_NOT_DEPLOYED`; backup and migration-ledger state remain `UNVERIFIED`.

## Verified resources

| Area | Observation |
|---|---|
| Railway project | `dinar-development-canonical` |
| Project ID | `3810e583-cc70-434c-b6fa-9ea15779f3c1` |
| Environment | One persistent `development` environment was visible |
| Environment ID | `4086de25-d270-4f39-89d1-93f611fe79c2` |
| Database service | One PostgreSQL service, one replica |
| Database service ID | `6a02fe25-1305-437c-9fe7-b989836c8949` |
| Volume | One 500 MB volume mounted at `/var/lib/postgresql/data`, region `iad` |
| Volume ID | `b8618f8c-29ac-4c6f-948f-c515b4c21f3c` |
| Configured image | `ghcr.io/railwayapp-templates/postgres-ssl:18` |
| App service | None |
| Buckets | None visible in the inspected environment |
| Domains | No app service or custom domain listed |
| Public database access | An active TCP proxy exists; its endpoint is intentionally omitted |
| Latest deployment | `SUCCESS`, deployment ID `5331773a-cc0b-4bcc-a9f9-e6db312d06cd`, dated 2026-10-08 |

The configured image tag does not prove the running PostgreSQL version. A prior read-only query
from 2026-11-03 recorded PostgreSQL 18.6, database `railway`, primary status, and a valid TLS service
identity; this continuation did not connect to the database or repeat that query.

## Metrics and limitations

The latest available hourly aggregation covered 168 hours and returned 169 samples. It reported
average RAM use of approximately 0.06165 GB and average disk use of approximately 0.12255 GB. An
earlier 2,017-sample query for the same 168-hour window reported CPU average 0.000325 and peak
0.001153 (units unstated), CPU limit 8 (unit unstated), RAM average 0.06167 GB and peak 0.06442 GB,
RAM limit 8 GB, and disk average 0.12254 GB. The different sample counts reflect different
aggregation/query results and were not reconciled. CPU/network units and disk-metric scope remain
uncertain. The disk metric was not proven to represent the attached volume, so no volume-capacity
percentage is inferred. There is no app service from which to estimate DINAR request capacity.

The prior service description returned these variable **names** only:
`DATABASE_PUBLIC_URL`, `DATABASE_URL`, `PGDATA`, `PGDATABASE`, `PGHOST`, `PGPASSWORD`, `PGPORT`,
`PGUSER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`, `POSTGRES_USER`,
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, and `SSL_CERT_DAYS`. No values were accessed. No
`WAL_ARCHIVE_*` name appeared, but the connector cannot inspect Backups/PITR state.

The connector did not expose the account plan, billing limits, Backups tab, PITR state, archive
health, retention, or restore history. No bucket or obvious `WAL_ARCHIVE_*` variable name appeared
in the inspected inventory; that is not proof that backups are disabled.

`getStatus` and `environmentStatus` reported a staged `EnvironmentPatch`, while detailed
environment/service descriptions and `getStagedChanges` showed no staged changes. This conflict
remains `UNVERIFIED`. Do not accept, discard, or apply anything based on the conflicting responses;
check Railway’s own environment view before any future cloud change.

## Migration and exposure risk

The current Railway migration ledger is `UNVERIFIED` in this package. The prior read-only report
recorded 28 of 51 expected migrations on the existing development database. Treat that as a dated
warning, not a current ledger query. Do not connect the app to this database or run migrations
against it.

The public TCP proxy is active. Do not use it for runtime or tests. Removing or restricting it is a
networking change and requires explicit owner approval after a private path is verified.

## Safety record

- No Railway resource was created, deployed, restarted, changed, or deleted.
- No database connection was made during this continuation.
- No variable values or credentials were read.
- No customer or private data was copied.
- PITR was not enabled; no restore was run.
