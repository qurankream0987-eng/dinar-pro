# DINAR development database migration rehearsal

**Recorded:** 2026-10-21  
**Target:** Railway Postgres in the DINAR development environment  
**Decision:** Rehearse only. Do not migrate the canonical Railway database without the user's explicit approval.

## Safety boundary

- The target was confirmed as the Railway development Postgres service. The connection was authenticated with the project's development-only TLS verifier.
- Target queries ran inside a `READ ONLY` transaction and were rolled back. No target DDL or DML, backup configuration, restore, deployment, or service change was performed.
- Production was not queried or modified.
- No live database rows or connection strings were copied into this document.
- The database is PostgreSQL 18.6. Its `drizzle.__drizzle_migrations` ledger has 28 of 37 entries; all 28 recorded hashes match the checked-in migration files.

## Target preflight results

Exact current data checks on the target returned:

| Check | Result |
| --- | ---: |
| Offers by pricing mode | 1 `FIXED`; no other modes |
| Unknown or invalid post-normalization offer prices | 0 |
| Negotiation amount / quantity constraint violations | 0 |
| Existing conversations that fail the new `conversations_shape_check` | 0 |
| Non-array `allowedModes` values under category pricing rules | 0 |
| `courier_fare_agreements_order_unique` index exists | Yes |
| Tables introduced by migrations 0029, 0032, 0034, 0035, and 0036 already exist | No |

`pg_stat_user_tables` estimated approximately 10 users, 53 conversations, 220 messages, 8 categories, 1 offer, and 1 order; these are planner statistics, not exact counts. No row contents were read for the inventory.

## Rehearsal performed

1. Built a disposable PostgreSQL 16 loopback database in `/tmp`; it contained no copied target rows.
2. Applied migrations `0000`–`0027` from the checked-in SQL and seeded the disposable Drizzle ledger with the same 28 journal entries.
3. Ran `lib/db/scripts/compare-canonical-schema.mjs` against that loopback database and the read-only canonical development target. Before pending migrations, every section matched:

   | Catalog section | Local / target | Match |
   | --- | ---: | --- |
   | Columns | 743 / 743 | Yes |
   | Constraints | 405 / 405 | Yes |
   | Indexes | 175 / 175 | Yes |
   | Enums | 0 / 0 | Yes |
   | Triggers | 12 / 12 | Yes |
   | Functions | 9 / 9 | Yes |
   | Sequences | 1 / 1 | Yes |
   | Views | 0 / 0 | Yes |

4. Ran the repository migration command against the loopback database:

   ```sh
   NODE_ENV=development \
   DINAR_DEV_DATABASE_URL="$LOOPBACK_REHEARSAL_URL" \
   pnpm --filter @workspace/db run migrate
   ```

5. The runner reported success. The disposable ledger now has 37 of 37 matching hashes, and the new negotiation, delivery-progress, tutorial, AI-usage, and marketplace-inquiry tables are present.

This is a **schema-only rehearsal**, not a restore of target data. The SQL chain and schema changes were exercised on an exact pre-migration schema; target-specific data guards were separately checked read-only and passed. It does not prove behavior against a full data clone.

## Exact pending sequence

All nine entries below remain unapplied on the canonical development target:

| Migration ID | File | Effect / relevant gate |
| --- | --- | --- |
| 0028 | `0028_fashion_search_attributes.sql` | Adds fashion search aliases and attributes. |
| 0029 | `0029_soft_radioactive_man.sql` | Adds negotiation events; makes negotiation price fields nullable; adds amount/pricing checks and category pricing rules. |
| 0030 | `0030_swift_living_mummy.sql` | Normalizes pricing modes to `FIXED`, `NEGOTIABLE`, and `OPEN_TO_OFFERS`; updates offer/category data and checks prices. |
| 0031 | `0031_negotiation_events_append_only.sql` | Adds append-only triggers to negotiation events. |
| 0032 | `0032_wave63_delivery_progress.sql` | Adds delivery progress events and append-only triggers. |
| 0033 | `0033_courier_fare_assignment_history.sql` | Drops `courier_fare_agreements_order_unique`; preflight confirmed the index exists. |
| 0034 | `0034_tutorial_learning_history.sql` | Adds tutorial learning events. |
| 0035 | `0035_ai_usage_allowances.sql` | Adds AI usage reservation and counter tables. |
| 0036 | `0036_marketplace_inquiries.sql` | Extends conversation shape and adds marketplace inquiry/event tables. |

