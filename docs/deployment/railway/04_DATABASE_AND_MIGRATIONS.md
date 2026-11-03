# 04 — Database and migrations

**Status:** Fresh local migration is `READY_AND_VERIFIED`; Railway ledger and unified-release
upgrade rehearsal are `UNVERIFIED`/`BLOCKED`.

## Current migration history

The canonical development branch observed on 2026-11-03 was
`replit/dinar-next-complete-development` at `11d7fbe`. It and the infrastructure source branch at
`75d5937` contain 51 journal entries through `0050_normal_nico_minoru.sql`.

Relevant active branch heads show an unresolved numbering collision:

| Branch | Migration file |
|---|---|
| `qoder/wave02-d4-d6-closure` | `0051_order_multi_item_money.sql` |
| `replit/d16-legal-privacy-compliance` | `0051_d16_legal_readiness_incidents.sql`, followed by `0052_d16_readiness_constraints.sql` and `0053_d16_country_legal_intake.sql` |

Do not renumber, merge, or invent a sequence for these migrations in this infrastructure branch.
The designated Claude/Qoder owners must supply the approved unified history. A fresh and an
upgrade rehearsal against that final SHA are release blockers.

The prior read-only report recorded the existing Railway development database at 28/51. This
continuation did not connect to Railway; its current ledger remains `UNVERIFIED`. Never run tests,
`drizzle-kit push`, or a release migration against that database.

## Local rehearsal

On a new loopback-only PostgreSQL 18.6 container, the checked-in migration command applied all 51
entries successfully. The database was disposable and removed after the test. The Docker app was
then started against a separate empty database; it returned 503 readiness and did not create
`drizzle.__drizzle_migrations`. Application startup therefore does not auto-migrate.

Reproducible local commands (replace the variable only with a loopback URL for an explicitly
disposable database named `dinar_test_*` or `dinar_migration_*`):

```sh
docker build --pull -t dinar-railway-readiness:local -f Dockerfile .
docker run --rm --network host --user 0 \
  --workdir /app/lib/db \
  -e NODE_ENV=development \
  -e DATABASE_URL="$LOCAL_TEST_DATABASE_URL" \
  -e DINAR_DEV_DATABASE_URL="$LOCAL_TEST_DATABASE_URL" \
  --entrypoint /app/lib/db/node_modules/.bin/drizzle-kit \
  dinar-railway-readiness:local migrate --config ./drizzle.config.ts
```

The 15-case readiness suite passed. It covers unavailable DB, pending/inconsistent migration
ledgers, unavailable journal metadata, valid readiness, and sanitized errors. The actual container
also survived stopping and restarting the disposable PostgreSQL service.

## Approved release procedure (not executed)

Only after the approved unified release SHA is selected, a separate staging database is created,
backup/restore is verified, and the owner approves the migration gate:

1. Confirm the exact staging service, private host, TLS behavior, database name, and `DATABASE_URL`.
2. Verify that `DINAR_DEV_DATABASE_URL` is absent and that the target database name exactly matches
   the owner-approved name.
3. Deploy the already-built approved SHA without running migrations at application startup.
4. Perform the plan-only command against the approved target:

```sh
NODE_ENV=production \
DINAR_DEPLOYMENT_ENV=staging \
DINAR_MIGRATION_TARGET=staging \
DINAR_MIGRATION_ACK=APPLY_STAGING_MIGRATIONS \
DINAR_MIGRATION_EXPECTED_DATABASE="<exact approved staging database name>" \
DINAR_MIGRATION_DRY_RUN=1 \
DATABASE_URL="<platform-injected private staging URL>" \
pnpm --filter @workspace/db run migrate:release
```

5. Review the manifest, expected migration list, database identity, and plan output with the owner.
   Stop on any manifest mismatch, divergent/advanced ledger, unexpected database, or unexpected SQL.
6. Only after explicit migration authorization, remove `DINAR_MIGRATION_DRY_RUN=1` and rerun with
   the same verified target inputs. The runner requires the checked-in `release-manifest.json`,
   SHA-256 matches, an exact ledger prefix, and an advisory lock.
7. Verify `/api/readyz`, migration ledger head, and staging smoke tests. Preserve logs with secrets
   and SQL parameters redacted.

For production the acknowledgement must be `APPLY_PRODUCTION_MIGRATIONS` and both
`DINAR_DEPLOYMENT_ENV` and `DINAR_MIGRATION_TARGET` must be `production`. Production migration is
not authorized by this package.
