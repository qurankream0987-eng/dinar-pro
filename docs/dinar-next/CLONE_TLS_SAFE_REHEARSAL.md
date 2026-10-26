# DINAR clone-only TLS-safe migration rehearsal

**Status:** Guard and local tests prepared; no Railway clone has been restored or migrated.  
**Canonical target:** Railway `development` / `Postgres`. Production and canonical development remain prohibited in clone mode.

## Inspected and changed

- Inspected the canonical development TLS verifier, migration URL resolver, Drizzle configuration and migrator, Railway service metadata, and the existing TLS tests.
- Added `lib/db/src/clone-migration-guard.ts` for clone target selection, endpoint and certificate pin checks, pre-write identity validation, and baseline ledger validation.
- Added `lib/db/scripts/migrate-clone.mjs` and the `@workspace/db` `migrate:clone` script. It uses one TLS-verified PostgreSQL connection for the read-only preflight and migration.
- Updated `resolveMigrationDatabaseUrl()` to refuse any explicit target mode. This prevents the regular `migrate` command from silently falling back to the canonical development URL when clone mode was requested.
- Extended `artifacts/api-server/test/development-tls.test.ts` with fail-closed clone and no-fallback tests.

No secret values, database rows, environment settings, Railway resources, or production settings were changed.

## TLS and target identity

The canonical TLS verifier is unchanged. Clone mode uses a separate verifier and never reuses the canonical volume's CA:

1. The clone URL must match the separately supplied proxy host and port, database name, and database user.
2. The proxy must be a Railway TCP proxy. Its server certificate must chain to `DINAR_CLONE_CA_CERT`, whose SHA-256 fingerprint must match `DINAR_CLONE_CA_FINGERPRINT_SHA256`. Obtain and verify both through authenticated Railway access before configuring them.
3. TLS certificate name validation is pinned to `DINAR_CLONE_SERVER_IDENTITY`; certificate verification cannot be disabled or downgraded.
4. The clone endpoint and identity must differ from the canonical development endpoint and from the required production endpoint and identity. If a workspace `DATABASE_URL` is present, a matching endpoint is also rejected.
5. The operator must explicitly set `DINAR_MIGRATION_TARGET=railway-clone` and `DINAR_CLONE_MIGRATION_ACK=I_CONFIRM_RAILWAY_CLONE_ONLY`. Missing or unknown modes stop rather than falling back.
6. Before migration, the runner opens a read-only transaction on the same verified connection and confirms the database name, role, PostgreSQL port, active TLS, and read-only state. It also checks that all 28 applied migration timestamps and hashes match the checked-in baseline. Only after these checks pass does it roll back the read-only transaction and invoke Drizzle on that same connection.

The checked-in runner requires the exact 28-entry pre-migration ledger and a 39-entry journal whose eleven pending migrations (`0028`–`0038`) match `REVIEWED_PENDING_MIGRATIONS` in `lib/db/src/clone-migration-guard.ts` by tag and SHA-256. The journal is checked before any connection is opened. An unexpected or already-migrated clone, or any added or edited migration, is rejected until the migration is reviewed and pinned.

**2026-10-22 — `0037_pre_integration_closure` reviewed and pinned.** It creates new tables, indexes and append-only triggers, and replaces two `CHECK` constraints (`ai_usage_reservations_resource_valid`, `ai_usage_counters_resource_valid`) with wider ones that add `AUDIO_TRANSCRIPTION`; no table or column is dropped and no row is rewritten. Local rehearsal on a disposable loopback PostgreSQL 16 (not Railway): a database migrated to `0036` and populated with development seed data and usage counters received `0037` without data loss; a second run was a no-op; the widened constraint accepted `AUDIO_TRANSCRIPTION` and still rejected an unknown resource. Adding the constraints scans `ai_usage_reservations` and `ai_usage_counters` under a brief exclusive lock. **No migration was run against Railway.**

**2026-10-22 — `0038_ai_model_price_entry` reviewed and pinned.** It adds one nullable column, `ai_model_prices.created_by`, with a foreign key to `users`; no row is rewritten. It was written by hand because the drizzle snapshots stop at `0033` and `drizzle-kit generate` would otherwise emit a migration recreating tables from `0034`–`0037` — do not use generated output for this chain without first regenerating snapshots. Local rehearsal (disposable loopback PostgreSQL 16, not Railway): a populated database at `0037` holding an existing price row received `0038`; the row kept a null author; a second run was a no-op (39). **No migration was run against Railway.**

