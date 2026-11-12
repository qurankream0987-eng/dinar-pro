# DINAR staging: backup and recovery procedure

Scope: Railway project `dinar-development-canonical`, environment `staging` only.
Database: `dinar-staging-postgres-ams` / `dinar_staging` (PostgreSQL 18.6, Amsterdam).
Bucket: `dinar-staging-ams` (private). Backups live under `backups/postgres/dinar_staging/`.

## Backups held

| Key | Bytes | sha256 | Contents |
|---|---|---|---|
| `pre-migration-20261109T134519Z.dump` | 914 | `e8985248…e566` | empty database (before the 61 migrations) |
| `post-migration-20261109T141432Z.dump` | 651,926 | `080c61eb…4ee0` | 61 migrations applied, no user data |

Both are pg_dump custom format. The checksum is also stored in object metadata as `x-amz-meta-sha256`. Anonymous GET and LIST on the bucket return 403. No presigned URL was issued.

Restore drill, 2026-11-09:
- The post-migration dump downloaded with a matching checksum and fully restored into `dinar_restore_drill_*` in 127 s.
- The restored copy matched the live database exactly: 133 tables, 395 indexes, 2,215 constraints, 99 triggers, 80 functions, 61 ledger entries, and the same digest `f1ab85d7…`.
- The drill database was then dropped.
- Allow about 2–3 minutes for a full restore, and never interrupt the job mid-restore.

## Taking a backup

The `dinar-staging-backup-job` service (image `postgres:18`, restart NEVER) reaches the database and bucket only through Railway references (`${{dinar-staging-postgres-ams.DATABASE_URL}}` and `${{dinar-staging-ams.*}}`).
1. Set `LABEL` (for example `pre-release-YYYYMMDD`).
2. Make sure the start command is `/bin/bash -c 'eval "$BACKUP_SCRIPT"'`.
3. Deploy the service.
4. The log must end with `BACKUP_OK key=… sha256=…`.

What the script does:
- refuses a non-`.railway.internal` host or any database other than `dinar_staging` on PostgreSQL 18+;
- dumps, uploads, HEADs and re-downloads the object, then compares the sha256;
- checks that anonymous access returns 403;
- restores into a fresh `dinar_backup_verify_<ts>` database, counts its tables and ledger, then drops it.

The service costs nothing between runs.

## Recovery (owner approval required)

1. Stop writers: scale `dinar-staging-app` to 0 replicas (or remove its deployment).
2. Restore into a new database rather than over the live one. Use the backup job with a one-off script that:
   - runs `createdb dinar_staging_restore_<ts>`;
   - downloads the chosen object and verifies its sha256;
   - runs `pg_restore --exit-on-error -d …/dinar_staging_restore_<ts>`;
   - checks that `drizzle.__drizzle_migrations` holds the expected number of entries.
3. Repoint the app: change `DATABASE_URL` on `dinar-staging-app` to the restored database, then redeploy commit `acc7c67`.
4. Verify:
   - `/api/healthz` returns 200;
   - `/api/readyz` shows `database: ready, migrations: current`.
5. Keep the previous database until the owner approves removing it. Nothing is dropped automatically.

## Application rollback

Redeploy the previous successful deployment of `dinar-staging-app`. Automatic deploys are off and there is no pre-deploy command, so a rollback never runs migrations.
Migrations are forward-only. A schema rollback is a database restore (above), never a reverse migration.
