# DINAR S3 URL-style microfix handoff

**Status:** implemented and verified locally only. No Railway Bucket, cloud database, production
data, deployment, DNS, SMS, paid AI, or external object-store endpoint was accessed.

## Configuration contract

- `OBJECT_STORAGE_S3_URL_STYLE=path` keeps the existing path-style addressing.
- `OBJECT_STORAGE_S3_URL_STYLE=virtual` uses virtual-hosted Bucket URLs.
- If the setting is absent, the adapter uses `path`. It does not infer a style from the endpoint.
- Any other value is rejected during S3 configuration validation.
- Object keys, private/public prefixes, ACL metadata, ownership checks, and URL normalization do not
  change with the address style.
- This setting adds no database schema change. A release containing only this microfix does not
  need a database migration.

For a new virtual-hosted Bucket, configure the provider-issued endpoint and select `virtual`.
Keep a legacy Bucket on `path` unless its provider configuration is separately verified. Configure
the Bucket CORS rule for only the intended app origin and required methods/headers. Add the exact
virtual-hosted Bucket origin to `CSP_CONNECT_EXTRA_ORIGINS`; the endpoint origin is included
separately by the app. Do not use a wildcard origin. Confirm the provider's generated hostname and
TLS certificate before enabling this against a real Bucket.

## Safe migration-only first boot

This sequence is for an approved staging release that also has reviewed, pending schema migrations.
The URL-style setting itself does not require one.

1. Confirm the staging database identity and backup, and obtain the separate release approval.
   Keep the staging database URL in the deployment's secret/environment settings; never print it
   or copy it into a command transcript. Do not set `DINAR_DEV_DATABASE_URL` for this operator run.
2. Set the provider-issued S3 endpoint, Bucket, credentials, and intended
   `OBJECT_STORAGE_S3_URL_STYLE`. For virtual-hosted access, set the exact app and Bucket origins
   in the Bucket CORS rule and `CSP_CONNECT_EXTRA_ORIGINS`.
3. Run the guarded release migration command in dry-run mode, with the staging target and exact
   database name:

   ```sh
   NODE_ENV=production \
   DINAR_DEPLOYMENT_ENV=staging \
   DINAR_MIGRATION_TARGET=staging \
   DINAR_MIGRATION_ACK=APPLY_STAGING_MIGRATIONS \
   DINAR_MIGRATION_EXPECTED_DATABASE="replace-with-exact-staging-database-name" \
   DINAR_MIGRATION_DRY_RUN=1 \
   pnpm --filter @workspace/db run migrate:release
   ```

   Replace the quoted placeholder with the exact database name before running the command.
   `DATABASE_URL` must be supplied through the protected environment settings. The dry run still
   connects to staging to verify target identity, PostgreSQL version, migration manifest, and the
   applied ledger; it reports the pending plan without applying it. Review that output and stop if
   the target or plan is unexpected.
4. Only after the review and approval, run the same guarded command once with
   `DINAR_MIGRATION_DRY_RUN` unset. Do not automatically retry a refused or failed migration.
   Follow the existing [release-migration handoff](PRE_STAGING_HARDENING_HANDOFF.md) if it refuses
   the target, version, manifest, or ledger.
5. Start the API as a separate step only after the migration command exits successfully. Keep the
   existing API entry point, authentication, and readiness behavior unchanged. Do not move the
   migration into normal application startup or start a serving API as the migration process.

If there are no pending schema migrations, skip the migration command; do not run it merely to
enable the S3 URL-style setting. No staging or production step above has been executed as part of
this local-only change.