## Fail-closed tests

The tests cover:

- Missing clone mode or acknowledgement.
- Unknown endpoint, canonical endpoint, production endpoint, and canonical server identity.
- Missing production denylist and mismatched clone URL, database name, or database user.
- Incorrect clone CA fingerprint and TLS downgrade settings.
- Identity mismatch, non-TLS connection, or a preflight that is not read-only.
- Missing, extra, or altered migration ledger entries.
- The regular canonical migration resolver refusing any explicit target mode.

The live Railway TLS acceptance test remains opt-in and was not run. No clone connection was attempted.

## Clone provisioning, data protection, and permissions

Railway's official backup guide says a PITR restore creates a sibling Postgres service and leaves the source untouched. Railway's read-only service description exposed only the Postgres service's live state, not backup or PITR status. **PITR availability, archiver health, and restore coverage are therefore unverified.** No backup was created and PITR was not enabled.

Before a full-data restore, the owner must separately approve it and verify:

- PITR is enabled, WAL archiving is healthy, and the requested timestamp is inside the restore window. Enabling PITR changes Railway service configuration and redeploys Postgres, so it is not part of this preparation.
- The restored sibling is in the development environment, has a distinct Railway service identity and TCP proxy, and is not attached to a public application domain.
- The owner can inspect backups, restore to a sibling, inspect the clone's service/volume identity, and configure development-only environment values. The exact Railway role name for those permissions was not exposed by the available read-only metadata; do not grant production changes for this rehearsal.
- A clone-only database credential has the DDL rights needed for migrations but is used only against that sibling. Keep its URL in the workspace's development secret settings; never put it in code or logs.
- Because a full restore may contain user accounts, messages, listings, and order history, restrict access to authorized project operators, do not export rows elsewhere, and keep the sibling only until the rehearsal report is complete. Delete the sibling and remove clone-only credentials afterward; use a 24-hour maximum unless the owner explicitly approves a longer retention.

No full-data clone or Railway migration is authorized by this document.

## Required development-only configuration

After a separately approved restore, configure these values only for the development environment:

| Variable | Source / purpose |
| --- | --- |
| `DINAR_CLONE_DATABASE_URL` | Secret connection URL for the restored sibling. |
| `DINAR_CLONE_PROXY_HOST`, `DINAR_CLONE_PROXY_PORT` | Exact sibling TCP proxy endpoint from Railway. |
| `DINAR_CLONE_SERVER_IDENTITY` | Sibling's internal TLS service identity, independently confirmed in Railway. |
| `DINAR_CLONE_DATABASE_NAME`, `DINAR_CLONE_DATABASE_USER` | Expected database and role from the sibling's connection settings. |
| `DINAR_CLONE_CA_CERT`, `DINAR_CLONE_CA_FINGERPRINT_SHA256` | Sibling CA certificate and independently authenticated fingerprint. |
| `DINAR_PRODUCTION_PROXY_HOST`, `DINAR_PRODUCTION_PROXY_PORT`, `DINAR_PRODUCTION_SERVER_IDENTITY` | Production endpoint and identity denylist. These are mandatory; clone mode refuses to run without them. |
| `DINAR_DEV_DATABASE_URL` | Existing canonical development connection, used only to reject that endpoint. Do not replace it with the clone URL. |
| `DINAR_MIGRATION_TARGET` | Exact value `railway-clone`. |
| `DINAR_CLONE_MIGRATION_ACK` | Exact value `I_CONFIRM_RAILWAY_CLONE_ONLY`, set only for the approved run. |

The clone URL and CA configuration are not currently set by this change. Do not ask the agent to reveal or print their values.

## Exact next safe action

The owner should inspect the canonical development service's **Backups** tab and report whether PITR is enabled, the WAL archiver is healthy, and the restore window covers the desired timestamp. Do not restore a clone yet. If a later restore is approved, configure and review the clone-only values above, then run:

```sh
NODE_ENV=development \
DINAR_MIGRATION_TARGET=railway-clone \
DINAR_CLONE_MIGRATION_ACK=I_CONFIRM_RAILWAY_CLONE_ONLY \
pnpm --filter @workspace/db run migrate:clone
```

The command refuses to proceed until all required development-only settings, TLS checks, database identity checks, and the exact 28-migration ledger check and the reviewed 39-entry journal check pass. It does not change or deploy the application.