Use the repository's checked-in SQL and journal as the source of truth; do not edit the migration ledger or apply hand-written replacement DDL.

## Railway backup and restore procedure

Railway's [Postgres backup guide](https://docs.railway.com/guides/postgres-backups-restores) distinguishes volume backups from point-in-time recovery (PITR). **Backup/PITR status for this service was not verified during this rehearsal. Do not assume a restorable point exists.**

### Before a future migration

1. In Railway, select the DINAR project, the **development** environment, and its Postgres service. Reconfirm the service identity; do not select production.
2. Open **Backups** and check PITR status, WAL archiver health, and the available restore window. If PITR is not enabled, enabling it configures WAL archiving and redeploys Postgres; get approval before enabling it, then wait until archiving is healthy and the first base backup completes before relying on it.
3. Create a manual volume backup from the same tab as an additional pre-change checkpoint. A volume backup is not a point-in-time restore.
4. Record the UTC cutoff time, current migration IDs/hashes, and the read-only preflight results. Schedule an approved write freeze or account for writes that would be lost if restoring to this point.
5. For an isolated restore rehearsal, choose a time immediately before the migration and use **Restore to this moment** in the Backups tab. Railway creates a sibling Postgres service; the original service is left untouched.
6. Wait for the sibling service to become healthy. Verify its identity, migration ledger, and baseline counts with read-only checks. Keep the original `DINAR_DEV_DATABASE_URL` unchanged.
7. Run migrations only against the isolated copy with the clone-only runner documented in [`docs/dinar-next/CLONE_TLS_SAFE_REHEARSAL.md`](dinar-next/CLONE_TLS_SAFE_REHEARSAL.md). It requires the clone's separately pinned CA fingerprint, proxy endpoint, service identity, database/user, production denylist, and an exact 28-migration baseline. Do not bypass the TLS verifier, use the canonical runner in clone mode, or point the shared app at the sibling.
8. Retain the sibling until its schema, data checks, and application smoke tests pass; then remove it only after confirming it is the rehearsal copy and no longer needed.

### If rollback is needed after an explicitly approved migration

1. Stop or freeze writes to the affected development app and record the rollback cutoff. Restoring an earlier point discards later database writes unless they are separately preserved and reconciled.
2. For a precise timestamp restore, use **Restore to this moment** to create a sibling, validate it, then make a separately approved connection switch. The current endpoint pin means that switch also needs a safe, reviewed service-identity update.
3. For an in-place restore to the same service, select the pre-migration volume backup and click **Restore**. This changes the active service and requires explicit approval. Review Railway's staged volume change carefully; clicking **Deploy** applies the restored volume and restarts the service. Railway retains the prior volume.
4. Verify the service is healthy, confirm the expected migration ledger and schema, and run development smoke checks before reopening writes.

No backup was created and no restore was attempted for this rehearsal.

## Re-running the checks

1. Confirm `NODE_ENV=development` and that the verified `DINAR_DEV_DATABASE_URL` resolves to the Railway development service. Never print the URL. Run target inspection through `verifiedDevelopmentCredentials()` and a `BEGIN READ ONLY` transaction.
2. Compare the ledger's `created_at` values and hashes against `lib/db/drizzle/meta/_journal.json` and the corresponding SQL files. Stop if there are unknown entries, mismatched hashes, unexpected pre-existing objects, or data-guard violations.
3. Create a fresh disposable loopback PostgreSQL database. Apply only journal entries `0000`–`0027`, create and seed the Drizzle migration ledger from those 28 checked-in hashes, and run `compare-canonical-schema.mjs` with `DINAR_SCHEMA_REFERENCE_URL` set to that loopback database.
4. Require `schemaDrift: NONE` before continuing. Run the exact migration command above with `DINAR_DEV_DATABASE_URL` set to the loopback database, then verify 37 matching ledger hashes and all expected new objects.
5. Keep the canonical development target read-only until the user explicitly approves a separate migration operation.

